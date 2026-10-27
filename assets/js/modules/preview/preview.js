/**
 * Preview Component - Auto-scale and auto-switch on resize.
 * Bundled as part of the bookshop optional JS module.
 *
 * Scaling strategy:
 * - Desktop (responsive mode, default): scales to fill the full container
 *   width; iframe height is set dynamically so the container height is also
 *   filled after the CSS transform.
 * - Desktop (strict mode, desktop-responsive=false): contain fit —
 *   min(containerWidth/1440, containerHeight/900) — keeps full frame visible.
 * - Tablet and mobile: contain fit so neither dimension is clipped.
 *
 * Uses hardcoded device dimensions because hidden Bootstrap tab panes
 * return clientWidth/clientHeight = 0.
 * Also switches to the largest visible device that fits when the active panel
 * is hidden by a viewport-width breakpoint.
 *
 * Every iframe carries its URL in data-src. With load activation, the default
 * view also carries src in the markup when the block has controls, or when
 * Bookshop live editing renders it; the script sets src on another view when
 * that view is first shown. For the blocks without controls
 * (data-controls="false") present when the script initializes, it picks the
 * view then and again whenever the viewport crosses a device breakpoint.
 *
 * With click activation (data-activation="click") no iframe carries src in the
 * markup, and every view shows a poster, unless the block shows its fallback,
 * which has no poster. Views still switch, but none loads until the poster
 * button is pressed: that loads the shown view, picking it first for a block
 * without controls, sets data-active="true" on the content, which hides the
 * posters unless the block has a ready message, and dispatches a bubbling
 * preview:activate event on the section. After that, views load as above.
 *
 * With visible activation the shown view starts after actual viewport entry,
 * parent load and an idle opportunity (600ms timeout). Opt-in mobile-static
 * blocks never navigate below 1024px and forget earlier navigation windows.
 * Window framing contains the native viewport below a measured title bar.
 *
 * With items, a tab per item sits above the frame, and every iframe starts with
 * the URL of the first item in data-src. Showing an item tab gives every iframe
 * the item URL in data-src, and loads it in the shown view when the block may
 * load its views; another view drops the URL it loaded, so it loads the item
 * URL when it is next shown. An iframe that has loaded is replaced by a copy
 * without src first, so a switch adds no entry to the session history. Every
 * iframe takes the label of the item tab as its title. When the content is the
 * tab panel of the item tabs, which it is when no item has a heading, the shown
 * tab labels it. The script also shows the poster image of the item in every
 * poster, points every .preview-open link and the link of every failure alert
 * at the open URL of the item, and dispatches a bubbling preview:item event on
 * the section, with the index of the item in its detail.
 *
 * Each navigation the script starts gets a deadline of data-load-timeout
 * seconds, 15 when that is not a positive number, which starts when the iframe
 * first intersects the viewport, or at once without IntersectionObserver. The
 * pane carries data-preview-state: waiting, ready or failed. When the deadline
 * passes first, the pane fails: its poster, if any, shows, the iframe is hidden
 * and inert, and the pane shows its alert, whose link opens the shown item.
 * Showing an item resets every pane. A block that shows its build-time fallback
 * has no live view to wait for: none of this applies to it, so its panes take
 * no state, deadline or busy state, also with data-ready-message, and no
 * message changes them.
 *
 * Without data-ready-message, the load event of the iframe makes the pane
 * ready. Chrome fires load for an error status and a refused connection too,
 * so this catches a target that does not answer, not one that answers with an
 * error. The iframe that the markup gives src gets no deadline, as its load
 * event may come before the script runs.
 *
 * With data-ready-message, every view has a poster, with load activation too,
 * unless the block shows its fallback, and load is no readiness. The pane is
 * busy, its poster shows a waiting status, also after click activation, and its
 * iframe is inert, until the window of its current iframe posts exactly that
 * string to this page. The script posts the string to the iframe window on
 * load, and at initialization for the iframe that the markup gives src, so a
 * frame that announced itself before the script listened can answer. A message
 * from another window, with other data, from an iframe without src or before
 * click activation changes nothing. A late acknowledgement recovers a failed pane, and the script never
 * moves focus.
 *
 * Opt-in theme-message adds a current-document exchange after readiness. A
 * monotonically increasing requestId, resolved light/dark theme and captured
 * HTTP(S) origin must match the applied ACK before reveal. A transient name
 * seed lets a participating child style its next full document before paint;
 * pagehide/startup invalidation and iframe load require fresh proof. Seeds are
 * limited to 512 characters; invalid admission keeps useful failure feedback.
 */

