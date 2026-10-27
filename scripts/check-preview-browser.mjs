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
// The check answers iframe requests for https://example.org/ itself and records
// which view made each one. Native fallback links briefly open their configured
// target in a real tab before the check closes it. A path under
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
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

// Native qualification is explicit: normal checks need no external tool module.
const nativeMode = process.env.PREVIEW_NATIVE === '1'
let nativeTool, nativeFont, nativeFontSHA256
const nativeBrowsers = new Map()
if (nativeMode) {
  const fontPath = process.env.PREVIEW_NATIVE_FONT
  assert.ok(fontPath, 'Native qualification requires PREVIEW_NATIVE_FONT: a readable existing WOFF2 fixture. No font is downloaded or substituted automatically.')
  try {
    nativeFont = fs.readFileSync(fontPath)
    assert.equal(nativeFont.subarray(0, 4).toString(), 'wOF2', 'The native font fixture must be WOFF2')
    nativeFontSHA256 = createHash('sha256').update(nativeFont).digest('hex')
  } catch (error) {
    throw new Error(`Cannot read the required WOFF2 native fixture: ${error.message}`, { cause: error })
  }
  const entry = process.env.PREVIEW_NATIVE_MODULE
  assert.ok(entry, 'Native qualification requires PREVIEW_NATIVE_MODULE: the ESM entry of an already installed Playwright tool with Chrome and WebKit. No tool is downloaded automatically.')
  try {
    const module = await import(pathToFileURL(path.resolve(entry)).href)
    nativeTool = module.default || module
    assert.ok(nativeTool.chromium?.launch && nativeTool.webkit?.launch, 'The installed tool must expose chromium and webkit launch methods')
  } catch (error) {
    throw new Error(`Cannot load the required installed native tool: ${error.message}`, { cause: error })
  }
}

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
  'native-window-waiting': { url: '/preview-demo/held/', lines: ['frame: window','devices: [desktop]','controls: false','activation: visible','open_link: true','open_url: /preview-demo/ready/','load_timeout: 30','mode: true','poster:','  desktop: img/preview-demo/ready-desktop.png'] },
  'native-window-failed': { url: '/preview-demo/unavailable/', lines: ['frame: window','devices: [desktop]','controls: false','activation: visible','open_link: true','open_url: /preview-demo/ready/',"ready_message: 'example:ready'",'load_timeout: 1','mode: true','poster:','  desktop: img/preview-demo/ready-desktop.png'] },
  'window-guard-held': { url: '/preview-demo/held/', lines: ['frame: window','devices: [desktop]','controls: false','activation: visible','open_link: true','load_timeout: 2','mode: true','poster:','  desktop: img/poster-desktop.png'] },
  'window-ready-devices': { url: child('silent'), lines: ['frame: window', `ready_message: '${TOKEN}'`, 'load_timeout: 15'] },
  'window-devices': ['frame: window', 'activation: click', 'open_link: true'],
  'window-fallback-static': ['frame: window','devices: [desktop]','controls: false','mobile_static: true','open_link: true','show_fallback: true','mode: true','image: img/poster-desktop.png'],
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
  await Promise.all([...nativeBrowsers.values()].map(driver => driver.close()))
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
const THEME_CHILD = `<!doctype html><html data-bs-theme="light"><head><meta charset="utf-8"><script>
if(location.search.includes('announce-only')){const img=document.createElement('img');img.src='/delay-load.svg';addEventListener('DOMContentLoaded',()=>document.body.append(img))}
const token='demo:theme',prefix='hinode-preview-theme:';window.themeRequests=[];window.firstTheme='light';let current=null,origin=null;
try{const seed=JSON.parse(window.name.slice(prefix.length));if(window.name.startsWith(prefix)&&window.name.length<=512&&['light','dark'].includes(seed.theme)){document.documentElement.dataset.bsTheme=seed.theme;window.firstTheme=seed.theme;if(seed.requestId>0)parent.postMessage({...seed,applied:false},seed.parentOrigin)}}catch{}
window.ack=(index,changes={})=>{const q=themeRequests[index];document.documentElement.dataset.bsTheme=q.data.theme;document.documentElement.dataset.theme=q.data.theme;current=q.data;origin=q.origin;window.name=prefix+JSON.stringify({...q.data,parentOrigin:q.origin});parent.postMessage({...q.data,applied:true,...changes},q.origin)};
window.invalidate=()=>{if(current)parent.postMessage({...current,applied:false},origin)};addEventListener('pagehide',window.invalidate);
addEventListener('message',e=>{if(e.source!==parent)return;if(e.data==='demo:ok'){if(!location.search.includes('announce-only'))parent.postMessage('demo:ok',e.origin)}else if(e.data?.type===token)themeRequests.push({data:e.data,origin:e.origin})});
addEventListener('DOMContentLoaded',()=>parent.postMessage('demo:ok','*'));
</script></head><body><h1>Theme bridge child</h1><p>A real local HTTP document.</p></body></html>`

const FRAMING_SERVERS = `
const http = require('node:http')
const chrome = { deny: 0, allow: 0 }
const themed = ${JSON.stringify(THEME_CHILD)}
const child = '<!doctype html><title>allow</title><p>allow</p><script>let ready = false;' +
  'document.addEventListener("DOMContentLoaded", () => setTimeout(() => { ready = true; parent.postMessage(${JSON.stringify(TOKEN)}, "*") }, 800));' +
  'addEventListener("message", e => { if (ready && e.source === parent && e.data === ${JSON.stringify(TOKEN)}) e.source.postMessage(e.data, "*") })</script>'
const listen = (name, headers, body) => new Promise(resolve => {
  const server = http.createServer((req, res) => {
    if (/Chrome/.test(req.headers['user-agent'] || '')) chrome[name]++
    if(req.url==='/delay-load.svg'){setTimeout(()=>{res.writeHead(200,{'Content-Type':'image/svg+xml'});res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')},250);return}
    res.writeHead(200, { 'Content-Type': 'text/html', ...headers })
    res.end(req.url.startsWith('/theme') ? themed : body)
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
  fs.writeFileSync(path.join(dir, 'themed-ready.md'), ['---','title: Theme bridge','modules: [preview]','content_blocks:','  - _bookshop_name: preview',
    `    url: ${framing.allow}/theme`,'    frame: window','    frame_title: Theme bridge','    open_link: true','    controls: false','    devices: [desktop]',
    '    activation: visible','    mobile_static: true',`    ready_message: '${TOKEN}'`,'    theme_message: demo:theme','    load_timeout: 2',
    '    mode: true','    poster:','      desktop: img/poster-desktop.png','---',''].join('\n'))
  const themedMarkdown=fs.readFileSync(path.join(dir,'themed-ready.md'),'utf8')
  for(const activation of ['load','click'])fs.writeFileSync(path.join(dir,`themed-${activation}.md`),themedMarkdown.replace('activation: visible',`activation: ${activation}`))
  fs.writeFileSync(path.join(dir,'owned-visible.md'),themedMarkdown.replace(/theme_message: demo:theme/, '').replace('/theme','/x'))
  fs.writeFileSync(path.join(dir,'themed-announce.md'),themedMarkdown.replace('/theme','/theme?announce-only'))
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
  for (const name of ['preview','preview-devices','preview-click','preview-items','preview-ready','preview-window']) {
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

// Compile the real Sass input used by a consumer with square global UI corners.
// A CSS custom property cannot exercise the producer's Sass radius dependency.
function buildZeroRadiusSite () {
  const themes = path.join(tmp, 'themes-zero')
  const scss = path.join(themes, 'preview-square', 'assets', 'scss', 'theme')
  fs.mkdirSync(scss, { recursive: true })
  fs.writeFileSync(path.join(scss, '_variables.scss'), '$theme-border-radius: 0;\n')
  const shell = process.platform === 'win32'
  const config = spawnSync('hugo', ['config', '-s', 'exampleSite', '--format', 'json'], { encoding: 'utf8', shell, timeout: 120000 })
  assert.equal(config.status, 0, `hugo config failed:\n${config.error || ''}${config.stderr}`)
  const imports = JSON.parse(config.stdout).module.imports.map(({ path }) => ({ path }))
  const file = path.join(tmp, 'zero-radius.json')
  fs.writeFileSync(file, JSON.stringify({ module: { imports: [{ path: 'preview-square' }, ...imports] } }))
  return hugo('public-zero-radius', ['--config', `hugo.toml,${file}`, '--themesDir', themes])
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }

function serve (root) {
  const previewRequests = []
  const held = []
  const server = http.createServer((req, res) => {
    const pathname=new URL(req.url,'http://x').pathname
    if(req.method==='GET'&&pathname.startsWith('/preview-demo/')&&pathname.endsWith('/'))previewRequests.push(pathname)
    if(pathname==='/preview-demo/held/'){held.push(res);return}
    if(pathname==='/preview-demo/unavailable/'){res.writeHead(503,{'Content-Type':'text/html'});res.end('<!doctype html><title>Unavailable</title><p>Service unavailable</p>');return}
    let file = path.join(root, decodeURIComponent(pathname))
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin' })
    fs.createReadStream(file).pipe(res)
  })
  server.releaseHeld=()=>{const body=fs.readFileSync(path.join(root,'preview-demo/ready/index.html'));held.splice(0).forEach(res=>{if(res.destroyed)return;res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end(body)})}
  server.previewRequests=previewRequests
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
  const documentRequests = []
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
    if (msg.method === 'Network.requestWillBeSent' && msg.params.type === 'Document') documentRequests.push(msg.params.request.url)
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

  const evaluate = async expression => (await send('Runtime.evaluate', { expression: typeof expression === 'function' ? `(${expression})()` : expression, returnByValue: true, awaitPromise: true })).result.value
  return {
    requests,
    localRequests,
    documentRequests,
    urls,
    evaluate,
    state: () => evaluate(STATE),
    releaseScripts,
    send,
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

let base, customFadeBase, deniedBase, zeroRadiusBase
if (!skip) {
  const start = Date.now()
  await startFramingServers()
  servers.push(await serve(buildSite()), await serve(buildCustomFadeSite()), await serve(buildDeniedSite()), await serve(buildZeroRadiusSite()))
  ;[base, customFadeBase, deniedBase, zeroRadiusBase] = servers.map(server => `http://127.0.0.1:${server.address().port}`)
  console.log(`# built the probe sites in ${Date.now() - start} ms`)
  try {
    await launch(chromePath)
    console.log(`# Chrome ${(await browser.cdp.send('Browser.getVersion')).product} at ${chromePath}, ready after ${Date.now() - start} ms`)
  } catch (error) {
    skip = `Chrome at ${chromePath} did not start: ${error.message.split('\n')[0]}`
  }
}
if (skip) console.log(`# skipped: ${skip}`)

