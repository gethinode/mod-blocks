// Checks the preview block in headless Chrome, with the real stylesheet and
// Bootstrap: at each measured viewport width exactly one offered view is visible,
// it is the view the block picks, it is the only view whose iframe was
// requested, and only the outer corners of the visible device buttons are
// rounded. With click activation, no iframe is requested until the poster
// button of the shown view is pressed, and the poster fades for the configured
// $transition-fade. check-preview-js.mjs drives the same module against a fake
// DOM that applies no CSS, which cannot show a view the stylesheet hides.
//
// The check builds the exampleSite with a throwaway content directory of probe
// pages, once as is and once with a longer $transition-fade, serves both on
// 127.0.0.1 and drives Chrome over the DevTools protocol.
// Chrome never reaches https://example.org/: the check answers those requests
// itself and records which view's iframe made each one. A path under
// https://example.org/child/ gets a child document of CHILDREN, which posts
// the ready message of a block or not, answers with an error status, refuses
// the connection or never answers, so the readiness checks run against real
// cross-origin frames.
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
import util from 'node:util'

const TARGET = 'https://example.org/'
const SETTLE_MS = 500

// The child documents, by the name that follows /child/ in their URL. A child
// that announces posts TOKEN to its parent once its DOM is ready, after delay
// ms; one that replies answers a TOKEN request from its parent once it has
// announced or would have. wrong posts and answers everything but TOKEN alone.
// phone stays silent in a frame narrower than 600px.
const TOKEN = 'demo:ok'
const CHILDREN = {
  ok: { announce: true, reply: true },
  slow: { announce: true, reply: true, delay: 1200 },
  late: { announce: true, reply: true, delay: 3500 },
  reply: { announce: false, reply: true },
  announce: { announce: true, reply: false },
  silent: { announce: false, reply: false },
  wrong: { wrong: true },
  phone: { announce: true, reply: true, delay: 1200, phone: 'silent' },
  503: { status: 503 },
  refused: { refuse: true },
  hang: { hang: true }
}
const child = name => `${TARGET}child/${name}`

function childDocument ({ announce, reply, delay = 0, wrong, phone }) {
  const script = wrong
    ? `const bad = [${JSON.stringify(TOKEN + ' ')}, ${JSON.stringify(TOKEN.toUpperCase())}, { type: ${JSON.stringify(TOKEN)} }, [${JSON.stringify(TOKEN)}], 'preview:ready']
      document.addEventListener('DOMContentLoaded', () => bad.forEach(data => parent.postMessage(data, '*')))
      addEventListener('message', event => { if (event.source === parent) bad.forEach(data => event.source.postMessage(data, '*')) })`
    : `const silent = ${JSON.stringify(phone === 'silent')} && innerWidth < 600
      let ready = false
      document.addEventListener('DOMContentLoaded', () => setTimeout(() => {
        ready = true
        if (${announce} && !silent) parent.postMessage(${JSON.stringify(TOKEN)}, '*')
      }, ${delay}))
      addEventListener('message', event => {
        if (${reply} && !silent && ready && event.source === parent && event.data === ${JSON.stringify(TOKEN)}) {
          event.source.postMessage(${JSON.stringify(TOKEN)}, event.origin === 'null' ? '*' : event.origin)
        }
      })`
  return `<!doctype html><title>child</title><p>child</p><script>${script}</script>`
}

const PAGES = {
  default: [],
  'window-ready-devices': { url: child('silent'), lines: ['frame: window', `ready_message: '${TOKEN}'`, 'load_timeout: 15'] },
  'window-devices': ['frame: window', 'activation: click', 'open_link: true'],
  'window-fallback': ['frame: window', 'open_link: true', 'show_fallback: true', 'mode: true', 'image: img/poster-desktop.png'],
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
  'click-nocontrols': ['devices: [desktop, mobile]', 'controls: false', 'activation: click'],
  // A page whose lines start with items: gets no url of its own.
  items: ['items:', ...item('a', 'Heading A'), ...item('b', 'Heading B')],
  'items-plain': ['items:', '  - title: View a', `    url: ${TARGET}a`, '  - title: View b', `    url: ${TARGET}b`],
  'items-fallback': ['items:', ...item('a', 'Heading A'), ...item('b', 'Heading B'), 'show_fallback: true'],
  'items-click': ['items:', ...item('a', 'Heading A', 'img/poster-desktop.png'), ...item('b', 'Heading B', 'img/poster-mobile.png'),
    'activation: click', 'mode: true'],
  ...Object.fromEntries(['visible', 'load', 'click'].map(activation => [`window-${activation}`, {
    url: child('slow'),
    lines: ['frame: window', 'frame_title: Example window', 'devices: [desktop]', 'controls: false',
      'mobile_static: true', `activation: ${activation}`, `ready_message: '${TOKEN}'`, 'load_timeout: 2', 'open_link: true',
      'mode: true', 'poster:', '  desktop: img/poster-desktop.png']
  }])),
  ...Object.fromEntries(['ok', 'reply', 'announce', 'silent', 'wrong', '503', 'refused', 'late'].map(name => [`window-${name}`, {
    url: child(name), lines: ['frame: window', 'devices: [desktop]', 'controls: false', 'activation: visible',
      `ready_message: '${TOKEN}'`, 'load_timeout: 2', 'open_link: true']
  }])),
  ...readyPages()
}

// The readiness probe pages. Each block waits for TOKEN, unless it is a legacy
// one, and gives up after two seconds, four for ready-phone, or one for the
// legacy pages.
function readyPages () {
  const ready = (name, ...lines) => ({
    url: child(name),
    lines: ['devices: [desktop, mobile]', `ready_message: '${TOKEN}'`, ...(lines.some(line => line.startsWith('load_timeout')) ? [] : ['load_timeout: 2']), ...lines]
  })
  const legacy = name => ({ url: child(name), lines: ['devices: [desktop, mobile]', 'load_timeout: 1'] })
  return {
    'ready-slow': ready('slow'),
    'ready-ok': ready('ok'),
    'ready-silent': ready('silent', 'open_link: true'),
    'ready-503': ready('503'),
    'ready-refused': ready('refused'),
    'ready-late': ready('late'),
    'ready-reply': ready('reply'),
    'ready-announce': ready('announce'),
    'ready-wrong': ready('wrong'),
    'ready-phone': ready('phone', 'load_timeout: 4'),
    'ready-items-click': {
      url: null,
      lines: ['devices: [desktop, mobile]', `ready_message: '${TOKEN}'`, 'load_timeout: 2', 'activation: click', 'mode: true', 'open_link: true',
        'poster:', '  desktop: img/poster-desktop.png', 'links:', '  - title: Start', '    url: https://gethinode.com/',
        'items:', '  - title: View a', `    url: ${child('slow')}`, `    open_url: ${TARGET}a-open`,
        '  - title: View b', `    url: ${child('silent')}`, `    open_url: ${TARGET}b-open`, '    poster:', '      desktop: img/poster-mobile.png']
    },
    'legacy-hang': legacy('hang'),
    'legacy-items': {
      url: null,
      lines: ['devices: [desktop, mobile]', 'load_timeout: 1', 'items:', '  - title: View a', `    url: ${TARGET}a`,
        '  - title: View b', `    url: ${child('hang')}`, `    open_url: ${TARGET}b-open`]
    },
    'legacy-silent': legacy('silent'),
    'fallback-portrait': ['show_fallback: true', 'image: img/poster-mobile.png', 'mode: true'],
    'fallback-ready': { url: child('ok'), lines: ['devices: [desktop, mobile]', 'show_fallback: true', `ready_message: '${TOKEN}'`, 'load_timeout: 1'] },
    'legacy-click-hang': { url: child('hang'), lines: ['devices: [desktop, mobile]', 'load_timeout: 1', 'activation: click', 'poster:', '  desktop: img/poster-desktop.png'] },
    'legacy-503': legacy('503'),
    'legacy-refused': legacy('refused')
  }
}

// One item of a page, viewing TARGET followed by its name, with a heading and,
// when given, a desktop poster.
function item (name, title, poster) {
  return [`  - title: View ${name}`, `    url: ${TARGET}${name}`, '    heading:', `      title: ${title}`,
    ...(poster ? ['    poster:', `      desktop: ${poster}`] : [])]
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
const servers = []
let browser

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
  servers.forEach(server => { server.closeAllConnections(); server.close() })
  if (framing) framing.proc.kill()
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    console.log(`# could not remove ${tmp}: ${error.message}`)
  }
})

const content = path.join(tmp, 'content')

// Builds the probe site into tmp/<name>, with extra hugo arguments. A build that
// runs longer than two minutes is stopped.
// The log of each build, by name.
const buildLogs = {}
function hugo (name, args = [], dir = content) {
  const publish = path.join(tmp, name)
  // On Windows the hugo-extended bin is a .cmd shim, which only a shell resolves.
  const shell = process.platform === 'win32'
  const quote = arg => shell ? `"${arg}"` : arg
  const result = spawnSync('hugo', ['-s', 'exampleSite', '--contentDir', quote(dir), '-d', quote(publish), ...args.map(quote)], { encoding: 'utf8', shell, timeout: 120000 })
  assert.equal(result.status, 0, `probe site build failed:\n${result.error || ''}${result.stderr}${result.stdout}`)
  buildLogs[name] = result.stderr + result.stdout
  return publish
}

// Two loopback servers in a child process, which keeps answering while a build blocks
// this one: deny sends X-Frame-Options: DENY, and allow sends a child document that posts
// TOKEN to its parent 800ms after its DOM is ready and answers a TOKEN request after that.
// Each counts the requests Chrome makes, told apart from those of the build by user agent,
// and prints the counts when it reads a line.
const FRAMING_SERVERS = `
const http = require('node:http')
const chrome = { deny: 0, allow: 0 }
const child = '<!doctype html><title>allow</title><p>allow</p><script>let ready = false;' +
  'document.addEventListener("DOMContentLoaded", () => setTimeout(() => { ready = true; parent.postMessage(${JSON.stringify(TOKEN)}, "*") }, 800));' +
  'addEventListener("message", e => { if (ready && e.source === parent && e.data === ${JSON.stringify(TOKEN)}) e.source.postMessage(e.data, "*") })</script>'
const listen = (name, headers, body) => new Promise(resolve => {
  const server = http.createServer((req, res) => {
    if (/Chrome/.test(req.headers['user-agent'] || '')) chrome[name]++
    res.writeHead(200, { 'Content-Type': 'text/html', ...headers })
    res.end(body)
  })
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})
Promise.all([listen('deny', { 'X-Frame-Options': 'DENY' }, '<p>deny</p>'), listen('allow', {}, child)]).then(ports => console.log(ports.join(' ')))
process.stdin.on('data', () => process.stdout.write(JSON.stringify(chrome) + '\\n'))
`
let framing
async function startFramingServers () {
  framing = { proc: spawn(process.execPath, ['-e', FRAMING_SERVERS], { stdio: ['pipe', 'pipe', 'inherit'] }) }
  const [deny, allow] = await new Promise(resolve => framing.proc.stdout.once('data', data => resolve(String(data).trim().split(' '))))
  framing.deny = `http://127.0.0.1:${deny}`
  framing.allow = `http://127.0.0.1:${allow}`
  framing.counts = () => new Promise(resolve => { framing.proc.stdout.once('data', data => resolve(JSON.parse(String(data)))); framing.proc.stdin.write('?\n') })
}

