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

// The window of an iframe, which records each message posted to it.
class FakeWindow {
  constructor () { this.posted = [] }
  postMessage (data, targetOrigin) { this.posted.push([data, targetOrigin]) }
}

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
    if (this.classList.contains('preview-iframe')) this.contentWindow = new FakeWindow()
  }

  append (...children) {
    children.forEach(child => { child.parent = this })
    this.children.push(...children)
    return this
  }

  hasAttribute (name) { return name in this.attrs }
  removeAttribute (name) { delete this.attrs[name] }
  getAttribute (name) { return name in this.attrs ? this.attrs[name] : null }
  setAttribute (name, value) { this.attrs[name] = String(value) }
  // A shallow copy: the same classes, data and attributes, without children,
  // listeners or the count of src sets, and with a window of its own.
  cloneNode () {
    return new FakeElement({ id: this.id, classes: [...this.classList.set], dataset: { ...this.dataset }, attrs: this.attrs, device: this.device })
  }

  replaceWith (other) {
    other.parent = this.parent
    this.parent.children[this.parent.children.indexOf(this)] = other
    this.parent = null
  }
  get src () { return this.attrs.src }
  set src (value) { this.attrs.src = value; this.srcSets = (this.srcSets || 0) + 1 }
  addEventListener (type, fn) { (this.listeners[type] ||= []).push(fn) }
  // Events bubble from the element up to the document, as Bootstrap's do.
  dispatch (type, event = {}) {
    const evt = { target: this, ...event }
    for (let el = this; el; el = el.parent) (el.listeners[type] || []).forEach(fn => fn(evt))
  }

  click () { this.dispatch('click') }
  dispatchEvent (event) { this.dispatch(event.type, { detail: event.detail, bubbles: event.bubbles }) }
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
  '.preview-content': el => el.classList.contains('preview-content'),
  '.preview-activate': el => el.classList.contains('preview-activate'),
  '.preview-poster': el => el.classList.contains('preview-poster'),
  '.preview-poster-item': el => el.classList.contains('preview-poster-item'),
  '.preview-items': el => el.classList.contains('preview-items'),
  '.preview-open': el => el.classList.contains('preview-open'),
  '[data-bs-toggle="tab"]': el => el.attrs['data-bs-toggle'] === 'tab',
  '.tab-pane': el => el.classList.contains('tab-pane'),
  'section.preview .preview-content[data-controls="false"]': el => el.classList.contains('preview-content') && el.dataset.controls === 'false',
  '.preview-iframe': el => el.classList.contains('preview-iframe'),
  'iframe[data-src]': el => el.classList.contains('preview-iframe') && 'src' in el.dataset,
  '.preview-controls [data-bs-toggle="tab"]': el => el.attrs['data-bs-toggle'] === 'tab',
  '.preview-controls .btn-group .btn': el => el.attrs['data-bs-toggle'] === 'tab',
  '.preview-items [data-bs-toggle="tab"]': el => el.attrs['data-bs-toggle'] === 'tab' && !!el.parent.closest('.preview-items'),
  '.preview-open, .preview-unavailable-link': el => el.classList.contains('preview-open') || el.classList.contains('preview-unavailable-link'),
  'section.preview .preview-content .preview-iframe': el => el.classList.contains('preview-iframe') && !!el.closest('.preview-content'),
  'section.preview .preview-content[data-ready-message] .preview-iframe': el => el.classList.contains('preview-iframe') &&
    'readyMessage' in ((el.closest('.preview-content') || {}).dataset || {})
}

function matches (el, selector) {
  const rule = rules[selector]
  if (!rule) throw new Error(`fake DOM does not support selector ${selector}`)
  return rule(el)
}

