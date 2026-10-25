// Checks the preview block in headless Chrome, with the real stylesheet and
// Bootstrap: at each measured viewport width exactly one offered view is visible,
// it is the view the block picks, it is the only view whose iframe was
// requested, and only the outer corners of the visible device buttons are
// rounded. With click activation, no iframe is requested until the poster
// button of the shown view is pressed. check-preview-js.mjs drives the same module against a fake DOM that
// applies no CSS, which cannot show a view the stylesheet hides.
//
// The check builds the exampleSite with a throwaway content directory of probe
// pages, serves it on 127.0.0.1 and drives Chrome over the DevTools protocol.
// Chrome never reaches https://example.org/: the check answers those requests
// itself and records which view's iframe made each one.
//
// Chrome is looked up at CHROME_PATH, then at the usual install locations. When
// none is found, or it does not start, the check is skipped with the reason.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

const TARGET = 'https://example.org/'
const SETTLE_MS = 500

const PAGES = {
  default: [],
  nocontrols: ['controls: false'],
  desktop: ['devices: [desktop]'],
  'desktop-nocontrols': ['devices: [desktop]', 'controls: false'],
  'desktop-tablet': ['devices: [desktop, tablet]'],
  'desktop-tablet-nocontrols': ['devices: [desktop, tablet]', 'controls: false'],
  'desktop-mobile': ['devices: [desktop, mobile]'],
  'desktop-mobile-nocontrols': ['devices: [desktop, mobile]', 'controls: false'],
  'mobile-desktop': ['devices: [mobile, desktop]'],
  'mobile-tablet-desktop': ['devices: [mobile, tablet, desktop]'],
  'mobile-desktop-tablet': ['devices: [mobile, desktop, tablet]'],
  'mobile-tablet': ['devices: [mobile, tablet]'],
  'tablet-desktop-mobile': ['devices: [tablet, desktop, mobile]'],
  'tablet-mobile': ['devices: [tablet, mobile]'],
  tablet: ['devices: [tablet]'],
  click: ['activation: click', 'mode: true', 'poster:', '  desktop: img/poster-desktop.png', '  mobile: img/poster-mobile.png'],
  'click-nocontrols': ['devices: [desktop, mobile]', 'controls: false', 'activation: click']
}

function findChrome () {
  const candidates = [process.env.CHROME_PATH]
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium')
  } else if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (base) candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    }
  } else {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) candidates.push(path.join(dir, name))
    }
  }
  return candidates.find(file => file && fs.existsSync(file))
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-browser-'))
let server, browser

// Settles with the promise, or after ms, whichever comes first.
function within (promise, ms) {
  let timer
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms) })]).finally(() => clearTimeout(timer))
}

// Stop Chrome before removing its profile directory, which it writes to while it runs.
after(async () => {
  if (browser) {
    const exited = new Promise(resolve => browser.proc.once('exit', resolve))
    const running = () => browser.proc.exitCode === null && browser.proc.signalCode === null
    if (browser.cdp) await within(browser.cdp.send('Browser.close').catch(() => {}), 5000)
    if (browser.ws) browser.ws.close()
    if (running()) await within(exited, 5000)
    if (running()) { browser.proc.kill('SIGKILL'); await within(exited, 5000) }
    browser.proc.unref()
  }
  if (server) { server.closeAllConnections(); server.close() }
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    console.log(`# could not remove ${tmp}: ${error.message}`)
  }
})

function buildSite () {
  const content = path.join(tmp, 'content')
  const publish = path.join(tmp, 'public')
  fs.mkdirSync(content)
  for (const [name, lines] of Object.entries(PAGES)) {
    fs.writeFileSync(path.join(content, `${name}.md`), [
      '---',
      `title: ${name}`,
      'modules: [preview]',
      'content_blocks:',
      '  - _bookshop_name: preview',
      `    url: ${TARGET}`,
      ...lines.map(line => `    ${line}`),
      '---',
      ''
    ].join('\n'))
  }
  // On Windows the hugo-extended bin is a .cmd shim, which only a shell resolves.
  const shell = process.platform === 'win32'
  const quote = arg => shell ? `"${arg}"` : arg
  const result = spawnSync('hugo', ['-s', 'exampleSite', '--contentDir', quote(content), '-d', quote(publish)], { encoding: 'utf8', shell })
  assert.equal(result.status, 0, `probe site build failed:\n${result.stderr}${result.stdout}`)
  return publish
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }

function serve (root) {
  const server = http.createServer((req, res) => {
    let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname))
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

// Minimal DevTools protocol client over one browser-level WebSocket, with
// flattened sessions for page targets.
class CDP {
  constructor (ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.handlers = new Set()
    ws.addEventListener('message', ({ data }) => {
      const msg = JSON.parse(data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`)); else resolve(msg.result)
      } else if (msg.method) {
        this.handlers.forEach(fn => fn(msg))
      }
    })
    // A command still waiting when the browser goes away never gets its answer.
    ws.addEventListener('close', () => {
      this.pending.forEach(({ reject }) => reject(new Error('DevTools connection closed')))
      this.pending.clear()
    })
  }

  send (method, params = {}, sessionId) {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  on (fn) { this.handlers.add(fn); return () => this.handlers.delete(fn) }
}

// Starts Chrome and connects to it. browser holds the process from the start, so
// the after hook stops it even when the connection is never made. Chrome gets no
// output pipes, because helper processes that outlived it kept a stderr pipe open
// and this script from exiting. It reads the DevTools port from the
// DevToolsActivePort file that Chrome writes to its profile directory instead.
async function launch (chromePath) {
  const profile = path.join(tmp, 'profile')
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--mute-audio', 'about:blank']
  // On Linux, run without Chrome's sandbox: the check loads only local pages, and
  // a Chrome that cannot start its sandbox would skip the check.
  if (process.platform === 'linux') args.unshift('--no-sandbox')
  const proc = spawn(chromePath, args, { stdio: 'ignore' })
  browser = { proc }
  let failure
  proc.on('error', error => { failure = error })
  proc.on('exit', code => { failure ||= new Error(`exited with ${code}`) })
  const activePort = path.join(profile, 'DevToolsActivePort')
  const [port, browserPath] = await waitFor(() => {
    if (failure) throw failure
    const lines = fs.existsSync(activePort) ? fs.readFileSync(activePort, 'utf8').split('\n') : []
    return lines.length >= 2 && lines[1] ? lines : null
  }, 'the DevTools port', 30000)
  browser.ws = new WebSocket(`ws://127.0.0.1:${port.trim()}${browserPath.trim()}`)
  await new Promise((resolve, reject) => { browser.ws.addEventListener('open', resolve); browser.ws.addEventListener('error', reject) })
  browser.cdp = new CDP(browser.ws)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor (check, what, timeout = 10000) {
  const end = Date.now() + timeout
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

// Reports each pane and button of the page's preview: its device, whether it is
// visible and, for panes, whether its iframe carries src.
const STATE = `(() => {
  const device = el => (el.dataset.bsTarget || el.id).split('-').pop()
  const visible = el => {
    const style = getComputedStyle(el)
    const box = el.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && box.width > 0 && box.height > 0
  }
  const panes = [...document.querySelectorAll('section.preview .preview-content > .tab-pane')]
  const buttons = [...document.querySelectorAll('section.preview .preview-controls .btn')]
  return {
    readyState: document.readyState,
    width: window.innerWidth,
    panes: panes.map(el => {
      const poster = el.querySelector('.preview-poster')
      const image = poster && [...poster.querySelectorAll('img')].find(visible)
      return {
        device: device(el),
        visible: visible(el),
        src: el.querySelector('iframe').hasAttribute('src'),
        poster: poster ? { visible: visible(poster), image: image ? image.currentSrc.split('/').pop() : null } : null
      }
    }),
    active: document.querySelector('section.preview .preview-content').dataset.active || null,
    buttons: buttons.map(el => {
      const style = getComputedStyle(el)
      const side = (top, bottom) => {
        const round = [top, bottom].map(corner => parseFloat(style['border' + corner + 'Radius']) > 0)
        return round[0] && round[1] ? 'round' : !round[0] && !round[1] ? 'square' : 'mixed'
      }
      return { device: device(el), visible: visible(el), active: el.classList.contains('active'), left: side('TopLeft', 'BottomLeft'), right: side('TopRight', 'BottomRight') }
    })
  }
})()`

// Opens one probe page in a fresh tab at the given viewport width. Requests for
// the preview target are answered with a stub page. A lazy iframe does not delay
// window load, so `hold` adds an image to the page at DOMContentLoaded and holds
// its request until release() is called, which keeps window load from firing.
// It also sets window.previewCheckReady then: readyState turns 'interactive'
// before the deferred scripts, Bootstrap among them, have run.
async function openPage (cdp, base, name, width, { hold = false } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const send = (method, params) => cdp.send(method, params, sessionId)
  const requests = []
  const held = []
  let holding = hold
  const fulfill = requestId => send('Fetch.fulfillRequest', {
    requestId,
    responseCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
    body: Buffer.from('<!doctype html><title>stub</title><p>stub</p>').toString('base64')
  }).catch(() => {})
  const off = cdp.on(async msg => {
    if (msg.sessionId !== sessionId || msg.method !== 'Fetch.requestPaused') return
    const { requestId, frameId, resourceType } = msg.params
    if (resourceType !== 'Document') {
      if (holding) held.push(requestId); else fulfill(requestId)
      return
    }
    let owner = 'unknown'
    try {
      const { backendNodeId } = await send('DOM.getFrameOwner', { frameId })
      const { node } = await send('DOM.describeNode', { backendNodeId })
      const classes = (node.attributes[node.attributes.indexOf('class') + 1] || '').split(' ')
      owner = (classes.find(cls => cls.startsWith('preview-') && cls !== 'preview-iframe') || 'unknown').replace('preview-', '')
    } catch {}
    requests.push(owner)
    fulfill(requestId)
  })
  await send('Page.enable')
  await send('DOM.enable')
  await send('Runtime.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: `${TARGET}*`, requestStage: 'Request' }] })
  if (hold) {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `if (window === window.top) document.addEventListener('DOMContentLoaded', () => {
        window.previewCheckReady = true
        const img = new Image()
        img.src = '${TARGET}hold.png'
        document.body.append(img)
      }, { once: true })`
    })
  }
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${base}/${name}/` })

  const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value
  return {
    requests,
    evaluate,
    state: () => evaluate(STATE),
    resize: w => send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false }),
    // Presses Enter on the focused element, as a keyboard does.
    async pressEnter () {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    },
    emulateMedia: features => send('Emulation.setEmulatedMedia', { features }),
    release () { holding = false; held.splice(0).forEach(fulfill) },
    // Waits for window load and for the expected iframe requests (the assertions
    // report any that never came), then lets SETTLE_MS pass for unexpected ones.
    async settle (expected) {
      await waitFor(async () => (await evaluate('document.readyState')) === 'complete', 'window load')
      await waitFor(() => expected.every(device => requests.includes(device)), 'the expected requests').catch(() => {})
      await sleep(SETTLE_MS)
      return evaluate(STATE)
    },
    async close () { off(); await cdp.send('Target.closeTarget', { targetId }).catch(() => {}) }
  }
}

const visibleDevices = items => items.filter(item => item.visible).map(item => item.device)
const loadedDevices = state => state.panes.filter(pane => pane.src).map(pane => pane.device)

// Asserts that the visible buttons read as one group: the first rounds its
// left corners, the last its right corners, and every inner corner is square.
function assertCorners (buttons, label) {
  const visible = buttons.filter(button => button.visible)
  visible.forEach((button, i) => {
    const want = { left: i === 0 ? 'round' : 'square', right: i === visible.length - 1 ? 'round' : 'square' }
    assert.deepEqual({ left: button.left, right: button.right }, want, `${label}: corners of the ${button.device} button, visible ${visible.map(b => b.device)}`)
  })
}

// Asserts the invariant: one visible pane, the expected one, and only the
// expected iframes requested so far.
function assertView (page, state, device, requested, label) {
  assert.equal(state.width, page.width, `${label}: viewport width`)
  assert.deepEqual(visibleDevices(state.panes), [device], `${label}: visible panes`)
  assert.deepEqual([...page.requests].sort(), [...requested].sort(), `${label}: iframe requests`)
  if (state.buttons.length > 0) {
    const active = state.buttons.filter(button => button.active).map(button => button.device)
    assert.deepEqual(active, [device], `${label}: active button`)
    assert.ok(visibleDevices(state.buttons).includes(device), `${label}: the active button is visible`)
    assertCorners(state.buttons, label)
  }
}

const chromePath = findChrome()
let skip = chromePath ? false : 'no Chrome found; set CHROME_PATH to run this check'
if (!skip && typeof WebSocket === 'undefined') skip = 'this Node has no global WebSocket'

let base
if (!skip) {
  const start = Date.now()
  server = await serve(buildSite())
  base = `http://127.0.0.1:${server.address().port}`
  console.log(`# built the probe site in ${Date.now() - start} ms`)
  try {
    await launch(chromePath)
    console.log(`# Chrome ${(await browser.cdp.send('Browser.getVersion')).product} at ${chromePath}, ready after ${Date.now() - start} ms`)
  } catch (error) {
    skip = `Chrome at ${chromePath} did not start: ${error.message.split('\n')[0]}`
  }
}
if (skip) console.log(`# skipped: ${skip}`)

// Each case opens a page at a width and names the one view that must show. The
// widths on either side of 1024px and 640px catch the stylesheet and the script
// disagreeing about a breakpoint.
const cases = [
  ['default', 1280, 'desktop'],
  ['default', 1024, 'desktop'],
  ['default', 1023, 'tablet'],
  ['default', 800, 'tablet'],
  ['default', 640, 'tablet'],
  ['default', 639, 'mobile'],
  ['default', 400, 'mobile'],
  ['nocontrols', 1024, 'desktop'],
  ['nocontrols', 1023, 'tablet'],
  ['nocontrols', 640, 'tablet'],
  ['nocontrols', 639, 'mobile'],
  ['desktop', 400, 'desktop'],
  ['desktop', 800, 'desktop'],
  ['desktop-nocontrols', 400, 'desktop'],
  ['desktop-nocontrols', 800, 'desktop'],
  ['desktop-tablet', 400, 'tablet'],
  ['desktop-tablet-nocontrols', 400, 'tablet'],
  ['desktop-mobile', 800, 'mobile'],
  ['desktop-mobile-nocontrols', 1280, 'desktop'],
  ['desktop-mobile-nocontrols', 400, 'mobile'],
  ['mobile-desktop', 1280, 'desktop'],
  ['mobile-desktop', 800, 'mobile'],
  ['mobile-tablet-desktop', 1280, 'desktop'],
  ['mobile-tablet-desktop', 800, 'tablet'],
  ['mobile-tablet-desktop', 400, 'mobile'],
  ['mobile-desktop-tablet', 400, 'mobile'],
  ['mobile-tablet', 400, 'mobile'],
  ['tablet-desktop-mobile', 400, 'mobile'],
  ['tablet-mobile', 400, 'mobile'],
  ['tablet', 800, 'tablet'],
  ['tablet', 400, 'tablet']
]

for (const [name, width, device] of cases) {
  test(`${name} at ${width}px shows and loads ${device} only`, { skip }, async () => {
    const page = await openPage(browser.cdp, base, name, width)
    try {
      page.width = width
      const state = await page.settle([device])
      assertView(page, state, device, [device], `${name} @${width}`)
      console.log(`# ${name} @${width}: visible ${visibleDevices(state.panes)}, requests [${page.requests}], src on [${loadedDevices(state)}]`)
    } finally {
      await page.close()
    }
  })
}

test('desktop-mobile-nocontrols resized 1280px to 600px swaps to mobile and loads it once', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'desktop-mobile-nocontrols', 1280)
  try {
    page.width = 1280
    assertView(page, await page.settle(['desktop']), 'desktop', ['desktop'], '@1280')
    await page.resize(600)
    page.width = 600
    const state = await page.settle(['desktop', 'mobile'])
    assertView(page, state, 'mobile', ['desktop', 'mobile'], '@600')
    console.log(`# desktop-mobile-nocontrols 1280->600: visible ${visibleDevices(state.panes)}, requests [${page.requests}]`)
  } finally {
    await page.close()
  }
})

test('default: a tablet click before window load loads the tablet view', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'default', 1280, { hold: true })
  try {
    page.width = 1280
    await waitFor(() => page.evaluate('window.previewCheckReady === true'), 'DOMContentLoaded')
    await page.evaluate('document.querySelector(\'section.preview .preview-controls [data-bs-target$="-tablet"]\').click()')
    await waitFor(() => page.requests.includes('tablet'), 'the tablet request')
    assert.equal(await page.evaluate('document.readyState'), 'interactive', 'window load had not fired')
    page.release()
    const state = await page.settle(['desktop', 'tablet'])
    assertView(page, state, 'tablet', ['desktop', 'tablet'], 'tablet clicked before load')
    console.log(`# default, tablet clicked before load: visible ${visibleDevices(state.panes)}, requests [${page.requests}]`)
  } finally {
    await page.close()
  }
})

// Click activation: no iframe loads until the poster button of the shown view is
// pressed, here with the keyboard.
const visiblePoster = state => state.panes.find(pane => pane.visible).poster
const RECORD_ACTIVATE = `window.previewActivations = []; document.addEventListener('preview:activate', event => window.previewActivations.push(event.target.matches('section.preview')))`
const FOCUS_ACTIVATE = `(() => { const button = [...document.querySelectorAll('section.preview .preview-activate')].find(el => el.offsetParent); button.focus(); return document.activeElement === button })()`

// The poster of the shown view must cover the box of its scaled iframe, with the
// same corners and a background of its own; its image, when it has one, must fill
// it without distortion; and its button must be the element under its center.
const POSTER_BOXES = `(() => {
  const pane = [...document.querySelectorAll('section.preview .preview-content > .tab-pane')].find(el => el.offsetParent)
  const box = el => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round) }
  const iframe = pane.querySelector('iframe')
  const poster = pane.querySelector('.preview-poster')
  const image = [...poster.querySelectorAll('img')].find(el => el.offsetParent)
  const button = poster.querySelector('.preview-activate').getBoundingClientRect()
  const style = getComputedStyle(poster)
  return {
    iframe: box(iframe),
    poster: box(poster),
    image: image ? box(image) : null,
    fit: image ? getComputedStyle(image).objectFit + ' ' + getComputedStyle(image).objectPosition : null,
    radius: [style.borderTopLeftRadius, getComputedStyle(iframe).borderTopLeftRadius],
    background: style.backgroundColor,
    buttonOnTop: document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2) === poster.querySelector('.preview-activate')
  }
})()`

const near = (got, want) => got.every((value, i) => Math.abs(value - want[i]) <= 1)

async function assertPosterCovers (page, label) {
  const { iframe, poster, image, fit, radius, background, buttonOnTop } = await page.evaluate(POSTER_BOXES)
  assert.ok(near(poster, iframe), `${label}: poster box ${poster} covers iframe box ${iframe}`)
  if (image) {
    assert.ok(near(image, poster), `${label}: image box ${image} fills poster box ${poster}`)
    assert.equal(fit, 'cover 50% 0%', `${label}: the image is cropped, not stretched`)
  }
  assert.equal(radius[0], radius[1], `${label}: poster corners match the iframe`)
  assert.notEqual(background, 'rgba(0, 0, 0, 0)', `${label}: the poster has a background`)
  assert.ok(buttonOnTop, `${label}: the button is on top of the poster`)
  console.log(`# ${label}: iframe box ${iframe}, poster box ${poster}, image box ${image}`)
}

// After activation the posters are faded out and their buttons cannot take focus.
const POSTERS_GONE = `(() => {
  const posters = [...document.querySelectorAll('section.preview .preview-poster')]
  const focusable = posters.map(poster => { const button = poster.querySelector('.preview-activate'); button.focus(); return document.activeElement === button })
  return { opacity: posters.map(poster => getComputedStyle(poster).opacity), focusable }
})()`

async function activateWithEnter (page) {
  await page.evaluate(RECORD_ACTIVATE)
  assert.equal(await page.evaluate(FOCUS_ACTIVATE), true, 'the visible poster button takes focus')
  await page.pressEnter()
}

test('click at 1280px loads nothing until Enter on the poster button, then desktop only', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'click', 1280)
  try {
    page.width = 1280
    let state = await page.settle([])
    assertView(page, state, 'desktop', [], 'before activation')
    assert.equal(visiblePoster(state).visible, true, 'the desktop poster shows')
    assert.match(visiblePoster(state).image, /^poster-desktop-light-/, 'the desktop poster shows')
    await assertPosterCovers(page, 'desktop @1280')
    assert.equal(state.active, null)
    await activateWithEnter(page)
    state = await page.settle(['desktop'])
    assertView(page, state, 'desktop', ['desktop'], 'after activation')
    assert.equal(state.active, 'true')
    assert.equal(visiblePoster(state).visible, false, 'the poster is hidden')
    assert.deepEqual(await page.evaluate(POSTERS_GONE), { opacity: ['0', '0', '0'], focusable: [false, false, false] }, 'every poster faded out and left the tab order')
    assert.deepEqual(await page.evaluate('window.previewActivations'), [true], 'one preview:activate event on the section')
    console.log(`# click @1280: requests before activation [], after [${page.requests}]`)
  } finally {
    await page.close()
  }
})