// A site whose build checks the headers of the framing servers: denied-ready frames the
// deny server, allowed-ready the allow server, both with TOKEN as their ready message.
function buildDeniedSite () {
  const dir = path.join(tmp, 'content-denied')
  fs.mkdirSync(dir)
  for (const [name, url] of [['denied-ready', `${framing.deny}/x`], ['allowed-ready', `${framing.allow}/x`]]) {
    fs.writeFileSync(path.join(dir, `${name}.md`), ['---', `title: ${name}`, 'modules: [preview]', 'content_blocks:', '  - _bookshop_name: preview',
      `    url: ${url}`, `    ready_message: '${TOKEN}'`, '    load_timeout: 1', '    devices: [desktop, mobile]', '---', ''].join('\n'))
  }
  const config = path.join(tmp, 'denied.toml')
  fs.writeFileSync(config, `[security.http]\n  urls = ['^https?://127\\.0\\.0\\.1:\\d+/']\n[params.modules.framing.csp]\n  frame-src = ["${framing.deny}", "${framing.allow}"]\n`)
  return hugo('public-denied', ['--config', `hugo.toml,${config}`], dir)
}

// A page is the lines of its one block, which also gets url: TARGET, or
// { url, lines } to give it another url, or none when url is null.
function buildSite () {
  fs.mkdirSync(content)
  // The readiness demo page of the exampleSite, as it is.
  fs.mkdirSync(path.join(content, 'components'))
  for (const name of ['preview-ready', 'preview-window']) {
    fs.copyFileSync(path.join('exampleSite', 'content', 'components', `${name}.md`), path.join(content, 'components', `${name}.md`))
  }
  for (const [name, page] of Object.entries(PAGES)) {
    const { url = TARGET, lines } = Array.isArray(page) ? { lines: page } : page
    fs.writeFileSync(path.join(content, `${name}.md`), [
      '---',
      `title: ${name}`,
      'modules: [preview]',
      'content_blocks:',
      '  - _bookshop_name: preview',
      ...(url === null ? [] : [`    url: ${url}`]),
      ...lines.map(line => `    ${line}`),
      '---',
      ''
    ].join('\n').replace(`    url: ${TARGET}\n    items:`, '    items:'))
  }
  return hugo('public')
}

// The fade of a site that sets its own $transition-fade. Hinode imports
// scss/theme/_variables.scss before Bootstrap, so a module that provides that
// file ahead of the site imports sets the fade.
const CUSTOM_FADE_MS = 600

function buildCustomFadeSite () {
  const themes = path.join(tmp, 'themes')
  const scss = path.join(themes, 'preview-fade', 'assets', 'scss', 'theme')
  fs.mkdirSync(scss, { recursive: true })
  fs.writeFileSync(path.join(scss, '_variables.scss'), `$transition-fade: opacity ${CUSTOM_FADE_MS / 1000}s linear;\n`)
  const shell = process.platform === 'win32'
  const config = spawnSync('hugo', ['config', '-s', 'exampleSite', '--format', 'json'], { encoding: 'utf8', shell, timeout: 120000 })
  assert.equal(config.status, 0, `hugo config failed:\n${config.error || ''}${config.stderr}`)
  const imports = JSON.parse(config.stdout).module.imports.map(({ path }) => ({ path }))
  const file = path.join(tmp, 'custom-fade.json')
  fs.writeFileSync(file, JSON.stringify({ module: { imports: [{ path: 'preview-fade' }, ...imports] } }))
  return hugo('public-fade', ['--config', `hugo.toml,${file}`, '--themesDir', themes])
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
// before the deferred scripts, Bootstrap among them, have run. With holdScript,
// the request for the preview script waits until a child document has been
// answered and holdScript ms have passed, so the child can announce itself
// before the script listens. Every page records the src of each iframe whose
// load event fires in window.previewLoads.
async function openPage (cdp, base, name, width, { hold = false, height = 900, holdScript = 0, beforeScript = '', skipPreviewScript = false } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const send = (method, params) => cdp.send(method, params, sessionId)
  const requests = []
  const localRequests = []
  // Each iframe request as its view and URL, in the order they came.
  const urls = []
  const held = []
  let holding = hold
  const fulfill = (requestId, body = '<!doctype html><title>stub</title><p>stub</p>', responseCode = 200) => send('Fetch.fulfillRequest', {
    requestId,
    responseCode,
    responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
    body: Buffer.from(body).toString('base64')
  }).catch(() => {})
  // Answers a document request, with a child document under /child/.
  const answer = (requestId, url) => {
    const name = url.startsWith(`${TARGET}child/`) && url.slice(`${TARGET}child/`.length)
    const spec = name && CHILDREN[name]
    if (!spec) return fulfill(requestId)
    if (spec.hang) return
    if (spec.refuse) return send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }).catch(() => {})
    if (spec.status) return fulfill(requestId, '<!doctype html><title>Service Unavailable</title><p>unavailable</p>', spec.status)
    return fulfill(requestId, childDocument(spec)).then(() => { childAnswered = Date.now() })
  }
  let childAnswered = 0
  const scripts = []
  const off = cdp.on(async msg => {
    if (msg.sessionId !== sessionId) return
    if (msg.method === 'Network.requestWillBeSent' && msg.params.type === 'Document' && new URL(msg.params.request.url).pathname.startsWith('/preview-demo/')) localRequests.push(msg.params.request.url)
    if (msg.method !== 'Fetch.requestPaused') return
    const { requestId, frameId, resourceType } = msg.params
    if (!msg.params.request.url.startsWith(TARGET)) {
      if (skipPreviewScript) send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {}); else scripts.push(requestId)
      return
    }
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
    urls.push(`${owner} ${msg.params.request.url}`)
    answer(requestId, msg.params.request.url)
  })
  // Lets the held preview script through once a child document was answered
  // holdScript ms ago, or after ten seconds.
  const started = Date.now()
  const releaseScripts = holdScript && (async () => {
    await waitFor(() => (childAnswered && Date.now() - childAnswered > holdScript) || Date.now() - started > 10000, 'the child document', 15000)
    scripts.splice(0).forEach(requestId => send('Fetch.continueRequest', { requestId }).catch(() => {}))
    return childAnswered
  })()
  if (beforeScript) await send('Page.addScriptToEvaluateOnNewDocument', { source: `if (window === window.top) { ${beforeScript} }` })
  await send('Network.enable')
  await send('Page.enable')
  await send('DOM.enable')
  await send('Runtime.enable')
  await send('Fetch.enable', {
    patterns: [{ urlPattern: `${TARGET}*`, requestStage: 'Request' }, ...((holdScript || skipPreviewScript) ? [{ urlPattern: `${base}/js/preview*`, requestStage: 'Request' }] : [])]
  })
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `if (window === window.top) { window.previewLoads = []; document.addEventListener('load', event => {
      if (event.target.tagName === 'IFRAME') window.previewLoads.push(event.target.getAttribute('src'))
    }, true) }`
  })
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
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${base}/${name}/` })

  const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value
  return {
    requests,
    localRequests,
    urls,
    evaluate,
    state: () => evaluate(STATE),
    releaseScripts,
    resize: (w, h = height) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }),
    // Presses Enter on the focused element, as a keyboard does.
    async pressEnter () {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    },
    // Presses an arrow key on the focused element.
    async pressArrow (key) {
      const windowsVirtualKeyCode = { ArrowLeft: 37, ArrowRight: 39 }[key]
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode })
    },
    emulateMedia: features => send('Emulation.setEmulatedMedia', { features }),
    release () { holding = false; held.splice(0).forEach(requestId => fulfill(requestId)) },
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

let base, customFadeBase, deniedBase
if (!skip) {
  const start = Date.now()
  await startFramingServers()
  servers.push(await serve(buildSite()), await serve(buildCustomFadeSite()), await serve(buildDeniedSite()))
  ;[base, customFadeBase, deniedBase] = servers.map(server => `http://127.0.0.1:${server.address().port}`)
  console.log(`# built the probe sites in ${Date.now() - start} ms`)
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

// The fade and activation checks run on the probe site with Bootstrap's own
// $transition-fade and on the one that sets a longer fade. ms is the configured
// fade, where the check sets it.
const FADES = [['the default fade', base, null], [`a ${CUSTOM_FADE_MS}ms fade`, customFadeBase, CUSTOM_FADE_MS]]

for (const [fade, site] of FADES) {
  test(`with ${fade}, click at 1280px loads nothing until Enter on the poster button, then desktop only`, { skip }, async () => {
    const page = await openPage(browser.cdp, site, 'click', 1280)
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
      await waitFor(async () => !visiblePoster(await page.state()).visible, 'the poster to hide')
      assert.deepEqual(await page.evaluate(POSTERS_GONE), { opacity: ['0', '0', '0'], focusable: [false, false, false] }, 'every poster faded out and left the tab order')
      assert.deepEqual(await page.evaluate('window.previewActivations'), [true], 'one preview:activate event on the section')
      console.log(`# click @1280: requests before activation [], after [${page.requests}]`)
    } finally {
      await page.close()
    }
  })
}

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
// and samples the poster at points of the opacity fade, so the samples do not
// depend on how fast the page runs.
const FADE_SAMPLES = `(() => {
  const poster = [...document.querySelectorAll('section.preview .preview-poster')].find(el => el.offsetParent)
  poster.querySelector('.preview-activate').click()
  const style = getComputedStyle(poster)
  void style.opacity
  const transitions = poster.getAnimations().filter(animation => animation.transitionProperty)
  transitions.forEach(animation => animation.pause())
  const fade = transitions.find(animation => animation.transitionProperty === 'opacity')
  if (!fade) return { transitions: transitions.map(animation => animation.transitionProperty), now: [Number(style.opacity).toFixed(2), style.visibility] }
  const { delay, duration } = fade.effect.getComputedTiming()
  const sample = at => { transitions.forEach(animation => { animation.currentTime = at }); return [Number(style.opacity).toFixed(2), style.visibility] }
  return { duration, samples: [sample(delay + duration / 2), sample(delay + duration - 1), sample(delay + duration + 1000)] }
})()`

for (const [fade, site, ms] of FADES) {
  test(`with ${fade}, click posters stay visible until their fade ends`, { skip }, async () => {
    const page = await openPage(browser.cdp, site, 'click', 1280)
    try {
      page.width = 1280
      await page.settle([])
      const { duration, samples, transitions } = await page.evaluate(FADE_SAMPLES)
      assert.ok(duration > 0, `the poster fades its opacity (transitions: ${transitions})`)
      if (ms) assert.equal(duration, ms, 'the poster fades for the configured duration')
      const [half, last, done] = samples
      assert.ok(Number(half[0]) > 0 && Number(half[0]) < 1, `halfway through the fade the poster is partly opaque: ${half}`)
      assert.equal(half[1], 'visible', 'halfway through the fade the poster is still visible')
      assert.equal(last[1], 'visible', 'just before the fade ends the poster is still visible')
      assert.deepEqual(done, ['0.00', 'hidden'], 'after the fade the poster is hidden')
      console.log(`# click @1280 with ${fade}: fade of ${duration}ms, samples ${JSON.stringify(samples)}`)
    } finally {
      await page.close()
    }
  })

  test(`with ${fade}, click posters hide at once when reduced motion is preferred`, { skip }, async () => {
    const page = await openPage(browser.cdp, site, 'click', 1280)
    try {
      page.width = 1280
      await page.settle([])
      await page.emulateMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }])
      assert.deepEqual(await page.evaluate(FADE_SAMPLES), { transitions: [], now: ['0.00', 'hidden'] })
    } finally {
      await page.close()
    }
  })
}