function select (root, selector) {
  if (selector === ':scope > .tab-pane') return root.children.filter(el => el.classList.contains('tab-pane'))
  if (selector === ':scope > .tab-pane.active') return root.children.filter(el => el.classList.contains('tab-pane') && el.classList.contains('active'))
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

// Builds a preview section as preview.html renders it outside Bookshop live
// editing: without controls no iframe carries src, with controls only the active
// one does. With click activation no iframe carries src, and every pane holds a
// poster with its button. With items, a heading pane and an item tab render per
// item, every iframe starts with the URL of the first item, every poster holds
// one image per item, and an open link follows the frame. Every iframe takes
// the title of the first item. With panel, the items carry no headings, so
// the content is the tab panel of every item tab, labelled by the first. Every
// pane holds the hidden runtime failure alert, whose link opens the first URL,
// unless the block shows its fallback.
// With readyMessage, every iframe is inert and every pane holds a poster with a
// waiting status, and the poster button only with click activation. timeout
// is the data-load-timeout value, or null for none.
function buildPreview ({ devices, active, controls = true, activation = 'load', items, panel = false, readyMessage, timeout = '15', fallback = false }) {
  const click = activation === 'click'
  const id = 'preview-1'
  const section = new FakeElement({ classes: ['preview'] })
  const dataset = { devices: devices.join(' '), desktopResponsive: 'true' }
  if (!controls) dataset.controls = 'false'
  if (click) dataset.activation = 'click'
  if (timeout !== null) dataset.loadTimeout = timeout
  if (readyMessage) dataset.readyMessage = readyMessage
  const content = new FakeElement({
    id: panel ? `${id}-items-panel` : '',
    classes: ['tab-content', 'preview-content'],
    dataset,
    attrs: panel ? { role: 'tabpanel', 'aria-labelledby': `${id}-item-0-tab` } : {}
  })
  const panes = {}
  const buttons = {}
  const first = items ? items[0].url : URL
  const itemButtons = []
  const headings = []
  if (items) {
    const headingContent = new FakeElement({ classes: ['tab-content', 'preview-headings'] })
    const nav = new FakeElement({ classes: ['nav', 'nav-pills', 'preview-items'] })
    items.forEach(({ url, openUrl = url, title }, n) => {
      if (!panel) headings.push(new FakeElement({ id: `${id}-item-${n}`, classes: ['tab-pane', 'fade', ...(n === 0 ? ['show', 'active'] : [])] }))
      const button = new FakeElement({
        id: `${id}-item-${n}-tab`,
        classes: ['nav-link', ...(n === 0 ? ['active'] : [])],
        dataset: { bsTarget: `#${id}-item-${n}`, previewUrl: url, previewOpenUrl: openUrl },
        attrs: { 'data-bs-toggle': 'tab', 'aria-controls': panel ? `${id}-items-panel` : `${id}-item-${n}` }
      })
      button.textContent = ` ${title} `
      itemButtons.push(button)
    })
    section.append(headingContent.append(...headings), nav.append(...itemButtons))
  }
  for (const device of devices) {
    const isActive = device === active
    const iframe = new FakeElement({
      classes: ['preview-iframe', `preview-${device}`],
      dataset: { src: first },
      attrs: { ...(isActive && controls && !click ? { src: first } : {}), ...(items ? { title: items[0].title } : {}), ...(readyMessage ? { inert: '' } : {}) }
    })
    panes[device] = new FakeElement({ id: `${id}-${device}`, classes: ['tab-pane', 'fade', ...(isActive ? ['show', 'active'] : [])], device }).append(iframe)
    if (click || readyMessage) {
      const posterItems = (items || []).map((item, n) => new FakeElement({ classes: ['preview-poster-item', ...(n > 0 ? ['d-none'] : [])], dataset: { previewItem: String(n) } }))
      panes[device].append(new FakeElement({ classes: ['preview-poster'] }).append(...posterItems,
        ...(click ? [new FakeElement({ classes: ['btn', 'preview-activate'] })] : []),
        ...(readyMessage ? [new FakeElement({ classes: ['preview-waiting'] })] : [])))
    }
    if (!fallback) {
      const link = new FakeElement({ classes: ['alert-link', 'preview-unavailable-link'] })
      link.href = items ? (items[0].openUrl || first) : first
      panes[device].append(new FakeElement({ classes: ['preview-unavailable'] }).append(new FakeElement({ classes: ['alert'] }).append(link)))
    }
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
  const open = new FakeElement({ classes: ['preview-open'] })
  if (items) {
    open.href = first
    section.append(open)
  }
  const activate = device => panes[device].children[1].children.find(el => el.classList.contains('preview-activate')).click()
  return { section, content, panes, buttons, devices, activate, itemButtons, headings, open }
}

// Loads preview.js into a fresh context with the given viewport width. `until`
// names the last page event to fire: 'none', 'ready' (DOMContentLoaded) or 'load'.
// readyState is the document state when the script runs.
// globals adds names to the context of the script, such as IntersectionObserver.
function run (preview, width, { until = 'load', readyState = 'loading', globals = {} } = {}) {
  let viewport = width
  const windowListeners = {}
  const queries = new Map()
  const document = new FakeElement().append(preview.section)
  document.readyState = readyState
  const window = {
    // innerWidth rounds down to a whole number; the media queries see the exact width.
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
  class CustomEvent {
    constructor (type, { bubbles = false, detail } = {}) { Object.assign(this, { type, bubbles, detail }) }
  }
  // Timers wait until elapse() runs them; delays records the delay of each.
  const timers = new Map()
  const delays = []
  let nextTimer = 1
  const setTimeout = (fn, ms) => { delays.push(ms); timers.set(nextTimer, fn); return nextTimer++ }
  const clearTimeout = timer => { timers.delete(timer) }
  const context = { window, document, CustomEvent, setTimeout, clearTimeout, ...globals }
  vm.runInNewContext(source, context)

  // Bootstrap's tab plugin: registered after preview.js, as the deferred core
  // bundle is. A click activates the button and its pane, then fires shown.bs.tab.
  // An item tab swaps the heading panes the same way.
  document.addEventListener('click', ({ target }) => {
    if (target.attrs['data-bs-toggle'] !== 'tab') return
    const isItem = preview.itemButtons.includes(target)
    const [tabs, targets] = isItem ? [preview.itemButtons, preview.headings] : [Object.values(preview.buttons), Object.values(preview.panes)]
    tabs.forEach(btn => btn.classList.toggle('active', btn === target))
    const pane = document.querySelector(target.dataset.bsTarget)
    targets.forEach(p => { p.classList.toggle('show', p === pane); p.classList.toggle('active', p === pane) })
    target.dispatch('shown.bs.tab')
  })

  const fire = type => (windowListeners[type] || []).forEach(fn => fn({}))
  const page = {
    document,
    delays,
    // Runs every pending timer, as if its delay had passed.
    elapse () { const due = [...timers.values()]; timers.clear(); due.forEach(fn => fn()) },
    // Posts a message to the page from source, as a window does.
    message (data, source) { (windowListeners.message || []).forEach(fn => fn({ data, source })) },
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

test('a Bootstrap tab outside a preview block is left alone', () => {
  const preview = buildPreview({ devices: ['desktop', 'tablet', 'mobile'], active: 'desktop' })
  const page = run(preview, 1280)
  const tab = new FakeElement({ dataset: { bsTarget: '#other' }, attrs: { 'data-bs-toggle': 'tab' } })
  page.document.append(tab)
  assert.doesNotThrow(() => tab.dispatch('shown.bs.tab'))
  assert.deepEqual(loaded(preview), ['desktop'])
})

test('with click activation, nothing loads before the poster button is pressed', () => {
  const preview = buildPreview({ devices: ['desktop', 'tablet', 'mobile'], active: 'desktop', activation: 'click' })
  run(preview, 1280)
  preview.buttons.tablet.click()
  assert.deepEqual(shown(preview), ['tablet'], 'the switcher still swaps the posters')
  assert.deepEqual(loaded(preview), [])
  assert.equal(preview.content.dataset.active, undefined)
})

test('with click activation, the button loads the view the switcher shows, once', () => {
  const preview = buildPreview({ devices: ['desktop', 'tablet', 'mobile'], active: 'desktop', activation: 'click' })
  const page = run(preview, 1280)
  const events = []
  page.document.addEventListener('preview:activate', event => events.push(event))
  preview.buttons.tablet.click()
  preview.activate('tablet')
  assert.equal(preview.content.dataset.active, 'true')
  assert.deepEqual(loaded(preview), ['tablet'])
  assert.equal(events.length, 1, 'one preview:activate event')
  assert.equal(events[0].target, preview.section, 'dispatched on the section')
  assert.equal(events[0].bubbles, true)
  preview.activate('tablet')
  assert.equal(preview.panes.tablet.children[0].srcSets, 1, 'tablet src is set once')
})

test('with click activation, later device switches load as without it', () => {
  const preview = buildPreview({ devices: ['desktop', 'tablet', 'mobile'], active: 'desktop', activation: 'click' })
  run(preview, 1280)
  preview.activate('desktop')
  preview.buttons.mobile.click()
  assert.deepEqual(loaded(preview), ['desktop', 'mobile'])
})

test('with click activation, a hidden active view switches but does not load', () => {
  const preview = buildPreview({ devices: ['desktop', 'tablet', 'mobile'], active: 'desktop', activation: 'click' })
  run(preview, 400)
  assert.deepEqual(shown(preview), ['mobile'])
  assert.deepEqual(loaded(preview), [])
  preview.activate('mobile')
  assert.deepEqual(loaded(preview), ['mobile'])
})

test('with click activation and no controls, the picked view loads on the button only', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', controls: false, activation: 'click' })
  const page = run(preview, 400)
  assert.deepEqual(shown(preview), ['mobile'])
  assert.deepEqual(loaded(preview), [])
  page.resize(1280)
  assert.deepEqual(shown(preview), ['desktop'], 'crossing a breakpoint swaps the posters')
  assert.deepEqual(loaded(preview), [])
  preview.activate('desktop')
  assert.deepEqual(loaded(preview), ['desktop'])
  page.resize(400)
  assert.deepEqual(shown(preview), ['mobile'])
  assert.deepEqual(loaded(preview), ['desktop', 'mobile'])
})

test('with click activation and no controls, the button picks the view itself', () => {
  // A block rendered after the script ran, as Bookshop live editing renders
  // one again, shows its default view and has had no pick.
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', controls: false, activation: 'click' })
  run(preview, 400, { until: 'none' })
  preview.activate('desktop')
  assert.deepEqual(shown(preview), ['mobile'])
  assert.deepEqual(loaded(preview), ['mobile'])
})

test('a poster button outside a preview block is left alone', () => {
  const preview = buildPreview({ devices: ['desktop'], active: 'desktop', activation: 'click' })
  const page = run(preview, 1280)
  const stray = new FakeElement({ classes: ['preview-activate'] })
  page.document.append(stray)
  assert.doesNotThrow(() => stray.click())
  assert.deepEqual(loaded(preview), [])
})

const A = 'https://example.org/a'
const B = 'https://example.org/b'
const ITEMS = [{ url: A, title: 'View A' }, { url: B, openUrl: 'https://example.org/b-open', title: 'View B' }]
const titles = preview => Object.values(preview.panes).map(pane => pane.children[0].getAttribute('title'))
const dataSrcs = preview => Object.values(preview.panes).map(pane => pane.children[0].dataset.src)
const srcs = preview => Object.fromEntries(Object.entries(preview.panes).map(([device, pane]) => [device, src(pane)]))
// The item each poster shows: the index of its one poster image without d-none.
const posterItems = preview => Object.values(preview.panes).map(pane => pane.children[1].children
  .filter(el => el.classList.contains('preview-poster-item') && !el.classList.contains('d-none'))
  .map(el => el.dataset.previewItem).join(','))
function recordItems (page) {
  const events = []
  page.document.addEventListener('preview:item', event => events.push(event))
  return events
}

test('with items and click activation, an item tab before activation swaps URL and posters and loads nothing', () => {
  const preview = buildPreview({ devices: ['desktop', 'tablet', 'mobile'], active: 'desktop', activation: 'click', items: ITEMS })
  const page = run(preview, 1280)
  const events = recordItems(page)
  assert.deepEqual(posterItems(preview), ['0', '0', '0'])
  assert.deepEqual(titles(preview), ['View A', 'View A', 'View A'])
  preview.itemButtons[1].click()
  assert.deepEqual(dataSrcs(preview), [B, B, B])
  assert.deepEqual(titles(preview), ['View B', 'View B', 'View B'], 'every iframe takes the title of the item')
  assert.deepEqual(loaded(preview), [])
  assert.deepEqual(posterItems(preview), ['1', '1', '1'])
  assert.equal(preview.open.href, 'https://example.org/b-open')
  assert.equal(events.length, 1, 'one preview:item event')
  assert.equal(events[0].target, preview.section, 'dispatched on the section')
  assert.equal(events[0].bubbles, true)
  assert.equal(events[0].detail.index, 1)
  preview.itemButtons[0].click()
  assert.deepEqual(dataSrcs(preview), [A, A, A])
  assert.deepEqual(posterItems(preview), ['0', '0', '0'])
  assert.equal(preview.open.href, A, 'the open link falls back to the item URL')
  assert.deepEqual(events.map(event => event.detail.index), [1, 0])
  preview.activate('desktop')
  assert.deepEqual(srcs(preview), { desktop: A, tablet: undefined, mobile: undefined })
})

test('with items and click activation, an item tab after activation loads the shown view only', () => {
  const preview = buildPreview({ devices: ['desktop', 'tablet', 'mobile'], active: 'desktop', activation: 'click', items: ITEMS })
  run(preview, 1280)
  preview.activate('desktop')
  preview.buttons.tablet.click()
  assert.deepEqual(srcs(preview), { desktop: A, tablet: A, mobile: undefined })
  const before = Object.values(preview.panes).map(pane => pane.children[0])
  preview.itemButtons[1].click()
  assert.deepEqual(dataSrcs(preview), [B, B, B])
  assert.deepEqual(srcs(preview), { desktop: undefined, tablet: B, mobile: undefined }, 'the hidden view drops the old URL')
  const after = Object.values(preview.panes).map(pane => pane.children[0])
  assert.deepEqual(after.map((iframe, i) => iframe !== before[i]), [true, true, false], 'the iframes that had loaded are replaced')
  assert.equal(before[0].attrs.src, A, 'the replaced iframe is left as it was')
  assert.equal(preview.panes.tablet.children[0].srcSets, 1, 'the new tablet iframe loads once')
  assert.deepEqual(after[0].classList.set, before[0].classList.set, 'the copy keeps the classes')
  assert.deepEqual(titles(preview), ['View B', 'View B', 'View B'], 'the copies and the untouched iframe take the item title')
  assert.equal(before[0].getAttribute('title'), 'View A', 'the replaced iframe keeps its title')
  preview.buttons.desktop.click()
  assert.deepEqual(srcs(preview), { desktop: B, tablet: B, mobile: undefined }, 'a view shown later loads the item URL')
  assert.equal(preview.panes.desktop.children[0].getAttribute('title'), 'View B', 'and carries its title')
})

test('with items and load activation, an item tab loads the shown view at once', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', items: ITEMS })
  run(preview, 1280)
  assert.deepEqual(srcs(preview), { desktop: A, mobile: undefined })
  preview.itemButtons[1].click()
  assert.deepEqual(srcs(preview), { desktop: B, mobile: undefined })
  preview.buttons.mobile.click()
  assert.deepEqual(srcs(preview), { desktop: B, mobile: B })
})

test('with items and no controls, an item tab loads the picked view', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', controls: false, items: ITEMS })
  const page = run(preview, 400)
  assert.deepEqual(srcs(preview), { desktop: undefined, mobile: A })
  preview.itemButtons[1].click()
  assert.deepEqual(srcs(preview), { desktop: undefined, mobile: B })
  page.resize(1280)
  assert.deepEqual(srcs(preview), { desktop: B, mobile: B }, 'a view shown later loads the item URL')
})

test('an item tab does not load a heading pane as a view', () => {
  const preview = buildPreview({ devices: ['desktop'], active: 'desktop', items: ITEMS })
  run(preview, 1280)
  assert.doesNotThrow(() => preview.itemButtons[1].click())
  assert.deepEqual(preview.headings.map(isShown), [false, true])
})

test('with items without headings, the content panel is labelled by the shown item tab', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', items: ITEMS, panel: true })
  run(preview, 1280)
  assert.equal(preview.content.getAttribute('aria-labelledby'), 'preview-1-item-0-tab')
  preview.itemButtons[1].click()
  assert.equal(preview.content.getAttribute('aria-labelledby'), 'preview-1-item-1-tab')
  assert.deepEqual(srcs(preview), { desktop: B, mobile: undefined })
  preview.itemButtons[0].click()
  assert.equal(preview.content.getAttribute('aria-labelledby'), 'preview-1-item-0-tab')
})

test('with item headings, the content is no tab panel and gets no label', () => {
  const preview = buildPreview({ devices: ['desktop'], active: 'desktop', items: ITEMS })
  run(preview, 1280)
  preview.itemButtons[1].click()
  assert.equal(preview.content.getAttribute('aria-labelledby'), null)
})

// Runtime fallback and readiness. The state of a view is the data-preview-state
// of its pane; the iframe of a pane is the current one after any replacement.
const frame = pane => pane.children[0]
const state = pane => pane.dataset.previewState
const states = preview => Object.fromEntries(Object.entries(preview.panes).map(([device, pane]) => [device, state(pane)]))
const failLink = pane => pane.children.find(el => el.classList.contains('preview-unavailable')).children[0].children[0]
const inert = pane => frame(pane).hasAttribute('inert')
const busy = pane => pane.getAttribute('aria-busy')
const TOKEN = 'demo:ok'

test('without a ready message, a view the script loads fails after the load timeout', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop' })
  const page = run(preview, 1280)
  preview.buttons.mobile.click()
  assert.deepEqual(states(preview), { desktop: undefined, mobile: 'waiting' }, 'the view in the markup gets no deadline')
  assert.equal(inert(preview.panes.mobile), false, 'a loading view stays focusable without a ready message')
  assert.equal(busy(preview.panes.mobile), null)
  page.elapse()
  assert.deepEqual(states(preview), { desktop: undefined, mobile: 'failed' })
  assert.equal(inert(preview.panes.mobile), true, 'a failed view cannot take focus')
  assert.equal(failLink(preview.panes.mobile).href, URL)
})