// This mode uses an installed native tool rather than a DOM hit-test surrogate.
// Each popup loads the ordinary public child over HTTP; no document is replaced.
async function nativeWindowCase (engine, state, height, font, t) {
  assert.ok(!skip && base, `Native qualification needs the real browser fixture: ${skip || 'fixture unavailable'}`)
  let driver = nativeBrowsers.get(engine)
  if (!driver) {
    try {
      driver = await nativeTool[engine].launch(engine === 'chromium' ? { executablePath: chromePath, headless: true } : { headless: true })
    } catch (error) {
      throw new Error(`Required installed ${engine} engine cannot start: ${error.message}`, { cause: error })
    }
    nativeBrowsers.set(engine, driver)
  }
  const context = await driver.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = [], scripts = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.request().resourceType() === 'script') scripts.push({ url: response.url(), status: response.status(), mime: response.headers()['content-type'] })
  })
  await context.addInitScript(() => {
    window.nativeWindowEvents = []
    window.nativeScriptLoads = []
    document.addEventListener('load', event => {
      if (event.target.tagName === 'SCRIPT') nativeScriptLoads.push(event.target.src)
    }, true)
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) document.addEventListener(type, event => {
      const win = document.querySelector('.preview-window')
      if (!win) return
      nativeWindowEvents.push({ type, trusted: event.isTrusted, action: !!event.target.closest?.('.preview-open'),
        x: event.clientX, y: event.clientY, target: event.target.outerHTML.slice(0, 250),
        state: win.dataset.previewState, actionRect: win.querySelector('.preview-open').getBoundingClientRect().toJSON(),
        statusRect: win.querySelector('.preview-window-state').getBoundingClientRect().toJSON(), scrollY })
    }, true)
  })
  try {
    const route = state === 'ready' ? 'components/preview-window' : `native-window-${state === 'waiting' ? 'waiting' : 'failed'}`
    await page.goto(`${base}/${route}/`)
    await page.evaluate(async bytes => {
      const font = new FontFace('Preview native fixture', new Uint8Array(bytes).buffer)
      try { await font.load() } catch (error) { throw new Error(`Required native fixture font cannot load: ${error.message}`) }
      document.fonts.add(font)
      document.body.style.fontFamily = '"Preview native fixture", sans-serif'
      await document.fonts.ready
      if (font.status !== 'loaded' || !document.fonts.check('11px "Preview native fixture"')) throw new Error('Required native fixture font did not load')
    }, [...nativeFont])
    await page.locator('.preview-window').scrollIntoViewIfNeeded()
    await page.waitForFunction(want => document.querySelector('.preview-window').dataset.previewState === want, state)
    await page.evaluate(({ font, height }) => {
      const win = document.querySelector('.preview-window')
      for (let el = win.parentElement; el && el !== document.body; el = el.parentElement) {
        el.style.width = '100%'; el.style.maxWidth = 'none'; el.style.paddingInline = '0'; el.style.marginInline = '0'
      }
      // A generic constrained parent must not conceal an action edge defect.
      win.style.maxWidth = '90%'
      document.documentElement.style.fontSize = `${font}px`
      document.querySelector('.navbar').style.height = `${font === 32 ? 177 : 91}px`
    }, { font, height })
    await page.setViewportSize({ width: 1440, height })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(200)
    await page.evaluate(() => {
      const action = document.querySelector('.preview-open')
      const parent = action.closest('.preview-window').parentElement
      const top = action.getBoundingClientRect().top
      // Ordinary fractional text layout can place a target near a pixel edge.
      const offset = (5 / 64 - (top - Math.floor(top)) + 1) % 1
      parent.style.setProperty('padding-top', `${parseFloat(getComputedStyle(parent).paddingTop) + offset}px`, 'important')
      const rect = action.getBoundingClientRect()
      const nav = document.querySelector('.navbar').getBoundingClientRect()
      scrollTo({ top: Math.floor(scrollY + rect.top - nav.bottom), behavior: 'instant' })
    })
    await page.waitForTimeout(100)
    const box = await page.evaluate(() => {
      const win = document.querySelector('.preview-window'), action = win.querySelector('.preview-open'), status = win.querySelector('.preview-window-state')
      const rect = el => el.getBoundingClientRect().toJSON()
      return { action: rect(action), status: rect(status), window: rect(win), viewport: rect(win.querySelector('.preview-content')),
        nav: rect(document.querySelector('.navbar')), height: innerHeight, font: getComputedStyle(document.documentElement).fontSize,
        fit: win.dataset.previewFit || null, state: win.dataset.previewState, word: status.innerText.trim(), scrollY,
        statusDisplay: getComputedStyle(status).display, statusVisibility: getComputedStyle(status).visibility,
        statusFont: getComputedStyle(status).fontSize, statusLine: getComputedStyle(status).lineHeight,
        statusFamily: getComputedStyle(status).fontFamily, fixtureFontLoaded: document.fonts.check('11px "Preview native fixture"') }
    })
    t.diagnostic(JSON.stringify({ engine, state, height, font, nativeFontSHA256, nativeFontBytes: nativeFont.length, box }))
    assert.ok(box.fixtureFontLoaded && box.statusFamily.includes('Preview native fixture'), 'required inherited fixture font is active')
    assert.equal(box.state, state)
    assert.ok(box.action.width >= 28 && box.action.height >= 28, 'complete28px action')
    assert.ok(box.action.top >= box.nav.bottom && box.action.bottom <= height, 'the whole action is visible below navigation')
    assert.ok(box.status.top >= box.nav.bottom && box.status.bottom <= height, 'the entire concise state is visible with the action')
    assert.ok(box.word && box.status.width > 0 && box.status.height > 0 && box.statusDisplay !== 'none' && box.statusVisibility === 'visible', 'visible nonempty state')
    assert.ok(Math.abs(box.viewport.width / box.viewport.height - 1.6) < .002, 'native16:10 content')
    const tags = await page.locator('script[src]').evaluateAll(elements => elements.map(element => element.src))
    assert.ok(scripts.every(script => script.status === 200 && /javascript/.test(script.mime)), 'faithful first-party JavaScript MIME')
    assert.ok(tags.every(src => scripts.some(script => script.url === src)), 'all parent script responses observed')
    assert.ok(await page.evaluate(tags => tags.every(src => nativeScriptLoads.includes(src)), tags), 'all parent scripts executed through load')
    const points = [[box.action.left + 1, box.action.top + 1], [box.action.right - 1, box.action.top + 1],
      [box.action.left + 1, box.action.bottom - 1], [box.action.right - 1, box.action.bottom - 1],
      [box.action.left + box.action.width / 2, box.action.top + box.action.height / 2]]
    for (const [x, y] of points) {
      await page.bringToFront()
      await page.evaluate(() => { nativeWindowEvents.length = 0 })
      const opened = page.waitForEvent('popup', { timeout: 1500 }).catch(() => null)
      await page.mouse.click(x, y)
      const popup = await opened
      const events = await page.evaluate(() => nativeWindowEvents)
      t.diagnostic(JSON.stringify({ engine, state, height, font, requested: { x, y }, events, popup: popup?.url() || null }))
      assert.ok(popup, 'each native1px corner and center opens the configured page')
      try {
        await popup.waitForLoadState('domcontentloaded')
        assert.equal(popup.url(), `${base}/preview-demo/ready/`)
        assert.equal(await popup.locator('h1').innerText(), 'Project workspace')
      } finally { await popup.close() }
      assert.ok(events.some(event => event.type === 'click' && event.trusted && event.action), 'actual trusted click reaches the action')
      assert.ok(events.every(event => event.state === state), 'event-time lifecycle state stays current')
    }
    assert.deepEqual(errors, [])
  } finally { await context.close() }
}