// Items: the item tabs, the visible item heading, and the item tab that has focus.
const ITEMS_STATE = `(() => {
  const visible = el => el.getBoundingClientRect().height > 0 && getComputedStyle(el).opacity !== '0'
  const tabs = [...document.querySelectorAll('section.preview .preview-items [data-bs-toggle="tab"]')]
  return {
    selected: tabs.filter(el => el.getAttribute('aria-selected') === 'true').map(el => el.textContent.trim()),
    focused: tabs.includes(document.activeElement) ? document.activeElement.textContent.trim() : null,
    headings: [...document.querySelectorAll('section.preview .preview-headings > .tab-pane')].filter(visible).map(el => el.textContent.trim()),
    // The heading panes lay out as block, without the flex layout of the views.
    display: [...new Set([...document.querySelectorAll('section.preview .preview-headings > .tab-pane.active')].map(el => getComputedStyle(el).display))]
  }
})()`
// Items: the role of the element each item tab controls, the text of the label of
// the panel the selected tab controls, whether that panel is visible, and the
// title of every view iframe.
const ARIA_STATE = `(() => {
  const tabs = [...document.querySelectorAll('section.preview .preview-items [data-bs-toggle="tab"]')]
  const byId = id => id ? document.getElementById(id) : null
  const selected = tabs.find(tab => tab.getAttribute('aria-selected') === 'true')
  const panel = byId(selected.getAttribute('aria-controls'))
  const label = panel && byId(panel.getAttribute('aria-labelledby'))
  return {
    controlled: tabs.map(tab => { const el = byId(tab.getAttribute('aria-controls')); return el ? el.getAttribute('role') : null }),
    label: label ? label.textContent.trim() : null,
    panelVisible: !!panel && panel.getBoundingClientRect().height > 0,
    titles: [...document.querySelectorAll('section.preview .preview-content .preview-iframe')].map(el => el.title)
  }
})()`
// Every id that an aria-labelledby or aria-controls in the preview names, with
// the ids no element in the page carries.
const ARIA_REFS = `(() => {
  const ids = [...document.querySelectorAll('section.preview [aria-labelledby], section.preview [aria-controls]')]
    .flatMap(el => [el.getAttribute('aria-labelledby'), el.getAttribute('aria-controls')])
    .filter(Boolean).flatMap(value => value.split(/\\s+/))
  return { count: ids.length, missing: ids.filter(id => !document.getElementById(id)) }
})()`
async function assertRefs (page, label) {
  const { count, missing } = await page.evaluate(ARIA_REFS)
  assert.deepEqual(missing, [], `${label}: every aria reference names an element`)
  return count
}
const aria = (label, n = 3) => ({ controlled: ['tabpanel', 'tabpanel'], label, panelVisible: true, titles: Array(n).fill(label) })
const clickItem = (page, n) => page.evaluate(`document.querySelectorAll('section.preview .preview-items [data-bs-toggle="tab"]')[${n}].click()`)
const itemsState = async page => { await sleep(SETTLE_MS); return page.evaluate(ITEMS_STATE) }

test('items-click at 1280px: item tabs before activation swap heading and poster and load nothing, after it the shown view only', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'items-click', 1280)
  try {
    page.width = 1280
    let state = await page.settle([])
    assertView(page, state, 'desktop', [], 'before activation')
    assert.deepEqual((await page.evaluate(ITEMS_STATE)).headings, ['Heading A'])
    assert.match(visiblePoster(state).image, /^poster-desktop-light-/, 'item A shows its poster')
    await clickItem(page, 1)
    assert.deepEqual(await itemsState(page), { selected: ['View b'], focused: null, headings: ['Heading B'], display: ['block'] })
    assert.deepEqual(await page.evaluate(ARIA_STATE), aria('View b'), 'before activation the titles follow the item')
    state = await page.settle([])
    assertView(page, state, 'desktop', [], 'item B before activation')
    assert.match(visiblePoster(state).image, /^poster-mobile-light-/, 'item B shows its poster')
    await assertPosterCovers(page, 'item B poster @1280')
    await activateWithEnter(page)
    state = await page.settle(['desktop'])
    assert.deepEqual(page.urls, [`desktop ${TARGET}b`], 'activation loads the shown view with the item URL')
    await clickItem(page, 0)
    await waitFor(() => page.urls.length > 1, 'the item A request').catch(() => {})
    state = await page.settle([])
    assert.deepEqual(page.urls, [`desktop ${TARGET}b`, `desktop ${TARGET}a`], 'one request, for the shown view only')
    assert.deepEqual((await page.evaluate(ITEMS_STATE)).headings, ['Heading A'])
    assert.deepEqual(await page.evaluate(ARIA_STATE), aria('View a'), 'after activation the titles follow the item')
    await page.evaluate('document.querySelector(\'section.preview .preview-controls [data-bs-target$="-tablet"]\').click()')
    state = await page.settle(['desktop', 'tablet'])
    assert.deepEqual(page.urls, [`desktop ${TARGET}b`, `desktop ${TARGET}a`, `tablet ${TARGET}a`])
    assert.deepEqual(await page.evaluate(ARIA_STATE), aria('View a'), 'a view shown later carries the item title')
    assert.ok(await assertRefs(page, 'items-click') > 0)
    console.log(`# items-click @1280: requests [${page.urls}]`)
  } finally {
    await page.close()
  }
})

test('items at 1280px: arrow keys move between the item tabs, and each switch loads the shown view once', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'items', 1280)
  try {
    page.width = 1280
    await page.settle(['desktop'])
    assert.deepEqual(page.urls, [`desktop ${TARGET}a`])
    const history = await page.evaluate('history.length')
    assert.equal(await page.evaluate('(() => { const tab = document.querySelector(\'section.preview .preview-items .active\'); tab.focus(); return document.activeElement === tab })()'), true)
    await page.pressArrow('ArrowRight')
    assert.deepEqual(await itemsState(page), { selected: ['View b'], focused: 'View b', headings: ['Heading B'], display: ['block'] })
    await waitFor(() => page.urls.length > 1, 'the item B request').catch(() => {})
    await sleep(SETTLE_MS)
    assert.equal(await page.evaluate('history.length'), history, 'the switch adds no session history entry')
    assert.deepEqual(page.urls, [`desktop ${TARGET}a`, `desktop ${TARGET}b`])
    await page.pressArrow('ArrowLeft')
    assert.deepEqual(await itemsState(page), { selected: ['View a'], focused: 'View a', headings: ['Heading A'], display: ['block'] })
    await waitFor(() => page.urls.length > 2, 'the item A request').catch(() => {})
    await sleep(SETTLE_MS)
    assert.deepEqual(page.urls, [`desktop ${TARGET}a`, `desktop ${TARGET}b`, `desktop ${TARGET}a`])
    assert.equal(await page.evaluate('history.length'), history, 'the switches add no session history entry')
    console.log(`# items @1280 with arrow keys: requests [${page.urls}]`)
  } finally {
    await page.close()
  }
})

test('items-fallback at 1280px shows the first item heading as a plain block, with no item tabs or tab panels', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'items-fallback', 1280)
  try {
    await page.settle([])
    assert.deepEqual(await page.evaluate(ITEMS_STATE), { selected: [], focused: null, headings: [], display: [] })
    const shown = await page.evaluate(`[...document.querySelectorAll('section.preview .section-title')].filter(el => el.getBoundingClientRect().height > 0).map(el => ({ text: el.textContent.trim(), display: getComputedStyle(el.parentElement).display }))`)
    assert.deepEqual(shown.map(({ text }) => text), ['Heading A'], 'only the first item heading shows')
    assert.equal(await page.evaluate(`document.querySelectorAll('section.preview [role="tabpanel"], section.preview [role="tab"], section.preview .preview-headings').length`), 0, 'no tab semantics without item tabs')
    assert.equal(await assertRefs(page, 'items-fallback'), 0, 'no aria references at all')
    assert.deepEqual(page.urls, [])
  } finally {
    await page.close()
  }
})

test('items-plain at 1280px: every item tab controls the content panel, whose label and iframe titles follow the selection', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'items-plain', 1280)
  try {
    page.width = 1280
    await page.settle(['desktop'])
    assert.deepEqual(await page.evaluate(ARIA_STATE), aria('View a'))
    assert.equal(await page.evaluate(`(() => { const ids = [...document.querySelectorAll('section.preview .preview-items [aria-controls]')].map(el => el.getAttribute('aria-controls')); return ids.length === 2 && ids[0] === ids[1] && document.getElementById(ids[0]).classList.contains('preview-content') })()`), true, 'both tabs control the content')
    assert.equal(await page.evaluate('(() => { const tab = document.querySelector(\'section.preview .preview-items .active\'); tab.focus(); return document.activeElement === tab })()'), true)
    await page.pressArrow('ArrowRight')
    await waitFor(() => page.urls.length > 1, 'the item b request').catch(() => {})
    await sleep(SETTLE_MS)
    assert.deepEqual(await page.evaluate(ARIA_STATE), aria('View b'))
    assert.deepEqual(page.urls, [`desktop ${TARGET}a`, `desktop ${TARGET}b`])
    await page.evaluate('document.querySelector(\'section.preview .preview-controls [data-bs-target$="-mobile"]\').click()')
    const state = await page.settle(['desktop', 'mobile'])
    assertView(page, state, 'mobile', ['desktop', 'desktop', 'mobile'], 'mobile after item b')
    assert.deepEqual(page.urls, [`desktop ${TARGET}a`, `desktop ${TARGET}b`, `mobile ${TARGET}b`])
    assert.deepEqual(await page.evaluate(ARIA_STATE), aria('View b'))
    assert.ok(await assertRefs(page, 'items-plain') > 0)
    console.log(`# items-plain @1280: requests [${page.urls}]`)
  } finally {
    await page.close()
  }
})

// Readiness and runtime fallback. READY_STATE reports the shown pane: its
// data-preview-state and aria-busy, whether its iframe is inert and shows,
// whether its poster shows, the text of its waiting status and of its alert
// when they show, with the alert link, and the element that has focus.
const READY_STATE = `(() => {
  const shows = el => {
    if (!el) return false
    const style = getComputedStyle(el)
    const box = el.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && box.width > 0 && box.height > 0
  }
  const pane = [...document.querySelectorAll('section.preview .preview-content > .tab-pane')].find(el => el.offsetParent)
  const iframe = pane.querySelector('iframe')
  const status = pane.querySelector('.preview-waiting')
  const alert = pane.querySelector('.preview-unavailable')
  const link = alert && alert.querySelector('a')
  return {
    device: pane.id.split('-').pop(),
    state: pane.dataset.previewState || null,
    busy: pane.getAttribute('aria-busy'),
    inert: iframe.inert,
    iframe: shows(iframe),
    poster: shows(pane.querySelector('.preview-poster')),
    hasPoster: !!pane.querySelector('.preview-poster'),
    waiting: shows(status) ? status.textContent.trim() : null,
    // The status sits in the middle of the poster, less than half its height.
    statusFits: !status || status.getBoundingClientRect().height < pane.querySelector('.preview-poster').getBoundingClientRect().height / 2,
    button: shows(pane.querySelector('.preview-activate')),
    alert: shows(alert) ? { text: alert.textContent.replace(/\\s+/g, ' ').trim(), role: alert.querySelector('[role]').getAttribute('role'), href: link.href, name: link.textContent.trim() } : null,
    focus: document.activeElement === document.body ? 'body' : document.activeElement.className || document.activeElement.tagName
  }
})()`
// Reports whether the iframe of the shown pane takes focus, and gives focus back.
const IFRAME_FOCUS = `(() => {
  const before = document.activeElement
  const iframe = [...document.querySelectorAll('section.preview .preview-content > .tab-pane')].find(el => el.offsetParent).querySelector('iframe')
  iframe.focus()
  const focused = document.activeElement === iframe
  if (focused) { iframe.blur(); if (before && before.focus) before.focus() }
  return focused
})()`
const readyState = page => page.evaluate(READY_STATE)
// Waits until the state of the shown pane passes check, and returns it. The
// state is undefined until the page has its preview.
const until = (page, check, what, timeout = 8000) => waitFor(async () => {
  const value = await readyState(page).catch(() => undefined)
  return value && check(value) && value
}, what, timeout)

