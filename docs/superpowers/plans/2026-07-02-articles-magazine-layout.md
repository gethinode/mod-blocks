# Articles "magazine" Layout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `magazine` layout to the articles Bookshop block — a large featured first article (keeping its thumbnail) beside a compact, thumbnail-less list of the remaining articles, reflowing below the featured card on small screens.

**Architecture:** Expose the value through the articles block's existing global `layout` argument. `articles.hugo.html` delegates to a new mod-blocks partial `assets/magazine.html` when `layout == "magazine"`. That partial reuses Hinode core `card.html` (featured) and `card-group.html` (list) and derives responsive column classes from `utilities/GetBreakpoint.html`. A demo is added to the mod-docs `articles.md` page.

**Tech Stack:** Hugo (extended) templates, Bootstrap 5 grid, SCSS, Bookshop component schema (YAML), Hinode `mod-utils` argument system.

## Global Constraints

- **No changes to Hinode core or `mod-utils`.** Only `mod-blocks` (code) and `mod-docs` (docs) change.
- **Copyright header** on any new `.html` partial (copy the exact banner used by existing mod-blocks partials, year `2026`).
- **Bookshop live-edit safety:** `articles.hugo.html` must keep accessing arguments directly (no `InitArgs` restructuring) — only additive edits.
- **Argument casing:** blueprint keys are snake_case; dict keys passed between partials are kebab-case and must be read with `index . "kebab-key"`.
- **Parameterized breakpoints:** never hardcode `md`/`lg`; derive from `GetBreakpoint.html` (`.current`, `.next`).
- **Precedence:** `layout: magazine` wins over `scroll`/`bento`/`cols`.
- **Conventional Commits** (commitlint enforced); body lines ≤ 100 chars. End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Repos / branches:** mod-blocks work on `feat/articles-magazine-layout` (already created, off `develop`); mod-docs work on a matching branch off `develop` (created in Task 1).

---

## File Structure

**mod-blocks** (`/Users/mark/Development/GitHub/gethinode/mod-blocks`)
- `layouts/partials/assets/magazine.html` — **new** renderer. Splits featured/list, builds the two responsive columns, delegates to core card partials.
- `component-library/components/articles/articles.hugo.html` — **modify.** Detect `layout == "magazine"` and route `$partial` to `assets/magazine.html`; give it precedence over `scroll`.
- `component-library/components/articles/articles.bookshop.yml` — **modify.** Add `layout` to the blueprint (makes it a recognized argument; type resolves from global `layout`).
- `component-library/components/articles/articles.yml` — **modify.** Mention `magazine` in the structure example.
- `component-library/components/articles/articles.scss` — **modify.** Add list-row separator rule scoped to `.card-magazine-list`.

**mod-docs** (`/Users/mark/Development/GitHub/gethinode/mod-docs`)
- `content/blocks/articles.md` — **modify.** New "Magazine layout" example section.

**hinode** (verification only — local, uncommitted)
- `exampleSite/config/_default/hugo.toml` — enable module `replacements` to resolve mod-blocks + mod-docs from local checkouts.

---

## Task 1: Verification harness + mod-docs branch

Establish a deterministic build+grep loop. The articles block only renders where Hinode core + mod-blocks + mod-docs are combined, i.e. the **hinode exampleSite**. Point it at the local module checkouts.

**Files:**
- Create branch in mod-docs.
- Modify (local, do NOT commit): `/Users/mark/Development/GitHub/gethinode/hinode/exampleSite/config/_default/hugo.toml`

- [ ] **Step 1: Create the mod-docs feature branch**

```bash
cd /Users/mark/Development/GitHub/gethinode/mod-docs && git checkout develop && git checkout -b feat/articles-magazine-layout && git rev-parse --abbrev-ref HEAD
```

Expected: prints `feat/articles-magazine-layout`.

- [ ] **Step 2: Point the exampleSite workspace at local mod-blocks + mod-docs**

The exampleSite uses a Hugo module workspace (`exampleSite/hinode.work`) with an active `use` list; workspace `use` directives take precedence over config `replacements`, so add the local modules there. Append these two lines to `/Users/mark/Development/GitHub/gethinode/hinode/exampleSite/hinode.work` (after the existing `use ../`):

```text
use ../../mod-blocks
use ../../mod-docs
```

This is a LOCAL dev toggle in the hinode repo (a different repo from our feature branches) — it must not be committed. Note: builds must use the project-pinned binary `./node_modules/.bin/hugo` (the system `hugo` may be older and reject newer config keys).

- [ ] **Step 3: Baseline build — confirm the harness renders the articles docs page**