test('click at 1280px: a device switch before activation swaps the poster and loads nothing', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'click', 1280)
  try {
    page.width = 1280
    await page.settle([])
    await page.evaluate('document.querySelector(\'section.preview .preview-controls [data-bs-target$="-tablet"]\').click()')
    let state = await page.settle([])
    assertView(page, state, 'tablet', [], 'tablet before activation')
    assert.equal(visiblePoster(state).visible, true, 'the tablet poster shows')
    assert.match(visiblePoster(state).image, /^poster-desktop-light-/, 'tablet falls back to the desktop poster')
    await assertPosterCovers(page, 'tablet @1280')
    await page.evaluate('document.querySelector(\'section.preview .preview-controls [data-bs-target$="-mobile"]\').click()')
    state = await page.settle([])
    assertView(page, state, 'mobile', [], 'mobile before activation')
    assert.match(visiblePoster(state).image, /^poster-mobile-light-/, 'mobile shows its own poster')
    await activateWithEnter(page)
    state = await page.settle(['mobile'])
    assertView(page, state, 'mobile', ['mobile'], 'mobile activated')
    await page.evaluate('document.querySelector(\'section.preview .preview-controls [data-bs-target$="-tablet"]\').click()')
    state = await page.settle(['mobile', 'tablet'])
    assertView(page, state, 'tablet', ['mobile', 'tablet'], 'tablet after activation')
    console.log(`# click @1280, tablet and mobile before activation: requests [${page.requests}]`)
  } finally {
    await page.close()
  }
})

