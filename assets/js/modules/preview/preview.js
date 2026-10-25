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
 * Only the active view loads: every iframe carries its URL in data-src. With
 * controls only the initially active one also carries src, and another view
 * gets its src when it is first shown. Without controls (data-controls="false")
 * no iframe carries src: the block picks the view itself at DOMContentLoaded
 * and again whenever the viewport crosses a device breakpoint.
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
   * Calls back whenever the viewport crosses a device breakpoint. The media
   * query change fires as the stylesheet's rules flip, with no debounce gap.
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
      })
    })
  }

  function initPreviewAutoPick () {
    document.querySelectorAll('section.preview .preview-content[data-controls="false"]').forEach(container => {
      const offered = (container.dataset.devices || '').split(' ').filter(Boolean)
      if (offered.length === 0) return

      const panes = Array.from(container.querySelectorAll(':scope > .tab-pane'))
      const show = () => {
        const device = pickDevice(offered)
        const target = panes.find(pane => pane.id.endsWith(`-${device}`))
        if (!target) return
        panes.forEach(pane => {
          const active = pane === target
          pane.classList.toggle('show', active)
          pane.classList.toggle('active', active)
        })
        loadPane(target)
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

  // Load a view when its tab is first shown. Bootstrap's tab plugin is live
  // before window load, so listen from the start, on the document, where
  // shown.bs.tab bubbles to.
  document.addEventListener('shown.bs.tab', event => {
    const controls = event.target.closest('.preview-controls')
    const section = controls && controls.closest('section.preview')
    if (section) loadPane(section.querySelector(event.target.dataset.bsTarget))
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

  // Images and fonts that finish after DOMContentLoaded can still move the layout
  window.addEventListener('load', () => { updatePreviewScale() })
  window.addEventListener('resize', () => { updatePreviewScale() })
}())
