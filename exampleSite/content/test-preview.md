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
  - case: items-basic
    block:
      _bookshop_name: preview
      heading:
        title: Block heading
      items:
        - title: View A
          url: https://example.org/a
          heading:
            title: Heading A
        - title: View B
          url: https://example.org/b
          open_url: https://example.org/b-open
          heading:
            title: Heading B
    want:
      - 'nav nav-pills justify-content-center'
      - 'data-preview-url="https://example.org/a"'
      - '-item-1"'
      - 'data-preview-open-url="https://example.org/b-open"'
      - 'role="tablist"'
    reject:
      - 'title="Block heading"'
      - '-items-panel'
    order:
      - 'class="tab-pane fade show active" id="preview-'
      - '-item-0" role="tabpanel"'
      - 'Heading A'
      - '-item-1" role="tabpanel"'
      - 'Heading B'
      - 'nav nav-pills'
      - 'class="nav-link active" data-bs-toggle="tab" data-bs-target="#preview-'
      - '-item-0" data-preview-url="https://example.org/a" data-preview-open-url="https://example.org/a" role="tab" aria-selected="true"'
      - '>View A</button>'
      - 'class="nav-link" data-bs-toggle="tab" data-bs-target="#preview-'
      - '-item-1" data-preview-url="https://example.org/b" data-preview-open-url="https://example.org/b-open" role="tab" aria-selected="false"'
      - '>View B</button>'
      - 'preview-controls'
      - 'preview-content'
    count:
      'data-src="https://example.org/a"': 3
      'data-src="https://example.org/b"': 0
      'src="https://example.org/a"': 1
      'show active': 2
      'class="nav-link active"': 1
      'class="nav-link"': 1
      'role="tabpanel"': 5
      'data-bs-toggle="tab"': 5
      'title="View A"': 3
      'title="View B"': 0
      'Block heading': 0
  - case: items-heading-fallback
    block:
      _bookshop_name: preview
      heading:
        title: Block heading
      items:
        - title: View A
          url: https://example.org/a
        - title: View B
          url: https://example.org/b
          heading:
            title: Heading B
    order:
      - '-item-0" role="tabpanel"'
      - 'Block heading'
      - '-item-1" role="tabpanel"'
      - 'Heading B'
      - 'nav nav-pills'
    count:
      'Block heading': 1
  - case: items-no-headings
    block:
      _bookshop_name: preview
      heading:
        title: Block heading
      items:
        - title: View A
          url: https://example.org/a
        - title: View B
          url: https://example.org/b
          open-url: https://example.org/b-kebab
    want:
      - 'nav nav-pills'
      - 'data-preview-open-url="https://example.org/b-kebab"'
    order:
      - 'Block heading'
      - 'nav nav-pills'
      - 'role="tab" aria-selected="true" aria-controls="preview-'
      - '-items-panel">View A</button>'
      - 'role="tab" aria-selected="false" aria-controls="preview-'
      - '-items-panel">View B</button>'
      - 'class="tab-content preview-content'
      - 'id="preview-'
      - '-items-panel" role="tabpanel" aria-labelledby="preview-'
      - '-item-0-tab"'
      - 'preview-desktop'
    count:
      'Block heading': 1
      'role="tabpanel"': 4
      'aria-controls="preview-': 5
      'title="View A"': 3
      'show active': 1
  - case: items-with-fallback
    block:
      _bookshop_name: preview
      show_fallback: true
      items:
        - title: View A
          url: https://example.org/a
          heading:
            title: Heading A
        - title: View B
          url: https://example.org/b
          heading:
            title: Heading B
    want:
      - 'class="preview-error"'
      - 'Unable to load preview for <code>https://example.org/a</code>'
    reject:
      - 'preview-items'
      - 'data-preview-url'
      - '-items-panel'
      - 'role="tab"'
      - 'role="tabpanel"'
      - 'aria-labelledby'
      - 'aria-controls'
      - 'preview-headings'
      - '-item-'
    count:
      'Heading A': 1
      'Heading B': 0
  - case: items-override-url
    block:
      _bookshop_name: preview
      url: https://example.org/
      items:
        - title: View A
          url: https://example.org/a
        - title: View B
          url: https://example.org/b
    want:
      - 'data-src="https://example.org/a"'
    count:
      'data-src="https://example.org/a"': 3
      'data-src="https://example.org/"': 0
  - case: items-posters
    block:
      _bookshop_name: preview
      activation: click
      mode: true
      devices: [desktop, mobile]
      poster:
        desktop: img/poster-desktop.png
      items:
        - title: View A
          url: https://example.org/a
          poster:
            mobile: img/poster-mobile.png
        - title: View B
          url: https://example.org/b
          poster:
            desktop: img/poster-mobile.png
    order:
      - 'preview-desktop'
      - 'class="preview-poster-item" data-preview-item="0"><div class="d-none-dark"><img'
      - 'src="/img/poster-desktop-light-'
      - 'class="preview-poster-item d-none" data-preview-item="1"><div class="d-none-dark"><img'
      - 'src="/img/poster-mobile-light-'
      - 'preview-mobile'
      - 'class="preview-poster-item" data-preview-item="0"><div class="d-none-dark"><img'
      - 'src="/img/poster-mobile-light-'
      - 'class="preview-poster-item d-none" data-preview-item="1"><div class="d-none-dark"><img'
      - 'src="/img/poster-mobile-light-'
    count:
      'src="https://example.org/a"': 0
      'class="preview-poster"': 2
      'class="preview-poster-item"': 2
      'class="preview-poster-item d-none"': 2
      'src="/img/poster-desktop-light-': 1
      'src="/img/poster-desktop-dark-': 1
      'src="/img/poster-mobile-light-': 3
      'src="/img/poster-mobile-dark-': 3
  - case: items-load-no-controls
    block:
      _bookshop_name: preview
      controls: false
      items:
        - title: View A
          url: https://example.org/a
        - title: View B
          url: https://example.org/b
    want:
      - 'nav nav-pills'
      - 'data-controls="false"'
    reject:
      - 'preview-controls'
      - 'preview-poster'
    count:
      'src="https://example.org/a"': 0
      'data-src="https://example.org/a"': 3
  - case: items-headings-controls-bottom
    block:
      _bookshop_name: preview
      controls_placement: bottom
      items:
        - title: View A
          url: https://example.org/a
          heading:
            title: Heading A
        - title: View B
          url: https://example.org/b
    want:
      - 'nav nav-pills'
      - 'preview-controls controls-bottom'
    reject:
      - 'width-100 mt-3'
  - case: items-headings-fallback-controls-bottom
    block:
      _bookshop_name: preview
      controls_placement: bottom
      show_fallback: true
      items:
        - title: View A
          url: https://example.org/a
          heading:
            title: Heading A
        - title: View B
          url: https://example.org/b
    want:
      - 'width-100 mt-3'
    reject:
      - 'nav nav-pills'
  - case: items-fallback-first-without-heading
    block:
      _bookshop_name: preview
      show_fallback: true
      heading:
        title: Block heading
      items:
        - title: View A
          url: https://example.org/a
        - title: View B
          url: https://example.org/b
          heading:
            title: Heading B
    want:
      - 'class="preview-error"'
    reject:
      - 'role="tabpanel"'
      - 'aria-labelledby'
    count:
      'Block heading': 1
      'Heading B': 0
  - case: items-fallback-no-heading-controls-bottom
    block:
      _bookshop_name: preview
      show_fallback: true
      controls_placement: bottom
      items:
        - title: View A
          url: https://example.org/a
        - title: View B
          url: https://example.org/b
          heading:
            title: Heading B
    want:
      - 'class="preview-error"'
    reject:
      - 'width-100 mt-3'
      - 'section-title'
    count:
      'Heading B': 0
---
