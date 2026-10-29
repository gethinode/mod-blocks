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
  path = "github.com/gethinode/mod-blocks/v2"
```

Then run:

```bash
hugo mod get -u
```

## Requirements

- **Hugo Extended** v0.147.6 or higher
- **Hinode v2** for:
  - mod-utils utilities (GetPadding, GetBreakpoint, LogWarn, Args, etc.)
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
- **mod-utils utilities**: GetPadding, GetBreakpoint, LogWarn, Args, etc.
- **Shared asset partials**: card-group, video, table, timeline, live-image, section-title, etc.
- **Bootstrap styling** and theming system

Visit the Hinode documentation site for [installation instructions][hinode_docs].

## Contributing

This module uses [semantic-release][semantic-release] to automate the release of new versions. The package uses `husky` and `commitlint` to ensure commit messages adhere to the [Conventional Commits][conventionalcommits] specification. You can run `npx git-cz` from the terminal to help prepare the commit message.

### Explicit native browser qualification

The default `pnpm test` command keeps its existing Hugo and Chrome checks. Additional
one-pixel action checks use an already installed external Playwright tool with Chrome
and WebKit available, plus an existing WOFF2 code fixture. No package, browser or font
is downloaded by the check.

Set `PLAYWRIGHT_ENTRY_POINT` to that tool's ESM entry and `WOFF2_FIXTURE` to the font file:

```sh
PREVIEW_NATIVE=1 PREVIEW_NATIVE_MODULE="$PLAYWRIGHT_ENTRY_POINT" \
  PREVIEW_NATIVE_FONT="$WOFF2_FIXTURE" \
  pnpm exec node --test --test-name-pattern="native compact" scripts/check-preview-browser.mjs
```

This explicit mode fails if a requested prerequisite is missing, invalid or cannot load.
It reports the exact font SHA-256, inherited font, geometry and trusted native events.
The fixture uses normal `FontFace` loading; qualification of a consuming site must use
that site's normally built and served fonts.

<!-- MARKDOWN LINKS -->
[hugo]: https://gohugo.io
[hinode_docs]: https://gethinode.com
<!-- [module]: https://example.com -->
[repository]: https://github.com/gethinode/hinode.git
[repository_template]: https://github.com/gethinode/template.git
[conventionalcommits]: https://www.conventionalcommits.org
[husky]: https://typicode.github.io/husky/
[semantic-release]: https://semantic-release.gitbook.io/

## List controls

With Hinode v3.39.0 or later, lists use full-width search above
results and page size, result count, and navigation below. Older Hinode versions keep
the compact toolbar. Set `controls_layout: compact` to request the compact layout explicitly.

Search text can be customized for each list. These overrides require Hinode v3.39.0
or later:

```yaml
_bookshop_name: list
input:
  section: articles
searchable: true
search_label: Search articles
search_placeholder: Search articles…
filter_responsive: true
```

`search_label` provides the accessible name independently of the placeholder. Omitted
text uses the active language's translations. The filter dropdown is enabled by
`filter_responsive` when a filter group is present.