test('click at 400px shows the mobile poster and loads mobile on Enter', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'click', 400)
  try {
    page.width = 400
    let state = await page.settle([])
    assertView(page, state, 'mobile', [], 'before activation')
    await assertPosterCovers(page, 'mobile @400')
    await activateWithEnter(page)
    state = await page.settle(['mobile'])
    assertView(page, state, 'mobile', ['mobile'], 'after activation')
  } finally {
    await page.close()
  }
})

test('click-nocontrols loads the picked view on Enter, then the next one on resize', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'click-nocontrols', 400)
  try {
    page.width = 400
    let state = await page.settle([])
    assertView(page, state, 'mobile', [], 'before activation')
    assert.deepEqual(visiblePoster(state), { visible: true, image: null }, 'a poster without an image')
    await assertPosterCovers(page, 'mobile without an image @400')
    await page.resize(1280)
    page.width = 1280
    state = await page.settle([])
    assertView(page, state, 'desktop', [], 'resized before activation')
    await activateWithEnter(page)
    state = await page.settle(['desktop'])
    assertView(page, state, 'desktop', ['desktop'], 'after activation')
    await page.resize(400)
    page.width = 400
    state = await page.settle(['desktop', 'mobile'])
    assertView(page, state, 'mobile', ['desktop', 'mobile'], 'resized after activation')
  } finally {
    await page.close()
  }
})

