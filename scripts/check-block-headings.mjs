import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'

const scratch = mkdtempSync(path.join(os.tmpdir(), 'block-headings-'))
const content = path.join(scratch, 'content')
const publish = path.join(scratch, 'public')
const section = 'heading-items'
const missingSection = 'missing-heading-test-section'

function page (file, params, body = '') {
  writeFileSync(path.join(content, file + '.md'), JSON.stringify(params) + '\n' + body)
}

function block (name, title, flags = {}) {
  return { _bookshop_name: name, heading: { title }, ...flags }
}

function conditional (name, title, visible, flag = 'hide_empty') {
  return block(name, title, { [flag]: true, input: { section, tags: [visible ? 'selected' : 'absent'] } })
}

const cases = {
  articles: {
    blocks: [conditional('articles', 'Empty Articles', false), conditional('articles', 'Visible Articles', true)],
    h1: ['Visible Articles']
  },
  list: {
    blocks: [
      conditional('team', 'Empty Team', false, 'hide-empty'),
      conditional('list', 'Visible List', true, 'hide-empty')
    ],
    h1: ['Visible List']
  },
  team: {
    blocks: [conditional('list', 'Empty List', false), conditional('team', 'Visible Team', true)],
    h1: ['Visible Team']
  },
  'all-empty': {
    blocks: [conditional('articles', 'All Empty Articles', false), conditional('team', 'All Empty Team', false)]
  },
  'missing-section': {
    blocks: [
      block('articles', 'Missing Section', { hide_empty: true, input: { section: missingSection } }),
      conditional('team', 'Visible After Missing Section', true)
    ],
    h1: ['Visible After Missing Section']
  },
  unconditional: {
    blocks: [conditional('articles', 'Conditional First', true), block('heading', 'Unconditional Second')],
    h1: ['Unconditional Second'],
    h2: ['Conditional First']
  },
  'first-visible': {
    blocks: [conditional('team', 'First Visible', true), conditional('list', 'Second Visible', true)],
    h1: ['First Visible'],
    h2: ['Second Visible']
  },
  explicit: {
    blocks: [
      block('heading', 'Suppressed Title', { heading_level: 0 }),
      block('heading', 'Explicit Title', { heading_level: 3 }),
      conditional('articles', 'Fallback Title', true)
    ],
    h2: ['Fallback Title'],
    h3: ['Explicit Title']
  },
  body: {
    blocks: [conditional('articles', 'Body Empty', false), conditional('list', 'Body Block', true)],
    body: '\nPage body.\n',
    h1: ['Page Title'],
    h2: ['Body Block']
  }
}

function headings (html, level) {
  const tag = 'h' + level
  return [...html.matchAll(new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'g'))]
    .map(match => match[1].replace(/<[^>]*>/g, '').trim())
}

try {
  mkdirSync(path.join(content, section), { recursive: true })
  page(section + '/_index', { title: 'Heading Items' })
  page(section + '/selected', { title: 'Selected Heading Item', description: 'Fixture page', tags: ['selected'] }, '\nSelected fixture content.\n')
  for (const [name, { blocks, body }] of Object.entries(cases)) {
    page(name, { title: 'Page Title', content_blocks: blocks }, body)
  }

  const shell = process.platform === 'win32'
  const quote = value => shell ? '"' + value + '"' : value
  const env = { ...process.env }
  delete env.HUGOxPARAMSxENV_BOOKSHOP_LIVE
  const result = spawnSync('hugo', ['-s', 'exampleSite', '--contentDir', quote(content), '-d', quote(publish)], {
    encoding: 'utf8', shell, timeout: 120000, env
  })
  if (result.error) throw result.error
  const log = stripVTControlCharacters(result.stderr + result.stdout)
  assert.equal(result.status, 0, log)

  for (const [name, { h1 = [], h2 = [], h3 = [] }] of Object.entries(cases)) {
    const html = readFileSync(path.join(publish, name, 'index.html'), 'utf8')
    for (const [level, expected] of [[1, h1], [2, h2], [3, h3]]) {
      assert.deepEqual(headings(html, level), expected, name + ': unexpected H' + level)
    }
    if (name === 'explicit') {
      assert.match(html, /Suppressed Title/, 'explicit level 0 still renders its title')
      assert.ok(![1, 2, 3, 4, 5, 6].some(level => headings(html, level).includes('Suppressed Title')),
        'explicit level 0 should omit the semantic heading')
    }
  }
  assert.equal(log.split('Cannot find section: ' + missingSection).length - 1, 1,
    'the scan and wrapper must share a selection, including an empty result')
  console.log('PASS production heading outline and warning count')
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