if (nativeMode) {
  test('native compact action WebKit Live32 one-pixel edge', async t => nativeWindowCase('webkit', 'ready', 220, 32, t))
  for (const engine of ['chromium', 'webkit']) for (const state of ['waiting', 'ready', 'failed']) {
    for (const [height, font] of [[220,16], [240,16], [220,32], [240,32], [120,16], [1000,16]]) {
      if (engine === 'webkit' && state === 'ready' && height === 220 && font === 32) continue
      test(`native compact action ${engine} ${state} 1440x${height} font${font}`, async t => nativeWindowCase(engine, state, height, font, t))
    }
  }
}

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
    waiting: shows(status) ? status.innerText.trim() : null,
    // The status sits in the middle of the poster, less than half its height.
    statusFits: !status || status.getBoundingClientRect().height < pane.querySelector('.preview-poster').getBoundingClientRect().height / 2,
    button: shows(pane.querySelector('.preview-activate')),
    alert: shows(alert) ? { text: alert.innerText.replace(/\\s+/g, ' ').trim(), role: alert.querySelector('[role]').getAttribute('role'), href: link.href, name: link.textContent.trim() } : null,
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
    assert.deepEqual(reloaded.got.filter(data=>typeof data==='string'), ['example:ready', 'example:ready'])
    assert.ok(reloaded.got.filter(data=>typeof data==='object').every(data=>data.type==='example:theme'&&typeof data.applied==='boolean'))
    assert.equal(reloaded.seen,1,'the local page receives its self-post without replying to it')
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
  await document.fonts.ready
  const alert = pane.querySelector('.preview-error .alert')
  const link = alert.querySelector('a')
  const linkTop = link.getBoundingClientRect().top + scrollY
  scrollTo({ top: linkTop - innerHeight / 2, behavior: 'instant' })
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const box = el => el.getBoundingClientRect().toJSON()
  const linkBox = box(link)
  const hit = document.elementFromPoint(linkBox.left + linkBox.width / 2, linkBox.top + linkBox.height / 2)
  const inside = (el, outer) => el.left >= outer.left - 0.01 && el.right <= outer.right + 0.01 && el.top >= outer.top - 0.01 && el.bottom <= outer.bottom + 0.01
  const c = box(content)
  const clip = { left: c.left + content.clientLeft, right: c.left + content.clientLeft + content.clientWidth,
    top: c.top + content.clientTop, bottom: c.top + content.clientTop + content.clientHeight }
  const linkRects = [...link.getClientRects()].map(rect => rect.toJSON())
  return {
    content: c.height,
    clipped: content.scrollHeight > content.clientHeight + 1,
    image: box(image).height,
    imageInside: inside(box(image), clip),
    alert: box(alert).height,
    alertInside: inside(box(alert), clip),
    clip, linkBox, linkRects,
    wholeLinkInside: linkRects.length > 0 && linkRects.every(rect => inside(rect, clip)),
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
      assert.ok(boxes.wholeLinkInside, `every link rectangle stays within the actual clipping boundary: ${JSON.stringify(boxes)}`)
      await page.evaluate(`window.legacyFallbackClicks=[];document.addEventListener('click',e=>{if(e.target.closest('.preview-error .alert-link'))legacyFallbackClicks.push(e.isTrusted)},true)`)
      let gestures=0
      for(const rect of boxes.linkRects)for(const [fx,fy] of [[.08,.08],[.92,.08],[.08,.92],[.92,.92],[.5,.5]]){
        await page.send('Page.bringToFront')
        const before=new Set((await browser.cdp.send('Target.getTargets')).targetInfos.map(info=>info.targetId))
        const point={x:rect.x+rect.width*fx,y:rect.y+rect.height*fy,button:'left',clickCount:1}
        await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point})
        await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point})
        const popup=await waitFor(async()=> (await browser.cdp.send('Target.getTargets')).targetInfos.find(info=>!before.has(info.targetId)&&info.type==='page'&&info.url===TARGET),'configured fallback target tab')
        await browser.cdp.send('Target.closeTarget',{targetId:popup.targetId});gestures++
      }
      assert.deepEqual(await page.evaluate('legacyFallbackClicks'),Array(gestures).fill(true),'every native corner/center gesture clicks the real link')
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
    alert: { role: alert.getAttribute('role'), box: box(alert), text: alert.innerText.replace(/\\s+/g, ' ').trim() },
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
    assert.equal((await page.evaluate(WINDOW_STATE)).status, 'Loading the live preview', 'hidden desktop must not announce tablet success')
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


// Check the entire sole action, including edge hit tests. A large target whose
// centre is inside the window can still lose an edge to its clipping boundary.
const WINDOW_ACTION = `(() => {
  const win = document.querySelector('.preview-window'), bar = win.querySelector('.preview-window-bar');
  const viewport = win.querySelector('.preview-content'), open = bar.querySelector('.preview-open');
  const rect = el => { const r = el.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height } };
  const w = rect(win), a = rect(open), v = rect(viewport), style = getComputedStyle(win);
  const points = [[a.left+1,a.top+1], [a.right-1,a.top+1], [a.left+1,a.bottom-1], [a.right-1,a.bottom-1], [(a.left+a.right)/2,(a.top+a.bottom)/2]];
  return { win:w, open:a, viewport:v, bar:rect(bar), nav:document.querySelector('.navbar').getBoundingClientRect().height,
    height:innerHeight, fit:win.dataset.previewFit || null, compact:win.classList.contains('preview-window-compact'),
    margin:parseFloat(style.marginTop), corners:[style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomLeftRadius,style.borderBottomRightRadius],
    contained:a.left>=w.left+0.5 && a.right<=w.right-0.5 && a.top>=w.top+0.5 && a.bottom<=w.bottom-0.5,
    hit:points.every(([x,y]) => open.contains(document.elementFromPoint(x,y))),
    hitTargets:points.map(([x,y])=>{const el=document.elementFromPoint(x,y);return el?.tagName+'.'+el?.getAttribute('class')}),
    barChildren:[...bar.children].map(el=>({class:el.className,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,position:getComputedStyle(el).position,display:getComputedStyle(el).display})),
    overflow:document.documentElement.scrollWidth>innerWidth,
    state:viewport.querySelector('.tab-pane.active')?.dataset.previewState || null }
})()`
async function positionWindow (page, scrollFallback = false) {
  await page.evaluate(`(() => { const win = document.querySelector('.preview-window');
    if (${scrollFallback}) win.querySelector('.preview-open').scrollIntoView({ block:'end' });
    else scrollBy(0, win.getBoundingClientRect().top - document.querySelector('.navbar').getBoundingClientRect().height - parseFloat(getComputedStyle(win).marginTop)) })()`)
  await sleep(100)
}
function assertWindowAction (b) {
  const detail = JSON.stringify(b)
  assert.ok(b.open.width >= 24 && b.open.height >= 24, `minimum action target: ${detail}`)
  assert.ok(b.contained, `entire action stays inside window: ${detail}`)
  assert.ok(b.hit, `all action edges are hit-testable: ${detail}`)
  assert.equal(b.overflow, false, `no horizontal page overflow: ${detail}`)
  assert.ok(b.viewport.width > 0 && b.viewport.height > 0 && Math.abs(b.viewport.width / b.viewport.height - 1.6) < 0.002, `native nonzero viewport: ${detail}`)
}

for (const height of [220, 240, 320, 360, 400, 768, 900]) {
  for (const enlarged of [false, true]) {
    test(`window sole action fits complete short chrome at 1440x${height} enlarged ${enlarged}`, { skip }, async t => {
      const page = await openPage(browser.cdp, base, 'window-visible', 1440, { height, beforeScript: CONTROL_IDLE })
      try {
        await loadedParent(page)
        await page.evaluate(`document.querySelector('.navbar').style.height = '${enlarged ? 110 : 91}px';
          ${enlarged ? "document.querySelector('.preview-window-bar').style.cssText = 'font-size:40px;padding:24px 60px;min-height:100px';" : ''}`)
        await sleep(200); await positionWindow(page)
        const b = await page.evaluate(WINDOW_ACTION)
        t.diagnostic(JSON.stringify(b)); assertWindowAction(b)
        assert.notEqual(b.fit, 'scroll', 'feasible short canvas still fits')
        assert.ok(b.win.height + 2*b.margin <= b.height-b.nav+2, 'complete window and margins fit after navigation')
        if(!enlarged || height>=240)assert.ok(b.margin >= 24, '24px margins remain feasible with visible state')
        else assert.ok(b.margin>0&&b.margin<24,'enlarged chrome only reduces infeasible24px margins')
        if (height >= 768 && !enlarged) assert.equal(b.compact, false, 'normal appearance remains unchanged')
        const stable = JSON.stringify([b.win.width, b.win.height, b.compact])
        await sleep(250)
        const next = await page.evaluate(WINDOW_ACTION)
        assert.equal(JSON.stringify([next.win.width,next.win.height,next.compact]), stable, 'resize observation settles without oscillation')
      } finally { await page.close() }
    })
  }
}