test('without a ready message, a load before the deadline makes the view ready', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop' })
  const page = run(preview, 1280)
  preview.buttons.mobile.click()
  frame(preview.panes.mobile).dispatch('load')
  assert.equal(state(preview.panes.mobile), 'ready')
  page.elapse()
  assert.equal(state(preview.panes.mobile), 'ready', 'the deadline no longer fails it')
})

test('without a ready message, a late load recovers a failed view', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop' })
  const page = run(preview, 1280)
  preview.buttons.mobile.click()
  page.elapse()
  assert.equal(state(preview.panes.mobile), 'failed')
  frame(preview.panes.mobile).dispatch('load')
  assert.equal(state(preview.panes.mobile), 'ready')
  assert.equal(inert(preview.panes.mobile), false)
})

test('without a ready message, no message makes a view ready', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop' })
  const page = run(preview, 1280)
  preview.buttons.mobile.click()
  page.message('', frame(preview.panes.mobile).contentWindow)
  page.message(undefined, frame(preview.panes.mobile).contentWindow)
  assert.equal(state(preview.panes.mobile), 'waiting')
  assert.deepEqual(frame(preview.panes.mobile).contentWindow.posted, [], 'and none is sent')
})

for (const [timeout, ms] of [['5', 5000], ['0.5', 500], [null, 15000], ['0', 15000], ['-3', 15000], ['soon', 15000]]) {
  test(`a load-timeout of ${timeout} gives a deadline of ${ms}ms`, () => {
    const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', timeout })
    const page = run(preview, 1280)
    preview.buttons.mobile.click()
    assert.deepEqual(page.delays, [ms])
  })
}

