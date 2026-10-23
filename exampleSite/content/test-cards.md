---
title: Cards block assertions
description: >-
  Build-time assertions for the cards block. The test-cards layout renders
  each fixture below and fails the build when the output differs from want.
layout: test-cards
build:
  list: never
  render: always
fixtures:
  - case: align_rows true
    block:
      _bookshop_name: cards
      cols: 2
      orientation: stacked
      align_rows: true
      elements:
        - title: Alpha
          subtitle: Sub *one*
          highlight: "**€1** high one"
          content: Body one
        - title: Beta
          subtitle: Sub *two*
          highlight: "**€2** high two"
          content: Body two
    want:
      aligned_groups: 2
      subtitles: ["Sub <em>one</em>", "Sub <em>two</em>"]
      highlights: ["<strong>€1</strong> high one", "<strong>€2</strong> high two"]
  - case: align_rows unset
    block:
      _bookshop_name: cards
      cols: 2
      orientation: stacked
      elements:
        - title: Alpha
          content: Body one
        - title: Beta
          content: Body two
    want:
      align_classes: 0
      bands: 0
  - case: align_rows false
    block:
      _bookshop_name: cards
      cols: 2
      orientation: stacked
      align_rows: false
      elements:
        - title: Alpha
          content: Body one
        - title: Beta
          content: Body two
    want:
      align_classes: 0
      bands: 0
      same_as: align_rows unset
  - case: align_rows null
    block:
      _bookshop_name: cards
      cols: 2
      orientation: stacked
      align_rows: null
      elements:
        - title: Alpha
          content: Body one
        - title: Beta
          content: Body two
    want:
      align_classes: 0
      bands: 0
      same_as: align_rows unset
  - case: subtitle only
    block:
      _bookshop_name: cards
      cols: 2
      elements:
        - title: Alpha
          subtitle: Sub *one*
          content: Body one
    want:
      subtitles: ["Sub <em>one</em>"]
  - case: highlight only
    block:
      _bookshop_name: cards
      cols: 2
      elements:
        - title: Alpha
          highlight: "**€1** high one"
          content: Body one
    want:
      highlights: ["<strong>€1</strong> high one"]
---
