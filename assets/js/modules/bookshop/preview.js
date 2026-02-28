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
 * Also switches to the next available device when the active panel is
 * hidden by a viewport-width breakpoint.
 */

const PREVIEW_DEVICE_DIMS = {
  'preview-desktop': { width: 1440, height: 900 },
  'preview-tablet': { width: 820, height: 1180 },
  'preview-mobile': { width: 402, height: 874 }
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

function initPreviewAutoSwitch () {
  const previewSections = document.querySelectorAll('section.preview')

  previewSections.forEach(section => {
    const buttons = section.querySelectorAll('.preview-controls .btn-group .btn')

    if (buttons.length === 0) return

    /**
         * Check if active button is hidden and switch to next available
         */
    const checkAndSwitchDevice = () => {
      // Find currently active button
      const activeButton = Array.from(buttons).find(btn => btn.classList.contains('active'))

      if (!activeButton) return

      // Check if active button is hidden by CSS
      const isHidden = window.getComputedStyle(activeButton).display === 'none'

      if (isHidden) {
        // Find all visible buttons
        const visibleButtons = Array.from(buttons).filter(btn =>
          window.getComputedStyle(btn).display !== 'none'
        )

        if (visibleButtons.length > 0) {
          // Switch to first visible button (desktop -> tablet -> mobile priority)
          visibleButtons[0].click()
        }
      }
    }

    // Debounced resize handler (avoid excessive checks)
    let resizeTimer
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(checkAndSwitchDevice, 150)
    })

    // Initial check on page load
    checkAndSwitchDevice()
  })
}

// Initialize on load (resize handler is set up inside initPreviewAutoSwitch)
window.addEventListener('load', () => {
  updatePreviewScale()
  initPreviewAutoSwitch()
})

window.addEventListener('resize', () => { updatePreviewScale() })
