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
import { execFileSync } from 'node:child_process'
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

// The preview block renders through the real mod-utils argument utilities, with the Hinode
// partials it calls stubbed: an icon or image reports nothing, a section title its title.
const MOD_UTILS = '_vendor/github.com/gethinode/mod-utils/v6'
const PREVIEW = 'layouts/partials/assets/preview.html'
const PREVIEW_BLOCK = 'component-library/components/preview/preview.hugo.html'

const files = {
  ...readTree(`${MOD_UTILS}/layouts/_partials`, 'layouts/_partials'),
  ...readTree(`${MOD_UTILS}/data`, 'data'),
  ...readTree('i18n', 'i18n'),
  ...readTree('data', 'data'),
  // The component blueprints that Bookshop supplies, and the table schema that Hinode supplies.
  'data/structures/components.json': JSON.stringify({
    hero: { 'hero.bookshop': { blueprint: { heading_level: 2 } } },
    text: { 'text.bookshop': { blueprint: {} } }
  }),
  'data/structures/table.json': JSON.stringify({ arguments: { 'controls-layout': {} } }),
  [`layouts/_partials/${LIST}`]: fs.readFileSync(LIST, 'utf8'),
  'layouts/_partials/page/blocks.html': fs.readFileSync(BLOCKS, 'utf8'),
  'layouts/_partials/assets/preview.html': fs.readFileSync(PREVIEW, 'utf8'),
  'layouts/_partials/bookshop/preview.hugo.html': fs.readFileSync(PREVIEW_BLOCK, 'utf8'),
  'layouts/_partials/assets/icon.html': '',
  'layouts/_partials/assets/image.html': '<img class="{{ .class }}" data-src="{{ .src }}">',
  'layouts/_partials/assets/links.html': ''
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

// The preview block, rendered as Bookshop live editing renders it. A block is a map of
// Bookshop (underscore) arguments; renderPartial passes kebab-case arguments to the partial.
const renderPreview = (block) => renderer.render(
  '{{ partial "bookshop/preview.hugo.html" (merge .Params.block (dict "_page" .)) }}', { block }
)
const renderPartial = (args) => renderer.render(
  '{{ partial "assets/preview.html" (merge .Params.args (dict "page" .)) }}', { args }
)
const squash = html => html.replace(/\s+/g, ' ').replace(/> </g, '><')
// The markup between the first occurrence of from and the next occurrence of to after it.
const between = (html, from, to) => {
  const start = html.indexOf(from)
  assert.notEqual(start, -1, `missing ${from}`)
  const end = html.indexOf(to, start + from.length)
  assert.notEqual(end, -1, `missing ${to} after ${from}`)
  return html.slice(start, end)
}
const ITEMS = [
  { title: 'View A', url: '/a/', caption: 'First **view**', poster: { desktop: 'img/a.png' } },
  { title: 'View B', url: '/b/', caption: 'Second view', poster: { desktop: 'img/b.png' } }
]

test('preview: item captions render in a strip under the window, only the first one shown', () => {
  const { error, output } = renderPreview({ frame: 'window', items: ITEMS })
  assert.equal(error, null)
  const html = squash(output)
  const strip = between(html, '<div class="preview-caption"', '</div></div>')
  assert.match(strip, /<div class="preview-caption-item" data-preview-item="0">First <strong>view<\/strong><\/div>/)
  assert.match(strip, /<div class="preview-caption-item d-none" data-preview-item="1">Second view/)
  // The strip follows the window, outside it.
  assert.ok(html.indexOf('preview-window-status') < html.indexOf('preview-caption'))
  assert.match(html, /<\/div><\/div><div class="preview-caption">/)
})

test('preview: captions render under the frame without a window too', () => {
  const { error, output } = renderPreview({ items: ITEMS })
  assert.equal(error, null)
  assert.match(squash(output), /class="preview-caption"/)
  assert.doesNotMatch(output, /preview-window/)
})

test('preview: items without a caption render no caption strip', () => {
  const { error, output } = renderPreview({ frame: 'window', items: ITEMS.map(({ caption, ...item }) => item) })
  assert.equal(error, null)
  assert.doesNotMatch(output, /preview-caption/)
})

for (const [label, render] of [
  ['underscore Bookshop arguments', () => renderPreview({ frame: 'window', tabs_placement: 'bar', items: ITEMS })],
  ['kebab-case partial arguments', () => renderPartial({ frame: 'window', 'tabs-placement': 'bar', items: ITEMS })]
]) {
  test(`preview: tabs_placement bar renders the item tabs in the window title bar, from ${label}`, () => {
    const { error, output } = render()
    assert.equal(error, null)
    const html = squash(output)
    const bar = between(html, '<div class="preview-window-bar', '<span class="preview-window-end">')
    assert.match(bar, /class="nav nav-pills preview-items preview-window-tabs" role="tablist"/)
    assert.match(bar, />View A<\/button>.*>View B<\/button>/)
    assert.equal(html.match(/preview-items/g).length, 1, 'the tabs render once')
    assert.doesNotMatch(bar, /preview-window-title/, 'the tabs take the place of the title')
  })
}

test('preview: tabs_placement bar without a window keeps the tabs above the frame', () => {
  const { error, output } = renderPreview({ tabs_placement: 'bar', items: ITEMS })
  assert.equal(error, null)
  assert.match(squash(output), /class="nav nav-pills justify-content-center mb-3 preview-items" role="tablist"/)
})

for (const [label, render] of [
  ['underscore Bookshop arguments', () => renderPreview({ frame: 'window', static_below: 768, static_max_height: 500, items: ITEMS })],
  ['kebab-case partial arguments', () => renderPartial({ frame: 'window', 'static-below': 768, 'static-max-height': 500, items: ITEMS })]
]) {
  test(`preview: static limits render posters and no live src, from ${label}`, () => {
    const { error, output } = render()
    assert.equal(error, null)
    const html = squash(output)
    assert.match(html, / data-static-below="768"/)
    assert.match(html, / data-static-max-height="500"/)
    assert.doesNotMatch(html, /data-mobile-static/, 'an explicit width limit replaces the mobile-static boundary')
    assert.doesNotMatch(html, / src="\/a\/"/, 'no frame navigates from the markup')
    assert.match(html, /srcdoc=""/)
    assert.equal(html.match(/class="preview-poster"/g).length, 3, 'every view has a poster')
    assert.match(html, /<div class="preview-poster-item" data-preview-item="0"><img class="preview-poster-image" data-src="img\/a.png">/)
    assert.match(html, /<div class="preview-poster-item d-none" data-preview-item="1"><img class="preview-poster-image" data-src="img\/b.png">/)
  })
}

test('preview: a height limit alone makes the block static, with no width limit', () => {
  const { error, output } = renderPreview({ url: '/a/', static_max_height: 500 })
  assert.equal(error, null)
  const html = squash(output)
  assert.match(html, / data-static-max-height="500"/)
  assert.doesNotMatch(html, /data-mobile-static|data-static-below/)
  assert.doesNotMatch(html, / src="\/a\/"/, 'no frame navigates from the markup')
  assert.equal(html.match(/srcdoc=""/g).length, 3)
  assert.equal(html.match(/class="preview-poster"/g).length, 3, 'every view has a poster')
})

// The stylesheet makes a data-mobile-static block static below 1024px before the script runs,
// so a block whose static-below replaces that width must not carry the attribute.
test('preview: static_below replaces the mobile-static width boundary', () => {
  const { error, output } = renderPreview({ url: '/a/', mobile_static: true, static_below: 768 })
  assert.equal(error, null)
  assert.match(output, / data-static-below="768"/)
  assert.doesNotMatch(output, /data-mobile-static/)
})

test('preview: a height limit alone keeps the mobile-static width boundary', () => {
  const { error, output } = renderPreview({ url: '/a/', mobile_static: true, static_max_height: 500 })
  assert.equal(error, null)
  assert.match(output, / data-mobile-static="true"/)
  assert.match(output, / data-static-max-height="500"/)
  assert.doesNotMatch(output, /data-static-below/)
})

// Byte compatibility: without the new arguments, the block renders exactly what the template
// at PREVIEW_BASE_REF rendered. Set PREVIEW_BASE_REF to a git ref, such as origin/main, to run it.
const BASE_REF = process.env.PREVIEW_BASE_REF
const COMPAT = {
  url: { url: '/a/' },
  window: { url: '/a/', frame: 'window', frame_title: 'T', open_link: true, controls: false, devices: ['desktop'] },
  static: { url: '/a/', frame: 'window', mobile_static: true, activation: 'visible' },
  click: { url: '/a/', activation: 'click' },
  'static items': { frame: 'window', mobile_static: true, items: ITEMS.map(({ caption, ...item }) => item) },
  items: { items: ITEMS.map(({ caption, ...item }) => item), heading: { title: 'H' } },
  'window items': { frame: 'window', open_link: true, ready_message: 'x:ready', items: ITEMS.map(({ caption, ...item }) => item) }
}
for (const [name, block] of Object.entries(COMPAT)) {
  test(`preview: without the new arguments, ${name} renders as at ${BASE_REF || 'the base ref'}`, { skip: !BASE_REF && 'set PREVIEW_BASE_REF' }, () => {
    const current = renderPreview(block)
    const base = execFileSync('git', ['show', `${BASE_REF}:${PREVIEW}`], { encoding: 'utf8' })
    renderer.write({ 'layouts/_partials/assets/preview.html': base })
    try {
      const before = renderPreview(block)
      assert.equal(current.error, null, current.logs.filter(line => /ERROR/.test(line)).join('\n'))
      assert.equal(before.error, null, before.logs.filter(line => /ERROR/.test(line)).join('\n'))
      assert.equal(current.output, before.output)
    } finally {
      renderer.write({ 'layouts/_partials/assets/preview.html': files['layouts/_partials/assets/preview.html'] })
    }
  })
}
