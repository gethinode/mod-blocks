---
title: Preview items
description: Demo of the preview component that switches between views as tabs.
date: 2026-10-25
modules:
  - preview
content_blocks:
  - _bookshop_name: preview
    activation: click
    desktop_responsive: false
    ready_message: example:ready
    theme_message: example:theme
    mode: true
    poster:
      desktop: img/preview-demo/ready-desktop.png
      tablet: img/preview-demo/ready-tablet.png
      mobile: img/preview-demo/ready-mobile.png
    items:
      - title: Workspace
        url: /preview-demo/ready/
        heading:
          preheading: Live preview
          title: Switch between views
          content: >-
            Each tab shows another view with a heading of its own. Before the
            button over the poster is pressed, a tab swaps the heading and the
            poster only; after it, a tab loads its view in the shown device.
      - title: Activity
        url: /preview-demo/activity/
        poster:
          desktop: img/preview-demo/activity-desktop.png
          tablet: img/preview-demo/activity-tablet.png
          mobile: img/preview-demo/activity-mobile.png
        heading:
          preheading: Live preview
          title: A second view
          content: >-
            This view has matching native screenshots for every offered
            device and follows the same outer theme.
---