test('with a ready message, the view in the markup waits and asks its frame at initialization', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', readyMessage: TOKEN })
  run(preview, 1280, { until: 'none' })
  assert.deepEqual(frame(preview.panes.desktop).contentWindow.posted, [], 'nothing before initialization')
  const page = run(preview, 1280, { until: 'none', readyState: 'interactive' })
  assert.deepEqual(states(preview), { desktop: 'waiting', mobile: undefined })
  assert.deepEqual(frame(preview.panes.desktop).contentWindow.posted, [[TOKEN, '*']], 'one request with the configured message')
  assert.equal(busy(preview.panes.desktop), 'true')
  assert.equal(inert(preview.panes.desktop), true)
  assert.deepEqual(page.delays, [15000])
  assert.deepEqual(frame(preview.panes.mobile).contentWindow.posted, [], 'a view that has not loaded is not asked')
})

test('with a ready message, a load asks the frame again but does not end the wait', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', readyMessage: TOKEN })
  const page = run(preview, 1280)
  preview.buttons.mobile.click()
  const iframe = frame(preview.panes.mobile)
  assert.deepEqual(iframe.contentWindow.posted, [], 'a view the script loads is asked on load')
  iframe.dispatch('load')
  assert.deepEqual(iframe.contentWindow.posted, [[TOKEN, '*']])
  assert.equal(state(preview.panes.mobile), 'waiting')
  assert.equal(inert(preview.panes.mobile), true)
  page.elapse()
  assert.equal(state(preview.panes.mobile), 'failed', 'a load is no readiness')
  assert.equal(busy(preview.panes.mobile), null, 'a failed view is not busy')
})

