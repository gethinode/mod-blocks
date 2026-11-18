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
  - _bookshop_name: preview
    heading:
      preheading: Live preview
      title: Tabs in the title bar
      content: >-
        The item tabs sit in the title bar of the window, and take a row of
        their own on a narrow screen or in a bar too narrow for them. A
        caption under the window describes the shown view. Below 768px wide
        or 500px high, the poster of the shown item replaces the live view.
    frame: window
    tabs_placement: bar
    static_below: 768
    static_max_height: 500
    devices: [desktop]
    controls: false
    activation: visible
    open_link: true
    ready_message: example:ready
    theme_message: example:theme
    mode: true
    items:
      - title: Workspace
        url: /preview-demo/ready/
        caption: The workspace view, with **ready** and theme messages.
        poster:
          desktop: img/preview-demo/ready-desktop.png
      - title: Activity
        url: /preview-demo/activity/
        caption: The activity view, with a poster of its own.
        poster:
          desktop: img/preview-demo/activity-desktop.png
  - _bookshop_name: preview
    heading:
      preheading: Live preview
      title: Captions as tooltips
      content: >-
        Each caption shows as a tooltip of its item tab, on hover and on
        keyboard focus, and no caption strip renders under the window. This
        suits a tall preview, whose strip would fall below the viewport.
    frame: window
    tabs_placement: bar
    caption_placement: tooltip
    devices: [desktop]
    controls: false
    activation: visible
    open_link: true
    ready_message: example:ready
    theme_message: example:theme
    mode: true
    items:
      - title: Workspace
        url: /preview-demo/ready/
        caption: The workspace view, with **ready** and theme messages.
        poster:
          desktop: img/preview-demo/ready-desktop.png
      - title: Activity
        url: /preview-demo/activity/
        caption: The activity view, with a poster of its own.
        poster:
          desktop: img/preview-demo/activity-desktop.png
---
