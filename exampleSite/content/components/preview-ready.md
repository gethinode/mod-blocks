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
        example:ready to this page. The Ready tab frames a demo page that posts
        it, and answers when the preview asks for it. The Silent tab frames a
        demo page that never posts it, so that view keeps its poster with the
        waiting status, and after five seconds an alert takes the place of the
        status, with a link that opens the page in a new tab. Each tab and each
        device view waits on its own.
    activation: click
    mode: true
    ready_message: example:ready
    load_timeout: 5
    open_link: true
    poster:
      desktop: img/poster-desktop.png
      mobile: img/poster-mobile.png
    items:
      - title: Ready
        url: /preview-demo/ready/
      - title: Silent
        url: /preview-demo/silent/
    links:
      - title: About Hinode
        url: https://gethinode.com/
---
