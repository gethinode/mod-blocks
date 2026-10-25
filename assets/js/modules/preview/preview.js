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
 * click activation changes nothing, and message data is never used other than
 * compared. A late acknowledgement recovers a failed pane, and the script never
 * moves focus.
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

  function loadTimeout (container) {
    const seconds = Number(container.dataset.loadTimeout)
    return (seconds > 0 ? seconds : PREVIEW_LOAD_TIMEOUT) * 1000
  }

  /**
   * Sets the state of the pane of a navigation, with the busy state and inert
   * iframe that go with it.
   */
  function setState (record, state) {
    const { iframe, pane, container } = record
    record.state = state
    pane.dataset.previewState = state
    const waiting = state === 'waiting' && readyMessage(container) !== ''
    if (waiting) pane.setAttribute('aria-busy', 'true'); else pane.removeAttribute('aria-busy')
    if (waiting || state === 'failed') iframe.setAttribute('inert', ''); else iframe.removeAttribute('inert')
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
      record.timer = setTimeout(() => setState(record, 'failed'), loadTimeout(record.container))
    }
    if (typeof IntersectionObserver === 'undefined') {
      start()
      return
    }
    record.observer = new IntersectionObserver(entries => {
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
    if (container.querySelector('.preview-error:not(.d-none)')) return null
    const record = { iframe, pane, container, state: null, timer: null, observer: null }
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
    iframe.addEventListener('load', () => {
      if (readyMessage(record.container)) askReady(record); else markReady(record)
    })
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
    if (record) stopDeadline(record)
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
      if (message === '' || event.data !== message) return
      const record = frames.get(iframe) || track(iframe)
      if (record) markReady(record)
    })
  })

  /**
   * Gives the pane's iframe its src from data-src, once.
   */
  function loadPane (pane) {
    if (!pane) return
    const iframe = pane.querySelector('iframe[data-src]')
    if (iframe && !iframe.hasAttribute('src')) {
      watch(iframe)
      iframe.src = iframe.dataset.src
    }
  }

  /**
   * Reports whether the block may load its views: always, unless it waits for
   * its poster button.
   */
  function isActivated (container) {
    return container.dataset.activation !== 'click' || container.dataset.active === 'true'
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
        if (activated && pane.classList.contains('active')) {
          watch(iframe)
          iframe.src = url
        }
      }
      pane.querySelectorAll('.preview-poster-item').forEach(image => {
        image.classList.toggle('d-none', image.dataset.previewItem !== String(index))
      })
    })
    section.querySelectorAll('.preview-open, .preview-unavailable-link').forEach(link => { link.href = tab.dataset.previewOpenUrl })
    section.dispatchEvent(new CustomEvent('preview:item', { bubbles: true, detail: { index } }))
  }

  function updatePreviewScale () {
    document.querySelectorAll('section.preview .preview-content').forEach(container => {
      const containerWidth = container.clientWidth
      const containerHeight = container.clientHeight
      container.querySelectorAll('.preview-iframe').forEach(iframe => {
        const deviceClass = Object.keys(PREVIEW_DEVICE_DIMS).find(cls => iframe.classList.contains(cls))
        if (!deviceClass) return
        const { width, height } = PREVIEW_DEVICE_DIMS[deviceClass]

        let scale
        if (deviceClass === 'preview-desktop') {
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
  })

  // Load the shown view when a poster button is pressed. Listen on the
  // document, so a block rendered after this script ran still activates.
  document.addEventListener('click', event => {
    const button = event.target.closest && event.target.closest('.preview-activate')
    const container = button && button.closest('.preview-content')
    const section = container && container.closest('section.preview')
    if (!section) return

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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }

  // Scale again once the page has loaded, and on every resize
  window.addEventListener('load', () => { updatePreviewScale() })
  window.addEventListener('resize', () => { updatePreviewScale() })
}())