const WAITING = 'Loading the live preview'
const UNAVAILABLE = 'The live preview is not available right now. Open in new tab'

// Picks the fields of a state that want names.
const pick = (state, want) => Object.fromEntries(Object.keys(want).map(key => [key, state[key]]))

// Waits up to a second, for the fades of the poster and the iframe, until the
// state of the shown pane matches want, and asserts that it does.
async function settleTo (page, want, label) {
  const state = await until(page, value => util.isDeepStrictEqual(pick(value, want), want), label, 1000).catch(() => readyState(page))
  assert.deepEqual(pick(state, want), want, label)
  return state
}

// The shown view waits behind its poster: busy, with its status, and an iframe
// that neither shows nor takes focus.
async function assertWaiting (page, label) {
  await settleTo(page, { state: 'waiting', busy: 'true', inert: true, iframe: false, poster: true, waiting: WAITING, statusFits: true, button: false, alert: null }, `${label}: waiting`)
  assert.equal(await page.evaluate(IFRAME_FOCUS), false, `${label}: the waiting iframe cannot take focus`)
}

// The shown view failed: its poster, when it has one, and alert show, the alert
// links to href, and the iframe neither shows nor takes focus.
async function assertFailed (page, href, label) {
  const { hasPoster } = await until(page, value => value.state === 'failed', `${label}: the failure`)
  const state = await settleTo(page, { busy: null, inert: true, iframe: false, poster: hasPoster, waiting: null, alert: { text: UNAVAILABLE, role: 'alert', href, name: 'Open in new tab' } }, `${label}: failed`)
  assert.equal(await page.evaluate(IFRAME_FOCUS), false, `${label}: the failed iframe cannot take focus`)
  return state
}

// The shown view is ready: the iframe shows and takes focus, the poster, status
// and alert are gone.
async function assertReady (page, label) {
  const state = await until(page, value => value.state === 'ready' && value.iframe && !value.poster, `${label}: readiness`)
  assert.deepEqual({ busy: state.busy, inert: state.inert, waiting: state.waiting, alert: state.alert }, { busy: null, inert: false, waiting: null, alert: null }, `${label}: ready`)
  assert.equal(await page.evaluate(IFRAME_FOCUS), true, `${label}: the ready iframe takes focus`)
  return state
}

const iframeLoads = page => page.evaluate('window.previewLoads')

test('ready-slow: the view waits behind its poster until its frame posts the ready message, without moving focus', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'ready-slow', 1280)
  try {
    await waitFor(() => page.requests.length > 0, 'the frame request')
    await until(page, value => value.state === 'waiting', 'the wait')
    await assertWaiting(page, 'ready-slow')
    const tab = 'document.querySelector(\'section.preview .preview-controls .btn.active\')'
    assert.equal(await page.evaluate(`(() => { ${tab}.focus(); return document.activeElement === ${tab} })()`), true)
    const state = await assertReady(page, 'ready-slow')
    assert.equal(state.focus.includes('btn'), true, `focus stays on the device button, not ${state.focus}`)
    assert.deepEqual(page.urls, [`desktop ${child('slow')}`])
  } finally {
    await page.close()
  }
})

for (const [name, what] of [['silent', 'a frame that loads and never posts'], ['503', 'a 503 answer'], ['refused', 'a refused connection'], ['wrong', 'a frame that posts and answers other data only']]) {
  test(`ready-${name}: ${what} fails after the load timeout with a friendly alert that opens the URL`, { skip }, async () => {
    const page = await openPage(browser.cdp, base, `ready-${name}`, 1280)
    try {
      await until(page, value => value.state === 'waiting', 'the wait')
      const started = Date.now()
      if (name === 'silent' || name === 'wrong') {
        await waitFor(async () => (await iframeLoads(page)).length > 0, 'the iframe load')
        await sleep(300)
        await assertWaiting(page, `${name} after its load`)
      }
      const state = await assertFailed(page, child(name), `ready-${name}`)
      assert.ok(Date.now() - started > 1000, 'it fails at the deadline, not before')
      assert.doesNotMatch(state.alert.text, /example\.org|child/, 'the alert names no URL')
      assert.equal(state.focus, 'body', 'focus does not move')
    } finally {
      await page.close()
    }
  })
}

test('ready-silent: messages from the page itself and from a sibling frame change nothing', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'ready-silent', 1280)
  try {
    await until(page, value => value.state === 'waiting', 'the wait')
    await page.evaluate(`(() => {
      window.postMessage('${TOKEN}', '*')
      const sibling = document.createElement('iframe')
      sibling.srcdoc = '<script>parent.postMessage(${JSON.stringify(TOKEN)}, "*")<\\/script>'
      document.querySelector('section.preview').append(sibling)
    })()`)
    await sleep(500)
    await assertWaiting(page, 'after the sibling messages')
    await assertFailed(page, child('silent'), 'ready-silent')
  } finally {
    await page.close()
  }
})

test('ready-late: an acknowledgement after the deadline recovers the failed view without moving focus', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'ready-late', 1280)
  try {
    await assertFailed(page, child('late'), 'ready-late')
    const state = await assertReady(page, 'ready-late')
    assert.equal(state.focus, 'body')
  } finally {
    await page.close()
  }
})

test('ready-reply: a frame that only answers requests becomes ready, as the script asks on load', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'ready-reply', 1280)
  try {
    await assertReady(page, 'ready-reply')
  } finally {
    await page.close()
  }
})

for (const [name, ready] of [['ok', true], ['announce', false]]) {
  test(`ready-${name}: when the frame announced itself before the script ran, ${ready ? 'its answer to the request makes the view ready' : 'the view without an answer fails'}`, { skip }, async () => {
    const page = await openPage(browser.cdp, base, `ready-${name}`, 1280, { holdScript: 1000 })
    try {
      assert.ok(await page.releaseScripts, 'the child document was answered before the script')
      if (ready) await assertReady(page, `held ready-${name}`); else await assertFailed(page, child(name), `held ready-${name}`)
    } finally {
      await page.close()
    }
  })
}

test('ready-phone: the acknowledgement of one device view does not reveal another, which waits on its own deadline', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'ready-phone', 1280)
  try {
    await until(page, value => value.state === 'waiting', 'the desktop wait')
    await page.evaluate('document.querySelector(\'section.preview .preview-controls [data-bs-target$="-mobile"]\').click()')
    await until(page, value => value.device === 'mobile' && value.state === 'waiting', 'the mobile wait')
    await assertWaiting(page, 'mobile')
    await waitFor(() => page.evaluate('document.querySelector(\'section.preview [id$="-desktop"]\').dataset.previewState === \'ready\''), 'the hidden desktop view to become ready')
    await assertWaiting(page, 'mobile after the desktop acknowledgement')
    await assertFailed(page, child('phone'), 'mobile')
    await page.evaluate('document.querySelector(\'section.preview .preview-controls [data-bs-target$="-desktop"]\').click()')
    await assertReady(page, 'desktop shown again')
    assert.deepEqual(page.urls, [`desktop ${child('phone')}`, `mobile ${child('phone')}`])
  } finally {
    await page.close()
  }
})

// Dispatches a message event with the ready message on the page, from the
// window of the shown iframe, or from the window stored in window.previewOld.
const fakeAck = from => `window.dispatchEvent(new MessageEvent('message', { data: '${TOKEN}', source: ${from === 'old' ? 'window.previewOld' : '[...document.querySelectorAll(\'section.preview .preview-content > .tab-pane\')].find(el => el.offsetParent).querySelector(\'iframe\').contentWindow'} }))`

test('ready-items-click: activation and item switches wait for the current frame, ignore the replaced one, and link the shown item', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'ready-items-click', 1280)
  try {
    await page.settle([])
    let state = await readyState(page)
    assert.deepEqual({ state: state.state, poster: state.poster, waiting: state.waiting, alert: state.alert }, { state: null, poster: true, waiting: null, alert: null }, 'before activation')
    assert.deepEqual(page.urls, [])
    await activateWithEnter(page)
    await until(page, value => value.state === 'waiting', 'the wait after activation')
    await assertWaiting(page, 'item a after activation')
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector(\'section.preview .preview-content > .tab-pane.active .preview-activate\')).display'), 'none', 'the poster button is gone')
    await assertReady(page, 'item a')
    await page.evaluate('window.previewOld = [...document.querySelectorAll(\'section.preview .preview-content > .tab-pane\')].find(el => el.offsetParent).querySelector(\'iframe\').contentWindow')
    await clickItem(page, 1)
    await until(page, value => value.state === 'waiting', 'the wait for item b')
    await assertWaiting(page, 'item b')
    assert.match(visiblePoster(await page.state()).image, /^poster-mobile-light-/, 'item b shows its poster')
    assert.equal(await page.evaluate('new MessageEvent(\'message\', { source: window.previewOld }).source === window.previewOld'), true, 'the replaced window can be a message source')
    await page.evaluate(fakeAck('old'))
    await assertWaiting(page, 'item b after a message from the replaced frame')
    const failed = await assertFailed(page, `${TARGET}b-open`, 'item b')
    assert.equal(failed.focus.includes('nav-link'), false)
    await page.evaluate(fakeAck('current'))
    await assertReady(page, 'item b after a message from its own frame')
    await clickItem(page, 0)
    await until(page, value => value.state === 'waiting', 'the wait for item a again')
    await assertReady(page, 'item a again')
    assert.deepEqual(page.urls, [`desktop ${child('slow')}`, `desktop ${child('silent')}`, `desktop ${child('slow')}`])
    const open = await page.evaluate('[...document.querySelectorAll(\'section.preview .preview-open\')].map(el => [el.href, el.textContent.trim(), el.getBoundingClientRect().top > document.querySelector(\'section.preview .preview-content\').getBoundingClientRect().bottom])')
    assert.deepEqual(open, [[`${TARGET}a-open`, 'Open in new tab', true]], 'the open link under the frame follows the item')
    const buttons = await page.evaluate('[...document.querySelectorAll(\'section.preview .btn.btn-primary:not(.preview-activate)\')].filter(el => el.offsetParent).map(el => [el.textContent.trim(), el.getBoundingClientRect().top > document.querySelector(\'section.preview .preview-content\').getBoundingClientRect().bottom])')
    assert.deepEqual(buttons, [['Start', true]], 'the visible link buttons render under the frame')
  } finally {
    await page.close()
  }
})

