// Runs assets/js/modules/preview/preview.js against a minimal fake DOM and checks
// that only the active view loads. The module is plain JS with no exports, so the
// checks drive it the way a browser does: fire `DOMContentLoaded` and `load`,
// change the viewport width (which fires `matchMedia` change events and `resize`)
// and click device buttons, then inspect pane classes and iframe src attributes.
//
// The fake applies no stylesheet. getComputedStyle answers from cssHides below,
// a model of the responsive rules in preview.scss; check-preview-browser.mjs runs
// the real stylesheet in Chrome.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// PREVIEW_JS points the checks at another copy of the module, for example a
// version taken from git to confirm the checks fail without the change.
const source = fs.readFileSync(process.env.PREVIEW_JS || 'assets/js/modules/preview/preview.js', 'utf8')
const URL = 'https://example.org/'

class FakeElement {
  constructor ({ id = '', classes = [], dataset = {}, attrs = {}, device } = {}) {
    this.id = id
    this.classList = new FakeClassList(classes)
    this.dataset = dataset
    this.attrs = { ...attrs }
    this.device = device
    this.parent = null
    this.children = []
    this.listeners = {}
    this.style = { setProperty () {} }
    this.clientWidth = 1000
    this.clientHeight = 600
  }

  append (...children) {
    children.forEach(child => { child.parent = this })
    this.children.push(...children)
    return this
  }

  hasAttribute (name) { return name in this.attrs }
  get src () { return this.attrs.src }
  set src (value) { this.attrs.src = value; this.srcSets = (this.srcSets || 0) + 1 }
  addEventListener (type, fn) { (this.listeners[type] ||= []).push(fn) }
  // Events bubble from the element up to the document, as Bootstrap's do.
  dispatch (type, event = {}) {
    const evt = { target: this, ...event }
    for (let el = this; el; el = el.parent) (el.listeners[type] || []).forEach(fn => fn(evt))
  }

  click () { this.dispatch('click') }
  closest (selector) {
    for (let el = this; el; el = el.parent) if (matches(el, selector)) return el
    return null
  }

  descendants () { return this.children.flatMap(child => [child, ...child.descendants()]) }
  querySelectorAll (selector) { return select(this, selector) }
  querySelector (selector) { return select(this, selector)[0] || null }
}

class FakeClassList {
  constructor (classes) { this.set = new Set(classes) }
  contains (name) { return this.set.has(name) }
  add (name) { this.set.add(name) }
  remove (name) { this.set.delete(name) }
  toggle (name, force) { if (force) this.set.add(name); else this.set.delete(name) }
}

// The handful of selectors preview.js uses, matched by predicate.
const rules = {
  'section.preview': el => el.classList.contains('preview'),
  '.preview-controls': el => el.classList.contains('preview-controls'),
  'section.preview .preview-content': el => el.classList.contains('preview-content'),
  'section.preview .preview-content[data-controls="false"]': el => el.classList.contains('preview-content') && el.dataset.controls === 'false',
  '.preview-iframe': el => el.classList.contains('preview-iframe'),
  'iframe[data-src]': el => el.classList.contains('preview-iframe') && 'src' in el.dataset,
  '.preview-controls [data-bs-toggle="tab"]': el => el.attrs['data-bs-toggle'] === 'tab',
  '.preview-controls .btn-group .btn': el => el.attrs['data-bs-toggle'] === 'tab'
}

function matches (el, selector) {
  const rule = rules[selector]
  if (!rule) throw new Error(`fake DOM does not support selector ${selector}`)
  return rule(el)
}

function select (root, selector) {
  if (selector === ':scope > .tab-pane') return root.children.filter(el => el.classList.contains('tab-pane'))
  if (selector.startsWith('#')) return root.descendants().filter(el => el.id === selector.slice(1))
  return root.descendants().filter(el => matches(el, selector))
}

// A model of the responsive rules in preview.scss: a view and its button hide
// below the device's breakpoint, but only when a smaller device is offered.
function cssHides (device, offered, width) {
  if (device === 'desktop') return width <= 1023 && (offered.includes('tablet') || offered.includes('mobile'))
  if (device === 'tablet') return width <= 639 && offered.includes('mobile')
  return false
}

// Builds a preview section as preview.html renders it: without controls no iframe
// carries src, with controls only the active one does.
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
      attrs: isActive && controls ? { src: URL } : {}
    })
    panes[device] = new FakeElement({ id: `${id}-${device}`, classes: ['tab-pane', 'fade', ...(isActive ? ['show', 'active'] : [])], device }).append(iframe)
    content.append(panes[device])
    if (controls) {
      buttons[device] = new FakeElement({
        classes: ['btn', ...(isActive ? ['active'] : [])],
        dataset: { bsTarget: `#${id}-${device}` },
        attrs: { 'data-bs-toggle': 'tab' },
        device
      })
    }
  }
  if (controls) section.append(new FakeElement({ classes: ['preview-controls'] }).append(...Object.values(buttons)))
  section.append(content)
  return { section, panes, buttons, devices }
}

