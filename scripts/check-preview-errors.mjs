// Builds the exampleSite with a throwaway content directory of preview blocks and
// checks what the build logs. Invalid `devices` must fail the build with the
// partial's error, and `warn-preview-device` must fire for exactly the blocks that
// earn it. An error fails the whole Hugo build, and the fixtures in
// exampleSite/content/test-preview.md only see the rendered output, so these
// cases cannot live among them.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// pages maps a page name to the extra YAML lines of its one preview block.
function build (pages) {
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
    const result = spawnSync('hugo', ['-s', 'exampleSite', '--contentDir', quote(content), '-d', quote(path.join(dir, 'public'))], { encoding: 'utf8', shell })
    return { ...result, log: result.stderr + result.stdout }
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