;(function () {
  'use strict'

  const PREVIEW_DEVICE_DIMS = {
    'preview-desktop': { width: 1440, height: 900 },
    'preview-tablet': { width: 820, height: 1180 },
    'preview-mobile': { width: 402, height: 874 }
  }

  // Devices from largest to smallest.
  const PREVIEW_DEVICES = ['desktop', 'tablet', 'mobile']

  // The media query below which each device view does not fit. These are the
  // max-width media queries that hide the desktop and tablet panes and buttons in
  // preview.scss; keep both in step. Mobile always fits.
  const PREVIEW_DEVICE_TOO_NARROW = {
    desktop: '(max-width: 1023px)',
    tablet: '(max-width: 639px)'
  }

  function deviceFits (device) {
    const query = PREVIEW_DEVICE_TOO_NARROW[device]
    return !query || !window.matchMedia(query).matches
  }

  /**
   * Returns the largest offered device whose breakpoint fits the viewport,
   * or the smallest offered device when none fits.
   */
  function pickDevice (offered) {
    const bySize = PREVIEW_DEVICES.filter(device => offered.includes(device))
    return bySize.find(deviceFits) || bySize[bySize.length - 1]
  }

  /**
   * Calls back whenever the viewport crosses a device breakpoint, on a change
   * event of the same media queries the stylesheet hides views with, without a
   * debounce.
   */
  function onBreakpointChange (callback) {
    Object.values(PREVIEW_DEVICE_TOO_NARROW).forEach(query => {
      window.matchMedia(query).addEventListener('change', callback)
    })
  }

  // The default deadline of a navigation, in seconds.
  const PREVIEW_LOAD_TIMEOUT = 15

  // The navigation record of each watched iframe.
  const frames = new WeakMap()

  function readyMessage (container) {
    return container.dataset.readyMessage || ''
  }

  const THEME_SEED_PREFIX = 'hinode-preview-theme:'
  let themeRequestId = 0

  function themeMessage (container) { return container.dataset.themeMessage || '' }

  function resolvedTheme () {
    const root = document.documentElement
    return [root.dataset.bsTheme, root.dataset.theme].find(value => value === 'light' || value === 'dark') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  }

  function httpOrigin (value) {
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) && url.origin === value ? value : null
    } catch { return null }
  }

  function owned (container) {
    return container.isConnected && container.ownerDocument === document
  }

  function currentThemeFrame (record) {
    return owned(record.container) && frames.get(record.iframe) === record &&
      isActivated(record.container) && record.iframe.hasAttribute('src') && record.pane.classList.contains('active')
  }

  // Name is transient browsing-context state, restored when ownership ends.
  // The child can apply it in its early critical task before a full navigation
  // paints; it never replaces the current document's correlated applied ACK.
  function seedTheme (record) {
    const parentOrigin = httpOrigin(window.location.origin)
    const seed = THEME_SEED_PREFIX + JSON.stringify({ type: themeMessage(record.container), theme: resolvedTheme(), requestId: record.seedId, parentOrigin })
    if (!parentOrigin || seed.length > 512) return false
    record.iframe.setAttribute('name', seed)
    return true
  }

  function requestTheme (record) {
    if (!currentThemeFrame(record) || !record.origin) return
    const theme = resolvedTheme()
    if (record.themeRequest && record.themeRequest.theme === theme) return
    if (!record.themeRequest && record.state === 'ready' && record.applied && record.applied.theme === theme) return
    if (themeRequestId === Number.MAX_SAFE_INTEGER) { setState(record, 'failed'); return }
    const request = { type: themeMessage(record.container), theme, requestId: ++themeRequestId }
    record.seedId = request.requestId
    if (!seedTheme(record)) { setState(record, 'failed'); return }
    record.themeRequest = request
    if (record.state === 'ready' || record.state === null) {
      setState(record, 'waiting')
      stopDeadline(record)
      startDeadline(record)
    }
    record.iframe.contentWindow.postMessage(request, record.origin)
  }

  function updateThemes () {
    document.querySelectorAll('section.preview .preview-content .preview-iframe').forEach(iframe => {
      const record = frames.get(iframe)
      if (!record || !themeMessage(record.container) || !currentThemeFrame(record)) return
      if (!seedTheme(record)) { setState(record, 'failed'); return }
      requestTheme(record)
    })
  }

  function loadTimeout (container) {
    const seconds = Number(container.dataset.loadTimeout)
    return (seconds > 0 ? seconds : PREVIEW_LOAD_TIMEOUT) * 1000
  }

  function updateWindowStatus (container) {
    if (container.dataset.frame !== 'window') return
    const win = container.closest('.preview-window')
    const status = win.querySelector('.preview-window-status')
    const visible = win.querySelector('.preview-window-state')
    const pane = container.querySelector(':scope > .tab-pane.active')
    const state = isStatic(container) ? 'preview' : (pane && pane.dataset.previewState) || (container.querySelector('.preview-error:not(.d-none)') ? 'failed' : 'preview')
    status.textContent = status.dataset[`${state}Label`]
    visible.querySelector('.preview-state-word').textContent = visible.dataset[`${state}Label`]
    visible.querySelector('.preview-state-short').textContent = visible.dataset[`compact${state[0].toUpperCase() + state.slice(1)}Label`] || visible.dataset[`${state}Label`]
    win.dataset.previewState = state
    updatePreviewScale()
  }

  /**
   * Sets the state of the pane of a navigation, with the busy state and inert
   * iframe that go with it.
   */
  function setState (record, state) {
    const { iframe, pane, container } = record
    if (!owned(container) || isStatic(container) || frames.get(iframe) !== record) return
    record.state = state
    pane.dataset.previewState = state
    const waiting = state === 'waiting' && readyMessage(container) !== ''
    if (waiting) pane.setAttribute('aria-busy', 'true'); else pane.removeAttribute('aria-busy')
    if (waiting || state === 'failed') iframe.setAttribute('inert', ''); else iframe.removeAttribute('inert')
    updateWindowStatus(container)
  }

  function stopDeadline (record) {
    clearTimeout(record.timer)
    if (record.observer) record.observer.disconnect()
  }

  /**
   * Starts the deadline of a navigation once its iframe first intersects the
   * viewport, or at once without IntersectionObserver.
   */
  function startDeadline (record) {
    const start = () => {
      if (!owned(record.container) || frames.get(record.iframe) !== record) return
      record.timer = setTimeout(() => setState(record, 'failed'), loadTimeout(record.container))
    }
    if (typeof IntersectionObserver === 'undefined') {
      start()
      return
    }
    record.observer = new IntersectionObserver(entries => {
      if (!owned(record.container) || frames.get(record.iframe) !== record) return
      if (!entries.some(entry => entry.isIntersecting)) return
      stopDeadline(record)
      if (record.state === 'waiting') start()
    })
    record.observer.observe(record.iframe)
  }

  function markReady (record) {
    stopDeadline(record)
    setState(record, 'ready')
  }

  // Posts the ready message to the window of the iframe of a navigation.
  function askReady (record) {
    if (!isActivated(record.container) || frames.get(record.iframe) !== record || !record.iframe.hasAttribute('src')) return
    record.iframe.contentWindow.postMessage(readyMessage(record.container), '*')
  }

  /**
   * Creates the record of an iframe in a view pane, which belongs to it alone,
   * so a copy that replaces it starts from nothing. A block that shows its
   * build-time fallback, whose fallback alert lacks d-none, has no live view to
   * wait for, so its iframes get no record.
   */
  function track (iframe) {
    const pane = iframe.closest('.tab-pane')
    const container = pane.closest('.preview-content')
    if (!owned(container) || isStatic(container) || container.querySelector('.preview-error:not(.d-none)')) return null
    const record = { iframe, pane, container, state: null, timer: null, observer: null,
      originalName: iframe.getAttribute('name'), seedId: 0, origin: null, themeRequest: null, applied: null, loaded: iframe.hasAttribute('src') }
    frames.set(iframe, record)
    return record
  }

  /**
   * Watches the navigation of an iframe in a view pane, before the script gives
   * it src or, for the iframe the markup gives src, at initialization. Returns
   * null for an iframe that gets no record.
   */
  function watch (iframe) {
    const record = track(iframe)
    if (!record) return null
    record.onLoad = () => {
      if (frames.get(iframe) !== record || !isActivated(record.container)) return
      if (themeMessage(record.container)) {
        // A full navigation keeps WindowProxy. Invalidate every previous
        // document's proof, even if its early ready message beat this load.
        record.origin = null
        record.themeRequest = null
        record.applied = null
        const wasLoaded = record.loaded
        record.loaded = true
        const wasReady = record.state === 'ready'
        setState(record, 'waiting')
        if (wasLoaded || wasReady) { stopDeadline(record); startDeadline(record) }
      }
      if (readyMessage(record.container)) askReady(record); else markReady(record)
    }
    iframe.addEventListener('load', record.onLoad)
    setState(record, 'waiting')
    startDeadline(record)
    return record
  }

  /**
   * Forgets the navigation of the pane's iframe and resets the pane, before an
   * item switch replaces or reloads the iframe. The iframe stays inert while a
   * ready message is still to come.
   */
  function forget (pane, iframe) {
    const record = frames.get(iframe)
    if (record) {
      stopDeadline(record)
      if (record.onLoad) iframe.removeEventListener('load', record.onLoad)
      if (themeMessage(record.container)) {
        if (record.originalName === null) iframe.removeAttribute('name'); else iframe.setAttribute('name', record.originalName)
      }
    }
    frames.delete(iframe)
    delete pane.dataset.previewState
    pane.removeAttribute('aria-busy')
    if (readyMessage(pane.closest('.preview-content'))) iframe.setAttribute('inert', ''); else iframe.removeAttribute('inert')
  }

  // Makes a pane ready when the window of its current iframe posts the ready
  // message of its block. Listen from the start, before any navigation. Only an
  // iframe with src in a block that may load its views counts: one without src
  // holds a same-origin about:blank window that a script can post from.
  window.addEventListener('message', event => {
    document.querySelectorAll('section.preview .preview-content .preview-iframe').forEach(iframe => {
      if (iframe.contentWindow !== event.source) return
      const container = iframe.closest('.preview-content')
      if (!iframe.hasAttribute('src') || !isActivated(container)) return
      const message = readyMessage(container)
      if (message === '') return
      if (!themeMessage(container)) {
        if (event.data !== message) return
        const record = frames.get(iframe) || track(iframe)
        if (record) markReady(record)
        return
      }
      const record = frames.get(iframe) || watch(iframe)
      if (!record || !currentThemeFrame(record)) return
      const origin = httpOrigin(event.origin)
      if (!origin) return
      if (event.data === message) {
        record.origin = origin
        if (record.loaded) requestTheme(record)
        return
      }
      const ack = event.data
      if (!ack || typeof ack !== 'object' || Array.isArray(ack) || ack.type !== themeMessage(container) ||
          !Number.isSafeInteger(ack.requestId) || ack.requestId <= 0 || !['light', 'dark'].includes(ack.theme) || record.origin !== origin) return
      if (ack.applied === false) {
        const proof = [record.themeRequest, record.applied].find(proof => proof && proof.requestId === ack.requestId && proof.theme === ack.theme)
        if (!proof) return
        record.origin = null
        record.themeRequest = null
        record.applied = null
        setState(record, 'waiting')
        stopDeadline(record)
        startDeadline(record)
        return
      }
      const request = record.themeRequest
      if (ack.applied !== true || !request || ack.requestId !== request.requestId ||
          ack.theme !== request.theme || ack.theme !== resolvedTheme()) return
      record.applied = request
      record.themeRequest = null
      markReady(record)
    })
  })

  /**
   * Gives the pane's iframe its src from data-src, once.
   */
  function loadPane (pane) {
    if (!pane) return
    if (!isActivated(pane.closest('.preview-content'))) return
    const iframe = pane.querySelector('iframe[data-src]')
    if (!iframe) return
    if (!iframe.hasAttribute('src')) {
      const record = watch(iframe)
      if (record && themeMessage(record.container) && !seedTheme(record)) {
        setState(record, 'failed')
        stopDeadline(record)
        return
      }
      iframe.src = iframe.dataset.src
    } else if (themeMessage(pane.closest('.preview-content'))) {
      const record = frames.get(iframe) || watch(iframe)
      if (record) {
        if (!seedTheme(record)) { setState(record, 'failed'); stopDeadline(record); return }
        if (record.origin) requestTheme(record); else askReady(record)
      }
    }
  }

  /**
   * Reports whether the block may load its views: always, unless it waits for
   * its poster button.
   */
  function isActivated (container) {
    if (!owned(container) || isStatic(container)) return false
    return !['click', 'visible'].includes(container.dataset.activation) || container.dataset.active === 'true'
  }

  /**
   * Shows the pane of the device that pickDevice chooses among the offered
   * views, and returns it.
   */
  function showFittingPane (container) {
    const offered = (container.dataset.devices || '').split(' ').filter(Boolean)
    const device = pickDevice(offered)
    const panes = Array.from(container.querySelectorAll(':scope > .tab-pane'))
    const target = panes.find(pane => pane.id.endsWith(`-${device}`))
    if (!target) return null
    panes.forEach(pane => {
      const active = pane === target
      pane.classList.toggle('show', active)
      pane.classList.toggle('active', active)
    })
    return target
  }

  /**
   * Shows the views of the item whose tab is shown.
   */
  function showItem (section, tab) {
    const index = Array.from(tab.closest('.preview-items').querySelectorAll('[data-bs-toggle="tab"]')).indexOf(tab)
    const url = tab.dataset.previewUrl
    const title = tab.textContent.trim()
    const container = section.querySelector('.preview-content')
    const activated = isActivated(container)
    if (tab.getAttribute('aria-controls') === container.id) {
      container.setAttribute('aria-labelledby', tab.id)
    }
    container.querySelectorAll(':scope > .tab-pane').forEach(pane => {
      let iframe = pane.querySelector('iframe[data-src]')
      if (iframe) {
        forget(pane, iframe)
        if (iframe.hasAttribute('src')) {
          const copy = iframe.cloneNode(false)
          copy.removeAttribute('src')
          iframe.replaceWith(copy)
          iframe = copy
        }
        iframe.dataset.src = url
        iframe.setAttribute('title', title)
        if (activated && pane.classList.contains('active')) loadPane(pane)
      }
      pane.querySelectorAll('.preview-poster-item').forEach(image => {
        image.classList.toggle('d-none', image.dataset.previewItem !== String(index))
      })
    })
    section.querySelectorAll('.preview-open, .preview-unavailable-link').forEach(link => { link.href = tab.dataset.previewOpenUrl })
    section.dispatchEvent(new CustomEvent('preview:item', { bubbles: true, detail: { index } }))
  }

  function isStatic (container) {
    return (enhanced(container) && !ownershipSupported) || (container.dataset.mobileStatic === 'true' && !deviceFits('desktop'))
  }

  // Only opt-in lifecycle modes need discovery and an eligibility controller.
  // Existing editor/load behavior remains on the original initialization path.
  const controllers = new Map()
  const measuredWindows = new Map()
  const geometryObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updatePreviewScale) : null
  const ownershipHooks = new WeakMap()
  const ownershipTag = 'hinode-preview-owner'
  const registry = window.customElements
  const ownershipSupported = !!(registry && typeof registry.define === 'function' && typeof registry.get === 'function' && window.HTMLElement)

  // Observer delivery is too late to stop an iframe reconnecting in one task.
  // These native reactions release ownership synchronously. Per-node callbacks
  // keep independently initialized documents isolated when a subtree is adopted.
  if (ownershipSupported && !registry.get(ownershipTag)) {
    registry.define(ownershipTag, class extends window.HTMLElement {
      disconnectedCallback () { if (this.previewRelease) this.previewRelease() }
      adoptedCallback () { if (this.previewRelease) this.previewRelease() }
    })
  }

  function observeOwnership (container, controller) {
    let hook = ownershipHooks.get(container)
    if (hook && hook.parentElement === container) return
    hook = document.createElement(ownershipTag)
    hook.hidden = true
    hook.style.setProperty('display', 'none', 'important')
    hook.previewRelease = () => {
      if (controllers.get(container) === controller) releaseOwnership(container)
    }
    ownershipHooks.set(container, hook)
    container.append(hook)
  }

  function enhanced (container) {
    return container.dataset.activation === 'visible' || container.dataset.mobileStatic === 'true' || themeMessage(container) !== ''
  }

  function inViewport (container) {
    const rect = container.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth
  }

  function cancelActivation (controller) {
    if (controller.idle === null) return
    if (controller.nativeIdle) window.cancelIdleCallback(controller.idle); else clearTimeout(controller.idle)
    controller.idle = null
    controller.generation++
  }

  function resetStatic (container) {
    container.querySelectorAll(':scope > .tab-pane').forEach(pane => {
      const iframe = pane.querySelector('iframe[data-src]')
      if (!iframe) return
      forget(pane, iframe)
      if (iframe.hasAttribute('src')) {
        const copy = iframe.cloneNode(false)
        copy.removeAttribute('src')
        iframe.replaceWith(copy)
      }
    })
    delete container.dataset.active
    if (container.dataset.frame === 'window') updateWindowStatus(container)
  }

  function shownPane (container) {
    return container.dataset.controls === 'false'
      ? showFittingPane(container)
      : container.querySelector(':scope > .tab-pane.active')
  }

  function eligible (container) {
    return owned(container) && !isStatic(container) && document.readyState === 'complete' && inViewport(container)
  }

  function reconcile (container, controller) {
    if (controllers.get(container) !== controller) return
    if (!owned(container)) { releaseOwnership(container); return }
    const narrow = isStatic(container)
    if (narrow) {
      cancelActivation(controller)
      if (container.dataset.previewStatic !== 'true') resetStatic(container)
      container.dataset.previewStatic = 'true'
      return
    }
    delete container.dataset.previewStatic
    if (container.dataset.activation !== 'visible') {
      if (isActivated(container)) loadPane(shownPane(container))
      return
    }
    if (container.dataset.active === 'true') return
    if (!eligible(container)) { cancelActivation(controller); return }
    if (controller.idle !== null) return
    const generation = ++controller.generation
    const activate = () => {
      if (controllers.get(container) !== controller || generation !== controller.generation) return
      controller.idle = null
      if (!eligible(container)) return
      container.dataset.active = 'true'
      loadPane(shownPane(container))
      updatePreviewScale()
      container.closest('section.preview').dispatchEvent(new CustomEvent('preview:activate', { bubbles: true }))
    }
    controller.nativeIdle = typeof window.requestIdleCallback === 'function' && typeof window.cancelIdleCallback === 'function'
    controller.idle = controller.nativeIdle ? window.requestIdleCallback(activate, { timeout: 600 }) : setTimeout(activate, 0)
  }

  function releaseOwnership (container) {
    const hook = ownershipHooks.get(container)
    if (hook) {
      ownershipHooks.delete(container)
      hook.previewRelease = null
      hook.remove()
    }
    const controller = controllers.get(container)
    if (controller) {
      cancelActivation(controller)
      if (controller.observer) controller.observer.disconnect()
      controllers.delete(container)
      resetStatic(container)
    }
    const bar = measuredWindows.get(container)
    if (bar) {
      geometryObserver.unobserve(bar)
      measuredWindows.delete(container)
    }
  }

  function discoverPreviews () {
    measuredWindows.forEach((bar, container) => { if (!owned(container)) releaseOwnership(container) })
    controllers.forEach((controller, container) => { if (!owned(container)) releaseOwnership(container) })
    document.querySelectorAll('section.preview .preview-content').forEach(container => {
      if (geometryObserver && container.dataset.frame === 'window' && !measuredWindows.has(container)) {
        const bar = container.closest('.preview-window').querySelector('.preview-window-bar')
        measuredWindows.set(container, bar)
        geometryObserver.observe(bar)
      }
      if (!enhanced(container)) return
      // Without native synchronous ownership reactions, enhanced modes stay
      // static. The unconfigured legacy load/click modes retain their defaults.
      if (!ownershipSupported) { resetStatic(container); container.dataset.previewStatic = 'true'; return }
      let controller = controllers.get(container)
      if (!controller) {
        controller = { idle: null, generation: 0, observer: null }
        controllers.set(container, controller)
        if (typeof IntersectionObserver !== 'undefined') {
          controller.observer = new IntersectionObserver(() => reconcile(container, controller))
          controller.observer.observe(container)
        }
      }
      observeOwnership(container, controller)
      reconcile(container, controller)
    })
  }

  // Measure normal chrome first on every pass, then choose one final layout.
  // This makes resize observation deterministic when compact chrome is shorter.
  // When even minimum chrome cannot fit, retain useful native content and let
  // the page scroll instead of clipping the action or collapsing the viewport.
  function fitWindow (container) {
    const win = container.closest('.preview-window')
    const bar = win.querySelector('.preview-window-bar')
    const pane = container.querySelector(':scope > .tab-pane.active')
    const iframe = pane && pane.querySelector('.preview-iframe')
    const device = iframe && Object.keys(PREVIEW_DEVICE_DIMS).find(cls => iframe.classList.contains(cls))
    const { width, height } = PREVIEW_DEVICE_DIMS[device || 'preview-desktop']
    const navigation = document.querySelector('.navbar, header[role="banner"]')
    const navigationHeight = navigation ? navigation.getBoundingClientRect().height : 0
    const availableHeight = window.innerHeight - navigationHeight
    win.classList.remove('preview-window-compact')
    win.style.width = `${Math.min(win.parentElement.clientWidth, width + 2)}px`
    const maximumWidth = win.getBoundingClientRect().width
    const insets = maximumWidth - container.getBoundingClientRect().width
    const winStyle = window.getComputedStyle(win)
    const borderHeight = parseFloat(winStyle.borderTopWidth) + parseFloat(winStyle.borderBottomWidth)
    const measure = () => {
      const style = window.getComputedStyle(bar)
      const children = [...bar.children].filter(el => window.getComputedStyle(el).display !== 'none')
      const column = style.flexDirection === 'column'
      const chromeWidth = children.reduce((sum, el) => {
        const childStyle = window.getComputedStyle(el)
        const fixedWidth = childStyle.flexShrink === '0' ? el.getBoundingClientRect().width : parseFloat(childStyle.minWidth) || 0
        return column ? Math.max(sum, fixedWidth) : sum + fixedWidth
      }, 0) + (column ? 0 : Math.max(0, children.length - 1) * (parseFloat(style.columnGap) || 0)) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      return { minimumWidth: Math.max(32, chromeWidth) + insets, barHeight: bar.getBoundingClientRect().height }
    }
    let chrome = measure()
    const minimumHeight = () => chrome.barHeight + borderHeight + (chrome.minimumWidth - insets) * height / width
    if (maximumWidth < chrome.minimumWidth || availableHeight - 48 < minimumHeight()) {
      win.classList.add('preview-window-compact')
      chrome = measure()
    }
    const scroll = availableHeight < minimumHeight()
    const margin = scroll ? 24 : Math.min(24, Math.max(0, (availableHeight - minimumHeight()) / 2))
    const fittedWidth = scroll ? maximumWidth : Math.min(maximumWidth, (availableHeight - 2 * margin - chrome.barHeight - borderHeight) * width / height + insets)
    if (scroll) win.dataset.previewFit = 'scroll'; else delete win.dataset.previewFit
    win.style.marginBlock = `${margin}px`
    win.style.width = `${fittedWidth}px`
    container.style.height = `${container.getBoundingClientRect().width * height / width}px`
    return { width, height }
  }

  function updatePreviewScale () {
    document.querySelectorAll('section.preview .preview-content').forEach(container => {
      const windowDims = container.dataset.frame === 'window' && fitWindow(container)
      const containerWidth = container.clientWidth
      const containerHeight = container.clientHeight
      container.querySelectorAll('.preview-iframe').forEach(iframe => {
        const deviceClass = Object.keys(PREVIEW_DEVICE_DIMS).find(cls => iframe.classList.contains(cls))
        if (!deviceClass) return
        const { width, height } = PREVIEW_DEVICE_DIMS[deviceClass]

        let scale
        if (windowDims) {
          scale = Math.min(containerWidth / width, containerHeight / height, 1)
          iframe.style.height = ''
        } else if (deviceClass === 'preview-desktop') {
          const desktopResponsive = container.dataset.desktopResponsive !== 'false'
          if (desktopResponsive) {
            // Responsive (default): scale to fill the full container width, then set the
            // iframe height so it also fills the full container height after the transform.
            // The website inside sees containerWidth/scale × containerHeight/scale pixels.
            scale = Math.min(containerWidth / width, 1)
            iframe.style.height = `${containerHeight / scale}px`
          } else {
            // Strict aspect ratio: contain fit keeps the full 1440×900 frame visible
            // with no clipping; may leave symmetric gaps above and below.
            scale = Math.min(containerWidth / width, containerHeight / height, 1)
            iframe.style.height = ''
          }
        } else {
          // Tablet and mobile: contain fit — largest size with neither dimension clipped.
          scale = Math.min(containerWidth / width, containerHeight / height, 1)
        }
        iframe.style.setProperty('--preview-scale', scale)

        // Cover the scaled iframe with its poster
        const pane = iframe.closest('.tab-pane')
        const poster = pane && pane.querySelector('.preview-poster')
        if (poster) {
          poster.style.width = `${width * scale}px`
          poster.style.height = `${(parseFloat(iframe.style.height) || height) * scale}px`
        }
      })
    })
  }

  function initPreviewAutoPick () {
    document.querySelectorAll('section.preview .preview-content[data-controls="false"]').forEach(container => {
      const show = () => {
        const target = showFittingPane(container)
        if (!target) return
        if (isActivated(container)) loadPane(target)
        updateWindowStatus(container)
        updatePreviewScale()
      }

      onBreakpointChange(show)
      show()
    })
  }

  function initPreviewAutoSwitch () {
    document.querySelectorAll('section.preview').forEach(section => {
      const buttons = Array.from(section.querySelectorAll('.preview-controls .btn-group .btn'))
      if (buttons.length === 0) return

      const isHidden = button => window.getComputedStyle(button).display === 'none'
      const deviceOf = button => PREVIEW_DEVICES.find(device => button.dataset.bsTarget.endsWith(`-${device}`))

      /**
       * When the stylesheet hides the active button, switch to the device that
       * pickDevice chooses among the visible buttons
       */
      const checkAndSwitchDevice = () => {
        const activeButton = buttons.find(button => button.classList.contains('active'))
        if (!activeButton || !isHidden(activeButton)) return

        const visibleButtons = buttons.filter(button => !isHidden(button))
        const device = pickDevice(visibleButtons.map(deviceOf))
        const target = visibleButtons.find(button => deviceOf(button) === device)
        if (target) target.click()
      }

      onBreakpointChange(checkAndSwitchDevice)
      checkAndSwitchDevice()
    })
  }

  // Load a view when its tab is first shown, and show an item when its tab is.
  // Bootstrap's tab plugin is live before window load, so listen from the
  // start, on the document, where shown.bs.tab bubbles to.
  document.addEventListener('shown.bs.tab', event => {
    const section = event.target.closest('section.preview')
    if (!section) return
    if (event.target.closest('.preview-items')) {
      showItem(section, event.target)
    } else if (event.target.closest('.preview-controls') && isActivated(section.querySelector('.preview-content'))) {
      loadPane(section.querySelector(event.target.dataset.bsTarget))
    }
    updatePreviewScale()
    updateWindowStatus(section.querySelector('.preview-content'))
  })

  // Load the shown view when a poster button is pressed. Listen on the
  // document, so a block rendered after this script ran still activates.
  document.addEventListener('click', event => {
    const button = event.target.closest && event.target.closest('.preview-activate')
    const container = button && button.closest('.preview-content')
    const section = container && container.closest('section.preview')
    if (!section || isStatic(container)) return

    container.dataset.active = 'true'
    const pane = container.dataset.controls === 'false'
      ? showFittingPane(container)
      : container.querySelector(':scope > .tab-pane.active')
    loadPane(pane)
    updatePreviewScale()
    section.dispatchEvent(new CustomEvent('preview:activate', { bubbles: true }))
  })

  /**
   * With a ready message, watches each iframe the markup gives src and asks it
   * at once, as it may have loaded and announced itself before this script ran.
   */
  function initPreviewReady () {
    document.querySelectorAll('section.preview .preview-content[data-ready-message] .preview-iframe').forEach(iframe => {
      const record = iframe.hasAttribute('src') && watch(iframe)
      if (record) askReady(record)
    })
  }

  function init () {
    initPreviewReady()
    updatePreviewScale()
    initPreviewAutoPick()
    initPreviewAutoSwitch()
    discoverPreviews()
    document.querySelectorAll('section.preview .preview-content').forEach(updateWindowStatus)
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(records => {
        records.forEach(record => record.removedNodes.forEach(node => {
          if (node.nodeType !== 1) return
          if (node.matches('.preview-content')) releaseOwnership(node)
          node.querySelectorAll('.preview-content').forEach(releaseOwnership)
        }))
        const changed = records.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
          node.nodeType === 1 && (node.matches(`section.preview, .preview-content, .preview-window, ${ownershipTag}`) || node.querySelector('section.preview, .preview-content, .preview-window'))))
        if (changed) { discoverPreviews(); updatePreviewScale() }
      }).observe(document.body, { childList: true, subtree: true })
    }
    if (document.documentElement && typeof MutationObserver !== 'undefined') {
      new MutationObserver(updateThemes).observe(document.documentElement, { attributes: true, attributeFilter: ['data-bs-theme', 'data-theme'] })
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateThemes)
    }
    if (geometryObserver) {
      document.querySelectorAll('.navbar, header[role="banner"]').forEach(el => geometryObserver.observe(el))
    }
    if (document.fonts) document.fonts.ready.then(updatePreviewScale)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }

  // Scale again once the page has loaded, and on every resize
  window.addEventListener('load', () => { discoverPreviews(); updatePreviewScale() })
  window.addEventListener('resize', () => { discoverPreviews(); updatePreviewScale() })
  window.addEventListener('scroll', () => {
    controllers.forEach((controller, container) => reconcile(container, controller))
  }, { passive: true })
}())