test('with a ready message, only that exact message from the current frame makes the view ready', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', readyMessage: TOKEN })
  const page = run(preview, 1280)
  const pane = preview.panes.desktop
  const win = frame(pane).contentWindow
  page.message('preview:ready', win)
  page.message(`${TOKEN} `, win)
  page.message(TOKEN.toUpperCase(), win)
  page.message({ data: TOKEN }, win)
  page.message([TOKEN], win)
  page.message(new String(TOKEN), win) // eslint-disable-line no-new-wrappers
  page.message(TOKEN, frame(preview.panes.mobile).contentWindow)
  page.message(TOKEN, new FakeWindow())
  page.message(TOKEN, null)
  assert.equal(state(pane), 'waiting', 'no other message, sibling frame or window makes it ready')
  page.message(TOKEN, win)
  assert.equal(state(pane), 'ready')
  assert.equal(inert(pane), false)
  assert.equal(busy(pane), null)
  page.elapse()
  assert.equal(state(pane), 'ready', 'the deadline ended')
})

test('with a ready message, the acknowledgement of one view does not reveal another', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', readyMessage: TOKEN })
  const page = run(preview, 1280)
  preview.buttons.mobile.click()
  page.message(TOKEN, frame(preview.panes.desktop).contentWindow)
  assert.deepEqual(states(preview), { desktop: 'ready', mobile: 'waiting' })
  page.elapse()
  assert.deepEqual(states(preview), { desktop: 'ready', mobile: 'failed' })
})