// Loads preview.js into a fresh context with the given viewport width. `until`
// names the last page event to fire: 'none', 'ready' (DOMContentLoaded) or 'load'.
// readyState is the document state when the script runs.
function run (preview, width, { until = 'load', readyState = 'loading' } = {}) {
  let viewport = width
  const windowListeners = {}
  const queries = new Map()
  const document = new FakeElement().append(preview.section)
  document.readyState = readyState
  const window = {
    // innerWidth is a whole number; the CSS viewport width need not be.
    get innerWidth () { return Math.floor(viewport) },
    addEventListener (type, fn) { (windowListeners[type] ||= []).push(fn) },
    getComputedStyle: el => ({ display: el.device && cssHides(el.device, preview.devices, viewport) ? 'none' : 'block' }),
    matchMedia (query) {
      const max = /^\(max-width: (\d+)px\)$/.exec(query)
      if (!max) throw new Error(`fake matchMedia does not support ${query}`)
      if (!queries.has(query)) {
        queries.set(query, {
          media: query,
          listeners: [],
          get matches () { return viewport <= Number(max[1]) },
          addEventListener (type, fn) { if (type === 'change') this.listeners.push(fn) }
        })
      }
      return queries.get(query)
    }
  }
  const context = { window, document, setTimeout: fn => fn(), clearTimeout () {} }
  vm.runInNewContext(source, context)

  // Bootstrap's tab plugin: registered after preview.js, as the deferred core
  // bundle is. A click activates the button and its pane, then fires shown.bs.tab.
  document.addEventListener('click', ({ target }) => {
    if (target.attrs['data-bs-toggle'] !== 'tab') return
    Object.values(preview.buttons).forEach(btn => btn.classList.toggle('active', btn === target))
    const pane = document.querySelector(target.dataset.bsTarget)
    Object.values(preview.panes).forEach(p => { p.classList.toggle('show', p === pane); p.classList.toggle('active', p === pane) })
    target.dispatch('shown.bs.tab')
  })

  const fire = type => (windowListeners[type] || []).forEach(fn => fn({}))
  const page = {
    ready () { document.readyState = 'interactive'; document.dispatch('DOMContentLoaded') },
    load () { document.readyState = 'complete'; fire('load') },
    resize (newWidth) {
      const before = new Map([...queries].map(([query, list]) => [query, list.matches]))
      viewport = newWidth
      for (const [query, list] of queries) {
        if (list.matches !== before.get(query)) list.listeners.forEach(fn => fn({ matches: list.matches, media: query }))
      }
      fire('resize')
    }
  }
  if (until === 'ready' || until === 'load') page.ready()
  if (until === 'load') page.load()
  return page
}

const isShown = pane => pane.classList.contains('show') && pane.classList.contains('active')
const src = pane => pane.children[0].attrs.src
const shown = preview => Object.keys(preview.panes).filter(device => isShown(preview.panes[device]))
const loaded = preview => Object.keys(preview.panes).filter(device => src(preview.panes[device]) !== undefined)

test('without controls, the view is picked and loaded at DOMContentLoaded', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', controls: false })
  run(preview, 1280, { until: 'ready' })
  assert.deepEqual(shown(preview), ['desktop'])
  assert.deepEqual(loaded(preview), ['desktop'])
})

test('without controls, nothing loads before DOMContentLoaded', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', controls: false })
  run(preview, 1280, { until: 'none' })
  assert.deepEqual(loaded(preview), [])
})

test('a script that runs after DOMContentLoaded still picks the view', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', controls: false })
  run(preview, 400, { until: 'none', readyState: 'interactive' })
  assert.deepEqual(shown(preview), ['mobile'])
  assert.deepEqual(loaded(preview), ['mobile'])
})

test('without controls, crossing 1024px swaps the view and loads the new pane once', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', controls: false })
  const page = run(preview, 1024)
  assert.deepEqual(shown(preview), ['desktop'], '1024px still fits desktop')
  page.resize(1023)
  assert.deepEqual(shown(preview), ['mobile'])
  assert.equal(src(preview.panes.mobile), URL)
  page.resize(800)
  page.resize(1280)
  assert.deepEqual(shown(preview), ['desktop'])
  page.resize(700)
  assert.deepEqual(shown(preview), ['mobile'])
  assert.equal(preview.panes.mobile.children[0].srcSets, 1, 'mobile src is set once')
  assert.equal(preview.panes.desktop.children[0].srcSets, 1, 'desktop src is set once')
})

