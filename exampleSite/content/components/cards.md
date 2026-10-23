---
title: Cards
description: Demo of the cards component.
date: 2026-07-12
content_blocks:
  - _bookshop_name: cards
    heading:
      preheading: Our values
      title: A card group
      content: The cards component renders a group of icon cards.
    cols: 3
    padding: 0
    elements:
      - title: People oriented
        icon: fas user-group
        content: People are at the heart of any organization.
      - title: Value obsessed
        icon: fas heart
        content: We ensure your investments bring tangible value.
      - title: Tech savvy
        icon: fas microchip
        content: We help you identify and utilize the right technology.
    links:
      - title: All components
        url: /components/
        icon: fas chevron-right
  - _bookshop_name: cards
    heading:
      preheading: Pricing
      title: Aligned rows
      content: >-
        With `align_rows` set, the titles, subtitles, highlights and bodies of
        stacked cards line up across each row.
    cols: 3
    padding: 0
    orientation: stacked
    align_rows: true
    elements:
      - title: Starter
        icon: fas seedling
        subtitle: For individuals.
        highlight: "**€0** per month"
        content: |
          - One project
          - Community support
      - title: Business
        icon: fas briefcase
        subtitle: >-
          For growing teams that need shared workspaces, role-based access
          control, priority support and a dedicated onboarding session.
        highlight: "**€149** per month"
        content: |
          - Unlimited projects
          - Priority support
          - Single sign-on
      - title: Enterprise
        icon: fas building
        subtitle: For organizations with *custom* needs.
        highlight: "**Custom pricing**"
        content: |
          - Dedicated account manager
          - Custom contracts
---