test('click posters follow the color mode', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'click', 1280)
  try {
    page.width = 1280
    await page.settle([])
    await page.evaluate('document.documentElement.setAttribute(\'data-bs-theme\', \'light\')')
    assert.match(visiblePoster(await page.state()).image, /^poster-desktop-light-/)
    await page.evaluate('document.documentElement.setAttribute(\'data-bs-theme\', \'dark\')')
    await waitFor(async () => /^poster-desktop-dark-/.test(visiblePoster(await page.state()).image || ''), 'the dark poster')
    assert.equal(page.requests.length, 0)
  } finally {
    await page.close()
  }
})

// Presses the shown poster button, pauses the transitions it starts on the poster
// and samples the poster at points of the opacity fade, so no timing is involved.
const FADE_SAMPLES = `(() => {
  const poster = [...document.querySelectorAll('section.preview .preview-poster')].find(el => el.offsetParent)
  poster.querySelector('.preview-activate').click()
  const style = getComputedStyle(poster)
  void style.opacity
  const transitions = poster.getAnimations().filter(animation => animation.transitionProperty)
  transitions.forEach(animation => animation.pause())
  const fade = transitions.find(animation => animation.transitionProperty === 'opacity')
  if (!fade) return { transitions: transitions.map(animation => animation.transitionProperty) }
  const { delay, duration } = fade.effect.getComputedTiming()
  const sample = at => { transitions.forEach(animation => { animation.currentTime = at }); return [Number(style.opacity).toFixed(2), style.visibility] }
  return { duration, samples: [sample(delay + duration / 2), sample(delay + duration - 1), sample(delay + duration + 1000)] }
})()`

