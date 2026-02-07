# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Hugo module that adds Bookshop blocks to Hinode sites. It provides reusable UI components (hero, cards, FAQ, testimonials, etc.) for quickly building layouts and pages. Visual editing is handled separately via setup-cloudcannon-cms.

**Key Purpose**: mod-blocks is an optional Hinode extension for rapidly building page layouts using pre-built blocks. It is NOT required for basic Hinode functionality.

## Development Commands

### Local Development
```bash
npm start                # Start Hugo server with exampleSite (hot reload enabled)
npm run build           # Build the exampleSite with minification
npm test                # Run tests (builds exampleSite)
```

### Module Management
```bash
npm run mod:vendor      # Vendor Hugo modules to _vendor/
npm run mod:update      # Update all Hugo module dependencies
npm run mod:tidy        # Clean up module dependencies
npm run mod:clean       # Clean Hugo module cache
```

### Maintenance
```bash
npm run clean           # Remove exampleSite/public and exampleSite/resources
npm run upgrade         # Upgrade npm dependencies and Hugo modules
```

### Commits
```bash
npx git-cz              # Interactive commit message builder (Conventional Commits)
```

## Architecture

### Module Structure

The module uses Hugo's module mounts to expose components and partials to consuming sites:

- **component-library/components/**: Individual Bookshop components (16 total)
  - Each component has 3 files: `[name].bookshop.yml`, `[name].hugo.html`, `[name].scss`
  - `.bookshop.yml` defines the component schema and CMS metadata
  - `.hugo.html` implements the Hugo template logic
  - `.scss` contains component-specific styles

- **component-library/shared/**: Shared utilities and styles
  - `hugo/page.hugo.html`: Renders an array of Bookshop components via `partial "bookshop"`
  - `styles/global.scss`: Global SCSS styles imported by all components

- **layouts/partials/**: Block-specific partials (7 files, moved from Hinode)
  - `assets/`: hero.html, contact.html, faq.html, testimonial-carousel.html, menu.html
  - `utilities/`: section.html (wraps all components for consistent theming)
  - `page/`: contact.html (contact page template)

- **Module mounts** (defined in `config.toml`):
  - `*.hugo.html` files → `layouts/partials/bookshop/`
  - `*.bookshop.yml` files → `data/structures/` (for CMS)
  - `*.scss` files → `assets/scss/modules/bookshop/`
  - `bookshop.scss` → `assets/scss/bookshop.scss` (main stylesheet)
  - `layouts/partials/` → `layouts/partials/` (block-specific partials)

### Component Pattern

All components follow the same structure:

1. **Bookshop YAML** (`.bookshop.yml`):
   - `spec.structures`: Defines which content blocks can use this component
   - `spec.label/description/icon`: CMS display metadata
   - `blueprint`: Component schema with default values

2. **Hugo Template** (`.hugo.html`):
   - Cannot use InitArgs partial (Bookshop live editing requirement)
   - Access arguments directly from dot notation (`.breadcrumb`, `.heading`, etc.)
   - Call mod-blocks partials like `assets/hero.html` (now owned by mod-blocks)
   - Call Hinode shared partials like `assets/card-group.html`, `assets/video.html` (still in Hinode)
   - Wrap output in `utilities/section.html` (now owned by mod-blocks)
   - Handle both snake_case and kebab-case parameter names: `(or .link_type (index . "link-type"))`

3. **SCSS Styles** (`.scss`):
   - Component-specific styles automatically imported via `bookshop.scss`
   - Follows Bootstrap conventions for spacing, utilities, and responsive design

### Integration with Hinode

**Ownership Model (as of v1.1.0):**

**mod-blocks owns (7 partials):**
- Asset partials: hero.html, contact.html, faq.html, testimonial-carousel.html, menu.html
- Utility partial: utilities/section.html (wraps all components)
- Page template: page/contact.html

**Hinode provides (accessed via module inheritance):**
- mod-utils utilities: GetPadding, GetBreakpoint, LogWarn, InitArgs, etc.
- Shared asset partials: card-group.html, video.html, table.html, timeline.html, live-image.html, section-title.html, etc.
- Bootstrap styling and theming system

**Dependency Flow:**
```
Hinode v2 (core theme)
  ├── mod-utils (GetPadding, LogWarn, InitArgs, etc.)
  ├── Shared partials (card-group, video, table, timeline, section-title)
  └── Bootstrap theming

mod-blocks v1.1 (optional extension)
  ├── 16 Bookshop components
  ├── Block-specific partials (hero, contact, faq, testimonial-carousel, menu)
  ├── utilities/section.html (component wrapper)
  └── Depends on Hinode v2 for utilities & shared partials (including section-title)
```

This architecture ensures:
- ✅ Hinode works standalone (no circular dependencies)
- ✅ mod-blocks is self-contained for building layouts and pages
- ✅ Clear ownership of partials (block-specific vs shared)

### Example Site

The `exampleSite/` directory uses Hugo workspaces to test the module locally:
- `hugo.toml` imports the module via workspace: `mod-blocks.work`
- `mod-blocks.work` file points to the parent directory
- This allows development without publishing the module

## Key Constraints

- **Bookshop live editing**: Components must access arguments directly (not through helper partials)
- **Dual parameter names**: Support both snake_case (CloudCannon) and kebab-case (Hugo)
- **Hugo version**: Requires Hugo Extended 0.147.6+
- **Conventional Commits**: All commits must follow the specification (enforced by commitlint + husky)
- **Semantic versioning**: Releases are automated via semantic-release on the `main` branch

## Testing

Tests run in CI on macOS, Windows, and Ubuntu with Node 22.x and 24.x. The test suite builds the exampleSite to verify the module mounts and templates work correctly.
