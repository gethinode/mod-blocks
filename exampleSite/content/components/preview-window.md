---
title: Preview window
description: A contained desktop window that starts when visible and stays static on narrow screens.
date: 2026-10-26
modules:
  - preview
content_blocks:
  - _bookshop_name: preview
    url: /preview-demo/ready/
    frame: window
    frame_title: Example workspace
    open_link: true
    controls: false
    devices: [desktop]
    activation: visible
    mobile_static: true
    ready_message: example:ready
    theme_message: example:theme
    mode: true
    poster:
      desktop: img/preview-demo/ready-desktop.png
---

The local child answers both the configured readiness query and correlated theme
requests. Opt-in theme synchronization requires both replies; an announcement
alone never proves the theme of a new document. Existing previews without a
theme token keep their original readiness behavior.
