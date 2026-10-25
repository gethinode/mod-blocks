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
 * posters, and dispatches a bubbling preview:activate event on the section.
 * After that, views load as above.
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
 * poster, points every .preview-open link at the open URL of the item, and
 * dispatches a bubbling preview:item event on the section, with the index of
 * the item in its detail.
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

  /**
   * Gives the pane's iframe its src from data-src, once.
   */
  function loadPane (pane) {
    if (!pane) return
    const iframe = pane.querySelector('iframe[data-src]')
    if (iframe && !iframe.hasAttribute('src')) {
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
        if (iframe.hasAttribute('src')) {
          const copy = iframe.cloneNode(false)
          copy.removeAttribute('src')
          iframe.replaceWith(copy)
          iframe = copy
        }
        iframe.dataset.src = url
        iframe.setAttribute('title', title)
        if (activated && pane.classList.contains('active')) iframe.src = url
      }
      pane.querySelectorAll('.preview-poster-item').forEach(image => {
        image.classList.toggle('d-none', image.dataset.previewItem !== String(index))
      })
    })
    section.querySelectorAll('.preview-open').forEach(link => { link.href = tab.dataset.previewOpenUrl })
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

  function init () {
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
