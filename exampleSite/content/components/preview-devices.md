---
title: Preview devices
description: Demo of the preview component with a subset of devices and no device switcher.
date: 2026-10-25
modules:
  - preview
content_blocks:
  - _bookshop_name: preview
    heading:
      preheading: Live preview
      title: Desktop and mobile only
      content: >-
        The preview offers the desktop and mobile views without a device
        switcher. It shows desktop from a 1024px wide viewport and mobile below
        it, and loads each view only when it is first shown.
    url: /preview-demo/ready/
    devices: [desktop, mobile]
    controls: false
    desktop_responsive: false
    ready_message: example:ready
    theme_message: example:theme
    mode: true
    poster:
      desktop: img/preview-demo/ready-desktop.png
      tablet: img/preview-demo/ready-tablet.png
      mobile: img/preview-demo/ready-mobile.png
---
