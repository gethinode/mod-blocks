# Articles block — "magazine" layout style

- **Date:** 2026-07-02
- **Status:** Approved (design)
- **Repos touched:** `mod-blocks` (implementation), `mod-docs` (documentation/demo)
- **Hinode core:** unchanged

## Summary

Add a new `magazine` layout to the articles Bookshop block. It renders the first
article as a large **featured** card (keeping its thumbnail) and the remaining
articles as a compact, thumbnail-less **list** beside it. On smaller screens the
list reflows to sit directly below the featured card. Inspired by an editorial
newsroom layout (large lead story + column of headlines).

## Goal / user story

As a site author, I can set `layout: magazine` on an `articles` block to get a
featured-story presentation: one prominent article with its illustration, and the
rest as a scannable headline list — responsive from desktop down to mobile.

## Non-goals

- No collapse/"show more" toggle. The list is always fully visible (it reflows,
  it does not hide).
- No changes to the default grid, `scroll`, or `bento` behaviors.
- No changes to Hinode core partials or to `mod-utils` (`_arguments.yml`).

## Background — current architecture

- The `articles` block lives in mod-blocks:
  `component-library/components/articles/articles.hugo.html` (wrapper),
  `articles.bookshop.yml` (CMS blueprint / valid-argument list),
  `articles.yml` (structure comment/example), `articles.scss` (styles).
- The wrapper selects a renderer:
  - `scroll: true` → Hinode core `assets/stack.html`
  - otherwise → Hinode core `assets/card-group.html` (grid; `bento`/`cols` apply)
- Card rendering chain: `card-group.html` → hook `assets/live-card.html` →
  `assets/card.html`. `live-card.html` adds live-image support.
- Responsive columns follow the **Hinode parameterized-breakpoint convention**:
  `utilities/GetBreakpoint.html` returns `{ prev, current, next }` (and their
  pixel sizes) relative to `site.Params.main.breakpoint` (default `md`).
  `card-group.html` builds classes such as
  `row-cols-1 row-cols-{prev}-2 row-cols-{current}-3` from it — never hardcoding
  `md`/`lg`.
- The global `layout` argument already exists in
  `mod-utils/data/structures/_arguments.yml` (`type: string`, `default: default`,
  comment: *"available values depend on the specific component"*). This is the
  designated hook for per-component layout variants, so exposing `magazine`
  requires **no** mod-utils change.

## Design

### 1. Argument exposure

- Add `layout` to the articles blueprint `articles.bookshop.yml` (default
  `default`). Its type resolves from the existing global `layout` string arg.
- Document it in the structure file `articles.yml` (comment/example).
- Precedence in `articles.hugo.html`: **`layout == "magazine"` takes precedence
  over `scroll`/`bento`/`cols`.** Selection order:
  1. `layout == "magazine"` → `assets/magazine.html`
  2. else `scroll` → `assets/stack.html`
  3. else → `assets/card-group.html`

### 2. New renderer — `layouts/partials/assets/magazine.html` (mod-blocks)

Lives in mod-blocks because the layout is block-specific (matching the ownership
rule that block-specific partials belong to mod-blocks). It reuses Hinode core
`card.html` (featured) and `card-group.html` (list) — no core changes.

Inputs (passed from the wrapper): `page`, `list` (pages), `class`,
`header-style`, `body-style`, `footer-style`, `ratio`, `padding`, `limit`,
`icon-*`/`link-*`, and the `more` link fields (`href`, `href-title`,
`more-link-type`, `more-link-icon`).

Behavior:

1. Apply `limit` to the full set. `featured = list[0]`; `rest = list[1:]`.
2. Call `utilities/GetBreakpoint.html` → `$bp` (`current`, `next`).
3. Emit a Bootstrap `row` with two columns:

   | Column | Classes (parameterized) | Default site (`md`) |
   |---|---|---|
   | Featured | `col-12 col-{{ $bp.current }}-6 col-{{ $bp.next }}-8` | `col-12 col-md-6 col-lg-8` |
   | List | `col-12 col-{{ $bp.current }}-6 col-{{ $bp.next }}-4` | `col-12 col-md-6 col-lg-4` |

   Result: **stacked full-width below tablet**, **6/6 at the site breakpoint
   (`md`)**, **8/4 one breakpoint up (`lg`)**. Raising the site breakpoint shifts
   the whole thing up automatically (e.g. `lg`→`xl`).

   Reflow guarantee: because both columns are `col-12` at the smallest tier, the
   list always folds directly below the featured card on mobile, and the featured
   card keeps its thumbnail at every breakpoint.

4. **Featured** column → `card.html` via `live-card` hook with:
   - `orientation: stacked` (thumbnail on top → thumbnail retained everywhere)
   - `ratio`: default `16x9`, overridable via the block's `ratio`
   - `header-style: publication` (category + date), `body-style: full`
     (title + description) — both overridable
   - `class`: default `border-0 h-100`, overridable via the block's `class`
5. **List** column → `card-group.html` with:
   - `cols: 1`, `responsive: false`, `orientation: none` (no thumbnail)
   - `header-style: publication`, `body-style: full`, `footer-style: none`
     (overridable)
   - separators between rows (see SCSS below)
   - `more`/`href` fields forwarded so the "more" button renders at the bottom of
     the list column when applicable.

Empty/edge cases: if `list` is empty the wrapper already handles `hide_empty`
before delegating; `magazine.html` assumes ≥1 page. With exactly one article,
only the featured card renders (the list column is omitted/empty).

### 3. Styling — `articles.scss` (mod-blocks)

Add a minimal rule so the list rows show thin separators at **all** breakpoints
(the core `card-group` `separator` option only draws them on mobile). Scope to a
wrapper class applied by `magazine.html`, e.g. `.card-magazine-list`, with a
bottom border between rows and none after the last row. Keep it to a few lines.

### 4. Documentation & demo — `mod-docs/content/blocks/articles.md`

Add a new **"Magazine layout"** section with an `example-bookshop` demo:

```yml
- _bookshop_name: articles
  heading:
    title: Blog
    align: start
  input:
    section: blog
    reverse: false
    sort: date
  hide_empty: false
  layout: magazine
  more:
    title: More Blogs
  padding: 0
  limit: 4
```

`limit: 4` against the exampleSite `blog` section (4 posts) yields a featured
card + 3 list rows. Follow the existing section conventions in the file
(`markdownlint-disable/enable MD037`, heading level, prose style). The
`{{< args bookshop-articles >}}` table picks up the new `layout` argument
automatically from the blueprint.

## Files to change

**mod-blocks**

- `component-library/components/articles/articles.bookshop.yml` — add `layout`.
- `component-library/components/articles/articles.hugo.html` — branch to
  `magazine.html` when `layout == "magazine"` (before the `scroll` branch).
- `layouts/partials/assets/magazine.html` — **new** renderer.
- `component-library/components/articles/articles.scss` — list-separator rule.
- `component-library/components/articles/articles.yml` — comment/example note.

**mod-docs**

- `content/blocks/articles.md` — new "Magazine layout" section.

## Verification

1. In `hinode/exampleSite/config/_default/hugo.toml`, enable the commented-out
   local-module `replacements` line so `mod-blocks` and `mod-docs` resolve from
   the local checkouts.
2. `npm run start:example`, open the Articles block docs page.
3. Confirm at three widths:
   - **Desktop (`lg`):** featured 8 / list 4, side by side.
   - **Tablet (`md`):** featured 6 / list 6, side by side.
   - **Mobile (`< md`):** featured card with thumbnail on top, list folded below,
     thumbnail-less, with separators.
4. `npm run lint` (scripts/styles/markdown) passes.

## Open questions

None blocking. Defaults chosen (featured `16x9`, list `body-style: full`) are all
overridable via existing block arguments.