for (const [name,width,height,state] of [['window-visible',1440,220,'waiting'], ['window-ok',1440,240,'ready'], ['window-503',1440,220,'failed'], ['window-fallback',1440,240,null], ['window-visible',390,220,null]]) {
  test(`window sole action survives short lifecycle ${name} ${width}x${height}`, { skip }, async t => {
    const page = await openPage(browser.cdp, base, name, width, { height, beforeScript: name === 'window-visible' ? CONTROL_IDLE : '' })
    try {
      await loadedParent(page)
      await page.evaluate("document.querySelector('.navbar').style.height='91px'")
      await sleep(200); await positionWindow(page)
      if (state === 'waiting') { await idlePending(page); await page.evaluate('flushIdle()') }
      if (state) await waitFor(() => page.evaluate(WINDOW_ACTION).then(b => b.state === state), 'short lifecycle state')
      const b = await page.evaluate(WINDOW_ACTION); t.diagnostic(JSON.stringify(b)); assertWindowAction(b)
      assert.equal(await page.evaluate('document.querySelectorAll(".preview-open").length'),1)
      if (width < 1024) assert.deepEqual(page.requests, [], 'static narrow state has zero app requests')
    } finally { await page.close() }
  })
}

// A full-width scroll fallback must leave room for native page scrolling at
// the viewport edges. DOM hit queries alone do not establish native routing.
for (const [height, font, navigationHeight, scroll] of [[220,16,91,false], [240,16,91,false], [220,32,177,true], [240,32,177,true], [120,16,91,true], [1000,16,91,false]]) {
  test(`window full-width fallback leaves native action clearance at 1440x${height} font ${font}`, { skip }, async t => {
    const page = await openPage(browser.cdp, base, 'components/preview-window', 1440, { height, beforeScript:CONTROL_IDLE })
    try {
      await loadedParent(page)
      await page.evaluate(`(() => {
        const section=document.querySelector('section.preview'),win=section.querySelector('.preview-window');
        for(let el=win.parentElement;el&&el!==document.body;el=el.parentElement){el.style.width='100%';el.style.maxWidth='none';el.style.paddingInline='0';el.style.marginInline='0'}
        document.documentElement.style.fontSize='${font}px';
        document.querySelector('.navbar').style.height='${navigationHeight}px';
        window.nativeActionEvents=[];
        document.addEventListener('click',e=>{if(e.target.closest('.preview-open'))nativeActionEvents.push({trusted:e.isTrusted})},true);
        dispatchEvent(new Event('resize'));
      })()`)
      await sleep(200)
      await page.evaluate(`(() => {const open=document.querySelector('.preview-open');open.scrollIntoView({block:'start',behavior:'instant'});const a=open.getBoundingClientRect();scrollBy({top:a.top-document.querySelector('.navbar').getBoundingClientRect().bottom-.25,behavior:'instant'})})()`)
      await sleep(200)
      const b=await page.evaluate(WINDOW_ACTION);t.diagnostic(JSON.stringify(b))
      assert.ok(b.open.width>=28&&b.open.height>=28,'whole28px action retained')
      assert.equal(b.fit==='scroll',scroll,'honest fit/scroll branch')
      if(scroll){
        assert.ok(b.win.left>=24&&b.win.right<=1440-24,'scroll fallback keeps24px inline native-scroll clearance')
        assert.ok(b.viewport.width>=320,'scroll fallback keeps useful native content')
      }else assert.ok(b.win.height+2*b.margin<=height-navigationHeight+2,'feasible window still fits')
      assertWindowAction(b)
      const points=[[.08,.08],[.92,.08],[.08,.92],[.92,.92],[.5,.5]]
      for(const [fx,fy] of points){
        const a=await page.evaluate(`document.querySelector('.preview-open').getBoundingClientRect().toJSON()`)
        const before=new Set((await browser.cdp.send('Target.getTargets')).targetInfos.map(info=>info.targetId))
        const point={x:a.x+a.width*fx,y:a.y+a.height*fy,button:'left',clickCount:1}
        await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point})
        await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point})
        const popup=await waitFor(async()=>{
          const infos=(await browser.cdp.send('Target.getTargets')).targetInfos
          return infos.find(info=>!before.has(info.targetId)&&info.type==='page'&&info.url===`${base}/preview-demo/ready/`)
        },'actual local root tab from native action')
        await browser.cdp.send('Target.closeTarget',{targetId:popup.targetId})
      }
      assert.deepEqual(await page.evaluate('nativeActionEvents'),points.map(()=>({trusted:true})))
      assert.deepEqual(page.localRequests,[],'sole action does not admit the held embedded preview')
      await page.evaluate("document.querySelector('.preview-open').focus({preventScroll:true})")
      assert.equal(await page.evaluate("document.activeElement.matches('.preview-open')"),true)
    } finally {await page.close()}
  })
}

test('window impossible height keeps useful uncropped viewport and page-scroll action', { skip }, async t => {
  const page = await openPage(browser.cdp, base, 'window-visible', 1440, { height:120, beforeScript:CONTROL_IDLE })
  try {
    await loadedParent(page); await page.evaluate("document.querySelector('.navbar').style.height='91px'")
    await sleep(200); await positionWindow(page,true)
    const b = await page.evaluate(WINDOW_ACTION); t.diagnostic(JSON.stringify(b)); assertWindowAction(b)
    assert.equal(b.fit,'scroll','impossible canvas explicitly uses ordinary page scrolling')
    assert.ok(b.viewport.width >= 320 && b.win.height > b.height-b.nav, 'fallback preserves a useful native viewport')
    await page.evaluate("document.querySelector('.preview-open').focus()")
    assert.equal(await page.evaluate("document.activeElement.matches('.preview-open')"),true)
    await page.resize(1440,900); await sleep(200); await positionWindow(page)
    const recovered=await page.evaluate(WINDOW_ACTION); assertWindowAction(recovered)
    assert.notEqual(recovered.fit,'scroll','resize restores normal fit')
    assert.equal(recovered.compact,false)
  } finally { await page.close() }
})

for (const [name,width,height,dark] of [['window-ok',1440,900,false], ['window-ok',1440,900,true], ['window-503',1440,240,false], ['window-fallback',1440,220,true], ['window-visible',390,600,false]]) {
  test(`window independent radius survives Sass zero UI radius ${name} ${width}x${height} dark ${dark}`, { skip }, async t => {
    const page=await openPage(browser.cdp,zeroRadiusBase,name,width,{height})
    try {
      await loadedParent(page)
      await page.evaluate(`document.documentElement.dataset.bsTheme='${dark ? 'dark' : 'light'}';document.querySelector('.navbar').style.height='91px'`)
      await sleep(200);await positionWindow(page)
      if (name==='window-ok'||name==='window-503') await waitFor(() => page.evaluate(WINDOW_ACTION).then(b=>b.state===(name==='window-ok'?'ready':'failed')),'radius runtime state')
      const b=await page.evaluate(WINDOW_ACTION);t.diagnostic(JSON.stringify(b))
      assert.ok(b.corners.every(value=>parseFloat(value)>0),`all four independent window radii: ${JSON.stringify(b.corners)}`)
      assertWindowAction(b)
      if(width<1024)assert.deepEqual(page.requests,[])
    }finally{await page.close()}
  })
}

test('Sass zero UI radius preserves legacy frame none square style', { skip }, async () => {
  const page=await openPage(browser.cdp,zeroRadiusBase,'default',1440)
  try {
    await loadedParent(page)
    assert.equal(await page.evaluate('document.querySelector(".preview-window")'),null)
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".preview-content")).borderTopLeftRadius'),'0px')
  }finally{await page.close()}
})


for (const constrained of [false,true]) {
  test(`window minimum chrome keeps whole action with reduced margins and theme constraints ${constrained}`, { skip }, async t => {
    const page=await openPage(browser.cdp,base,'window-visible',1440,{height:constrained ? 900 : 180,beforeScript:CONTROL_IDLE})
    try {
      await loadedParent(page)
      await page.evaluate(`document.querySelector('.navbar').style.height='91px';
        ${constrained ? "document.querySelector('.preview-window').parentElement.style.cssText='max-width:100px;padding-inline:16px;margin-inline:auto';dispatchEvent(new Event('resize'))" : ''}`)
      await sleep(200);await positionWindow(page)
      const b=await page.evaluate(WINDOW_ACTION);t.diagnostic(JSON.stringify(b));assertWindowAction(b)
      assert.equal(b.compact,true)
      assert.notEqual(b.fit,'scroll','feasible constrained window fits')
      assert.ok(b.win.height+2*b.margin <= b.height-b.nav+2,'complete constrained window fits')
      if(constrained) assert.ok(b.win.width<=100,'honour actual theme max width and padding')
      else assert.ok(b.margin>0 && b.margin<24,'only reduce margins where 24px cannot fit minimum chrome')
    }finally{await page.close()}
  })
}


const FEEDBACK_PAINT = `(() => {
  const pane=document.querySelector('.preview-content > .tab-pane.active'),poster=pane.querySelector('.preview-poster');
  const status=pane.querySelector('.preview-waiting'),label=[...status?.querySelectorAll('.preview-feedback-full,.preview-feedback-short')||[]].find(el=>el.offsetWidth)||status?.querySelector('span:last-child');
  const r=label?.getBoundingClientRect(),bar=document.querySelector('.preview-window-state');
  const hit=r&&[[r.left+1,r.top+1],[r.right-1,r.top+1],[r.left+1,r.bottom-1],[r.right-1,r.bottom-1],[(r.left+r.right)/2,(r.top+r.bottom)/2]].every(([x,y])=>status.contains(document.elementFromPoint(x,y)));
  return {word:bar?.innerText||null,label:label?.innerText||null,hit:!!hit,scrim:poster?getComputedStyle(poster,'::after').backgroundColor:null,
    state:pane.dataset.previewState||null,spinner:status?getComputedStyle(status.querySelector('.spinner-border')).display:null}
})()`

