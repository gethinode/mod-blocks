// Builds the exampleSite with a throwaway content directory holding one preview
// block with invalid `devices`, and checks that the build fails with the
// partial's error. An error ends a Hugo build, so these cases cannot live among
// the fixtures in exampleSite/content/test-preview.md.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

function build (devices) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-errors-'))
  const content = path.join(dir, 'content')
  fs.mkdirSync(content)
  fs.writeFileSync(path.join(content, '_index.md'), [
    '---',
    'title: Preview errors',
    'modules: [preview]',
    'content_blocks:',
    '  - _bookshop_name: preview',
    '    url: https://example.org/',
    `    devices: ${devices}`,
    '---',
    ''
  ].join('\n'))
  try {
    // On Windows the hugo-extended bin is a .cmd shim, which only a shell resolves.
    const shell = process.platform === 'win32'
    const quote = arg => shell ? `"${arg}"` : arg
    return spawnSync('hugo', ['-s', 'exampleSite', '--contentDir', quote(content), '-d', quote(path.join(dir, 'public'))], { encoding: 'utf8', shell })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

for (const [label, devices] of [['an empty list', '[]'], ['an unknown device', '[desktop, phone]']]) {
  test(`devices with ${label} fails the build`, () => {
    const result = build(devices)
    assert.notEqual(result.status, 0, 'build succeeded')
    assert.match(result.stderr + result.stdout, /Invalid argument 'devices'/)
  })
}
