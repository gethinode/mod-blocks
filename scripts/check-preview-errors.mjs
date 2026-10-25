// Builds the exampleSite with a throwaway content directory of preview blocks and
// checks what the build logs. Invalid `devices` must fail the build with the
// partial's error, and `warn-preview-device` must fire for exactly the blocks that
// earn it. An error fails the whole Hugo build, and the fixtures in
// exampleSite/content/test-preview.md only see the rendered output, so these
// cases cannot live among them. The last check renders with the site parameter
// that Bookshop live editing sets, which the fixtures cannot vary per block.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// pages maps a page name to the extra YAML lines of its one preview block. env adds
// environment variables to the build, and html holds each built page.
function build (pages, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-errors-'))
  const content = path.join(dir, 'content')
  fs.mkdirSync(content)
  for (const [name, lines] of Object.entries(pages)) {
    fs.writeFileSync(path.join(content, `${name}.md`), [
      '---',
      `title: ${name}`,
      'modules: [preview]',
      'content_blocks:',
      '  - _bookshop_name: preview',
      '    url: https://example.org/',
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
    const result = spawnSync('hugo', ['-s', 'exampleSite', '--contentDir', quote(content), '-d', quote(publish)], { encoding: 'utf8', shell, env: { ...process.env, ...env } })
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

// preview.js looks up the blocks without controls once, at DOMContentLoaded, so
// a block that Bookshop live editing renders again is never picked. Such a block must then
// load its default view itself, and a block with click activation must still
// load none.
test('in Bookshop live editing, only a block without controls carries src', () => {
  // The x after HUGO sets the delimiter, so the underscores stay in the key.
  const result = build({
    nocontrols: ['devices: [desktop, mobile]', 'controls: false'],
    click: ['devices: [desktop, mobile]', 'controls: false', 'activation: click'],
    controls: ['devices: [desktop, mobile]']
  }, { HUGOxPARAMSxENV_BOOKSHOP_LIVE: 'true' })
  assert.equal(result.status, 0, result.log)
  const srcs = html => [...html.matchAll(/<iframe data-src="https:\/\/example\.org\/" src="https:\/\/example\.org\/"\s+class="preview-iframe preview-(\w+)/g)].map(([, device]) => device)
  assert.deepEqual(srcs(result.html.nocontrols), ['desktop'])
  assert.deepEqual(srcs(result.html.click), [])
  assert.deepEqual(srcs(result.html.controls), ['desktop'])
  assert.equal((result.html.click.match(/ src="https:\/\/example\.org\//g) || []).length, 0)
  assert.match(result.html.click, /class="btn btn-primary preview-activate"/)
})