test('window loading words and spinner paint above the thirty percent poster scrim', {skip}, async () => {
  const page=await openPage(browser.cdp,base,'window-visible',1440,{beforeScript:CONTROL_IDLE})
  try{
    await loadedParent(page);await page.evaluate(IN_VIEW);await idlePending(page);await page.evaluate('flushIdle()')
    await waitFor(()=>page.evaluate(FEEDBACK_PAINT).then(b=>b.state==='waiting'),'waiting')
    const b=await page.evaluate(FEEDBACK_PAINT)
    assert.ok(b.hit,JSON.stringify(b));assert.equal(b.word,'Loading');assert.equal(b.scrim,'rgba(0, 0, 0, 0.3)');assert.notEqual(b.spinner,'none')
  }finally{await page.close()}
})

test('window static Preview and explicit CSS square token keep action and native geometry', {skip},async()=>{
  const page=await openPage(browser.cdp,base,'window-visible',390,{height:600})
  try{
    await loadedParent(page);await page.evaluate(IN_VIEW)
    assert.equal((await page.evaluate(FEEDBACK_PAINT)).word,'Preview')
    assert.notEqual((await page.evaluate(FEEDBACK_PAINT)).scrim,'rgba(0, 0, 0, 0.3)')
    await page.evaluate("document.querySelector('.preview-window').style.setProperty('--preview-window-border-radius','0')")
    const b=await page.evaluate(WINDOW_ACTION);assert.ok(b.corners.every(v=>parseFloat(v)===0));assertWindowAction(b);assert.deepEqual(page.requests,[])
  }finally{await page.close()}
})


// Isolated worlds do not share JS globals; the document exposes controls through
// DOM events, so the calls remain real messages from the actual child window.
async function themeProbe (page,expression) {
  const tree=await page.send('Page.getFrameTree'),child=tree.frameTree.childFrames?.find(f=>f.frame.url.includes('/theme'))
  assert.ok(child)
  // The default world can be reached by a transient script element in the child.
  const world=await page.send('Page.createIsolatedWorld',{frameId:child.frame.id,worldName:'theme-probe'})
  const code=`(()=>{const s=document.createElement('script');s.textContent=${JSON.stringify('document.documentElement.dataset.themeProbe=JSON.stringify('+expression+')')};document.head.append(s);s.remove();return JSON.parse(document.documentElement.dataset.themeProbe)})()`
  const result=await page.send('Runtime.evaluate',{expression:code,contextId:world.executionContextId,returnByValue:true,awaitPromise:true})
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function themeRequests (page) {return themeProbe(page,'window.themeRequests')}
async function startThemed (page) {
  await loadedParent(page);await page.evaluate("document.documentElement.dataset.bsTheme='dark'");await page.evaluate(IN_VIEW)
  if(await page.evaluate("typeof flushIdle==='function'")){await idlePending(page);await page.evaluate('flushIdle()')}
  await waitFor(()=>themeRequests(page).then(x=>x?.length>0).catch(()=>false),'a real correlated theme request')
  return (await themeRequests(page)).at(-1).data
}

test('theme bridge keeps real current document hidden until correlated applied ACK and outer theme', {skip},async()=>{
  const page=await openPage(browser.cdp,deniedBase,'themed-ready',1440,{beforeScript:CONTROL_IDLE})
  try{
    const first=await startThemed(page)
    assert.equal((await page.evaluate(WINDOW_STATE)).state,'waiting')
    assert.equal(first.theme,'dark');assert.ok(Number.isSafeInteger(first.requestId)&&first.requestId>0)
    const name=await page.evaluate("document.querySelector('.preview-iframe').name")
    assert.ok(name.startsWith('hinode-preview-theme:')&&name.length<=512)
    assert.equal(JSON.parse(name.slice('hinode-preview-theme:'.length)).parentOrigin,new URL(deniedBase).origin)
    for(const changes of [{requestId:first.requestId+1},{requestId:String(first.requestId)},{theme:'light'},{applied:'true'},{type:'wrong'}]){
      await themeProbe(page,`(window.ack(0,${JSON.stringify(changes)}),true)`);await sleep(30)
      assert.equal((await page.evaluate(WINDOW_STATE)).state,'waiting','malformed or mismatched ACK cannot reveal')
    }
    await page.evaluate(`dispatchEvent(new MessageEvent('message',{source:window,origin:${JSON.stringify(framing.allow)},data:${JSON.stringify({...first,applied:true})}}))`)
    assert.equal((await page.evaluate(WINDOW_STATE)).state,'waiting','wrong source rejected')
    await page.evaluate(`dispatchEvent(new MessageEvent('message',{source:document.querySelector('iframe').contentWindow,origin:'null',data:${JSON.stringify({...first,applied:true})}}))`)
    assert.equal((await page.evaluate(WINDOW_STATE)).state,'waiting','opaque origin rejected')
    await themeProbe(page,'(window.ack(0),true)');await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='ready'),'matching applied ACK')
    assert.equal((await page.evaluate(FEEDBACK_PAINT)).word,'Live')
    await page.evaluate("document.documentElement.dataset.bsTheme='light'")
    await waitFor(()=>themeRequests(page).then(q=>q.length>1),'new outer theme request')
    const next=(await themeRequests(page)).at(-1).data;assert.ok(next.requestId>first.requestId);assert.equal(next.theme,'light')
    assert.equal((await page.evaluate(WINDOW_STATE)).state,'waiting')
    await themeProbe(page,'(window.ack(0),true)');await sleep(30);assert.equal((await page.evaluate(WINDOW_STATE)).state,'waiting','out-of-order old ACK rejected')
    await themeProbe(page,'(window.ack(themeRequests.length-1),true)');await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='ready'),'latest theme ACK')
    assert.equal(await themeProbe(page,'document.documentElement.dataset.bsTheme'),'light')
    await page.emulateMedia([{name:'prefers-color-scheme',value:'dark'}]);await sleep(50)
    assert.equal(await themeProbe(page,'document.documentElement.dataset.bsTheme'),'light','resolved explicit outer theme beats OS preference')
    assert.equal(page.localRequests.length,0)
    assert.equal(await page.evaluate('document.activeElement.tagName'),'BODY')
  }finally{await page.close()}
})

test('theme bridge full navigation uses transient early seed and fresh proof despite same WindowProxy', {skip},async()=>{
  const page=await openPage(browser.cdp,deniedBase,'themed-ready',1440,{beforeScript:CONTROL_IDLE+"document.addEventListener('DOMContentLoaded',()=>document.querySelector('.preview-iframe').setAttribute('name','original-preview-frame'),{once:true})"})
  try{
    const old=await startThemed(page);await themeProbe(page,'(window.ack(0),true)');await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='ready'),'initial ACK')
    await page.evaluate("window.previousThemeFrame=document.querySelector('.preview-iframe').contentWindow")
    await themeProbe(page,"(window.invalidate(),location.href='/theme?next',true)")
    await waitFor(()=>themeProbe(page,"location.search==='?next'&&window.themeRequests.length>0").catch(()=>false),'new real child document')
    assert.equal(await page.evaluate("previousThemeFrame===document.querySelector('.preview-iframe').contentWindow"),true)
    assert.equal(await themeProbe(page,'window.firstTheme'),'dark','next document applies current theme in head')
    const fresh=(await themeRequests(page)).at(-1).data;assert.ok(fresh.requestId>old.requestId)
    assert.equal((await page.evaluate(WINDOW_STATE)).state,'waiting','new document needs a new ACK')
    await page.evaluate(`dispatchEvent(new MessageEvent('message',{source:previousThemeFrame,origin:${JSON.stringify(framing.allow)},data:${JSON.stringify({...old,applied:true})}}))`)
    assert.equal((await page.evaluate(WINDOW_STATE)).state,'waiting','old-document ACK cannot prove the new document')
    await themeProbe(page,'(window.ack(themeRequests.length-1),true)');await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='ready'),'new document ACK')
    await page.evaluate(`dispatchEvent(new MessageEvent('message',{source:previousThemeFrame,origin:${JSON.stringify(framing.allow)},data:${JSON.stringify({...old,applied:false})}}))`)
    assert.equal((await page.evaluate(WINDOW_STATE)).state,'ready','superseded invalidation cannot undo fresh proof')
    await page.resize(390,600);await sleep(100)
    assert.equal((await page.evaluate(WINDOW_STATE)).src,null);assert.equal(await page.evaluate("document.querySelector('.preview-iframe').getAttribute('name')"),'original-preview-frame')
    await page.resize(1440,900);await page.evaluate(IN_VIEW)
    await idlePending(page);await page.evaluate('flushIdle()')
    await waitFor(()=>themeRequests(page).then(q=>q.length>0).catch(()=>false),'new desktop document')
    const after=(await themeRequests(page)).at(-1).data;assert.ok(after.requestId>fresh.requestId)
    assert.equal((await page.evaluate(WINDOW_STATE)).state,'waiting')
    await themeProbe(page,'(window.ack(themeRequests.length-1),true)');await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='ready'),'fresh desktop ACK')
  }finally{await page.close()}
})