for (const mode of ['light', 'dark']) {
  test(`ready-silent in ${mode} mode: the waiting status and the alert read against their background`, { skip }, async () => {
    const page = await openPage(browser.cdp, base, 'ready-silent', 1280)
    try {
      const colors = selector => page.evaluate(`(() => { const el = document.querySelector('section.preview .preview-content > .tab-pane.active ${selector}'); const s = getComputedStyle(el); return [s.color, s.backgroundColor] })()`)
      await until(page, value => value.state === 'waiting', 'the wait')
      await page.evaluate(`document.documentElement.setAttribute('data-bs-theme', '${mode}')`)
      assert.equal(await page.evaluate('getComputedStyle(document.body).backgroundColor === \'rgb(255, 255, 255)\''), mode === 'light', `${mode}: the page takes the color mode`)
      const waiting = await colors('.preview-waiting')
      assert.notEqual(waiting[0], waiting[1], `${mode}: status text ${waiting[0]} on ${waiting[1]}`)
      assert.notEqual(waiting[1], 'rgba(0, 0, 0, 0)', `${mode}: the status has a background`)
      await assertFailed(page, child('silent'), mode)
      const alert = await colors('.preview-unavailable .alert')
      assert.notEqual(alert[0], alert[1], `${mode}: alert text ${alert[0]} on ${alert[1]}`)
      console.log(`# ready-silent ${mode}: status ${waiting}, alert ${alert}`)
    } finally {
      await page.close()
    }
  })
}

// Makes the shown view ready with a message from its own frame, pauses the
// transitions that starts on its iframe and poster, and samples them halfway
// through the iframe fade and after it.
const READY_FADE = `(() => {
  const pane = [...document.querySelectorAll('section.preview .preview-content > .tab-pane')].find(el => el.offsetParent)
  const iframe = pane.querySelector('iframe')
  const poster = pane.querySelector('.preview-poster')
  ${fakeAck('current')}
  const styles = [getComputedStyle(iframe), getComputedStyle(poster)]
  styles.forEach(style => void style.opacity)
  const transitions = [...iframe.getAnimations(), ...poster.getAnimations()].filter(animation => animation.transitionProperty)
  transitions.forEach(animation => animation.pause())
  const now = () => [Number(styles[0].opacity).toFixed(2), Number(styles[1].opacity).toFixed(2), styles[1].visibility]
  const fade = iframe.getAnimations().find(animation => animation.transitionProperty === 'opacity')
  if (!fade) return { transitions: transitions.map(animation => animation.transitionProperty), now: now() }
  const { delay, duration } = fade.effect.getComputedTiming()
  const sample = at => { transitions.forEach(animation => { animation.currentTime = at }); return now() }
  return { duration, samples: [sample(delay + duration / 2), sample(delay + duration + 1000)] }
})()`

for (const [fade, site, ms] of FADES) {
  test(`with ${fade}, a ready view fades its iframe in and its poster out`, { skip }, async () => {
    const page = await openPage(browser.cdp, site, 'ready-silent', 1280)
    try {
      await until(page, value => value.state === 'waiting', 'the wait')
      const { duration, samples, transitions } = await page.evaluate(READY_FADE)
      assert.ok(duration > 0, `the iframe fades (transitions: ${transitions})`)
      if (ms) assert.equal(duration, ms, 'the iframe fades for the configured duration')
      const [half, done] = samples
      assert.ok(Number(half[0]) > 0 && Number(half[0]) < 1, `halfway the iframe is partly opaque: ${half}`)
      assert.ok(Number(half[1]) > 0 && Number(half[1]) < 1 && half[2] === 'visible', `halfway the poster is partly opaque: ${half}`)
      assert.deepEqual(done, ['1.00', '0.00', 'hidden'], 'after the fade the iframe shows and the poster is hidden')
      console.log(`# ready-silent with ${fade}: fade of ${duration}ms, samples ${JSON.stringify(samples)}`)
    } finally {
      await page.close()
    }
  })

  test(`with ${fade}, a ready view shows at once when reduced motion is preferred`, { skip }, async () => {
    const page = await openPage(browser.cdp, site, 'ready-silent', 1280)
    try {
      await page.emulateMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }])
      await until(page, value => value.state === 'waiting', 'the wait')
      assert.deepEqual(await page.evaluate(READY_FADE), { transitions: [], now: ['1.00', '0.00', 'hidden'] })
    } finally {
      await page.close()
    }
  })
}

test('ready-silent below the fold: the deadline starts when the frame comes into view', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'ready-silent', 1280, { height: 60 })
  try {
    await until(page, value => value.state === 'waiting', 'the wait')
    assert.equal(await page.evaluate('document.querySelector(\'section.preview iframe[src]\').getBoundingClientRect().top > innerHeight'), true, 'the frame starts out of view')
    await sleep(3000)
    assert.equal((await readyState(page)).state, 'waiting', 'no deadline out of view')
    await page.resize(1280, 900)
    await assertFailed(page, child('silent'), 'in view')
  } finally {
    await page.close()
  }
})

// Without a ready message, a view the script loads fails when its iframe does
// not load in time. Browsers fire load for error pages too, so an error answer
// or a refused connection counts as loaded.
test('legacy-hang: the view in the markup gets no deadline, and a view the script loads fails when its frame never answers', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'legacy-hang', 1280)
  try {
    await sleep(2000)
    let state = await readyState(page)
    assert.deepEqual({ state: state.state, iframe: state.iframe, alert: state.alert }, { state: null, iframe: true, alert: null }, 'the markup view')
    await page.evaluate('document.querySelector(\'section.preview .preview-controls [data-bs-target$="-mobile"]\').click()')
    state = await until(page, value => value.device === 'mobile' && value.state === 'waiting', 'the mobile wait')
    assert.deepEqual({ busy: state.busy, inert: state.inert, waiting: state.waiting }, { busy: null, inert: false, waiting: null }, 'a loading view is neither busy nor inert')
    await assertFailed(page, child('hang'), 'legacy-hang mobile')
  } finally {
    await page.close()
  }
})

test('legacy-items: the copy that replaces a loaded iframe on an item switch fails when its frame never answers', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'legacy-items', 1280)
  try {
    await page.settle(['desktop'])
    await clickItem(page, 1)
    let state = await until(page, value => value.state === 'waiting', 'the wait for item b')
    await sleep(300)
    state = await readyState(page)
    assert.equal(state.state, 'waiting', 'the inserted copy does not count as loaded')
    await assertFailed(page, `${TARGET}b-open`, 'legacy-items b')
    await clickItem(page, 0)
    await until(page, value => value.state === 'ready', 'item a loads')
    assert.deepEqual(page.urls, [`desktop ${TARGET}a`, `desktop ${child('hang')}`, `desktop ${TARGET}a`])
  } finally {
    await page.close()
  }
})

test('legacy-click-hang: a view that fails after activation shows its poster again, without its button', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'legacy-click-hang', 1280)
  try {
    await page.settle([])
    await activateWithEnter(page)
    await until(page, value => value.state === 'waiting' && !value.poster, 'the poster to fade on activation')
    const state = await assertFailed(page, child('hang'), 'legacy-click-hang')
    assert.deepEqual({ poster: state.poster, button: state.button }, { poster: true, button: false })
  } finally {
    await page.close()
  }
})

for (const name of ['silent', '503', 'refused']) {
  test(`legacy-${name}: a view the script loads is ready on its load event`, { skip }, async () => {
    const page = await openPage(browser.cdp, base, `legacy-${name}`, 1280)
    try {
      await page.settle(['desktop'])
      await page.evaluate('document.querySelector(\'section.preview .preview-controls [data-bs-target$="-mobile"]\').click()')
      await until(page, value => value.device === 'mobile' && value.state === 'ready', 'the mobile load')
      await sleep(1500)
      const state = await readyState(page)
      assert.deepEqual({ state: state.state, iframe: state.iframe, alert: state.alert, inert: state.inert }, { state: 'ready', iframe: true, alert: null, inert: false })
    } finally {
      await page.close()
    }
  })
}

// On a phone, the frame leaves part of the viewport to scroll the page with:
// the content box is at most 80% of the viewport height and the page scrolls
// past it above and below. At 480px the 400px minimum height would pass that.
const PHONE_BOXES = `(() => {
  const content = document.querySelector('section.preview .preview-content')
  const iframe = [...content.querySelectorAll('iframe')].find(el => el.offsetParent)
  content.scrollIntoView({ block: 'center', behavior: 'instant' })
  const box = content.getBoundingClientRect()
  const frame = iframe.getBoundingClientRect()
  return {
    viewport: [innerWidth, innerHeight],
    content: [box.width, box.height].map(Math.round),
    frame: [frame.width, frame.height].map(Math.round),
    frameInside: frame.left >= box.left - 1 && frame.right <= box.right + 1 && frame.top >= box.top - 1 && frame.bottom <= box.bottom + 1,
    scrollWidth: document.scrollingElement.scrollWidth,
    above: Math.round(box.top),
    below: Math.round(innerHeight - box.bottom),
    scrolls: document.scrollingElement.scrollHeight > innerHeight
  }
})()`

for (const height of [844, 600, 480]) {
  test(`default at 390x${height}px: the mobile frame fits and leaves page scroll above and below it`, { skip }, async () => {
    const page = await openPage(browser.cdp, base, 'default', 390, { height })
    try {
      page.width = 390
      await page.settle(['mobile'])
      const boxes = await page.evaluate(PHONE_BOXES)
      assert.deepEqual(boxes.viewport, [390, height])
      assert.ok(boxes.content[0] > 0 && boxes.content[1] > 0 && boxes.frame[0] > 0 && boxes.frame[1] > 0, `nonzero boxes: ${JSON.stringify(boxes)}`)
      assert.ok(boxes.frameInside, 'the scaled frame fits its content box')
      assert.ok(boxes.scrollWidth <= 390, `no horizontal scroll: ${boxes.scrollWidth}`)
      assert.ok(boxes.content[1] <= Math.ceil(height * 0.8), `the content is at most 80% of the viewport height: ${boxes.content[1]} of ${height}`)
      assert.ok(boxes.scrolls && boxes.above > 0 && boxes.below > 0, `page scroll reaches past the frame: ${JSON.stringify(boxes)}`)
      console.log(`# default @390x${height}: ${JSON.stringify(boxes)}`)
    } finally {
      await page.close()
    }
  })
}

// An iframe without src holds a same-origin about:blank window. A script that
// runs in it and posts the ready message to this page changes nothing before
// a navigation: before click activation, and in a view that has not loaded.
const POST_FROM = device => `(() => {
  const iframe = document.querySelector('section.preview .preview-content > [id$="-${device}"] iframe')
  if (iframe.hasAttribute('src')) return 'has src'
  iframe.contentWindow.eval("parent.postMessage('${TOKEN}', '*')")
  return iframe.contentWindow.location.href
})()`
const paneOf = device => `(() => { const pane = document.querySelector('section.preview .preview-content > [id$="-${device}"]'); return { state: pane.dataset.previewState || null, busy: pane.getAttribute('aria-busy'), inert: pane.querySelector('iframe').inert } })()`

test('ready-items-click: the ready message from an iframe window without src changes nothing before activation', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'ready-items-click', 1280)
  try {
    await page.settle([])
    assert.equal(await page.evaluate(POST_FROM('desktop')), 'about:blank')
    await sleep(300)
    const state = await readyState(page)
    assert.deepEqual({ state: state.state, busy: state.busy, inert: state.inert, poster: state.poster, button: state.button, waiting: state.waiting },
      { state: null, busy: null, inert: true, poster: true, button: true, waiting: null })
    assert.deepEqual(page.urls, [])
    await activateWithEnter(page)
    await assertWaiting(page, 'after activation')
    await assertReady(page, 'after activation')
  } finally {
    await page.close()
  }
})

