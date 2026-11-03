// Renders the templates that read Hinode data files through Bookshop's live-editing Hugo
// renderer (v0.147.6, see renderer-harness.mjs, copied from mod-utils). That renderer does not
// know hugo.Data, so a template that reads it directly breaks CloudCannon live editing while
// the regular Hugo build still passes. The templates must read data through mod-utils'
// utilities/GetData.html instead.
//
// Hinode's partials are not available in the renderer, so the partials the templates call are
// stubbed. Each stub reports what it receives, which lets the tests assert that the data was read.
// GetData.html is read from _vendor, so run `pnpm mod:vendor` first (pnpm test:renderer does).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test, { after, before } from 'node:test'
import { createRenderer, readTree } from './renderer-harness.mjs'

const GETDATA = 'github.com/gethinode/mod-utils/v6/layouts/_partials/utilities/GetData.html'
const CALL = 'partial "utilities/GetData.html" .'
const BLOCKS = 'layouts/partials/page/blocks.html'
const LIST = 'component-library/components/list/list.hugo.html'

const stub = (lines) => lines.join('\n')
const partials = {
  'utilities/GetData.html': fs.readFileSync(`_vendor/${GETDATA}`, 'utf8'),
  'utilities/GetPadding.html': '{{ return (dict "y" 3) }}',
  'utilities/AddModule.html': '',
  'utilities/LogWarn.html': '',
  // Live editing supplies pages as plain maps, which the list renders into its default table.
  'assets/live-pages.html': '{{ return (dict "pages" (slice (dict "title" "A" "description" "a")) "total" 1) }}',
  'assets/section-title.html': '',
  // Reports which table arguments the list passed, so the controls-layout default is visible.
  'assets/table.html': '{{ range $k, $v := . }}[{{ $k }}={{ $v }}]{{ end }}',
  'utilities/section.html': '{{ .raw }}',
  // Reports the heading level that blocks.html assigned to each block.
  bookshop_partial: stub([
    '{{ range index . 1 }}<block {{ index . "_bookshop_name" }} level={{ index . "heading_level" | default "none" }}>{{ end }}'
  ]),
  bookshop_bindings: ''
}

const files = {
  ...readTree('data', 'data'),
  // The component blueprints that Bookshop supplies, and the table schema that Hinode supplies.
  'data/structures/components.json': JSON.stringify({
    hero: { 'hero.bookshop': { blueprint: { heading_level: 2 } } },
    text: { 'text.bookshop': { blueprint: {} } }
  }),
  'data/structures/table.json': JSON.stringify({ arguments: { 'controls-layout': {} } }),
  [`layouts/_partials/${LIST}`]: fs.readFileSync(LIST, 'utf8'),
  'layouts/_partials/page/blocks.html': fs.readFileSync(BLOCKS, 'utf8')
}
for (const [name, body] of Object.entries(partials)) files[`layouts/_partials/${name}`] = body

let renderer
before(async () => {
  renderer = await createRenderer({ files })
})
after(() => renderer?.close())

const renderBlocks = (partialName = 'page/blocks.html') => renderer.render(
  `{{ partial "${partialName}" (dict "page" . "heading-level" 1) }}`,
  { content_blocks: [{ _bookshop_name: 'text', heading: { title: 'T' } }, { _bookshop_name: 'hero', heading: { title: 'H' } }] }
)
const renderList = (partialName = `${LIST}`) => renderer.render(
  `{{ partial "${partialName}" (dict "input" (dict "section" "x")) }}`
)

test('the renderer is the Hugo that Bookshop live editing runs', () => {
  assert.equal(renderer.render('{{ hugo.Version }}').output, '0.147.6')
})

test('negative control: an unguarded hugo.Data fails in the renderer', () => {
  const { error } = renderer.render('{{ hugo.Data.structures }}')
  assert.match(error ?? 'no error', /can't evaluate field Data/)
})

test('blocks.html reads the component blueprints through GetData', () => {
  const { error, output } = renderBlocks()
  assert.equal(error, null)
  // Only hero declares heading_level in its blueprint, and it carries the second title, so it
  // is the lead block and takes the requested level 1. text declares none and gets no level.
  assert.match(output, /<block text level=none>/)
  assert.match(output, /<block hero level=1>/)
})

test('list reads the table schema through GetData', () => {
  const { error, output } = renderList()
  assert.equal(error, null)
  assert.match(output, /\[controls-layout=list\]/)
})

test('list omits the controls-layout default when the table schema lacks it', () => {
  renderer.write({ 'data/structures/table.json': JSON.stringify({ arguments: {} }) })
  const { error, output } = renderList()
  renderer.write({ 'data/structures/table.json': files['data/structures/table.json'] })
  assert.equal(error, null)
  assert.doesNotMatch(output, /controls-layout/)
})

test('negative control: blocks.html with an unguarded hugo.Data fails', () => {
  assert.ok(files['layouts/_partials/page/blocks.html'].includes(CALL))
  renderer.write({ 'layouts/_partials/page/unguarded-blocks.html': files['layouts/_partials/page/blocks.html'].replace(CALL, 'hugo.Data') })
  const { error } = renderBlocks('page/unguarded-blocks.html')
  assert.match(error ?? 'no error', /can't evaluate field Data/)
})

test('negative control: list with an unguarded hugo.Data fails', () => {
  assert.ok(fs.readFileSync(LIST, 'utf8').includes(CALL))
  renderer.write({ 'layouts/_partials/unguarded-list.html': fs.readFileSync(LIST, 'utf8').replace(CALL, 'hugo.Data') })
  const { error } = renderList('unguarded-list.html')
  assert.match(error ?? 'no error', /can't evaluate field Data/)
})
