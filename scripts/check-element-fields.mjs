import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'

const cases = [
  ['approach-grid', 'approach', []],
  ['approach-split', 'approach', ['layout: split']],
  ['panels', 'panels', []],
  ['cards', 'cards', ['orientation: stacked', 'align_rows: true']]
]
const scratch = mkdtempSync(path.join(os.tmpdir(), 'block-fields-'))

try {
  const content = path.join(scratch, 'content')
  mkdirSync(content)
  for (const [name, block, settings] of cases) {
    writeFileSync(path.join(content, name + '.md'), [
      '---', 'title: Element field test', 'content_blocks:', '  - _bookshop_name: ' + block,
      ...settings.map(setting => '    ' + setting),
      '    elements:', '      - title: Supported title', '        icon: fas star',
      '        content: BODYFIELD2259', '        label: Supported label', '        url: /components/',
      '        subtitle: SUBTITLEFIELD2259',
      '        highlight: "**HIGHLIGHTFIELD2259**"', '---', ''
    ].join('\n'))
  }

  for (const live of [false, true]) {
    const publish = path.join(scratch, live ? 'live' : 'regular')
    const shell = process.platform === 'win32'
    // The Windows Hugo .cmd shim requires a shell and quoted filesystem paths.
    const quote = value => shell ? `"${value}"` : value
    const env = { ...process.env }
    delete env.HUGOxPARAMSxENV_BOOKSHOP_LIVE
    if (live) env.HUGOxPARAMSxENV_BOOKSHOP_LIVE = 'true'
    const result = spawnSync('hugo', ['-s', 'exampleSite', '--contentDir', quote(content), '-d', quote(publish)], {
      encoding: 'utf8', shell, timeout: 120000, env
    })
    if (result.error) throw result.error
    const log = stripVTControlCharacters(result.stderr + result.stdout)
    assert.equal(result.status, 0, log)
    const warnings = log.split(/(?=^WARN\s)/m).filter(line => line.startsWith('WARN'))
    for (const [name, block] of cases) {
      const html = readFileSync(path.join(publish, name, 'index.html'), 'utf8')
      assert.match(html, /BODYFIELD2259/, `${name}: missing supported content`)
      const elementWarnings = warnings.filter(warning =>
        warning.includes(name + '.md') && warning.includes(`[${block}] argument 'elements[0]'`))
      const unsupported = elementWarnings.flatMap(warning =>
        [...warning.matchAll(/unsupported attribute '([^']+)'/g)].map(match => match[1]))
      assert.deepEqual([...new Set(unsupported)].sort(), block !== 'cards' && !live ? ['highlight', 'subtitle'] : [],
        `${name}: unexpected unsupported element warnings\n${log}`)
      for (const field of ['subtitle', 'highlight']) {
        const rendered = html.includes(field.toUpperCase() + 'FIELD2259')
        assert.equal(rendered, block === 'cards', `${name}: unexpected output for ${field}`)
      }
    }
    console.log(`PASS element fields in the ${live ? 'Bookshop live' : 'regular'} build`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
