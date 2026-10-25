---
title: Preview items
description: Demo of the preview component that switches between views as tabs.
date: 2026-10-25
modules:
  - preview
content_blocks:
  - _bookshop_name: preview
    activation: click
    mode: true
    poster:
      desktop: img/poster-desktop.png
      mobile: img/poster-mobile.png
    items:
      - title: Home
        url: https://example.org/
        heading:
          preheading: Live preview
          title: Switch between views
          content: >-
            Each tab shows another view with a heading of its own. Before the
            button over the poster is pressed, a tab swaps the heading and the
            poster only; after it, a tab loads its view in the shown device.
      - title: About
        url: https://example.org/about
        poster:
          desktop: img/poster-mobile.png
        heading:
          preheading: Live preview
          title: A second view
          content: >-
            This view has a desktop poster of its own, which the tablet and
            mobile views use too.
---