test('ready-silent: the ready message from the window of a view that has not loaded changes nothing', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'ready-silent', 1280)
  try {
    await until(page, value => value.state === 'waiting', 'the desktop wait')
    assert.equal(await page.evaluate(POST_FROM('mobile')), 'about:blank')
    await sleep(300)
    assert.deepEqual(await page.evaluate(paneOf('mobile')), { state: null, busy: null, inert: true })
    await page.evaluate('document.querySelector(\'section.preview .preview-controls [data-bs-target$="-mobile"]\').click()')
    await assertWaiting(page, 'mobile after it loads')
  } finally {
    await page.close()
  }
})

// A site without a navbar or device controls, and with a tall section, makes the
// height of the content reach past 80svh on a phone in portrait, which the
// stylesheet caps. Hinode declares these variables on .main.
const NO_CHROME = `(() => {
  const style = document.createElement('style')
  style.textContent = '.main { --navbar-height: 0px; --max-section-height: 2000px } section.preview { --preview-controls-height: 0px }'
  document.head.append(style)
  window.dispatchEvent(new Event('resize'))
})()`

test('nocontrols at 600x1080px without a navbar: the mobile frame stays within 80% of the viewport height', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'nocontrols', 600, { height: 1080 })
  try {
    page.width = 600
    await page.settle(['mobile'])
    await page.evaluate(NO_CHROME)
    await sleep(200)
    const boxes = await page.evaluate(PHONE_BOXES)
    const vars = await page.evaluate('(() => { const s = getComputedStyle(document.querySelector(\'section.preview\')); return [s.getPropertyValue(\'--navbar-height\'), s.getPropertyValue(\'--preview-controls-height\'), s.getPropertyValue(\'--max-section-height\')].map(v => v.trim()) })()')
    assert.deepEqual(vars, ['0px', '0px', '2000px'], 'the layout has no navbar or controls and a tall section')
    assert.ok(boxes.content[1] > 0 && boxes.frame[0] > 0 && boxes.frame[1] > 0 && boxes.frameInside, `nonzero boxes: ${JSON.stringify(boxes)}`)
    assert.ok(boxes.scrollWidth <= 600, `no horizontal scroll: ${boxes.scrollWidth}`)
    assert.ok(boxes.content[1] <= Math.ceil(1080 * 0.8), `the content is at most 80% of the viewport height: ${boxes.content[1]} of 1080`)
    assert.ok(boxes.frame[1] <= Math.ceil(1080 * 0.8), `the frame is at most 80% of the viewport height: ${boxes.frame[1]} of 1080`)
    assert.ok(boxes.scrolls && boxes.above > 0 && boxes.below > 0, `page scroll reaches past the frame: ${JSON.stringify(boxes)}`)
    console.log(`# nocontrols @600x1080 without navbar: ${JSON.stringify(boxes)}`)
  } finally {
    await page.close()
  }
})

// The readiness demo page of the exampleSite frames its own demo pages: Ready
// posts example:ready and answers a request, Silent never posts it.
test('components/preview-ready: the Ready tab shows its view, the Silent tab fails with a link to its page', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'components/preview-ready', 1280)
  try {
    await page.settle([])
    assert.equal(await page.evaluate('document.querySelectorAll(\'section.preview iframe[src]\').length'), 0, 'nothing loads before the button')
    assert.equal(await page.evaluate('[...document.querySelectorAll(\'section.preview .preview-error\')].some(el => el.offsetParent)'), false, 'the site frame-src allows the demo pages')
    await activateWithEnter(page)
    await assertWaiting(page, 'Ready')
    await assertReady(page, 'Ready')
    // The Ready page answers a request with the ready message, and nothing else.
    const replies = await page.evaluate(`new Promise(resolve => {
      const win = [...document.querySelectorAll('section.preview .preview-content > .tab-pane')].find(el => el.offsetParent).querySelector('iframe').contentWindow
      const got = []
      window.addEventListener('message', event => { if (event.source === win) got.push(event.data) })
      win.postMessage('other', '*')
      win.postMessage('example:ready', '*')
      setTimeout(() => resolve(got), 500)
    })`)
    assert.deepEqual(replies, ['example:ready'], 'one reply, to the matching request')
    // Reloaded, it announces itself, then answers the request the preview sends
    // on load; a message it posts to itself gets no answer.
    const reloaded = await page.evaluate(`new Promise(resolve => {
      const win = [...document.querySelectorAll('section.preview .preview-content > .tab-pane')].find(el => el.offsetParent).querySelector('iframe').contentWindow
      const got = []
      window.addEventListener('message', event => { if (event.source === win) got.push(event.data) })
      win.location.reload()
      setTimeout(() => {
        win.eval("window.seen = 0; addEventListener('message', () => { window.seen++ }); postMessage('example:ready', '*')")
        setTimeout(() => resolve({ got, seen: win.seen }), 500)
      }, 1000)
    })`)
    assert.deepEqual(reloaded, { got: ['example:ready', 'example:ready'], seen: 1 })
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll(\'section.preview .preview-open\')].map(el => el.href)'), [`${base}/preview-demo/ready/`])
    await clickItem(page, 1)
    await assertWaiting(page, 'Silent')
    await sleep(3000)
    await assertWaiting(page, 'Silent before its deadline')
    await assertFailed(page, `${base}/preview-demo/silent/`, 'Silent')
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll(\'section.preview .preview-open\')].map(el => el.href)'), [`${base}/preview-demo/silent/`])
    await clickItem(page, 0)
    await assertReady(page, 'Ready again')
  } finally {
    await page.close()
  }
})

// A block that shows its build-time fallback on a phone shows all of it: its
// portrait image, and its alert with the link, which the page scroll reaches.
// Nothing in the content box is cut off. Only the page scrolls, as a touch on
// the page does; scrollIntoView would also scroll the overflow: hidden content
// box, which no touch can.
const FALLBACK_BOXES = `(async () => {
  const content = document.querySelector('section.preview .preview-content')
  const pane = content.querySelector(':scope > .tab-pane.active')
  const image = [...pane.querySelectorAll('.preview-fallback-image')].find(el => el.getBoundingClientRect().height > 0)
  await image.decode().catch(() => {})
  const alert = pane.querySelector('.preview-error .alert')
  const link = alert.querySelector('a')
  const linkTop = link.getBoundingClientRect().top + scrollY
  scrollTo({ top: linkTop - innerHeight / 2, behavior: 'instant' })
  const box = el => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) } }
  const linkBox = link.getBoundingClientRect()
  const hit = document.elementFromPoint(linkBox.left + linkBox.width / 2, linkBox.top + linkBox.height / 2)
  const inside = (el, outer) => el.top >= outer.top - 1 && el.bottom <= outer.bottom + 1
  const c = box(content)
  return {
    content: c.height,
    clipped: content.scrollHeight > content.clientHeight + 1,
    image: box(image).height,
    imageInside: inside(box(image), c),
    alert: box(alert).height,
    alertInside: inside(box(alert), c),
    linkReached: link === hit || link.contains(hit),
    contentScrollTop: content.scrollTop,
    scrollWidth: document.scrollingElement.scrollWidth
  }
})()`

for (const height of [600, 844]) {
  test(`fallback-portrait at 390x${height}px: the fallback image, alert and link all show`, { skip }, async () => {
    const page = await openPage(browser.cdp, base, 'fallback-portrait', 390, { height })
    try {
      page.width = 390
      await page.settle([])
      const boxes = await page.evaluate(FALLBACK_BOXES)
      assert.ok(boxes.content > 0 && boxes.image > 0 && boxes.alert > 0, `nonzero boxes: ${JSON.stringify(boxes)}`)
      assert.ok(boxes.image > height * 0.8, `the portrait image is taller than 80% of the viewport: ${JSON.stringify(boxes)}`)
      assert.deepEqual({ clipped: boxes.clipped, imageInside: boxes.imageInside, alertInside: boxes.alertInside, linkReached: boxes.linkReached, contentScrollTop: boxes.contentScrollTop },
        { clipped: false, imageInside: true, alertInside: true, linkReached: true, contentScrollTop: 0 }, `nothing is cut off: ${JSON.stringify(boxes)}`)
      assert.ok(boxes.scrollWidth <= 390, `no horizontal scroll: ${boxes.scrollWidth}`)
      assert.deepEqual(page.urls, [], 'the fallback loads no view')
      console.log(`# fallback-portrait @390x${height}: ${JSON.stringify(boxes)}`)
    } finally {
      await page.close()
    }
  })
}

// A block that shows its build-time fallback has no live view to wait for: whatever its
// ready message, its pane takes no readiness state and is not busy, its fallback alert
// and link show, and its hidden frame makes no request. A ready message from the window
// of that hidden frame changes nothing either.
const FALLBACK_READINESS = `(() => {
  const content = document.querySelector('section.preview .preview-content')
  const pane = content.querySelector(':scope > .tab-pane.active')
  const alert = pane.querySelector('.preview-error .alert')
  const link = alert.querySelector('a')
  const box = el => { const r = el.getBoundingClientRect(); return [r.width, r.height].map(Math.round) }
  const r = link.getBoundingClientRect()
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  return {
    readyMessage: content.dataset.readyMessage || null,
    states: [...content.querySelectorAll(':scope > .tab-pane')].map(el => el.dataset.previewState || null),
    busy: [...document.querySelectorAll('[aria-busy]')].map(el => el.getAttribute('aria-busy')),
    alertInBusy: !!alert.closest('[aria-busy="true"]'),
    alert: { role: alert.getAttribute('role'), box: box(alert), text: alert.textContent.replace(/\\s+/g, ' ').trim() },
    link: { box: box(link), href: link.href, reached: link === hit || link.contains(hit) },
    frame: (() => { const iframe = pane.querySelector('iframe'); return { src: iframe.getAttribute('src'), display: getComputedStyle(iframe).display } })()
  }
})()`
const POST_FROM_HIDDEN = `(() => {
  const iframe = document.querySelector('section.preview .preview-content > .tab-pane.active iframe')
  iframe.contentWindow.eval("parent.postMessage('${TOKEN}', '*')")
  return iframe.contentWindow.location.href
})()`

async function assertFallbackStartsNoReadiness (page, url, label) {
  const want = state => {
    assert.equal(state.readyMessage, TOKEN, `${label}: the block has a ready message`)
    assert.deepEqual(state.states, [null, null], `${label}: no pane takes a readiness state`)
    assert.deepEqual(state.busy, [], `${label}: nothing is busy`)
    assert.equal(state.alertInBusy, false, `${label}: the alert is in no busy region`)
    assert.equal(state.alert.role, 'alert')
    assert.ok(state.alert.box[0] > 0 && state.alert.box[1] > 0 && state.alert.text.includes(url), `${label}: the fallback alert shows, naming ${url}: ${JSON.stringify(state.alert)}`)
    assert.ok(state.link.box[0] > 0 && state.link.box[1] > 0 && state.link.reached, `${label}: its link shows and is reached: ${JSON.stringify(state.link)}`)
    assert.equal(state.link.href, url)
    assert.deepEqual(state.frame, { src: url, display: 'none' }, `${label}: the hidden frame keeps its src, as before readiness`)
  }
  const first = await page.evaluate(FALLBACK_READINESS)
  want(first)
  await sleep(1500)
  want(await page.evaluate(FALLBACK_READINESS))
  assert.equal(await page.evaluate(POST_FROM_HIDDEN), 'about:blank', `${label}: the hidden frame never navigated`)
  await sleep(300)
  want(await page.evaluate(FALLBACK_READINESS))
  console.log(`# ${label}: ${JSON.stringify(first)}`)
}

