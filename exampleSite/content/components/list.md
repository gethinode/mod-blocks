---
title: List
description: Demo of the list component.
date: 2026-07-12
content_blocks:
  - _bookshop_name: list
    heading:
      preheading: Blog
      title: A page list
      align: start
    hide_empty: false
    input:
      section: blog
      reverse: true
      sort: date
    limit: 3

  - _bookshop_name: list
    heading:
      preheading: Blog
      title: A centered, filtered page list
      align: center
    hide_empty: false
    input:
      section: blog
    filter:
      - post 1
      - post 2
    filter_col: 0
    width: 8
    justify: center
---
