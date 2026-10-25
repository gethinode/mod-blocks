---
title: Preview readiness
description: Demo of the preview component that waits for the framed page to report that it is ready, and falls back when it does not.
date: 2026-10-25
modules:
  - preview
content_blocks:
  - _bookshop_name: preview
    heading:
      preheading: Live preview
      title: Wait until the view is ready
      content: >-
        After the button over the poster is pressed, the view stays behind its
        poster with a waiting status until the framed page posts the message
        example:ready to this page. The pages framed here never post it, so
        after five seconds the view shows its poster again, with an alert and a
        link that opens the shown tab in a new tab. Each tab and each device
        view waits on its own.
    activation: click
    mode: true
    ready_message: example:ready
    load_timeout: 5
    open_link: true
    poster:
      desktop: img/poster-desktop.png
      mobile: img/poster-mobile.png
    items:
      - title: Home
        url: https://example.org/
      - title: About
        url: https://example.org/about
        open_url: https://example.org/
    links:
      - title: About Hinode
        url: https://gethinode.com/
---