for(const activation of ['load','click','visible']){
 test(`theme bridge ${activation} preserves static zero requests and admitted activation`,{skip},async()=>{
  const name=activation==='visible'?'themed-ready':`themed-${activation}`
  const page=await openPage(browser.cdp,deniedBase,name,390,{beforeScript:CONTROL_IDLE})
  try{
   await loadedParent(page);await page.evaluate(IN_VIEW);await sleep(200)
   assert.equal(page.documentRequests.filter(u=>u.startsWith(framing.allow)).length,0)
   assert.equal((await page.evaluate(WINDOW_STATE)).src,null)
   await page.resize(1440,900);await page.evaluate(IN_VIEW)
   if(activation==='click'){
    await sleep(100);assert.equal(page.documentRequests.filter(u=>u.startsWith(framing.allow)).length,0)
    await page.evaluate("document.querySelector('.preview-activate').click()")
   }else if(activation==='visible'){await idlePending(page);await page.evaluate('flushIdle()')}
   await waitFor(()=>themeRequests(page).then(q=>q.length>0).catch(()=>false),'eligible theme request')
   assert.equal((await page.evaluate(WINDOW_STATE)).state,'waiting')
   await themeProbe(page,'(window.ack(themeRequests.length-1),true)');await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='ready'),'eligible ACK')
  }finally{await page.close()}
 })
}

test('theme seed overflow fails closed before navigation while preserving visible fallback/action',{skip},async()=>{
 const beforeScript="document.addEventListener('DOMContentLoaded',()=>document.querySelector('.preview-content').dataset.themeMessage='x'.repeat(600),{once:true})"
 const page=await openPage(browser.cdp,deniedBase,'themed-ready',1440,{beforeScript})
 try{
  await loadedParent(page);await page.evaluate(IN_VIEW);await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='failed'),'seed admission failure')
  assert.equal(page.documentRequests.filter(u=>u.startsWith(framing.allow)).length,0)
  assert.equal((await page.evaluate(WINDOW_STATE)).src,null)
  assert.equal((await page.evaluate(FEEDBACK_PAINT)).word,'Unavailable')
  await positionWindow(page);assertWindowAction(await page.evaluate(WINDOW_ACTION))
 }finally{await page.close()}
})

test('theme rapid changes supersede pending proof and late matching ACK recovers failure', {skip},async()=>{
 const page=await openPage(browser.cdp,deniedBase,'themed-ready',1440,{beforeScript:CONTROL_IDLE})
 try{
  const first=await startThemed(page);await themeProbe(page,'(window.ack(0),true)');await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='ready'),'first ACK')
  await page.evaluate("document.documentElement.dataset.bsTheme='light'");await waitFor(()=>themeRequests(page).then(q=>q.length>=2),'pending light')
  await page.evaluate("document.documentElement.dataset.bsTheme='dark'");await waitFor(()=>themeRequests(page).then(q=>q.length>=3),'superseding dark')
  const fresh=(await themeRequests(page)).at(-1).data;assert.ok(fresh.requestId>first.requestId)
  await themeProbe(page,'(window.ack(1),true)');await sleep(30);assert.equal((await page.evaluate(WINDOW_STATE)).state,'waiting')
  await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='failed'),'theme ACK deadline')
  await themeProbe(page,'(window.ack(themeRequests.length-1),true)');await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='ready'),'late current ACK')
 }finally{await page.close()}
})

test('theme disconnect cancels pending ownership and reinsertion needs fresh eligible proof', {skip},async()=>{
 const page=await openPage(browser.cdp,deniedBase,'themed-ready',1440,{beforeScript:CONTROL_IDLE})
 try{
  await loadedParent(page);await page.evaluate(IN_VIEW);await idlePending(page);await page.evaluate('flushIdle()')
  await waitFor(()=>themeRequests(page).then(q=>q.length>0).catch(()=>false),'first request');const old=(await themeRequests(page)).at(-1).data
  await page.evaluate("window.detachedSection=document.querySelector('section.preview');window.detachedFrame=detachedSection.querySelector('iframe').contentWindow;detachedSection.remove()")
  await sleep(100)
  await page.evaluate(`dispatchEvent(new MessageEvent('message',{source:detachedFrame,origin:${JSON.stringify(framing.allow)},data:${JSON.stringify({...old,applied:true})}}))`)
  const before=page.documentRequests.filter(u=>u.startsWith(framing.allow)).length
  await page.evaluate("document.body.append(detachedSection);detachedSection.scrollIntoView({block:'center'})")
  await idlePending(page);assert.equal(page.documentRequests.filter(u=>u.startsWith(framing.allow)).length,before,'no request before fresh idle')
  await page.evaluate('flushIdle()');await waitFor(()=>themeRequests(page).then(q=>q.length>0).catch(()=>false),'fresh request')
  const fresh=(await themeRequests(page)).at(-1).data;assert.ok(fresh.requestId>old.requestId)
  assert.equal((await page.evaluate(WINDOW_STATE)).state,'waiting')
  await themeProbe(page,'(window.ack(themeRequests.length-1),true)');await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='ready'),'fresh reinsert ACK')
 }finally{await page.close()}
})

for(const height of [220,240,320,768])for(const name of ['window-visible','window-ok','window-503','window-fallback']){
 test(`window visible concise state and entire action survive ${name} at1440x${height}`,{skip},async t=>{
  const page=await openPage(browser.cdp,base,name,1440,{height,beforeScript:name==='window-visible'?CONTROL_IDLE:''})
  try{
   await loadedParent(page);await page.evaluate("document.querySelector('.navbar').style.height='91px'");await sleep(100);await positionWindow(page)
   if(name==='window-visible'){await idlePending(page);await page.evaluate('flushIdle()')}
   if(name==='window-ok'||name==='window-503')await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state===(name==='window-ok'?'ready':'failed')),'state')
   const b=await page.evaluate(WINDOW_ACTION);assertWindowAction(b)
   const word=await page.evaluate("(()=>{const el=document.querySelector('.preview-window-state'),r=el.getBoundingClientRect(),w=el.closest('.preview-window').getBoundingClientRect();return {text:el.innerText,inside:r.left>=w.left&&r.right<=w.right&&r.top>=w.top&&r.bottom<=w.bottom,hit:el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)),height:r.height}})()")
   t.diagnostic(JSON.stringify({b,word}));assert.ok(word.text&&word.inside&&word.hit,JSON.stringify(word));assert.ok(word.height>0)
   if(name==='window-fallback'){
    const fallback=await page.evaluate("(()=>{const e=document.querySelector('.preview-error:not(.d-none)'),status=e.querySelector('.preview-fallback-status'),label=[...e.querySelectorAll('.preview-feedback-full,.preview-feedback-short')].find(x=>x.offsetWidth),r=label?.getBoundingClientRect();return {scrim:getComputedStyle(e,'::after').backgroundColor,hit:!!r&&[[r.left+1,r.top+1],[r.right-1,r.top+1],[r.left+1,r.bottom-1],[r.right-1,r.bottom-1],[(r.left+r.right)/2,(r.top+r.bottom)/2]].every(([x,y])=>status.contains(document.elementFromPoint(x,y)))}})()")
    assert.equal(fallback.scrim,'rgba(0, 0, 0, 0.3)');assert.ok(fallback.hit,JSON.stringify(fallback))
   }
   if(height<=240)assert.ok(['Preview','Wait','Live','Error'].includes(word.text))
   if(name==='window-visible'){const paint=await page.evaluate(FEEDBACK_PAINT);assert.ok(paint.hit,JSON.stringify(paint));assert.equal(paint.scrim,'rgba(0, 0, 0, 0.3)')}
  }finally{await page.close()}
 })
}

for(const name of ['preview','preview-devices','preview-click','preview-items','preview-ready','preview-window'])for(const width of [390,1440]){
 test(`public local ${name} paints a real matching native child at ${width}`,{skip},async()=>{
  const page=await openPage(browser.cdp,base,`components/${name}`,width)
  try{
   await loadedParent(page);await page.evaluate(IN_VIEW)
   if(name==='preview-window'&&width<1024){await sleep(150);assert.deepEqual(page.localRequests,[]);return}
   if(['preview-click','preview-items','preview-ready'].includes(name)){
    assert.deepEqual(page.localRequests,[],'poster is shown before activation')
    await activateWithEnter(page)
   }
   await waitFor(()=>page.evaluate("[...document.querySelectorAll('.preview-content>.tab-pane')].find(p=>p.offsetParent)?.dataset.previewState==='ready'"),'real public ready child')
   assert.ok(page.localRequests.every(u=>u.startsWith(base+'/preview-demo/')))
   const content=await page.evaluate("(()=>{const p=[...document.querySelectorAll('.preview-content>.tab-pane')].find(p=>p.offsetParent),f=p.querySelector('iframe');return {text:f.contentDocument.body.innerText,width:f.contentWindow.innerWidth,height:f.contentWindow.innerHeight,theme:f.contentDocument.documentElement.dataset.bsTheme,reference:[f.offsetWidth,f.offsetHeight]}})()")
   assert.ok(content.text.includes('Project workspace'))
   assert.deepEqual(content.reference,width<640&&name!=='preview-window'?[402,874]:[1440,900]);assert.ok(content.width>0&&content.height>0)
   await page.evaluate("(()=>{const f=[...document.querySelectorAll('.preview-content>.tab-pane')].find(p=>p.offsetParent).querySelector('iframe');f.contentDocument.querySelector('[data-add-task]').click()})()")
   assert.equal(await page.evaluate("[...document.querySelectorAll('.preview-content>.tab-pane')].find(p=>p.offsetParent).querySelector('iframe').contentDocument.body.innerText.includes('New task 1')"),true,'a working live page, not a screenshot')
  }finally{await page.close()}
 })
}


