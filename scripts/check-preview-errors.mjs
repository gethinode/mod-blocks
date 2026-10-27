// Builds the exampleSite with a throwaway content directory of preview blocks and
// checks what the build logs. Invalid `devices` must fail the build with the
// partial's error, and `warn-preview-device` must fire for exactly the blocks that
// earn it. An error fails the whole Hugo build, and the fixtures in
// exampleSite/content/test-preview.md only see the rendered output, so these
// cases cannot live among them. The last checks render with the site parameter
// that Bookshop live editing sets, and with a site language other than English,
// which the fixtures cannot vary per block.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'

// pages maps a page name to the extra YAML lines of its one preview block, which
// also gets url: https://example.org/, or to { url, lines } to give it another url,
// or none when url is null. env adds
// environment variables to the build, config adds TOML that overrides the site
// config, and html holds each built page. A build that runs longer than two
// minutes is stopped.
function build (pages, env = {}, config = '', assets = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-errors-'))
  const content = path.join(dir, 'content')
  fs.mkdirSync(content)
  for (const [name, page] of Object.entries(pages)) {
    const { url = 'https://example.org/', lines } = Array.isArray(page) ? { lines: page } : page
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
    ].join('\n'))
  }
  try {
    // On Windows the hugo-extended bin is a .cmd shim, which only a shell resolves.
    const shell = process.platform === 'win32'
    const quote = arg => shell ? `"${arg}"` : arg
    const publish = path.join(dir, 'public')
    const args = ['-s', 'exampleSite', '--contentDir', quote(content), '-d', quote(publish)]
    if (Object.keys(assets).length) {
      const assetDir=path.join(dir,'assets')
      for(const [name,body] of Object.entries(assets)){
        const file=path.join(assetDir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body)
      }
      config += `\n[[module.mounts]]\nsource = "assets"\ntarget = "assets"\n[[module.mounts]]\nsource = '${assetDir.replaceAll('\\','/')}'\ntarget = "assets"\n`
    }
    if (config) {
      const file = path.join(dir, 'config.toml')
      fs.writeFileSync(file, config)
      args.push('--config', quote(`hugo.toml,${file}`))
    }
    const result = spawnSync('hugo', args, { encoding: 'utf8', shell, env: { ...process.env, ...env }, timeout: 120000 })
    const read = name => { try { return fs.readFileSync(path.join(publish, name, 'index.html'), 'utf8') } catch { return '' } }
    const html = Object.fromEntries(Object.keys(pages).map(name => [name, read(name)]))
    return { ...result, log: result.stderr + result.stdout, html }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

for (const [label, devices] of [['an empty list', '[]'], ['an unknown device', '[desktop, phone]']]) {
  test(`devices with ${label} fails the build`, () => {
    const result = build({ _index: [`devices: ${devices}`] })
    assert.notEqual(result.status, 0, 'build succeeded')
    assert.match(result.log, /Invalid argument 'devices'/)
  })
}

test('warn-preview-device fires for an explicit unoffered device and for duplicates only', () => {
  const result = build({
    implicit: ['devices: [mobile]'],
    explicit: ['devices: [mobile]', 'device: desktop'],
    duplicate: ['devices: [mobile, desktop, mobile]']
  })
  assert.equal(result.status, 0, result.log)
  // Each warning of the partial names its message, then the page it comes from.
  // Only the two warn-preview-device messages count: a target that cannot be
  // reached adds a warn-preview-unverified warning to every page.
  const deviceWarnings = ['Duplicate devices', 'Default device not offered']
  const warned = [...result.log.matchAll(/partial \[assets\/preview\.html\] - ([^:\n]+): (\S+)\.md/g)]
    .filter(([, msg]) => deviceWarnings.includes(msg))
    .map(([, msg, page]) => `${page}: ${msg}`)
    .sort()
  assert.deepEqual(warned, ['duplicate: Duplicate devices', 'explicit: Default device not offered'])
  assert.match(result.log, /Devices \[mobile desktop mobile\] list a device more than once; offering \[mobile desktop\]/)
  assert.equal(result.log.match(/ignoreLogs = \['warn-preview-device'\]/g)?.length, 2)
})

// Bookshop live editing can render a block after preview.js scanned the page for
// blocks without controls, when it initialized, so there the markup puts src on
// the default view of a block with load activation.
test('in Bookshop live editing, load puts src on the default view and click on none, with or without controls', () => {
  // The x after HUGO sets the delimiter, so the underscores stay in the key.
  const result = build({
    nocontrols: ['devices: [desktop, mobile]', 'controls: false'],
    'nocontrols-mobile': ['devices: [desktop, mobile]', 'controls: false', 'device: mobile'],
    controls: ['devices: [desktop, mobile]'],
    'controls-mobile': ['devices: [desktop, mobile]', 'device: mobile'],
    click: ['devices: [desktop, mobile]', 'controls: false', 'activation: click'],
    'click-controls': ['devices: [desktop, mobile]', 'activation: click']
  }, { HUGOxPARAMSxENV_BOOKSHOP_LIVE: 'true' })
  assert.equal(result.status, 0, result.log)
  const srcs = html => [...html.matchAll(/<iframe data-src="https:\/\/example\.org\/" src="https:\/\/example\.org\/"\s+class="preview-iframe preview-(\w+)/g)].map(([, device]) => device)
  const all = html => (html.match(/ src="https:\/\/example\.org\//g) || []).length
  for (const [name, want] of [['nocontrols', ['desktop']], ['nocontrols-mobile', ['mobile']], ['controls', ['desktop']], ['controls-mobile', ['mobile']]]) {
    assert.deepEqual(srcs(result.html[name]), want, name)
    assert.equal(all(result.html[name]), 1, name)
  }
  for (const name of ['click', 'click-controls']) {
    assert.equal(all(result.html[name]), 0, name)
    assert.match(result.html[name], /class="btn btn-primary preview-activate"/, name)
  }
})

// The button label comes from the i18n strings of the module, so a site in another
// language gets its own label, and so do the waiting status, runtime failure
// alert and item tablist. A missing translation must not fall back to English.
const LABELS = {
  en: ['Load preview', 'Loading the live preview', 'The live preview is not available right now.', 'View selection'],
  de: ['Vorschau laden', 'Live-Vorschau wird geladen', 'Die Live-Vorschau ist gerade nicht verfügbar.', 'Ansichtsauswahl'],
  fr: ['Charger l\'aperçu', 'Chargement de l\'aperçu en direct', 'L\'aperçu en direct n\'est pas disponible pour le moment.', 'Sélection de la vue'],
  nl: ['Voorbeeld laden', 'Live voorbeeld wordt geladen', 'Het live voorbeeld is nu niet beschikbaar.', 'Weergaveselectie'],
  pl: ['Załaduj podgląd', 'Wczytywanie podglądu na żywo', 'Podgląd na żywo jest teraz niedostępny.', 'Wybór widoku']
}
const text = value => value.trim().replaceAll('&#39;', "'")
for (const [lang, [label, loading, unavailable, selection]] of Object.entries(LABELS)) {
  test(`with ${lang} as the site language, the poster, status, failure and item tablist labels are ${lang}`, () => {
    const result = build({
      click: {
        url: null,
        lines: ['activation: click', 'ready_message: demo:ok', 'items:',
          '  - title: First view', '    url: https://example.org/a',
          '  - title: Second view', '    url: https://example.org/b']
      }
    }, {}, `defaultContentLanguage = '${lang}'\n[languages.${lang}]\n  weight = 1\n`)
    assert.equal(result.status, 0, result.log)
    const labels = [...result.html.click.matchAll(/class="btn btn-primary preview-activate">([^<]*)</g)].map(([, value]) => text(value))
    assert.deepEqual(labels, [label, label, label])
    const statuses = [...result.html.click.matchAll(/class="preview-waiting" role="status" aria-label="[^"]*">.*?<span class="preview-feedback-full">([^<]*)<\/span>/g)].map(([, value]) => text(value))
    assert.deepEqual(statuses, [loading, loading, loading])
    const alerts = [...result.html.click.matchAll(/preview-unavailable-alert" role="alert" aria-label="[^"]*">[\s\S]*?<span class="preview-feedback-full">([^<]*)<a /g)].map(([, value]) => text(value))
    assert.deepEqual(alerts, [unavailable, unavailable, unavailable])
    const tablists = [...result.html.click.matchAll(/class="[^"]*preview-items" role="tablist" aria-label="([^"]*)"/g)].map(([, value]) => text(value))
    assert.deepEqual(tablists, [selection])
  })
}

test('the open link, load timeout and ready message read kebab-case keys too', () => {
  const result = build({ kebab: ['open-link: true', 'load-timeout: 7', 'ready-message: demo:kebab'] })
  assert.equal(result.status, 0, result.log)
  assert.match(result.html.kebab, /<a class="preview-open" href="https:\/\/example\.org\/"/)
  assert.match(result.html.kebab, /data-load-timeout="7" data-ready-message="demo:kebab"/)
})

const item = (title, url, ...lines) => [`  - title: ${title}`, `    url: ${url}`, ...lines.map(line => `    ${line}`)]

test('items replace url with a warn-preview-items warning', () => {
  const result = build({ both: ['items:', ...item('A', 'https://example.org/a'), ...item('B', 'https://example.org/b')] })
  assert.equal(result.status, 0, result.log)
  assert.equal(result.log.match(/partial \[assets\/preview\.html\] - Both url and items: both\.md/g)?.length, 1, result.log)
  assert.match(result.log, /Items replace url 'https:\/\/example\.org\/'; showing 'https:\/\/example\.org\/a' first/)
  assert.match(result.log, /ignoreLogs = \['warn-preview-items'\]/)
  assert.equal((result.html.both.match(/ data-src="https:\/\/example\.org\/a"/g) || []).length, 3)
  assert.doesNotMatch(result.html.both, / data-src="https:\/\/example\.org\/"/)
})

test('items check embedding once per distinct URL, until one shows the fallback', () => {
  // A host under .invalid never resolves, so each check of it logs a warning that
  // names the URL it requested. The site CSP covers the first two hosts only.
  const result = build({
    origins: {
      url: null,
      lines: ['items:', ...item('A', 'https://preview-one.invalid/a'), ...item('B', 'https://preview-one.invalid/b'),
        ...item('C', 'https://preview-two.invalid/c'), ...item('D', 'https://preview-two.invalid/d'),
        ...item('E', 'https://preview-three.invalid/e'), ...item('F', 'https://preview-four.invalid/f')]
    }
  }, {}, '[params.modules.items.csp]\n  frame-src = ["https://preview-one.invalid", "https://preview-two.invalid"]\n')
  assert.equal(result.status, 0, result.log)
  const requested = [...result.log.matchAll(/Request to '([^']+)' failed/g)].map(([, url]) => url).sort()
  assert.deepEqual(requested, ['https://preview-one.invalid/a', 'https://preview-one.invalid/b', 'https://preview-three.invalid/e',
    'https://preview-two.invalid/c', 'https://preview-two.invalid/d'])
  const csp = [...result.log.matchAll(/URL '([^']+)' is not covered by the frame-src directive this site publishes/g)].map(([, url]) => url)
  assert.deepEqual(csp, ['https://preview-three.invalid/e'])
  assert.match(result.html.origins, /class="preview-error"/)
})

test('items on the same origin as the site CSP all render without a fallback', () => {
  const result = build({ same: { url: null, lines: ['items:', ...item('A', 'https://example.org/a'), ...item('B', 'https://example.org/b')] } })
  assert.equal(result.status, 0, result.log)
  assert.match(result.html.same, /class="preview-error d-none"/)
  assert.doesNotMatch(result.log, /warn-preview-csp/)
  assert.doesNotMatch(result.log, /warn-preview-items/, 'no url, so no warning that items replace it')
})

for (const [label, lines] of [['a title', ['  - url: https://example.org/a']], ['a url', ['  - title: A']]]) {
  test(`an item without ${label} fails the build`, () => {
    const result = build({ _index: { url: null, lines: ['items:', ...lines] } })
    assert.notEqual(result.status, 0, 'build succeeded')
    assert.match(result.log, /Invalid argument 'items'/)
    assert.match(result.log, /Item 1 needs both a title and a url/, 'items count from 1')
  })
}

// The alerts of the fallback, each as the URL in its text and the URL of its link.
const alerts = html => [...html.matchAll(/<div class="alert alert-warning" role="alert">([\s\S]*?)<\/div>/g)]
  .map(([, body]) => [body.match(/<code>([^<]*)<\/code>/)?.[1], body.match(/<a href="([^"]*)"/)?.[1]])

test('the fallback alert names the item URL whose origin shows the fallback', () => {
  // The first item is on an origin the site CSP covers; the second is not.
  const result = build({
    later: { url: null, lines: ['items:', ...item('A', 'https://example.org/a'), ...item('B', 'https://preview-blocked.invalid/b')] },
    explicit: { url: null, lines: ['show_fallback: true', 'items:', ...item('A', 'https://example.org/a'), ...item('B', 'https://preview-blocked.invalid/b')] }
  })
  assert.equal(result.status, 0, result.log)
  const blocked = 'https://preview-blocked.invalid/b'
  assert.deepEqual(alerts(result.html.later), [[blocked, blocked], [blocked, blocked], [blocked, blocked]])
  assert.match(result.html.later, /class="preview-error"/)
  const first = 'https://example.org/a'
  assert.deepEqual(alerts(result.html.explicit), [[first, first], [first, first], [first, first]], 'an explicit fallback names the first item')
})

// Two servers on 127.0.0.1 that this check owns, in a child process, so they answer
// while the build blocks this one. The first permits framing, except for a path
// ending in /b or a query with v=deny, which get X-Frame-Options: DENY; the second
// denies every path. Each server logs the requests it answers to a file.
const SERVER = `
const http = require('node:http')
const fs = require('node:fs')
const listen = (name, deny) => new Promise(resolve => {
  const server = http.createServer((req, res) => {
    fs.appendFileSync(process.env.PREVIEW_LOG, JSON.stringify({ server: name, path: req.url }) + '\\n')
    res.writeHead(200, { 'Content-Type': 'text/html', ...(deny(new URL(req.url, 'http://x')) ? { 'X-Frame-Options': 'DENY' } : {}) })
    res.end('<p>stub</p>')
  })
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})
Promise.all([
  listen('allow', url => url.pathname.endsWith('/b') || url.searchParams.get('v') === 'deny'),
  listen('deny', () => true)
]).then(ports => console.log(ports.join(' ')))
`
const serverLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'preview-servers-')), 'requests.jsonl')
let servers, allowPort, ALLOW, DENY, LOCAL_CSP
before(async () => {
  servers = spawn(process.execPath, ['-e', SERVER], { env: { ...process.env, PREVIEW_LOG: serverLog }, stdio: ['ignore', 'pipe', 'inherit'] })
  const ports = await new Promise((resolve, reject) => {
    servers.stdout.once('data', data => resolve(String(data).trim().split(' ').map(Number)))
    servers.once('error', reject)
  })
  allowPort = ports[0]
  ALLOW = `http://127.0.0.1:${ports[0]}`
  DENY = `http://127.0.0.1:${ports[1]}`
  // Hugo refuses remote requests to an IP address by default, so this config permits
  // the loopback servers of this check only, and the site CSP covers their http origins.
  LOCAL_CSP = `[security.http]\n  urls = ['^https?://127\\.0\\.0\\.1:\\d+/']\n` +
    `[params.modules.items.csp]\n  frame-src = ["${ALLOW}", "${DENY}"]\n`
})
after(() => {
  if (servers) servers.kill()
  fs.rmSync(path.dirname(serverLog), { recursive: true, force: true })
})
// The requests each server answered whose path starts with prefix, in order.
const answered = (server, prefix) => (fs.existsSync(serverLog) ? fs.readFileSync(serverLog, 'utf8').trim().split('\n') : [])
  .filter(Boolean).map(line => JSON.parse(line)).filter(r => r.server === server && r.path.startsWith(prefix)).map(r => r.path)

test('embedding headers are checked for each distinct item URL, with its path and query and without its fragment', () => {
  const result = build({
    paths: { url: null, lines: ['items:', ...item('A', `${ALLOW}/p/a`), ...item('B', `${ALLOW}/p/b`)] },
    queries: {
      url: null,
      lines: ['items:', ...item('A', `${ALLOW}/q/a`), ...item('A2', `${ALLOW}/q/a#second`), ...item('X', `${ALLOW}/q/x?v=allow`),
        ...item('Y', `${ALLOW}/q/x?v=deny#part`), ...item('Z', `${ALLOW}/q/z`)]
    },
    allowed: { url: null, lines: ['items:', ...item('A', `${ALLOW}/r/a`), ...item('A2', `${ALLOW}/r/a#second`), ...item('C', `${ALLOW}/r/c`)] }
  }, {}, LOCAL_CSP)
  assert.equal(result.status, 0, result.log)
  // The /b path on the origin whose /a permits framing shows the fallback.
  assert.deepEqual(answered('allow', '/p/'), ['/p/a', '/p/b'])
  assert.deepEqual(alerts(result.html.paths), Array(3).fill([`${ALLOW}/p/b`, `${ALLOW}/p/b`]))
  assert.match(result.log, new RegExp(`URL '${ALLOW}/p/b' cannot be embedded because it sets 'X-Frame-Options: DENY'`))
  // A query of its own is another check; a fragment is not, and the first refusal ends
  // them. The alert names the item URL as the author wrote it.
  assert.deepEqual(answered('allow', '/q/'), ['/q/a', '/q/x?v=allow', '/q/x?v=deny'])
  assert.deepEqual(alerts(result.html.queries), Array(3).fill([`${ALLOW}/q/x?v=deny#part`, `${ALLOW}/q/x?v=deny#part`]))
  assert.match(result.log, new RegExp(`URL '${ALLOW}/q/x\\?v=deny' cannot be embedded`))
  // Paths that all permit framing render the views, each checked once.
  assert.deepEqual(answered('allow', '/r/'), ['/r/a', '/r/c'])
  assert.equal(result.html.allowed.match(/class="preview-error d-none"/g)?.length, 3)
  assert.match(result.html.allowed, /data-preview-url="http:\/\/127\.0\.0\.1:\d+\/r\/a#second"/)
})

test('a URL on the same host with another port or scheme is checked again', () => {
  const HTTPS = `https://127.0.0.1:${allowPort}`
  const result = build({
    port: { url: null, lines: ['items:', ...item('A', `${ALLOW}/o/a`), ...item('B', `${DENY}/o/a`)] },
    // The https URL reaches a server that does not speak TLS, so its request fails, and
    // the site CSP covers the http origin only.
    scheme: { url: null, lines: ['items:', ...item('A', `${ALLOW}/s/a`), ...item('B', `${HTTPS}/s/a`)] }
  }, {}, LOCAL_CSP)
  assert.equal(result.status, 0, result.log)
  assert.deepEqual(answered('allow', '/o/'), ['/o/a'])
  assert.deepEqual(answered('deny', '/o/'), ['/o/a'])
  assert.deepEqual(alerts(result.html.port), Array(3).fill([`${DENY}/o/a`, `${DENY}/o/a`]))
  assert.deepEqual(answered('allow', '/s/'), ['/s/a'])
  assert.match(result.log, new RegExp(`Request to '${HTTPS}/s/a' failed`))
  assert.deepEqual(alerts(result.html.scheme), Array(3).fill([`${HTTPS}/s/a`, `${HTTPS}/s/a`]))
})

// A URL without a host is a page of this site: the build makes no request for
// its headers and checks it against the frame-src of the site as its own origin.
test('a URL on this site renders when the site frame-src allows its own origin, and shows the fallback when not', () => {
  const allowed = build({ local: { url: '/preview-demo/ready/', lines: [] } })
  assert.equal(allowed.status, 0, allowed.log)
  assert.doesNotMatch(allowed.log, /Could not verify embedding restrictions|iframe blocked by this site's own CSP/)
  assert.match(allowed.html.local, /class="preview-error d-none"/)
  const denied = build({ local: { url: '/preview-demo/ready/', lines: [] } }, {}, '[params.modules.test.csp]\n  frame-src = ["https://example.org"]\n')
  assert.equal(denied.status, 0, denied.log)
  assert.doesNotMatch(denied.log, /Could not verify embedding restrictions/)
  assert.match(denied.log, /URL 'http:\/\/example\.org\/preview-demo\/ready\/' is not covered by the frame-src directive this site publishes/)
  assert.doesNotMatch(denied.html.local, /class="preview-error d-none"/)
})

// A scheme-relative URL has a host, so the build still requests its headers,
// unlike a URL without a host. The security policy of Hugo refuses the request,
// and the build warns that it could not verify the URL.
test('a scheme-relative URL with a host gets the header request, which warns when it fails', () => {
  const result = build({ schemeless: { url: '//example.org/x', lines: [] } })
  assert.equal(result.status, 0, result.log)
  assert.match(result.log, /Could not verify embedding restrictions: schemeless\.md/)
  assert.match(result.log, /Request to '\/\/example\.org\/x' failed/)
})

const WINDOW_LABELS = {
  en: ['Live preview ready', 'Open in new tab'],
  de: ['Live-Vorschau bereit', 'In neuem Tab öffnen'],
  fr: ['Aperçu en direct prêt', 'Ouvrir dans un nouvel onglet'],
  nl: ['Live voorbeeld gereed', 'Open in nieuw tabblad'],
  pl: ['Podgląd na żywo gotowy', 'Otwórz w nowej karcie']
}
for (const [lang, [ready, open]] of Object.entries(WINDOW_LABELS)) {
  test(`window labels render in ${lang}`, () => {
    const result = build({ window: ['frame: window', 'open_link: true', 'ready_message: demo:ok'] }, {},
      `defaultContentLanguage = '${lang}'\n[languages.${lang}]\n  weight = 1\n`)
    assert.equal(result.status, 0, result.log)
    const html = text(result.html.window)
    assert.match(html, new RegExp(`data-ready-label="${ready}"`))
    assert.ok(html.includes(`aria-label="${open}"`), html)
    assert.ok(html.includes(LABELS[lang][1]), 'localized loading status')
    assert.ok(html.includes(LABELS[lang][2]), 'localized unavailable status')
  })
}

test('mobile static presence preserves false underscore and accepts kebab keys', () => {
  const result = build({
    explicit: ['mobile_static: false', 'mobile-static: true'],
    kebab: ['mobile-static: true'],
    title: ['frame: window', 'frame-title: Example window', 'open-url: /open/']
  })
  assert.equal(result.status, 0, result.log)
  assert.doesNotMatch(result.html.explicit, /data-mobile-static=/)
  assert.match(result.html.explicit, / src="https:\/\/example.org\/"/)
  assert.match(result.html.kebab, /data-mobile-static="true"/)
  assert.doesNotMatch(result.html.kebab, / src="https:\/\/example.org\/"/)
  assert.match(result.html.title, /title="Example window"/)
})


test('theme bridge requires readiness and preserves explicit nil and invalid false forwarding', () => {
  const invalid=build({invalid:['theme_message: example:theme']})
  assert.notEqual(invalid.status,0)
  assert.match(invalid.log,/theme-message.*ready-message|ready-message.*theme-message/)
  const valid=build({configured:['ready_message: example:ready','theme_message: example:theme'],
    kebab:['ready-message: example:ready','theme-message: example:theme'],
    omitted:[],nil:['ready_message: example:ready','theme_message: null','theme-message: example:theme']})
  assert.equal(valid.status,0,valid.log)
  for(const name of ['configured','kebab']){
    assert.match(valid.html[name],/data-theme-message="example:theme"/)
    assert.doesNotMatch(valid.html[name],/<iframe[^>]+ src=/,'seed must precede navigation')
  }
  assert.doesNotMatch(valid.html.omitted,/data-theme-message=/)
  assert.doesNotMatch(valid.html.nil,/data-theme-message=/,'explicit nil does not revive kebab value')
  const bad=build({bad:['ready_message: example:ready','theme_message: false','theme-message: example:theme']})
  assert.notEqual(bad.status,0,'false is invalid, not an or-fallback to kebab')
})

test('window action uses the externalLink theme icon alias and forwards explicit zero padding', () => {
  const result=build({custom:['frame: window','open_link: true']},{},'[params.icons]\nexternalLink = "fi-tr arrow-up-right-from-square"\n',{'svgs/fi-tr/arrow-up-right-from-square.svg':'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 3h7v7M21 3L10 14M10 3H3v18h18v-7" fill="none" stroke="currentColor"/></svg>'})
  assert.equal(result.status,0,result.log)
  assert.match(result.html.custom,/fi-tr-arrow-up-right-from-square|fi-tr.*arrow-up-right-from-square/)
  const padded=build({padded:['frame: window','padding: 0']});assert.equal(padded.status,0,padded.log);assert.match(padded.html.padded,/py-0/)
})


const VISIBLE_STATES={en:['Preview','Loading','Live','Unavailable','Wait','Error'],de:['Vorschau','Laden','Live','Nicht verfügbar','Warten','Fehler'],fr:['Aperçu','Chargement','En direct','Indisponible','Attente','Erreur'],nl:['Voorbeeld','Laden','Live','Niet beschikbaar','Wacht','Fout'],pl:['Podgląd','Ładowanie','Na żywo','Niedostępny','Czekaj','Błąd']}
for(const [lang,words]of Object.entries(VISIBLE_STATES))test(`window visible and concise states render in ${lang}`,()=>{
 const result=build({window:['frame: window','open_link: true','ready_message: example:ready']},{},`defaultContentLanguage = '${lang}'\n[languages.${lang}]\nweight = 1\n`)
 assert.equal(result.status,0,result.log)
 const state=result.html.window.match(/<span class="preview-window-state"[^>]+>/)?.[0]
 assert.ok(state)
 for(const word of words)assert.ok(text(state).includes(`="${word}"`),`${lang}: ${word}`)
})

test('explicit false desktop responsive reaches the native public example profile',()=>{
 const result=build({native:['desktop_responsive: false','desktop-responsive: true']})
 assert.equal(result.status,0,result.log)
 assert.match(result.html.native,/data-desktop-responsive="false"/)
})


test('enhanced previews render an empty native guard while legacy source defaults stay unchanged',()=>{
 const result=build({visible:['activation: visible'],static:['mobile_static: true'],theme:['ready_message: example:ready','theme_message: example:theme'],legacy:[],click:['activation: click']})
 assert.equal(result.status,0,result.log)
 for(const name of ['visible','static','theme']){
  const frames=[...result.html[name].matchAll(/<iframe[^>]*>/g)].map(x=>x[0]);assert.equal(frames.length,3)
  assert.ok(frames.every(html=>html.includes('srcdoc=""')),'guard contains no script, source or metadata')
 }
 for(const name of ['legacy','click'])assert.doesNotMatch(result.html[name],/srcdoc=/)
})
