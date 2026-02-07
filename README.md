# Hinode Module - Blocks

<!-- Tagline -->
<p align="center">
    <b>Pre-built Bookshop blocks for Hinode sites</b>
    <br />
</p>

<!-- Badges -->
<p align="center">
    <a href="https://gohugo.io" alt="Hugo website">
        <img src="https://img.shields.io/badge/generator-hugo-brightgreen">
    </a>
    <a href="https://gethinode.com" alt="Hinode theme">
        <img src="https://img.shields.io/badge/theme-hinode-blue">
    </a>
    <a href="https://github.com/gethinode/mod-blocks/commits/main" alt="Last commit">
        <img src="https://img.shields.io/github/last-commit/gethinode/mod-blocks.svg">
    </a>
    <a href="https://github.com/gethinode/mod-blocks/issues" alt="Issues">
        <img src="https://img.shields.io/github/issues/gethinode/mod-blocks.svg">
    </a>
    <a href="https://github.com/gethinode/mod-blocks/pulls" alt="Pulls">
        <img src="https://img.shields.io/github/issues-pr-raw/gethinode/mod-blocks.svg">
    </a>
    <a href="https://github.com/gethinode/mod-blocks/blob/main/LICENSE" alt="License">
        <img src="https://img.shields.io/github/license/gethinode/mod-blocks">
    </a>
</p>

## About

![Logo](https://raw.githubusercontent.com/gethinode/hinode/main/static/img/logo.png)

Hinode is a clean blog theme for [Hugo][hugo], an open-source static site generator. Hinode is available as a [template][repository_template], and a [main theme][repository].

This module provides **pre-built Bookshop blocks** for quickly building layouts and pages in Hinode sites. It includes:

- **16 Bookshop components** for visual page building
- **Block-specific partials** (hero, section-title, contact, faq, testimonial-carousel, menu)
- **Page templates** (contact page)
- **Section wrapper utility** for consistent theming

## Features

- 🧱 **Content Blocks**: 16 reusable Bookshop components (hero, cards, FAQ, testimonials, etc.)
- 🎨 **Visual Editing**: Compatible with CloudCannon CMS for visual page building
- 📦 **Self-Contained**: All block-specific partials included
- 🔧 **Modular**: Optional extension for Hinode v2+

## Installation

Add mod-blocks to your Hinode site's `hugo.toml`:

```toml
[[module.imports]]
  path = "github.com/gethinode/mod-blocks"
```

Then run:

```bash
hugo mod get -u
```

## Requirements

- **Hugo Extended** v0.147.6 or higher
- **Hinode v2** for:
  - mod-utils utilities (GetPadding, GetBreakpoint, LogWarn, InitArgs, etc.)
  - Shared asset partials (card-group, video, table, timeline, etc.)

## Architecture

This module exposes:

### Bookshop Components (16)
Located in `component-library/components/`:
- hero, about, cards, features, faq, testimonials, menu, teams, cta, timeline, newsletter, logos, articles, video, sponsors, stats

### Block-Specific Partials (7)

**Asset Partials (5):**
- `assets/hero.html` - Hero section rendering
- `assets/contact.html` - Contact information display
- `assets/faq.html` - FAQ accordion rendering
- `assets/testimonial-carousel.html` - Testimonial carousel
- `assets/menu.html` - Menu item rendering

**Utility Partial (1):**
- `utilities/section.html` - Wraps all components for consistent theming

**Page Template (1):**
- `page/contact.html` - Contact page layout

### Dependencies on Hinode

mod-blocks depends on Hinode v2 for:
- **mod-utils utilities**: GetPadding, GetBreakpoint, LogWarn, InitArgs, etc.
- **Shared asset partials**: card-group, video, table, timeline, live-image, section-title, etc.
- **Bootstrap styling** and theming system

Visit the Hinode documentation site for [installation instructions][hinode_docs].

## Contributing

This module uses [semantic-release][semantic-release] to automate the release of new versions. The package uses `husky` and `commitlint` to ensure commit messages adhere to the [Conventional Commits][conventionalcommits] specification. You can run `npx git-cz` from the terminal to help prepare the commit message.

<!-- MARKDOWN LINKS -->
[hugo]: https://gohugo.io
[hinode_docs]: https://gethinode.com
<!-- [module]: https://example.com -->
[repository]: https://github.com/gethinode/hinode.git
[repository_template]: https://github.com/gethinode/template.git
[conventionalcommits]: https://www.conventionalcommits.org
[husky]: https://typicode.github.io/husky/
[semantic-release]: https://semantic-release.gitbook.io/