test('click posters stay visible until their fade ends', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'click', 1280)
  try {
    page.width = 1280
    await page.settle([])
    const { duration, samples, transitions } = await page.evaluate(FADE_SAMPLES)
    assert.ok(duration > 0, `the poster fades its opacity (transitions: ${transitions})`)
    const [half, last, done] = samples
    assert.ok(Number(half[0]) > 0 && Number(half[0]) < 1, `halfway through the fade the poster is partly opaque: ${half}`)
    assert.equal(half[1], 'visible', 'halfway through the fade the poster is still visible')
    assert.equal(last[1], 'visible', 'just before the fade ends the poster is still visible')
    assert.deepEqual(done, ['0.00', 'hidden'], 'after the fade the poster is hidden')
    console.log(`# click @1280: fade of ${duration}ms, samples ${JSON.stringify(samples)}`)
  } finally {
    await page.close()
  }
})

test('click posters crossfade, and not when reduced motion is preferred', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'click', 1280)
  const transition = 'JSON.stringify([...document.querySelectorAll(\'section.preview .preview-poster\')].map(el => getComputedStyle(el).transitionProperty + \' \' + getComputedStyle(el).transitionDuration)[0])'
  try {
    page.width = 1280
    await page.settle([])
    assert.equal(JSON.parse(await page.evaluate(transition)), 'opacity, visibility 0.15s')
    await page.emulateMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    assert.match(JSON.parse(await page.evaluate(transition)), / 0s$/)
    assert.doesNotMatch(JSON.parse(await page.evaluate(transition)), /0\.15s/)
  } finally {
    await page.close()
  }
})