test('static CSS prevents a pending spinner or scrim even before lifecycle JavaScript runs',{skip},async()=>{
 const beforeScript="document.addEventListener('DOMContentLoaded',()=>document.querySelector('.tab-pane.active').dataset.previewState='waiting',{once:true})"
 const page=await openPage(browser.cdp,base,'window-visible',390,{height:600,skipPreviewScript:true,beforeScript})
 try{await loadedParent(page);await page.evaluate(IN_VIEW);const b=await page.evaluate(FEEDBACK_PAINT);assert.equal(b.word,'Preview');assert.notEqual(b.scrim,'rgba(0, 0, 0, 0.3)');assert.deepEqual(page.requests,[])}finally{await page.close()}
})


test('opt-in theme child that ignores the normal ready query fails safely after its announcement',{skip},async()=>{
 const page=await openPage(browser.cdp,deniedBase,'themed-announce',1440)
 try{
  await loadedParent(page);await page.evaluate(IN_VIEW);await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='failed'),'silent query deadline')
  assert.equal((await themeRequests(page)).length,0,'no applied proof from an initial announcement alone')
  assert.equal((await page.evaluate(FEEDBACK_PAINT)).word,'Unavailable')
  assert.equal(await page.evaluate("document.querySelector('.tab-pane.active iframe').hasAttribute('inert')"),true)
 }finally{await page.close()}
})


test('static phone fallback stays Preview with no error scrim, spinner or child request',{skip},async()=>{
 const page=await openPage(browser.cdp,base,'window-fallback-static',390,{height:600})
 try{
  await loadedParent(page);await page.evaluate(IN_VIEW);await sleep(100)
  const value=await page.evaluate("(()=>{const e=document.querySelector('.preview-error:not(.d-none)');return {word:document.querySelector('.preview-window-state').innerText,scrim:getComputedStyle(e,'::after').backgroundColor,status:getComputedStyle(e.querySelector('.preview-fallback-status')).display,src:document.querySelector('.preview-iframe').getAttribute('src')}})()")
  assert.equal(value.word,'Preview');assert.notEqual(value.scrim,'rgba(0, 0, 0, 0.3)');assert.equal(value.status,'none');assert.equal(value.src,null);assert.deepEqual(page.requests,[])
  await positionWindow(page);assertWindowAction(await page.evaluate(WINDOW_ACTION))
 }finally{await page.close()}
})


const OWNER_SNAPSHOT = `(() => {
 const section=window.ownershipSection,container=section.querySelector('.preview-content'),frame=container.querySelector('iframe'),pane=frame.closest('.tab-pane');
 return {connected:section.isConnected,owned:section.ownerDocument===document,src:frame.getAttribute('src'),active:container.dataset.active||null,state:pane.dataset.previewState||null,top:section.getBoundingClientRect().top}
})()`
const TAKE_OUT = `window.ownershipSection=document.querySelector('section.preview');window.ownershipFrame=ownershipSection.querySelector('iframe').contentWindow;
 window.ownershipForeign=document.implementation.createHTMLDocument('Temporary preview host');ownershipForeign.body.append(ownershipForeign.adoptNode(ownershipSection));`
const RETURN_BELOW = `scrollTo(0,0);const spacer=document.createElement('div');spacer.style.height='3000px';document.body.append(spacer,document.adoptNode(ownershipSection));`
for(const themed of [true,false])for(const kind of ['adopt150','remove150','adoptRapid','removeRapid']){
 test(`ownership ${themed?'themed':'unthemed'} ${kind} clears current proof and requires fresh visible admission`,{skip},async t=>{
  const page=await openPage(browser.cdp,themed?base:deniedBase,themed?'components/preview-window':'owned-visible',1440,{beforeScript:CONTROL_IDLE})
  const childRequests=()=>page.documentRequests.filter(u=>themed?u.startsWith(base+'/preview-demo/'):u.startsWith(framing.allow))
  try{
   await loadedParent(page);await page.evaluate(IN_VIEW);await idlePending(page);await page.evaluate('flushIdle()');await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='ready'),'actual local child ready')
   const before=childRequests().length
   await page.evaluate("window.oldOwnershipRelease=document.querySelector('hinode-preview-owner').previewRelease;window.ownershipElement=document.querySelector('section.preview iframe')")
   const element=(await page.send('Runtime.evaluate',{expression:'ownershipElement'})).result.objectId
   const listeners=()=>page.send('DOMDebugger.getEventListeners',{objectId:element}).then(r=>r.listeners.filter(l=>l.type==='load'))
   assert.ok((await listeners()).length>0,'actual watched iframe has a load listener')
   const leave=kind.startsWith('adopt')?TAKE_OUT:"window.ownershipSection=document.querySelector('section.preview');window.ownershipFrame=ownershipSection.querySelector('iframe').contentWindow;ownershipSection.remove();"
   if(kind.endsWith('150')){
    await page.evaluate(leave);await sleep(150)
    const foreign=await page.evaluate(OWNER_SNAPSHOT);t.diagnostic(JSON.stringify({foreign}))
    if(kind.startsWith('adopt'))assert.deepEqual([foreign.connected,foreign.owned],[true,false],'inert-document adoption is connected but not owned')
    assert.equal(foreign.src,null,'release src after ownership ends');assert.equal(foreign.active,null);assert.equal(foreign.state,null)
    await page.evaluate(RETURN_BELOW)
   }else await page.evaluate(leave+RETURN_BELOW)
   await sleep(400)
   const returned=await page.evaluate(OWNER_SNAPSHOT);t.diagnostic(JSON.stringify({returned,requests:childRequests().slice(before)}))
   assert.ok(returned.owned&&returned.connected&&returned.top>900,'returned component remains below fold')
   assert.deepEqual(childRequests().slice(before),[],'no re-adoption navigation without fresh visible admission')
   assert.equal(returned.src,null);assert.equal(returned.active,null);assert.equal(returned.state,null)
   assert.equal((await listeners()).length,0,'release removes the old native iframe load listener')
   await page.evaluate(`dispatchEvent(new MessageEvent('message',{source:ownershipFrame,origin:location.origin,data:document.querySelector('.preview-content').dataset.readyMessage}))`)
   assert.equal((await page.evaluate(OWNER_SNAPSHOT)).state,null,'old window readiness cannot restore proof')
   await page.evaluate(IN_VIEW);await idlePending(page);assert.equal(childRequests().length,before,'fresh idle must still be admitted');await page.evaluate('flushIdle()')
   await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='ready'),'fresh actual child ready')
   assert.equal(childRequests().length,before+1)
   await page.evaluate('oldOwnershipRelease()');await sleep(50)
   assert.equal((await page.evaluate(WINDOW_STATE)).state,'ready','old owning-controller callback cannot release the new owner')
  }finally{await page.close()}
 })
}

for(const themed of [true,false])test(`ownership pending idle ${themed?'themed':'unthemed'} adoption rejects stale callback`,{skip},async()=>{
 const page=await openPage(browser.cdp,themed?base:deniedBase,themed?'components/preview-window':'owned-visible',1440,{beforeScript:CONTROL_IDLE})
 try{
  await loadedParent(page);await page.evaluate(IN_VIEW);await idlePending(page)
  await page.evaluate('window.ownershipIdle=[...idleCallbacks.values()][0];'+TAKE_OUT)
  await sleep(150);await page.evaluate('ownershipIdle({});flushIdle()')
  assert.equal(page.documentRequests.filter(u=>themed?u.startsWith(base+'/preview-demo/'):u.startsWith(framing.allow)).length,0)
  await page.evaluate(RETURN_BELOW);await sleep(150);await page.evaluate('ownershipIdle({});flushIdle()')
  assert.equal((await page.evaluate(OWNER_SNAPSHOT)).src,null)
  await page.evaluate(IN_VIEW);await idlePending(page);await page.evaluate('ownershipIdle({})');await sleep(50)
  assert.equal((await page.evaluate(OWNER_SNAPSHOT)).src,null,'stale idle cannot bypass the newly admitted owner')
  await page.evaluate('flushIdle()');await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='ready'),'fresh eligible current owner')
 }finally{await page.close()}
})