test('without controls, a fractional width follows the media query, not innerWidth', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', controls: false })
  const page = run(preview, 1023.5)
  assert.deepEqual(shown(preview), ['desktop'], 'max-width: 1023px does not match 1023.5px')
  assert.deepEqual(loaded(preview), ['desktop'])
  page.resize(1023)
  assert.deepEqual(shown(preview), ['mobile'])
})

test('without controls, tablet fits from 640px and mobile below it', () => {
  const preview = buildPreview({ devices: ['desktop', 'tablet', 'mobile'], active: 'desktop', controls: false })
  const page = run(preview, 640)
  assert.deepEqual(shown(preview), ['tablet'])
  assert.deepEqual(loaded(preview), ['tablet'])
  page.resize(639)
  assert.deepEqual(shown(preview), ['mobile'])
})

test('without controls, the smallest offered device shows when none fits', () => {
  const preview = buildPreview({ devices: ['desktop', 'tablet'], active: 'desktop', controls: false })
  run(preview, 400)
  assert.deepEqual(shown(preview), ['tablet'])
  assert.deepEqual(loaded(preview), ['tablet'])
})

test('without controls, the offered order does not change which device fits', () => {
  const preview = buildPreview({ devices: ['mobile', 'desktop'], active: 'mobile', controls: false })
  run(preview, 1280)
  assert.deepEqual(shown(preview), ['desktop'])
})

test('with controls, a tab shown before window load loads its pane', () => {
  const preview = buildPreview({ devices: ['desktop', 'tablet', 'mobile'], active: 'desktop' })
  run(preview, 1280, { until: 'ready' })
  preview.buttons.tablet.click()
  assert.deepEqual(shown(preview), ['tablet'])
  assert.equal(src(preview.panes.tablet), URL)
  assert.equal(src(preview.panes.mobile), undefined)
})

test('with controls, showing a tab loads its pane once', () => {
  const preview = buildPreview({ devices: ['desktop', 'tablet', 'mobile'], active: 'desktop' })
  run(preview, 1280)
  assert.deepEqual(loaded(preview), ['desktop'])
  preview.buttons.tablet.click()
  preview.buttons.desktop.click()
  preview.buttons.tablet.click()
  assert.deepEqual(loaded(preview), ['desktop', 'tablet'])
  assert.equal(preview.panes.tablet.children[0].srcSets, 1, 'tablet src is set once')
})

test('with controls, a hidden active view switches at DOMContentLoaded', () => {
  const preview = buildPreview({ devices: ['desktop', 'tablet', 'mobile'], active: 'desktop' })
  run(preview, 400, { until: 'ready' })
  assert.deepEqual(shown(preview), ['mobile'])
  assert.equal(src(preview.panes.mobile), URL)
})

test('with controls, the switch picks the largest visible device that fits, not the first', () => {
  const preview = buildPreview({ devices: ['mobile', 'tablet', 'desktop'], active: 'desktop' })
  run(preview, 800)
  assert.deepEqual(shown(preview), ['tablet'])
  assert.equal(src(preview.panes.tablet), URL)
  assert.equal(src(preview.panes.mobile), undefined)
})

test('with controls, crossing a breakpoint switches a view the CSS hides', () => {
  const preview = buildPreview({ devices: ['desktop', 'tablet', 'mobile'], active: 'desktop' })
  const page = run(preview, 1280)
  assert.deepEqual(shown(preview), ['desktop'])
  page.resize(800)
  assert.deepEqual(shown(preview), ['tablet'])
  page.resize(500)
  assert.deepEqual(shown(preview), ['mobile'])
})

test('with controls, a visible active view is kept', () => {
  const preview = buildPreview({ devices: ['desktop', 'tablet', 'mobile'], active: 'desktop' })
  const page = run(preview, 1280)
  preview.buttons.mobile.click()
  page.resize(800)
  assert.deepEqual(shown(preview), ['mobile'])
  assert.deepEqual(loaded(preview), ['desktop', 'mobile'])
})

test('with controls, a lone device the CSS keeps visible stays shown', () => {
  const preview = buildPreview({ devices: ['desktop'], active: 'desktop' })
  run(preview, 400)
  assert.deepEqual(shown(preview), ['desktop'])
  assert.deepEqual(loaded(preview), ['desktop'])
})

test('with controls, the smallest offered device takes over when none fits', () => {
  const preview = buildPreview({ devices: ['desktop', 'tablet'], active: 'desktop' })
  run(preview, 400)
  assert.deepEqual(shown(preview), ['tablet'])
  assert.equal(src(preview.panes.tablet), URL)
})