test('fallback-ready: a block that shows its fallback by show_fallback starts no readiness, even with a ready message', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'fallback-ready', 1280)
  try {
    await page.settle([])
    await assertFallbackStartsNoReadiness(page, child('ok'), 'fallback-ready')
    assert.deepEqual(page.urls, [], 'no frame document request')
  } finally {
    await page.close()
  }
})

test('denied-ready: a block whose target the build found refusing framing starts no readiness, while allowed-ready waits and is ready', { skip }, async () => {
  assert.match(buildLogs['public-denied'], new RegExp(`URL '${framing.deny}/x' cannot be embedded because it sets 'X-Frame-Options: DENY'`))
  assert.doesNotMatch(buildLogs['public-denied'], new RegExp(`URL '${framing.allow}/x' cannot be embedded`))
  const before = await framing.counts()
  const denied = await openPage(browser.cdp, deniedBase, 'denied-ready', 1280)
  try {
    await denied.settle([])
    await assertFallbackStartsNoReadiness(denied, `${framing.deny}/x`, 'denied-ready')
  } finally {
    await denied.close()
  }
  const mid = await framing.counts()
  assert.equal(mid.deny - before.deny, 0, 'the hidden frame makes no request')
  const allowed = await openPage(browser.cdp, deniedBase, 'allowed-ready', 1280)
  try {
    await until(allowed, value => value.state === 'waiting', 'the live wait')
    await assertWaiting(allowed, 'allowed-ready')
    await assertReady(allowed, 'allowed-ready')
  } finally {
    await allowed.close()
  }
  assert.equal((await framing.counts()).allow - mid.allow, 1, 'the live view loads its frame once')
})

// Framed previews use real layout and frames; the small API shims only control
// browser scheduling so that load, exit and breakpoint races are deterministic.
const CONTROL_IDLE = `window.idleCallbacks = new Map(); window.idleSerial = 0; window.idleOptions = [];
  window.requestIdleCallback = (callback, options) => { idleOptions.push(options); idleCallbacks.set(++idleSerial, callback); return idleSerial };
  window.cancelIdleCallback = id => idleCallbacks.delete(id);
  window.flushIdle = () => { const callbacks = [...idleCallbacks.values()]; idleCallbacks.clear(); callbacks.forEach(fn => fn({ didTimeout: false, timeRemaining: () => 20 })) };`
const BELOW = `document.addEventListener('DOMContentLoaded', () => { document.querySelector('section.preview').style.marginTop = '2000px' }, { once: true });`
const IN_VIEW = `document.querySelector('section.preview').scrollIntoView({ block: 'center' })`
const WINDOW_STATE = `(() => {
  const container = document.querySelector('section.preview .preview-content')
  const frame = container.querySelector('iframe')
  const pane = frame.closest('.tab-pane')
  return { src: frame.getAttribute('src'), state: pane.dataset.previewState || null,
    busy: pane.getAttribute('aria-busy'), static: container.dataset.previewStatic || null,
    status: document.querySelector('.preview-window-status').textContent }
})()`
async function loadedParent (page) {
  await waitFor(() => page.evaluate('document.readyState === "complete"'), 'parent load')
}
async function idlePending (page) {
  await waitFor(() => page.evaluate('window.idleCallbacks.size > 0'), 'eligible idle callback')
  assert.deepEqual(await page.evaluate('window.idleOptions.at(-1)'), { timeout: 600 })
}

for (const visibleBeforeLoad of [false, true]) {
  test(`window visible waits for viewport, parent load and idle (visible before load ${visibleBeforeLoad})`, { skip }, async () => {
    const page = await openPage(browser.cdp, base, 'window-visible', 1440, { hold: true, beforeScript: CONTROL_IDLE + BELOW })
    try {
      await waitFor(() => page.evaluate('window.previewCheckReady'), 'DOM ready')
      if (visibleBeforeLoad) await page.evaluate(IN_VIEW)
      await sleep(700)
      assert.equal(page.requests.length, 0, 'no child before parent load')
      assert.equal(await page.evaluate('idleCallbacks.size'), 0)
      page.release(); await loadedParent(page)
      if (!visibleBeforeLoad) {
        await sleep(700)
        assert.equal(page.requests.length, 0, 'no child below fold')
        await page.evaluate(IN_VIEW)
      }
      await idlePending(page)
      assert.equal(page.requests.length, 0, 'no child before idle')
      await page.evaluate('flushIdle()')
      await waitFor(() => page.requests.length === 1, 'one child navigation')
      assert.deepEqual(page.requests, ['desktop'])
      await waitFor(() => page.evaluate(WINDOW_STATE).then(s => s.state === 'ready'), 'ready window')
      assert.equal((await page.evaluate(WINDOW_STATE)).status, 'Live preview ready')
      assert.equal(await page.evaluate('document.activeElement === document.body'), true, 'no automatic focus')
    } finally { await page.close() }
  })
}

for (const reason of ['exit', 'detach', 'static']) {
  test(`window visible cancels idle on ${reason}, and rechecks eligibility`, { skip }, async () => {
    const page = await openPage(browser.cdp, base, 'window-visible', 1440, { beforeScript: CONTROL_IDLE })
    try {
      await loadedParent(page); await page.evaluate(IN_VIEW); await idlePending(page)
      // Retain the queued callback too: cancellation alone cannot admit stale work.
      await page.evaluate('window.oldIdle = [...idleCallbacks.values()][0]; window.savedSection = document.querySelector("section.preview")')
      if (reason === 'exit') await page.evaluate('savedSection.style.marginTop = "3000px"; scrollTo(0,0)')
      if (reason === 'detach') await page.evaluate('savedSection.remove()')
      if (reason === 'static') await page.resize(390, 600)
      await sleep(150)
      await page.evaluate('oldIdle({}); flushIdle()')
      await sleep(700)
      assert.equal(page.requests.length, 0, `no navigation after ${reason}`)
      if (reason === 'exit') await page.evaluate('savedSection.style.marginTop = "0"')
      if (reason === 'detach') await page.evaluate('document.body.append(savedSection)')
      if (reason === 'static') await page.resize(1440)
      await page.evaluate(IN_VIEW); await idlePending(page); await page.evaluate('flushIdle()')
      await waitFor(() => page.requests.length === 1, 'fresh eligible navigation')
    } finally { await page.close() }
  })
}

for (const activation of ['load', 'click', 'visible']) {
  for (const [width, height] of [[390, 844], [390, 600], [1023, 900]]) {
    test(`window ${activation} is static with no app requests at ${width}x${height}`, { skip }, async () => {
      const page = await openPage(browser.cdp, base, `window-${activation}`, width, { height })
      try {
        await loadedParent(page); await page.evaluate(IN_VIEW)
        await page.evaluate('document.querySelector(".preview-activate")?.click()')
        await sleep(2300)
        assert.deepEqual(page.requests, [])
        const state = await page.evaluate(WINDOW_STATE)
        assert.deepEqual({ src: state.src, state: state.state, busy: state.busy }, { src: null, state: null, busy: null })
        assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".preview-poster")).visibility'), 'visible')
        assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".preview-waiting")).display'), 'none')
        assert.equal(await page.evaluate('document.querySelector(".preview-open").getBoundingClientRect().width >= 24'), true)
      } finally { await page.close() }
    })
  }
}

for (const waitForReady of [false, true]) {
  test(`window desktop to static forgets ${waitForReady ? 'ready' : 'waiting'} frame and restarts at 1024`, { skip }, async () => {
    const page = await openPage(browser.cdp, base, 'window-visible', 1440, { beforeScript: CONTROL_IDLE })
    try {
      await loadedParent(page); await page.evaluate(IN_VIEW); await idlePending(page); await page.evaluate('flushIdle()')
      await waitFor(() => page.requests.length === 1, 'desktop navigation')
      if (waitForReady) await waitFor(() => page.evaluate(WINDOW_STATE).then(s => s.state === 'ready'), 'ready desktop')
      await page.evaluate('window.oldFrame = document.querySelector(".preview-iframe"); window.oldWindow = oldFrame.contentWindow')
      await page.resize(1023)
      await sleep(100)
      const state = await page.evaluate(WINDOW_STATE)
      assert.equal(state.src, null); assert.equal(state.state, null); assert.equal(state.busy, null)
      assert.equal(await page.evaluate('oldFrame === document.querySelector(".preview-iframe")'), false)
      await page.evaluate(`dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(TOKEN)}, source: oldWindow }))`)
      assert.equal((await page.evaluate(WINDOW_STATE)).state, null)
      await sleep(2300)
      assert.equal(page.requests.length, 1, 'no static navigation or deadline')
      await page.resize(1024); await page.evaluate(IN_VIEW); await idlePending(page)
      await page.evaluate(`dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(TOKEN)}, source: oldWindow })); flushIdle()`)
      await waitFor(() => page.requests.length === 2, 'fresh desktop navigation')
      assert.equal((await page.evaluate(WINDOW_STATE)).state, 'waiting')
    } finally { await page.close() }
  })
}

test('window inserted after parent load has one controller and independent visibility', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'window-visible', 1440, { beforeScript: CONTROL_IDLE + BELOW })
  try {
    await loadedParent(page)
    await page.evaluate(`window.first = document.querySelector('section.preview'); window.second = first.cloneNode(true);
      second.querySelectorAll('[id]').forEach(el => el.id = 'copy-' + el.id); second.style.marginTop = '0'; first.before(second);
      window.activations = []; document.addEventListener('preview:activate', e => activations.push(e.target === second ? 'second' : 'first'));
      second.scrollIntoView({ block: 'center' })`)
    await idlePending(page); await page.evaluate('flushIdle()')
    await waitFor(() => page.requests.length === 1, 'inserted block navigates once')
    await page.evaluate('second.append(document.createElement("span")); second.append(document.createElement("span"))')
    await sleep(150); await page.evaluate('flushIdle()')
    assert.deepEqual(await page.evaluate('activations'), ['second'])
    assert.equal(await page.evaluate('first.querySelector("iframe").hasAttribute("src")'), false, 'independent below-fold block')
    await page.evaluate('first.scrollIntoView({ block: "center" })'); await idlePending(page); await page.evaluate('flushIdle()')
    await waitFor(() => page.requests.length === 2, 'first block navigation')
    assert.deepEqual(await page.evaluate('activations'), ['second', 'first'])
  } finally { await page.close() }
})

for (const missing of ['observer', 'idle', 'both']) {
  test(`window visible uses guarded ${missing} API fallback without polling`, { skip }, async () => {
    const beforeScript = BELOW + (missing !== 'idle' ? 'window.IntersectionObserver = undefined;' : '') +
      (missing !== 'observer' ? 'window.requestIdleCallback = undefined; window.cancelIdleCallback = undefined;' : '')
    const page = await openPage(browser.cdp, base, 'window-visible', 1440, { beforeScript })
    try {
      await loadedParent(page); await sleep(800)
      assert.equal(page.requests.length, 0, 'fallback still waits for entry')
      await page.evaluate(IN_VIEW)
      await waitFor(() => page.requests.length === 1, 'fallback navigation')
    } finally { await page.close() }
  })
}

