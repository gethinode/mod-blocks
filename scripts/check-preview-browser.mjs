// Checks the preview block in headless Chrome, with the real stylesheet and
// Bootstrap: at each measured viewport width exactly one offered view is visible,
// it is the view the block picks, and it is the only view whose iframe was
// requested. check-preview-js.mjs drives the same module against a fake DOM that
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
  desktop: ['devices: [desktop]'],
  'desktop-nocontrols': ['devices: [desktop]', 'controls: false'],
  'desktop-tablet': ['devices: [desktop, tablet]'],
  'desktop-tablet-nocontrols': ['devices: [desktop, tablet]', 'controls: false'],
  'desktop-mobile': ['devices: [desktop, mobile]'],
  'desktop-mobile-nocontrols': ['devices: [desktop, mobile]', 'controls: false']
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

// Chrome must be gone before its profile directory can be removed.
after(async () => {
  if (browser) {
    if (browser.ws) browser.ws.close()
    if (browser.proc.exitCode === null) {
      const exited = new Promise(resolve => browser.proc.once('exit', resolve))
      browser.proc.kill()
      await Promise.race([exited, sleep(5000)])
    }
  }
  if (server) server.close()
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
// the after hook stops it even when the connection is never made.
async function launch (chromePath) {
  const profile = path.join(tmp, 'profile')
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--mute-audio', 'about:blank']
  // Linux CI runners commonly cannot start Chrome's sandbox; the check only loads local pages.
  if (process.platform === 'linux') args.unshift('--no-sandbox')
  const proc = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  browser = { proc }
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = ''
    const fail = error => { clearTimeout(timer); reject(error) }
    const timer = setTimeout(() => fail(new Error(`no DevTools endpoint within 30s\n${stderr}`)), 30000)
    proc.on('error', fail)
    proc.on('exit', code => fail(new Error(`exited with ${code}\n${stderr}`)))
    proc.stderr.on('data', chunk => {
      stderr += chunk
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    })
  })
  browser.ws = new WebSocket(endpoint)
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
    panes: panes.map(el => ({ device: device(el), visible: visible(el), src: el.querySelector('iframe').hasAttribute('src') })),
    buttons: buttons.map(el => ({ device: device(el), visible: visible(el), active: el.classList.contains('active') }))
  }
})()`

// Opens one probe page in a fresh tab at the given viewport width. Requests for
// the preview target are answered with a stub page. A lazy iframe does not delay
// window load, so `hold` adds an image to the page at DOMContentLoaded and holds
// its request until release() is called, which keeps window load from firing.
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
      source: `document.addEventListener('DOMContentLoaded', () => { const img = new Image(); img.src = '${TARGET}hold.png'; document.body.append(img) }, { once: true })`
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
    release () { holding = false; held.splice(0).forEach(fulfill) },
    async settle () {
      await waitFor(async () => (await evaluate('document.readyState')) === 'complete', 'window load')
      await sleep(SETTLE_MS)
      return evaluate(STATE)
    },
    async close () { off(); await cdp.send('Target.closeTarget', { targetId }).catch(() => {}) }
  }
}

const visibleDevices = items => items.filter(item => item.visible).map(item => item.device)
const loadedDevices = state => state.panes.filter(pane => pane.src).map(pane => pane.device)

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
  }
}

const chromePath = findChrome()
let skip = chromePath ? false : 'no Chrome found; set CHROME_PATH to run this check'
if (!skip && typeof WebSocket === 'undefined') skip = 'this Node has no global WebSocket'

let base
if (!skip) {
  server = await serve(buildSite())
  base = `http://127.0.0.1:${server.address().port}`
  try {
    await launch(chromePath)
    console.log(`# Chrome ${(await browser.cdp.send('Browser.getVersion')).product} at ${chromePath}`)
  } catch (error) {
    skip = `Chrome at ${chromePath} did not start: ${error.message.split('\n')[0]}`
  }
}
if (skip) console.log(`# skipped: ${skip}`)

// Each case opens a page at a width and names the one view that must show.
const cases = [
  ['default', 1280, 'desktop'],
  ['default', 800, 'tablet'],
  ['default', 400, 'mobile'],
  ['desktop', 400, 'desktop'],
  ['desktop', 800, 'desktop'],
  ['desktop-nocontrols', 400, 'desktop'],
  ['desktop-nocontrols', 800, 'desktop'],
  ['desktop-tablet', 400, 'tablet'],
  ['desktop-tablet-nocontrols', 400, 'tablet'],
  ['desktop-mobile', 800, 'mobile'],
  ['desktop-mobile-nocontrols', 1280, 'desktop'],
  ['desktop-mobile-nocontrols', 400, 'mobile']
]

for (const [name, width, device] of cases) {
  test(`${name} at ${width}px shows and loads ${device} only`, { skip }, async () => {
    const page = await openPage(browser.cdp, base, name, width)
    try {
      page.width = width
      const state = await page.settle()
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
    assertView(page, await page.settle(), 'desktop', ['desktop'], '@1280')
    await page.resize(600)
    page.width = 600
    await waitFor(async () => visibleDevices((await page.state()).panes).includes('mobile'), 'the mobile view')
    await sleep(SETTLE_MS)
    const state = await page.state()
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
    await waitFor(async () => (await page.evaluate('document.readyState')) === 'interactive', 'DOMContentLoaded')
    await page.evaluate('document.querySelector(\'section.preview .preview-controls [data-bs-target$="-tablet"]\').click()')
    await waitFor(() => page.requests.includes('tablet'), 'the tablet request')
    assert.equal(await page.evaluate('document.readyState'), 'interactive', 'window load had not fired')
    page.release()
    const state = await page.settle()
    assertView(page, state, 'tablet', ['desktop', 'tablet'], 'tablet clicked before load')
    console.log(`# default, tablet clicked before load: visible ${visibleDevices(state.panes)}, requests [${page.requests}]`)
  } finally {
    await page.close()
  }
})
