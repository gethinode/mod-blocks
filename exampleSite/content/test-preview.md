---
title: Preview block assertions
description: >-
  Build-time assertions for the preview block. The test-preview layout renders
  each fixture below and fails the build when the output differs from want,
  reject or count.
layout: test-preview
modules:
  - preview
build:
  list: never
  render: always
fixtures:
  - case: default-three-devices
    block:
      _bookshop_name: preview
      url: https://example.org/
    want:
      - 'id="preview-'
      - 'preview-desktop" '
      - 'data-src="https://example.org/"'
      - 'data-devices="desktop tablet mobile"'
      - 'preview-controls'
    reject:
      - 'data-controls='
    count:
      'src="https://example.org/" class="preview-iframe preview-desktop"': 1
      'src="https://example.org/"': 1
      'data-src="https://example.org/"': 3
      'data-devices="desktop tablet mobile"': 2
  - case: device-mobile-active
    block:
      _bookshop_name: preview
      url: https://example.org/
      device: mobile
    count:
      'src="https://example.org/" class="preview-iframe preview-mobile"': 1
      'src="https://example.org/"': 1
      'show active': 1
  - case: devices-subset
    block:
      _bookshop_name: preview
      url: https://example.org/
      devices: [desktop, mobile]
    want:
      - 'data-devices="desktop mobile"'
      - 'preview-desktop'
      - 'preview-mobile'
    reject:
      - 'preview-tablet'
      - '-tablet"'
      - '-tablet-tab'
    count:
      'data-src="https://example.org/"': 2
      'data-bs-toggle="tab"': 2
      'data-devices="desktop mobile"': 2
  - case: devices-duplicate
    block:
      _bookshop_name: preview
      url: https://example.org/
      devices: [mobile, desktop, mobile]
    want:
      - 'data-devices="mobile desktop"'
    count:
      'data-src="https://example.org/"': 2
      'data-bs-toggle="tab"': 2
      'show active': 1
      'src="https://example.org/"': 1
      'src="https://example.org/" class="preview-iframe preview-desktop"': 1
  - case: devices-excludes-default
    block:
      _bookshop_name: preview
      url: https://example.org/
      devices: [mobile]
    want:
      - 'preview-mobile'
      - 'show active'
    reject:
      - 'preview-desktop'
      - '-desktop"'
      - '-desktop-tab'
    count:
      'src="https://example.org/" class="preview-iframe preview-mobile"': 1
      'src="https://example.org/"': 1
  - case: devices-excludes-default-picks-first
    block:
      _bookshop_name: preview
      url: https://example.org/
      devices: [tablet, mobile]
    want:
      - 'data-devices="tablet mobile"'
    count:
      'src="https://example.org/" class="preview-iframe preview-tablet"': 1
      'src="https://example.org/"': 1
      'show active': 1
  - case: controls-false-snake
    block:
      _bookshop_name: preview
      url: https://example.org/
      controls: false
    want:
      - 'data-controls="false"'
    reject:
      - 'preview-controls'
      - 'data-bs-toggle'
      - 'role="tabpanel"'
    count:
      'src="https://example.org/"': 0
      'data-src="https://example.org/"': 3
  - case: controls-false-bottom
    block:
      _bookshop_name: preview
      url: https://example.org/
      controls: false
      controls_placement: bottom
    want:
      - 'data-controls="false"'
    reject:
      - 'preview-controls'
    count:
      'src="https://example.org/"': 0
      'data-src="https://example.org/"': 3
  - case: controls-true-bottom
    block:
      _bookshop_name: preview
      url: https://example.org/
      controls: true
      controls_placement: bottom
    want:
      - 'preview-controls controls-bottom'
    reject:
      - 'data-controls='
  - case: click-poster
    block:
      _bookshop_name: preview
      url: https://example.org/
      activation: click
      poster:
        desktop: img/placeholder.png
    want:
      - 'data-activation="click"'
      - 'preview-activate'
      - 'Load preview'
      - 'preview-poster"><img'
    count:
      'src="https://example.org/"': 0
      'data-src="https://example.org/"': 3
      'class="preview-poster"': 3
      'class="btn btn-primary preview-activate"': 3
  - case: click-no-poster
    block:
      _bookshop_name: preview
      url: https://example.org/
      activation: click
    want:
      - 'preview-poster'
      - 'preview-activate'
    reject:
      - 'preview-poster"><img'
      - 'preview-poster"><picture'
    count:
      'src="https://example.org/"': 0
  - case: click-with-fallback
    block:
      _bookshop_name: preview
      url: https://example.org/
      show_fallback: true
      activation: click
    want:
      - 'preview-error'
      - 'data-activation="click"'
    reject:
      - 'preview-activate'
      - 'preview-poster'
    count:
      'src="https://example.org/"': 0
  - case: click-no-controls
    block:
      _bookshop_name: preview
      url: https://example.org/
      activation: click
      controls: false
      devices: [desktop, mobile]
    want:
      - 'data-activation="click"'
      - 'data-controls="false"'
    count:
      'src="https://example.org/"': 0
      'class="btn btn-primary preview-activate"': 2
  - case: click-device-mobile
    block:
      _bookshop_name: preview
      url: https://example.org/
      activation: click
      device: mobile
    want:
      - 'data-activation="click"'
    count:
      'src="https://example.org/"': 0
  - case: load-default
    block:
      _bookshop_name: preview
      url: https://example.org/
      activation: load
      poster:
        desktop: img/placeholder.png
    reject:
      - 'data-activation='
      - 'preview-poster'
      - 'preview-activate'
    count:
      'src="https://example.org/"': 1
  - case: click-poster-per-device
    block:
      _bookshop_name: preview
      url: https://example.org/
      activation: click
      mode: true
      poster:
        desktop: img/poster-desktop.png
        mobile: img/poster-mobile.png
    count:
      'class="preview-poster"': 3
      'src="/img/poster-desktop-light-': 2
      'src="/img/poster-desktop-dark-': 2
      'src="/img/poster-mobile-light-': 1
      'src="/img/poster-mobile-dark-': 1
---
