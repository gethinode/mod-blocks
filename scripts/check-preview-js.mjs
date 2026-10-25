// Runs assets/js/modules/preview/preview.js against a minimal fake DOM and checks
// that only the active view loads. The module is plain JS with no exports, so the
// checks drive it the way a browser does: fire `load`, `resize` and
// `shown.bs.tab`, then inspect pane classes and iframe src attributes.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// PREVIEW_JS points the checks at another copy of the module, for example a
// version taken from git to confirm the checks fail without the change.
const source = fs.readFileSync(process.env.PREVIEW_JS || 'assets/js/modules/preview/preview.js', 'utf8')
const URL = 'https://example.org/'

class FakeElement {
  constructor ({ id = '', classes = [], dataset = {}, attrs = {} } = {}) {
    this.id = id
    this.classList = new FakeClassList(classes)
    this.dataset = dataset
    this.attrs = { ...attrs }
    this.children = []
    this.listeners = {}
    this.style = { setProperty () {} }
    this.clientWidth = 1000
    this.clientHeight = 600
  }

  append (...children) { this.children.push(...children); return this }
  hasAttribute (name) { return name in this.attrs }
  get src () { return this.attrs.src }
  set src (value) { this.attrs.src = value; this.srcSets = (this.srcSets || 0) + 1 }
  addEventListener (type, fn) { (this.listeners[type] ||= []).push(fn) }
  dispatch (type, event = {}) { (this.listeners[type] || []).forEach(fn => fn({ target: this, ...event })) }
  descendants () { return this.children.flatMap(child => [child, ...child.descendants()]) }
  querySelectorAll (selector) { return select(this, selector) }
  querySelector (selector) { return select(this, selector)[0] || null }
}

class FakeClassList {
  constructor (classes) { this.set = new Set(classes) }
  contains (name) { return this.set.has(name) }
  toggle (name, force) { if (force) this.set.add(name); else this.set.delete(name) }
}

// The handful of selectors preview.js uses, matched by predicate.
function select (root, selector) {
  if (selector === ':scope > .tab-pane') return root.children.filter(el => el.classList.contains('tab-pane'))
  if (selector.startsWith('#')) return root.descendants().filter(el => el.id === selector.slice(1))
  const rules = {
    'section.preview': el => el.classList.contains('preview'),
    'section.preview .preview-content': el => el.classList.contains('preview-content'),
    'section.preview .preview-content[data-controls="false"]': el => el.classList.contains('preview-content') && el.dataset.controls === 'false',
    '.preview-iframe': el => el.classList.contains('preview-iframe'),
    'iframe[data-src]': el => el.classList.contains('preview-iframe') && 'src' in el.dataset,
    '.preview-controls [data-bs-toggle="tab"]': el => el.attrs['data-bs-toggle'] === 'tab',
    '.preview-controls .btn-group .btn': el => el.attrs['data-bs-toggle'] === 'tab'
  }
  const rule = rules[selector]
  if (!rule) throw new Error(`fake DOM does not support selector ${selector}`)
  return root.descendants().filter(rule)
}

// Builds a preview section as preview.html renders it.
function buildPreview ({ devices, active, controls = true }) {
  const id = 'preview-1'
  const section = new FakeElement({ classes: ['preview'] })
  const dataset = { devices: devices.join(' '), desktopResponsive: 'true' }
  if (!controls) dataset.controls = 'false'
  const content = new FakeElement({ classes: ['tab-content', 'preview-content'], dataset })
  const panes = {}
  const buttons = {}
  for (const device of devices) {
    const isActive = device === active
    const iframe = new FakeElement({
      classes: ['preview-iframe', `preview-${device}`],
      dataset: { src: URL },
      attrs: isActive ? { src: URL } : {}
    })
    panes[device] = new FakeElement({ id: `${id}-${device}`, classes: ['tab-pane', 'fade', ...(isActive ? ['show', 'active'] : [])] }).append(iframe)
    content.append(panes[device])
    if (controls) {
      buttons[device] = new FakeElement({
        classes: ['btn', ...(isActive ? ['active'] : [])],
        dataset: { bsTarget: `#${id}-${device}` },
        attrs: { 'data-bs-toggle': 'tab' }
      })
    }
  }
  if (controls) section.append(new FakeElement({ classes: ['preview-controls'] }).append(...Object.values(buttons)))
  section.append(content)
  return { section, panes, buttons }
}