const NO_NATIVE_OWNER = `Object.defineProperty(window,'customElements',{value:undefined,configurable:true});`
for(const name of ['window-visible','window-load','window-click'])test(`ownership capability absence keeps enhanced ${name} static without new UI copy`,{skip},async()=>{
 const page=await openPage(browser.cdp,base,name,1440,{beforeScript:NO_NATIVE_OWNER+CONTROL_IDLE})
 try{
  await loadedParent(page);await page.evaluate(IN_VIEW);await sleep(150);await page.evaluate('flushIdle()')
  assert.deepEqual(page.requests,[]);const state=await page.evaluate(WINDOW_STATE);assert.equal(state.src,null);assert.equal(state.state,null)
  assert.equal(state.static,'true');assert.equal((await page.evaluate(FEEDBACK_PAINT)).word,'Preview')
  assert.equal(await page.evaluate("getComputedStyle(document.querySelector('.preview-iframe')).display"),'none')
  assert.equal(await page.evaluate("document.querySelector('.preview-activate')?getComputedStyle(document.querySelector('.preview-activate')).display:'none'"),'none')
  await positionWindow(page);assertWindowAction(await page.evaluate(WINDOW_ACTION))
 }finally{await page.close()}
})
for(const name of ['default','click'])test(`ownership capability absence preserves unconfigured legacy ${name}`,{skip},async()=>{
 const page=await openPage(browser.cdp,base,name,1440,{beforeScript:NO_NATIVE_OWNER})
 try{
  await loadedParent(page);await page.evaluate(IN_VIEW)
  if(name==='click'){assert.deepEqual(page.requests,[]);await activateWithEnter(page)}
  await waitFor(()=>page.requests.length===1,'legacy default activation')
  assert.equal(await page.evaluate("document.querySelector('.preview-content').dataset.previewStatic||null"),null)
 }finally{await page.close()}
})


for(const themed of [true,false])test(`guarded active clone ${themed?'themed':'unthemed'} has no app request or copied live proof`,{skip},async t=>{
 const page=await openPage(browser.cdp,themed?base:deniedBase,themed?'components/preview-window':'owned-visible',1440,{beforeScript:CONTROL_IDLE})
 const documents=()=>page.documentRequests.filter(u=>themed?u.startsWith(base+'/preview-demo/'):u.startsWith(framing.allow))
 const wire=async()=>themed?servers[0].previewRequests.length:(await framing.counts()).allow
 try{
  await loadedParent(page);await page.evaluate(IN_VIEW);await idlePending(page);await page.evaluate('flushIdle()');await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='ready'),'real source ready')
  const before=documents().length,wireBefore=await wire()
  await page.evaluate("window.ownershipSection=document.querySelector('section.preview').cloneNode(true);document.querySelector('section.preview').remove();scrollTo(0,0);const spacer=document.createElement('div');spacer.style.height='3000px';document.body.append(spacer,ownershipSection)")
  await sleep(400);const snapshot=await page.evaluate(OWNER_SNAPSHOT);t.diagnostic(JSON.stringify({snapshot,requests:documents().slice(before),wire:(await wire())-wireBefore}))
  assert.deepEqual(documents().slice(before),[]);assert.equal(await wire(),wireBefore);assert.equal(snapshot.src,null);assert.equal(snapshot.active,null);assert.equal(snapshot.state,null)
  assert.equal(await page.evaluate("ownershipSection.querySelector('.preview-content').dataset.previewStatic||null"),null,'supported clone must remain eligible for fresh live admission')
  assert.equal(await page.evaluate("ownershipSection.querySelector('.preview-window-state').innerText"),'Preview')
  await page.evaluate(IN_VIEW);await idlePending(page);assert.equal(await wire(),wireBefore);await page.evaluate('flushIdle()');await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='ready'),'fresh clone admission')
  assert.equal(await wire(),wireBefore+1)
 }finally{await page.close()}
})
for(const policy of ['no-referrer','same-origin','strict-origin'])test(`guard incompatible iframe referrer ${policy} stays static without a request`,{skip},async()=>{
 const beforeScript=CONTROL_IDLE+`document.addEventListener('DOMContentLoaded',()=>document.querySelectorAll('section.preview iframe').forEach(f=>f.referrerPolicy='${policy}'),{once:true})`
 const page=await openPage(browser.cdp,base,'components/preview-window',1440,{beforeScript})
 try{
  await loadedParent(page);await page.evaluate(IN_VIEW);await sleep(100);await page.evaluate('flushIdle()');await sleep(100)
  assert.deepEqual(page.localRequests,[]);const state=await page.evaluate(WINDOW_STATE);assert.equal(state.src,null);assert.equal(state.state,null);assert.equal(state.static,'true');assert.equal((await page.evaluate(FEEDBACK_PAINT)).word,'Preview')
  assert.equal(await page.evaluate('document.querySelector("section.preview iframe").referrerPolicy'),policy)
 }finally{await page.close()}
})


test('native blank guard is not app readiness, a restarted navigation or a deadline reset',{skip},async()=>{
 const page=await openPage(browser.cdp,base,'window-guard-held',1440,{beforeScript:CONTROL_IDLE});const before=servers[0].previewRequests.length
 try{
  await loadedParent(page);await page.evaluate(IN_VIEW);await idlePending(page);await page.evaluate('flushIdle()');await waitFor(()=>servers[0].previewRequests.length===before+1,'one held actual HTTP app request')
  assert.equal(await page.evaluate("document.querySelector('section.preview iframe').contentDocument.URL"),'about:srcdoc')
  assert.equal((await page.evaluate(WINDOW_STATE)).state,'waiting','blank native load never marks Live without an app load')
  await sleep(1300);await page.evaluate("document.querySelector('section.preview iframe').dispatchEvent(new Event('load'))")
  await sleep(900);assert.equal((await page.evaluate(WINDOW_STATE)).state,'failed','blank load cannot reset the real app deadline')
  assert.equal(servers[0].previewRequests.length,before+1,'blank load never recursively restarts the app')
  servers[0].releaseHeld();await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='ready'),'actual late HTTP app load recovers normally')
  assert.equal(await page.evaluate("document.querySelector('section.preview iframe').contentDocument.querySelector('h1').textContent"),'Project workspace')
 }finally{servers[0].releaseHeld();await page.close()}
})

test('empty guard prevents implicit two-owner wire requests before fresh admission',{skip},async()=>{
 const page=await openPage(browser.cdp,base,'components/preview-window',1440,{beforeScript:CONTROL_IDLE})
 try{
  await loadedParent(page);await page.evaluate(IN_VIEW);await idlePending(page);await page.evaluate('flushIdle()');await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='ready'),'first actual owner ready')
  await page.evaluate(`window.ownershipSection=document.querySelector('section.preview');const host=document.createElement('iframe');host.id='guard-owner';host.src='${base}/components/preview-window/';host.style.cssText='position:fixed;inset:0;width:1440px;height:900px;z-index:9999';document.body.append(host)`)
  await waitFor(()=>page.evaluate("document.querySelector('#guard-owner').contentDocument?.querySelector('.tab-pane.active')?.dataset.previewState==='ready'"),'independent second owner ready')
  const before=servers[0].previewRequests.length
  await page.evaluate(()=>{const d=document.querySelector('#guard-owner').contentDocument,w=d.defaultView;d.querySelector('section.preview').remove();w.heldOwnerIdles=new Map();w.heldOwnerSerial=0;w.requestIdleCallback=fn=>{w.heldOwnerIdles.set(++w.heldOwnerSerial,fn);return w.heldOwnerSerial};w.cancelIdleCallback=id=>w.heldOwnerIdles.delete(id);d.body.prepend(ownershipSection)})
  await waitFor(()=>page.evaluate("document.querySelector('#guard-owner').contentWindow.heldOwnerIdles.size>0"),'recipient fresh idle')
  await sleep(150);assert.equal(servers[0].previewRequests.length,before,'implicit adoption must not leak an aborted wire GET')
  assert.equal(await page.evaluate("document.querySelector('#guard-owner').contentDocument.querySelector('.preview-content').dataset.active||null"),null)
  assert.equal(await page.evaluate("document.querySelector('#guard-owner').contentDocument.querySelector('.tab-pane.active').dataset.previewState||null"),null)
  await page.evaluate(()=>{const w=document.querySelector('#guard-owner').contentWindow,callbacks=[...w.heldOwnerIdles.values()];w.heldOwnerIdles.clear();callbacks.forEach(fn=>fn({didTimeout:false,timeRemaining:()=>20}))})
  await waitFor(()=>page.evaluate("document.querySelector('#guard-owner').contentDocument.querySelector('.tab-pane.active').dataset.previewState==='ready'"),'recipient actual app ready')
  assert.equal(servers[0].previewRequests.length,before+1)
  const returnBefore=servers[0].previewRequests.length
  await page.evaluate("scrollTo(0,0);const spacer=document.createElement('div');spacer.style.height='3000px';document.body.append(spacer,ownershipSection)")
  await sleep(300);assert.equal(servers[0].previewRequests.length,returnBefore,'implicit return below-fold has zero wire GET')
  const returned=await page.evaluate(OWNER_SNAPSHOT);assert.equal(returned.src,null);assert.equal(returned.active,null);assert.equal(returned.state,null);assert.ok(returned.top>900)
  await page.evaluate("document.querySelector('#guard-owner').remove()");await page.evaluate(IN_VIEW);await idlePending(page);assert.equal(servers[0].previewRequests.length,returnBefore);await page.evaluate('flushIdle()');await waitFor(()=>page.evaluate(WINDOW_STATE).then(s=>s.state==='ready'),'fresh original owner ready')
  assert.equal(servers[0].previewRequests.length,returnBefore+1)
 }finally{await page.close()}
})