test('with a ready message, a late acknowledgement recovers a failed view', () => {
  const preview = buildPreview({ devices: ['desktop'], active: 'desktop', readyMessage: TOKEN })
  const page = run(preview, 1280)
  page.elapse()
  assert.equal(state(preview.panes.desktop), 'failed')
  page.message(TOKEN, frame(preview.panes.desktop).contentWindow)
  assert.equal(state(preview.panes.desktop), 'ready')
  assert.equal(inert(preview.panes.desktop), false)
})

test('with a ready message, an item switch ignores the replaced frame and waits for the copy', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', readyMessage: TOKEN, items: ITEMS })
  const page = run(preview, 1280)
  preview.buttons.mobile.click()
  preview.buttons.desktop.click()
  page.message(TOKEN, frame(preview.panes.mobile).contentWindow)
  const old = frame(preview.panes.desktop)
  preview.itemButtons[1].click()
  const copy = frame(preview.panes.desktop)
  assert.notEqual(copy, old)
  assert.deepEqual(states(preview), { desktop: 'waiting', mobile: undefined }, 'the switch resets every view')
  assert.equal(inert(preview.panes.mobile), true, 'the reset view cannot take focus')
  assert.equal(busy(preview.panes.mobile), null)
  page.message(TOKEN, old.contentWindow)
  assert.equal(state(preview.panes.desktop), 'waiting', 'the replaced frame cannot make the copy ready')
  page.message(TOKEN, copy.contentWindow)
  assert.equal(state(preview.panes.desktop), 'ready')
  page.elapse()
  assert.deepEqual(states(preview), { desktop: 'ready', mobile: undefined }, 'no earlier deadline fails a view')
})