```bash
cd /Users/mark/Development/GitHub/gethinode/hinode && rm -rf exampleSite/public && ./node_modules/.bin/hugo -s exampleSite --logLevel info 2>&1 | tee /tmp/magazine-build.log | tail -5
```

Expected: build completes with `Total in ...` and no `ERROR`. (Ignore pre-existing warnings.)

- [ ] **Step 4: Confirm the mod-docs Articles page built from the LOCAL module**

```bash
grep -rl "bookshop-articles\|Articles" /Users/mark/Development/GitHub/gethinode/hinode/exampleSite/public/ | grep -i "articles" | head
```

Expected: at least one generated `.../articles/index.html` path is listed. If empty, the replacements or build failed — fix before proceeding (re-read `/tmp/magazine-build.log`).

- [ ] **Step 5: Record the exact articles page path for reuse**

```bash
ARTPAGE=$(grep -rl "_bookshop_name\|articles" /Users/mark/Development/GitHub/gethinode/hinode/exampleSite/public/ 2>/dev/null | grep "/articles/index.html" | head -1); echo "$ARTPAGE"
```

Expected: prints one path, e.g. `.../exampleSite/public/blocks/articles/index.html`. Note it — later greps target `exampleSite/public/` recursively so this is just a sanity check.

No commit in this task (harness only).

---

## Task 2: mod-docs demo (render consumer — "red")

Add the demo that exercises `layout: magazine`. Before the renderer exists, the block renders as the default grid and Hugo logs an "unsupported argument 'layout'" warning — the failing state.

**Files:**
- Modify: `/Users/mark/Development/GitHub/gethinode/mod-docs/content/blocks/articles.md`

**Interfaces:**
- Produces: a rendered `articles` block on the Articles docs page carrying `layout: magazine`, used as the render fixture by all later tasks.

- [ ] **Step 1: Insert the "Magazine layout" section**