const WINDOW_BOX = `(() => {
  const win = document.querySelector('.preview-window'), bar = win.querySelector('.preview-window-bar'), viewport = win.querySelector('.preview-content');
  const iframe = viewport.querySelector('.tab-pane.active iframe'), open = bar.querySelector('.preview-open'), navbar = document.querySelector('.navbar');
  const box = el => { const b = el.getBoundingClientRect(); return { width: b.width, height: b.height, left: b.left, right: b.right, top: b.top, bottom: b.bottom } };
  return { win: box(win), bar: box(bar), viewport: box(viewport), iframe: box(iframe), open: box(open), nav: navbar ? box(navbar) : { height: 0 }, width: innerWidth, height: innerHeight }
})()`
for (const [width, height] of [[1440, 900], [1440, 768], [1920, 1080]]) {
  test(`window geometry contains native 16:10 viewport at ${width}x${height} after bar and navigation resize`, { skip }, async () => {
    const page = await openPage(browser.cdp, base, 'window-visible', width, { height, beforeScript: CONTROL_IDLE })
    try {
      await loadedParent(page); await page.evaluate(IN_VIEW)
      for (const enlarged of [false, true]) {
        if (enlarged) await page.evaluate(`document.querySelector('.preview-window-bar').style.fontSize = '40px'; document.querySelector('.navbar').style.minHeight = '140px'`)
        await sleep(200)
        const b = await page.evaluate(WINDOW_BOX)
        assert.ok(b.bar.height > 0 && b.nav.height > 0 && b.viewport.height > 0)
        assert.ok(Math.abs(b.iframe.width / b.iframe.height - 1.6) < 0.002, 'native desktop ratio')
        assert.ok(b.win.height <= b.height - b.nav.height - 48 + 2, 'complete window fits after measured navigation and 48px margins')
        assert.ok(b.win.width <= b.width && Math.abs(b.iframe.width - b.viewport.width) < 3, 'contained viewport')
        assert.ok(b.iframe.top >= b.bar.bottom - 1 && b.iframe.bottom <= b.win.bottom + 1, 'bar stays outside uncropped app')
        assert.ok(b.open.width >= 24 && b.open.height >= 24, 'reachable bar action')
      }
      await page.emulateMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }])
      assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.preview-iframe')).transitionDuration`), '0s')
    } finally { await page.close() }
  })
}

for (const name of ['ok', 'reply', 'announce', 'silent', 'wrong', '503', 'refused', 'late']) {
  test(`window ${name} retains readiness and late recovery with sole title bar action`, { skip }, async () => {
    const page = await openPage(browser.cdp, base, `window-${name}`, 1440)
    try {
      await loadedParent(page); await page.evaluate(IN_VIEW)
      const ready = ['ok', 'reply', 'announce'].includes(name)
      await waitFor(() => page.evaluate(WINDOW_STATE).then(s => s.state === (ready ? 'ready' : 'failed')), 'window readiness outcome')
      assert.equal(await page.evaluate('document.querySelectorAll(".preview-open").length'), 1)
      assert.equal(await page.evaluate('document.querySelectorAll(".preview-unavailable a").length'), 0)
      if (name === 'late') await waitFor(() => page.evaluate(WINDOW_STATE).then(s => s.state === 'ready'), 'window late recovery')
    } finally { await page.close() }
  })
}

test('window script initialized after parent load still starts only the eligible view', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'window-visible', 1440, { skipPreviewScript: true, beforeScript: CONTROL_IDLE + BELOW })
  try {
    await loadedParent(page)
    assert.equal(page.requests.length, 0)
    await page.evaluate(fs.readFileSync('assets/js/modules/preview/preview.js', 'utf8'))
    await sleep(200)
    assert.equal(await page.evaluate('idleCallbacks.size'), 0)
    await page.evaluate(IN_VIEW); await idlePending(page); await page.evaluate('flushIdle()')
    await waitFor(() => page.requests.length === 1, 'late initialization navigation')
  } finally { await page.close() }
})

test('window inserted bar changes and component re-render keep fitted geometry and one controller', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'window-visible', 1440, { beforeScript: CONTROL_IDLE + BELOW })
  try {
    await loadedParent(page)
    await page.evaluate(`window.original = document.querySelector('section.preview'); window.inserted = original.cloneNode(true);
      inserted.querySelectorAll('[id]').forEach(el => el.id = 'inserted-' + el.id); inserted.style.marginTop = '0'; original.before(inserted);
      inserted.scrollIntoView({ block: 'center' }); window.activationCount = 0; document.addEventListener('preview:activate', () => activationCount++)`)
    await idlePending(page); await page.evaluate('flushIdle()'); await waitFor(() => page.requests.length === 1, 'inserted navigation')
    await page.evaluate(`inserted.querySelector('.preview-window-bar').style.fontSize = '48px'`)
    await sleep(200)
    const b = await page.evaluate(WINDOW_BOX)
    assert.ok(b.win.height <= b.height - b.nav.height - 48 + 2, 'inserted title bar is measured after a size change')
    await page.evaluate(`window.replacement = original.cloneNode(true); replacement.style.marginTop = '0';
      replacement.querySelectorAll('[id]').forEach(el => el.id = 'replacement-' + el.id); inserted.replaceWith(replacement);
      replacement.scrollIntoView({ block: 'center' }); replacement.append(document.createElement('span'))`)
    await idlePending(page); await page.evaluate('flushIdle()'); await waitFor(() => page.requests.length === 2, 're-rendered navigation')
    await sleep(100); await page.evaluate('flushIdle()')
    assert.equal(await page.evaluate('activationCount'), 2, 'one activation per fresh component')
  } finally { await page.close() }
})

test('window device controls preserve native tablet and mobile dimensions', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'window-devices', 1440)
  try {
    await loadedParent(page)
    for (const [device, width, height] of [['desktop', 1440, 900], ['tablet', 820, 1180], ['mobile', 402, 874]]) {
      await page.evaluate(`document.querySelector('.preview-controls [data-bs-target$="-${device}"]').click()`)
      await sleep(200)
      const b = await page.evaluate(WINDOW_BOX)
      assert.ok(Math.abs(b.iframe.width / b.iframe.height - width / height) < 0.002, `${device} native ratio`)
      assert.ok(Math.abs(b.viewport.height - b.iframe.height) < 2, `${device} contained without vertical gaps`)
      assert.ok(b.win.height <= b.height - b.nav.height - 48 + 2)
    }
  } finally { await page.close() }
})

for (const width of [390, 1440]) {
  test(`window build fallback retains its sole reachable title bar action at ${width}`, { skip }, async () => {
    const page = await openPage(browser.cdp, base, 'window-fallback', width, { height: 600 })
    try {
      await loadedParent(page); await page.evaluate(IN_VIEW)
      assert.equal(await page.evaluate('document.querySelectorAll("section.preview a").length'), 1)
      assert.equal(await page.evaluate(`(() => { const a = document.querySelector('.preview-open'); a.focus();
        const r = a.getBoundingClientRect(); return document.activeElement === a && r.width >= 24 && r.height >= 24 && a.target === '_blank' && a.rel === 'noopener' })()`), true)
    } finally { await page.close() }
  })
}

for (const activation of ['load', 'click']) {
  test(`window static return respects ${activation} activation eligibility`, { skip }, async () => {
    const page = await openPage(browser.cdp, base, `window-${activation}`, 390)
    try {
      await loadedParent(page); await page.evaluate(IN_VIEW); await sleep(100)
      assert.equal(page.requests.length, 0)
      await page.resize(1024); await page.evaluate(IN_VIEW)
      if (activation === 'click') {
        await sleep(200); assert.equal(page.requests.length, 0, 'click eligibility remains required')
        await page.evaluate('document.querySelector(".preview-activate").click()')
      }
      await waitFor(() => page.requests.length === 1, 'eligible desktop return')
      await page.resize(390); await sleep(100)
      assert.equal((await page.evaluate(WINDOW_STATE)).state, null)
      await page.resize(1024); await page.evaluate(IN_VIEW)
      if (activation === 'click') {
        await sleep(200); assert.equal(page.requests.length, 1, 'fresh click required after static reset')
        await page.evaluate('document.querySelector(".preview-activate").click()')
      }
      await waitFor(() => page.requests.length === 2, 'fresh return navigation')
    } finally { await page.close() }
  })
}

test('window success announcement follows the shown device independently of hidden ready frames', { skip }, async () => {
  const page = await openPage(browser.cdp, base, 'window-ready-devices', 1440)
  try {
    await loadedParent(page); await page.evaluate(IN_VIEW)
    await waitFor(() => page.requests.length === 1, 'desktop navigation')
    await page.evaluate(`document.querySelector('.preview-controls [data-bs-target$="-tablet"]').click()`)
    await waitFor(() => page.requests.length === 2, 'tablet navigation')
    await page.evaluate(`dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(TOKEN)}, source: document.querySelector('.preview-desktop').contentWindow }))`)
    assert.equal((await page.evaluate(WINDOW_STATE)).status, '', 'hidden desktop must not announce tablet success')
    await page.evaluate(`dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(TOKEN)}, source: document.querySelector('.preview-tablet').contentWindow }))`)
    assert.equal((await page.evaluate(WINDOW_STATE)).status, 'Live preview ready')
  } finally { await page.close() }
})

for (const width of [390, 1440]) {
  test(`components/preview-window renders the real local Ready route with static narrow behavior at ${width}`, { skip }, async () => {
    const page = await openPage(browser.cdp, base, 'components/preview-window', width)
    try {
      await loadedParent(page); await page.evaluate(IN_VIEW)
      if (width >= 1024) {
        await waitFor(() => page.evaluate(WINDOW_STATE).then(s => s.state === 'ready'), 'real local Ready document')
        assert.equal(page.localRequests.length, 1)
        assert.ok(page.localRequests[0].endsWith('/preview-demo/ready/'))
        assert.equal(await page.evaluate('document.querySelector(".preview-content").dataset.readyMessage'), 'example:ready')
      } else {
        await sleep(1000)
        assert.deepEqual(page.localRequests, [], 'no local embedded app requests after scroll or idle')
        assert.equal((await page.evaluate(WINDOW_STATE)).src, null)
      }
      assert.equal(await page.evaluate('document.querySelectorAll("section.preview a").length'), 1)
      assert.equal(await page.evaluate('document.querySelector(".preview-window-title").textContent'), 'Example workspace')
    } finally { await page.close() }
  })
}

for (const [width, height] of [[390, 600], [390, 844], [1023, 900], [1920, 1080]]) {
  test(`window measured viewport preserves 16:10 under theme padding at ${width}x${height}`, { skip }, async () => {
    const page = await openPage(browser.cdp, base, 'window-visible', width, { height, beforeScript: CONTROL_IDLE })
    try {
      await loadedParent(page); await page.evaluate(IN_VIEW)
      const b = await page.evaluate(WINDOW_BOX)
      assert.ok(Math.abs(b.viewport.width / b.viewport.height - 1.6) < 0.002,
        `actual viewport ${b.viewport.width}x${b.viewport.height} must keep the native ratio`)
      const poster = await page.evaluate(`(() => { const b = document.querySelector('.preview-poster').getBoundingClientRect(); return { width: b.width, height: b.height } })()`)
      assert.ok(Math.abs(poster.width - b.viewport.width) < 1 && Math.abs(poster.height - b.viewport.height) < 1,
        'the static poster covers the actual native viewport without bands')
      if (width < 1024) assert.equal(page.requests.length, 0)
    } finally { await page.close() }
  })
}