test('without a ready message, an item switch resets a failed view so its copy can take focus', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', items: ITEMS })
  const page = run(preview, 1280)
  preview.buttons.mobile.click()
  page.elapse()
  assert.equal(state(preview.panes.mobile), 'failed')
  preview.itemButtons[1].click()
  assert.deepEqual(states(preview), { desktop: undefined, mobile: 'waiting' })
  assert.equal(inert(preview.panes.mobile), false)
  assert.equal(inert(preview.panes.desktop), false)
})

test('a failed view links to the open URL of the shown item', () => {
  const preview = buildPreview({ devices: ['desktop'], active: 'desktop', readyMessage: TOKEN, items: ITEMS })
  const page = run(preview, 1280)
  preview.itemButtons[1].click()
  page.elapse()
  assert.equal(state(preview.panes.desktop), 'failed')
  assert.equal(failLink(preview.panes.desktop).href, 'https://example.org/b-open')
  preview.itemButtons[0].click()
  page.elapse()
  assert.equal(failLink(preview.panes.desktop).href, A, 'the item URL when it has no open URL')
})

test('with a ready message and click activation, nothing waits or is asked before the poster button', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', readyMessage: TOKEN, activation: 'click' })
  const page = run(preview, 1280)
  assert.deepEqual(states(preview), { desktop: undefined, mobile: undefined })
  assert.deepEqual(page.delays, [])
  preview.activate('desktop')
  assert.deepEqual(states(preview), { desktop: 'waiting', mobile: undefined })
  frame(preview.panes.desktop).dispatch('load')
  page.message(TOKEN, frame(preview.panes.desktop).contentWindow)
  assert.equal(state(preview.panes.desktop), 'ready')
})

test('with a ready message, a frame rendered after initialization becomes ready on its acknowledgement', () => {
  const preview = buildPreview({ devices: ['desktop'], active: 'desktop', readyMessage: TOKEN })
  const page = run(preview, 1280)
  const later = buildPreview({ devices: ['desktop'], active: 'desktop', readyMessage: TOKEN })
  page.document.append(later.section)
  page.message('other', frame(later.panes.desktop).contentWindow)
  assert.equal(state(later.panes.desktop), undefined)
  page.message(TOKEN, frame(later.panes.desktop).contentWindow)
  assert.equal(state(later.panes.desktop), 'ready')
  assert.equal(inert(later.panes.desktop), false)
})