In `content/blocks/articles.md`, insert the following block immediately BEFORE the `## Arguments` line (i.e. after the "Minimal cards" example's `<!-- markdownlint-enable MD037 -->`):

````markdown
### Magazine layout

Set `layout` to `magazine` to feature the first article as a large card while the
remaining articles are shown as a compact list beside it. On smaller screens the
list reflows below the featured article.

<!-- markdownlint-disable MD037 -->
{{< example-bookshop lang="bookshop" >}}

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

{{< /example-bookshop >}}
<!-- markdownlint-enable MD037 -->

````

- [ ] **Step 2: Rebuild and confirm the "red" state**

```bash
cd /Users/mark/Development/GitHub/gethinode/hinode && rm -rf exampleSite/public && ./node_modules/.bin/hugo -s exampleSite --logLevel info 2>&1 | tee /tmp/magazine-build.log | grep -i "unsupported argument 'layout'\|magazine" | head
```

Expected: the build logs a warning mentioning `unsupported argument 'layout'` (magazine not yet a known arg). This confirms the demo reaches the articles block.

- [ ] **Step 3: Confirm no magazine markup yet**

```bash
grep -rl "card-magazine-list" /Users/mark/Development/GitHub/gethinode/hinode/exampleSite/public/ || echo "NONE (expected)"
```

Expected: `NONE (expected)` — the magazine renderer does not exist yet.

- [ ] **Step 4: Lint the markdown**

```bash
cd /Users/mark/Development/GitHub/gethinode/mod-docs && npx markdownlint-cli2 "content/blocks/articles.md" 2>&1 | tail -5
```

Expected: no errors for `articles.md` (Summary shows 0 errors, or only pre-existing ignores).

- [ ] **Step 5: Commit (mod-docs branch)**

```bash
cd /Users/mark/Development/GitHub/gethinode/mod-docs && git add content/blocks/articles.md && git commit -m "docs(blocks): add magazine layout example for articles

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Expose the `layout` argument (mod-blocks — "arg accepted")

Add `layout` to the articles blueprint so it is a recognized, typed argument (type inherited from the global `layout` string). No rendering change yet.

**Files:**
- Modify: `/Users/mark/Development/GitHub/gethinode/mod-blocks/component-library/components/articles/articles.bookshop.yml`
- Modify: `/Users/mark/Development/GitHub/gethinode/mod-blocks/component-library/components/articles/articles.yml`

**Interfaces:**
- Produces: `layout` as a valid articles argument (default `default`), readable in `articles.hugo.html` as `.layout`.

- [ ] **Step 1: Add `layout` to the blueprint**

In `articles.bookshop.yml`, under `blueprint:`, add a `layout:` key. Place it directly above the existing `ratio:` line so it sits with the other layout controls:

```yaml
  layout:
  ratio:
  cols:
```

(The `layout:` value is intentionally empty — the type and `default: default` come from the global `_arguments.yml`.)

- [ ] **Step 2: Mention `magazine` in the structure example**

In `articles.yml`, replace the `example: |` block so the example advertises the new option. Full new file content:

```yaml
comment: >-
  Renders a grid of articles from a Hugo section with optional filtering and pagination.
example: |
  heading:
    title: Latest Articles
  input:
    section: blog
  layout: magazine
  more:
    title: View all articles
    link: /blog/
```

- [ ] **Step 3: Rebuild and confirm the warning is gone**

```bash
cd /Users/mark/Development/GitHub/gethinode/hinode && rm -rf exampleSite/public && ./node_modules/.bin/hugo -s exampleSite --logLevel info 2>&1 | tee /tmp/magazine-build.log | grep -i "unsupported argument 'layout'" || echo "no layout warning (expected)"
```

Expected: `no layout warning (expected)` — `layout` is now accepted. The block still renders as the default grid (no branch yet).

- [ ] **Step 4: Confirm still no magazine markup (branch not wired)**

```bash
grep -rl "card-magazine-list" /Users/mark/Development/GitHub/gethinode/hinode/exampleSite/public/ || echo "NONE (expected)"
```

Expected: `NONE (expected)`.

- [ ] **Step 5: Commit (mod-blocks branch)**

```bash
cd /Users/mark/Development/GitHub/gethinode/mod-blocks && git add component-library/components/articles/articles.bookshop.yml component-library/components/articles/articles.yml && git commit -m "feat(articles): accept layout argument

Register the global 'layout' argument on the articles block so components can
select a layout variant. No behavior change yet; unknown values fall back to the
default grid.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Magazine renderer + branch wiring (mod-blocks — "green")

Create the renderer and route to it. After this task the demo renders the featured/list columns.

**Files:**
- Create: `/Users/mark/Development/GitHub/gethinode/mod-blocks/layouts/partials/assets/magazine.html`
- Modify: `/Users/mark/Development/GitHub/gethinode/mod-blocks/component-library/components/articles/articles.hugo.html`

**Interfaces:**
- Consumes (dict passed by `articles.hugo.html`, same shape as the grid branch): `page`, `list` (page collection), `limit`, `padding`, `class`, `ratio`, `header-style`, `body-style`, `footer-style`, `hook`, `href`, `href-title`, `href-force`, `icon-rounded`, `icon-style`, `link-icon`, `more-link-type`, `more-link-icon`.
- Produces: HTML — a `container-fluid` with one `row g-4` holding a featured column (`col-12 col-{current}-6 col-{next}-8`) and a list column (`col-12 col-{current}-6 col-{next}-4`, wrapper class `card-magazine-list`, each card carrying `card-magazine-item`).

- [ ] **Step 1: Create `layouts/partials/assets/magazine.html`**

```html
<!--
    Copyright © 2026 The Hinode Team / Mark Dumay. All rights reserved.
    Use of this source code is governed by The MIT License (MIT) that can be found in the LICENSE file.
    Visit gethinode.com/license for more details.
-->

{{/* Featured-first "magazine" layout for the articles block. Renders the first
     article as a large featured card (keeping its thumbnail) beside a compact,
     thumbnail-less list of the remaining articles. Columns follow the Hinode
     parameterized-breakpoint convention: stacked below the site breakpoint,
     6/6 at it, and 8/4 one breakpoint up. */}}

{{ $page := .page }}
{{ $list := .list }}
{{ $bp := partial "utilities/GetBreakpoint.html" }}

{{/* Apply the block limit across the whole set, then peel off the featured item */}}
{{ $count := len $list }}
{{ $max := $count }}
{{ with .limit }}{{ if gt . 0 }}{{ $max = int (math.Min . $count) }}{{ end }}{{ end }}
{{ $list = first $max $list }}

{{ if gt (len $list) 0 }}
    {{ $featured := index $list 0 }}
    {{ $rest := after 1 $list }}

    {{ $featuredCols := printf "col-12 col-%s-6 col-%s-8" $bp.current $bp.next }}
    {{ $listCols := printf "col-12 col-%s-6 col-%s-4" $bp.current $bp.next }}

    {{ $class := .class | default "border-0" }}
    {{ $ratio := .ratio | default "16x9" }}
    {{ $headerStyle := or (index . "header-style") "publication" }}
    {{ $bodyStyle := or (index . "body-style") "full" }}
    {{ $footerStyle := or (index . "footer-style") "none" }}
    {{ $hook := .hook | default "assets/live-card.html" }}

    <div class="container-fluid px-0">
        <div class="row g-4">
            {{/* Featured article — keeps its thumbnail at every breakpoint */}}
            <div class="{{ $featuredCols }}">
                {{ partial $hook (dict
                    "page"         $page
                    "path"         $featured.RelPermalink
                    "class"        (trim (printf "%s h-100" $class) " ")
                    "orientation"  "stacked"
                    "ratio"        $ratio
                    "header-style" $headerStyle
                    "body-style"   $bodyStyle
                    "footer-style" $footerStyle
                    "padding"      .padding
                    "align"        "start"
                    "icon-rounded" (index . "icon-rounded")
                    "icon-style"   (index . "icon-style")
                    "link-icon"    (index . "link-icon")
                ) }}
            </div>

            {{/* Remaining articles — compact, thumbnail-less list */}}
            {{ if gt (len $rest) 0 }}
                <div class="{{ $listCols }}">
                    {{ partial "assets/card-group.html" (dict
                        "page"           $page
                        "list"           $rest
                        "cols"           1
                        "responsive"     false
                        "orientation"    "none"
                        "header-style"   $headerStyle
                        "body-style"     $bodyStyle
                        "footer-style"   "none"
                        "class"          (trim (printf "%s card-magazine-item" $class) " ")
                        "wrapper"        "card-magazine-list"
                        "hook"           $hook
                        "padding"        .padding
                        "align"          "start"
                        "href"           .href
                        "href-title"     (index . "href-title")
                        "href-force"     (index . "href-force")
                        "more-link-type" (index . "more-link-type")
                        "more-link-icon" (index . "more-link-icon")
                    ) }}
                </div>
            {{ end }}
        </div>
    </div>
{{ end }}
```

- [ ] **Step 2: Wire the branch in `articles.hugo.html` — detect magazine**

Replace this exact snippet:

```hugo
		{{ $partial := "assets/card-group.html" }}
		{{ $params := dict }}
```

with:

```hugo
		{{ $partial := "assets/card-group.html" }}
		{{ $useMagazine := eq (or .layout "default") "magazine" }}
		{{ if $useMagazine }}{{ $partial = "assets/magazine.html" }}{{ end }}
		{{ $params := dict }}
```

- [ ] **Step 3: Wire the branch in `articles.hugo.html` — give magazine precedence over scroll**

Replace this exact line:

```hugo
		{{ if .scroll }}
```

with:

```hugo
		{{ if and .scroll (not $useMagazine) }}
```

(The existing `{{ else }}` block already builds the shared style params — `header-style`, `body-style`, `footer-style`, `class`, `ratio`, `href-title`, `icon-*`, `hook`, `more-link-*` — which `magazine.html` consumes. No other change is needed.)

- [ ] **Step 4: Rebuild and confirm the featured/list columns render ("green")**

```bash
cd /Users/mark/Development/GitHub/gethinode/hinode && rm -rf exampleSite/public && ./node_modules/.bin/hugo -s exampleSite --logLevel info 2>&1 | tee /tmp/magazine-build.log | grep -iE "ERROR|magazine" | head
```

Expected: no `ERROR` lines.

```bash
grep -rl "card-magazine-list" /Users/mark/Development/GitHub/gethinode/hinode/exampleSite/public/ | head
grep -rho "col-12 col-md-6 col-lg-8" /Users/mark/Development/GitHub/gethinode/hinode/exampleSite/public/ | head -1
grep -rho "col-12 col-md-6 col-lg-4" /Users/mark/Development/GitHub/gethinode/hinode/exampleSite/public/ | head -1
```

Expected: the first prints a generated articles page path; the next two print `col-12 col-md-6 col-lg-8` and `col-12 col-md-6 col-lg-4` respectively (default site breakpoint `md` → `current=md`, `next=lg`). This proves the featured (8) and list (4) columns and the parameterized breakpoints.

- [ ] **Step 5: Commit (mod-blocks branch)**

```bash
cd /Users/mark/Development/GitHub/gethinode/mod-blocks && git add layouts/partials/assets/magazine.html component-library/components/articles/articles.hugo.html && git commit -m "feat(articles): add magazine layout renderer

Render the first article as a large featured card beside a compact,
thumbnail-less list of the remaining articles. Columns use the parameterized
GetBreakpoint convention (8/4 at the next breakpoint, 6/6 at the site
breakpoint, stacked below). Takes precedence over scroll.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: List-row separators (mod-blocks SCSS)

Draw thin rules between list rows at all breakpoints (core `card-group` separators are mobile-only), matching the screenshot.

**Files:**
- Modify: `/Users/mark/Development/GitHub/gethinode/mod-blocks/component-library/components/articles/articles.scss`

- [ ] **Step 1: Append the separator rule**

Append to `articles.scss`:

```scss
.card-magazine-list {
    .col:not(:first-child) .card-magazine-item {
        border-top: var(--bs-border-width, 1px) solid var(--bs-border-color);
        padding-top: 1rem;
        margin-top: 1rem;
    }
}
```

- [ ] **Step 2: Lint the SCSS**

```bash
cd /Users/mark/Development/GitHub/gethinode/mod-blocks && npx stylelint "component-library/components/articles/articles.scss" 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 3: Rebuild and confirm the rule reaches compiled CSS**

```bash
cd /Users/mark/Development/GitHub/gethinode/hinode && rm -rf exampleSite/public && ./node_modules/.bin/hugo -s exampleSite 2>&1 | tail -2 && grep -rlo "card-magazine-list" /Users/mark/Development/GitHub/gethinode/hinode/exampleSite/public/*.css /Users/mark/Development/GitHub/gethinode/hinode/exampleSite/public/**/*.css 2>/dev/null | head || echo "check CSS manually"
```

Expected: build completes; the selector appears in a generated CSS file (PurgeCSS keeps it because `card-magazine-list`/`card-magazine-item` are emitted in the HTML). If not found, verify the classes appear in HTML (Task 4 grep) and that PurgeCSS is not stripping them.

- [ ] **Step 4: Commit (mod-blocks branch)**

```bash
cd /Users/mark/Development/GitHub/gethinode/mod-blocks && git add component-library/components/articles/articles.scss && git commit -m "style(articles): separate magazine list rows

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Full lint + visual verification

**Files:** none (verification only).

- [ ] **Step 1: Lint mod-blocks and mod-docs**

```bash
cd /Users/mark/Development/GitHub/gethinode/mod-blocks && npm test 2>&1 | tail -5
cd /Users/mark/Development/GitHub/gethinode/mod-docs && npx markdownlint-cli2 "content/blocks/articles.md" 2>&1 | tail -3
```

Expected: mod-blocks build (`hugo -s exampleSite`) completes without error; markdown lint clean. (Note: mod-blocks' own exampleSite cannot render the articles block — it lacks Hinode core — so this only proves templates parse.)

- [ ] **Step 2: Visual check in a browser**

```bash
cd /Users/mark/Development/GitHub/gethinode/hinode && ./node_modules/.bin/hugo server -s exampleSite --bind=0.0.0.0 --disableFastRender
```

Open the Articles block docs page and confirm at three widths:
- **Desktop (≥ 992px / `lg`):** featured card ~2/3 width on the left, list ~1/3 on the right.
- **Tablet (768–991px / `md`):** featured and list each half width, side by side.
- **Mobile (< 768px):** featured card with its thumbnail on top; list folded directly below, thumbnail-less, with separators between rows.

- [ ] **Step 3: Revert the local hinode harness edit**

Undo the uncommitted `replacements` line added in Task 1 (it must never be committed):

```bash
cd /Users/mark/Development/GitHub/gethinode/hinode && git checkout -- exampleSite/hinode.work && git status --short exampleSite/hinode.work
```

Expected: no output (clean).

- [ ] **Step 4: Summary of branches to push / PR**

- mod-blocks: `feat/articles-magazine-layout` (spec, plan, feat + style commits) → PR into `develop`.
- mod-docs: `feat/articles-magazine-layout` (docs commit) → PR into `develop`.

---

## Self-Review

**Spec coverage:**
- Argument exposure via global `layout` (no mod-utils change) → Task 3. ✓
- Renderer in mod-blocks reusing core card/card-group → Task 4 (`magazine.html`). ✓
- Featured keeps thumbnail (`orientation: stacked`); list thumbnail-less (`orientation: none`) → Task 4. ✓
- Parameterized breakpoints 8/4 (`next`) + 6/6 (`current`), stacked below → Task 4 Steps 1 & 4. ✓
- Precedence magazine > scroll/bento/cols → Task 4 Steps 2–3. ✓
- List separators at all breakpoints → Task 5. ✓
- mod-docs demo (`section: blog`, `limit: 4`) → Task 2. ✓
- Verification via hinode exampleSite with local replacements → Tasks 1–6. ✓

**Placeholder scan:** No TBD/TODO; every code and command step is concrete.

**Type/name consistency:** `card-magazine-list` (list wrapper) and `card-magazine-item` (per-card) are used identically in Task 4 (emit) and Task 5 (style). `$useMagazine`, `.current`/`.next`, and the kebab-case dict keys match between `articles.hugo.html` and `magazine.html`.
