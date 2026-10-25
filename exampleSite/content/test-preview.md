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
---
