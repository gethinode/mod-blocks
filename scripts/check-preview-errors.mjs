// Builds the exampleSite with a throwaway content directory of preview blocks and
// checks what the build logs. Invalid `devices` must fail the build with the
// partial's error, and `warn-preview-device` must fire for exactly the blocks that
// earn it. An error fails the whole Hugo build, and the fixtures in
// exampleSite/content/test-preview.md only see the rendered output, so these
// cases cannot live among them. The last checks render with the site parameter
// that Bookshop live editing sets, and with a site language other than English,
// which the fixtures cannot vary per block.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// pages maps a page name to the extra YAML lines of its one preview block, which
// also gets url: https://example.org/, or to { url, lines } to give it another url,
// or none when url is null. env adds
// environment variables to the build, config adds TOML that overrides the site
// config, and html holds each built page. A build that runs longer than two
// minutes is stopped.
function build (pages, env = {}, config = '') {
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
// language gets its own label.
for (const [lang, label] of [['de', 'Vorschau laden'], ['fr', 'Charger l\'aperçu'], ['nl', 'Voorbeeld laden'], ['pl', 'Załaduj podgląd']]) {
  test(`with ${lang} as the site language, the poster button reads ${label}`, () => {
    const result = build({ click: ['activation: click'] }, {}, `defaultContentLanguage = '${lang}'\n[languages.${lang}]\n  weight = 1\n`)
    assert.equal(result.status, 0, result.log)
    const labels = [...result.html.click.matchAll(/class="btn btn-primary preview-activate">([^<]*)</g)].map(([, text]) => text.trim().replaceAll('&#39;', "'"))
    assert.deepEqual(labels, [label, label, label])
  })
}

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

test('items check embedding once per distinct origin, until one shows the fallback', () => {
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
  assert.deepEqual(requested, ['https://preview-one.invalid/a', 'https://preview-three.invalid/e', 'https://preview-two.invalid/c'])
  const csp = [...result.log.matchAll(/URL '([^']+)' allows being framed, but is not covered/g)].map(([, url]) => url)
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
  })
}