// Loads preview.js into a fresh context with the given viewport width.
function run (preview, width) {
  const windowListeners = {}
  const document = new FakeElement().append(preview.section)
  const window = {
    innerWidth: width,
    addEventListener (type, fn) { (windowListeners[type] ||= []).push(fn) },
    getComputedStyle: () => ({ display: 'block' })
  }
  const context = { window, document, setTimeout: fn => fn(), clearTimeout () {} }
  vm.runInNewContext(source, context)
  const fire = type => (windowListeners[type] || []).forEach(fn => fn())
  fire('load')
  return {
    resize (newWidth) { window.innerWidth = newWidth; fire('resize') }
  }
}

const isShown = pane => pane.classList.contains('show') && pane.classList.contains('active')
const src = pane => pane.children[0].attrs.src

test('without controls, a wide viewport shows desktop and loads nothing else', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', controls: false })
  run(preview, 1280)
  assert.ok(isShown(preview.panes.desktop))
  assert.ok(!isShown(preview.panes.mobile))
  assert.equal(src(preview.panes.desktop), URL)
  assert.equal(src(preview.panes.mobile), undefined)
})

test('without controls, crossing 1024px swaps the view and loads the new pane once', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', controls: false })
  const page = run(preview, 1024)
  assert.ok(isShown(preview.panes.desktop), '1024px still fits desktop')
  page.resize(1023)
  assert.ok(isShown(preview.panes.mobile))
  assert.ok(!isShown(preview.panes.desktop))
  assert.equal(src(preview.panes.mobile), URL)
  page.resize(800)
  page.resize(1280)
  page.resize(700)
  assert.ok(isShown(preview.panes.mobile))
  assert.equal(preview.panes.mobile.children[0].srcSets, 1, 'mobile src is set once')
  assert.equal(preview.panes.desktop.children[0].srcSets, undefined, 'desktop keeps its rendered src')
})

test('without controls, tablet fits from 640px and mobile below it', () => {
  const preview = buildPreview({ devices: ['desktop', 'tablet', 'mobile'], active: 'desktop', controls: false })
  const page = run(preview, 640)
  assert.ok(isShown(preview.panes.tablet))
  assert.equal(src(preview.panes.mobile), undefined)
  page.resize(639)
  assert.ok(isShown(preview.panes.mobile))
  assert.ok(!isShown(preview.panes.tablet))
})

test('without controls, the smallest offered device shows when none fits', () => {
  const preview = buildPreview({ devices: ['desktop', 'tablet'], active: 'desktop', controls: false })
  run(preview, 400)
  assert.ok(isShown(preview.panes.tablet))
  assert.ok(!isShown(preview.panes.desktop))
})

test('without controls, the offered order does not change which device fits', () => {
  const preview = buildPreview({ devices: ['mobile', 'desktop'], active: 'mobile', controls: false })
  run(preview, 1280)
  assert.ok(isShown(preview.panes.desktop))
})

test('with controls, showing a tab loads its pane', () => {
  const preview = buildPreview({ devices: ['desktop', 'tablet', 'mobile'], active: 'desktop' })
  run(preview, 1280)
  assert.equal(src(preview.panes.tablet), undefined)
  preview.buttons.tablet.dispatch('shown.bs.tab')
  assert.equal(src(preview.panes.tablet), URL)
  assert.equal(src(preview.panes.mobile), undefined)
  preview.buttons.tablet.dispatch('shown.bs.tab')
  assert.equal(preview.panes.tablet.children[0].srcSets, 1, 'tablet src is set once')
})

test('with controls, the block does not pick the view itself', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop' })
  run(preview, 400)
  assert.ok(isShown(preview.panes.desktop))
  assert.equal(src(preview.panes.mobile), undefined)
})