test('with an IntersectionObserver, the deadline starts when the frame first comes into view', () => {
  const observers = []
  class IntersectionObserver {
    constructor (callback) { this.callback = callback; this.targets = []; observers.push(this) }
    observe (target) { this.targets.push(target) }
    disconnect () { this.targets = [] }
  }
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', readyMessage: TOKEN })
  const page = run(preview, 1280, { globals: { IntersectionObserver } })
  const iframe = frame(preview.panes.desktop)
  assert.deepEqual(observers.flatMap(observer => observer.targets), [iframe])
  assert.deepEqual(page.delays, [], 'no deadline out of view')
  observers[0].callback([{ target: iframe, isIntersecting: false }])
  assert.deepEqual(page.delays, [])
  observers[0].callback([{ target: iframe, isIntersecting: true }])
  assert.deepEqual(page.delays, [15000])
  assert.deepEqual(observers[0].targets, [], 'it stops observing')
  page.elapse()
  assert.equal(state(preview.panes.desktop), 'failed')
})

test('with an IntersectionObserver, a view that is ready before it comes into view gets no deadline', () => {
  const observers = []
  class IntersectionObserver {
    constructor (callback) { this.callback = callback; observers.push(this) }
    observe () {}
    disconnect () {}
  }
  const preview = buildPreview({ devices: ['desktop'], active: 'desktop', readyMessage: TOKEN })
  const page = run(preview, 1280, { globals: { IntersectionObserver } })
  page.message(TOKEN, frame(preview.panes.desktop).contentWindow)
  observers[0].callback([{ target: frame(preview.panes.desktop), isIntersecting: true }])
  assert.deepEqual(page.delays, [])
})

test('a view of a block that shows its fallback, which has no failure alert, still fails', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', controls: false, fallback: true, items: ITEMS })
  const page = run(preview, 400)
  page.elapse()
  assert.equal(state(preview.panes.mobile), 'failed')
})

test('with a ready message, an item switch clears the busy state of a view it hides', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', readyMessage: TOKEN, items: ITEMS })
  run(preview, 1280)
  preview.buttons.mobile.click()
  preview.buttons.desktop.click()
  assert.equal(busy(preview.panes.mobile), 'true')
  preview.itemButtons[1].click()
  assert.equal(busy(preview.panes.mobile), null)
  assert.equal(state(preview.panes.mobile), undefined)
})

// An iframe without src holds a same-origin about:blank window, which a script
// can post from. Before a navigation starts, the ready message from it changes
// nothing: no state, busy state or deadline, and the iframe stays inert.
test('with a ready message, the message from the window of an iframe without src changes nothing', () => {
  const preview = buildPreview({ devices: ['desktop', 'mobile'], active: 'desktop', readyMessage: TOKEN })
  const page = run(preview, 1280)
  page.message(TOKEN, frame(preview.panes.mobile).contentWindow)
  assert.deepEqual(states(preview), { desktop: 'waiting', mobile: undefined })
  assert.equal(busy(preview.panes.mobile), null)
  assert.equal(inert(preview.panes.mobile), true)
  assert.deepEqual(page.delays, [15000], 'no deadline starts or ends')
  preview.buttons.mobile.click()
  assert.equal(state(preview.panes.mobile), 'waiting', 'the later navigation still waits')
  page.message(TOKEN, frame(preview.panes.mobile).contentWindow)
  assert.equal(state(preview.panes.mobile), 'ready')
})

test('with a ready message and click activation, a message before activation changes nothing, even from an iframe with src', () => {
  const preview = buildPreview({ devices: ['desktop'], active: 'desktop', readyMessage: TOKEN, activation: 'click' })
  const page = run(preview, 1280)
  page.message(TOKEN, frame(preview.panes.desktop).contentWindow)
  assert.equal(state(preview.panes.desktop), undefined, 'without src')
  frame(preview.panes.desktop).setAttribute('src', URL)
  page.message(TOKEN, frame(preview.panes.desktop).contentWindow)
  assert.equal(state(preview.panes.desktop), undefined, 'with src set by another script before activation')
  assert.equal(inert(preview.panes.desktop), true)
  assert.deepEqual(page.delays, [])
  frame(preview.panes.desktop).removeAttribute('src')
  preview.activate('desktop')
  assert.equal(state(preview.panes.desktop), 'waiting')
  page.message(TOKEN, frame(preview.panes.desktop).contentWindow)
  assert.equal(state(preview.panes.desktop), 'ready')
})
