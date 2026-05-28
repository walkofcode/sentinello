# "What's new" pill + version history — design

**Date:** 2026-05-28
**Status:** Approved (ready for implementation plan)

## Problem

When a Sentinello instance is upgraded, operators have no in-app sense of *what changed in the
version they are now running*. The existing "v0.2.0 available" banner only signals that a **newer**
version exists remotely — it says nothing about the features in the version already installed. We
want two things:

1. A small, dismissible **notification** announcing what's new in the running version — analogous to
   the update-available banner, but for the current version's features.
2. A persistent **summary in Settings** of what each version delivered.

## Solution overview

- A **"What's new" pill** in the top bar. Clicking it opens a popover listing the running version's
  highlights, with a "See full history →" link. Per-version dismissal in `localStorage`, mirroring
  `UpdateBannerClient`.
- A dedicated **`Settings → What's new` tab** listing every release's highlights, newest first.
- A curated, **localized** highlights source: a locale-independent index in
  `apps/web/lib/release-highlights.ts` (version + date, newest first), with all prose living in the
  `messages/*.json` catalogs under a `WhatsNew.releases.<version>` block.

This deliberately reuses three existing patterns:
- `UpdateBannerClient` — server wrapper + client component, "start hidden, reveal via effect" to
  avoid flash, per-version `localStorage` dismissal.
- `nav-menu.tsx` — the click-outside dropdown styling/behaviour for the popover.
- The MCP-tab work — surgical i18n insertions across all 10 locale files for the new tab.

## Components & data flow

### 1. Highlights index — `apps/web/lib/release-highlights.ts`

Locale-independent, parsed once (static module — no async per the static-data rule):

```ts
export type ReleaseHighlightMeta = {
    version: string   // '1.4.0' — must match a WhatsNew.releases key in every catalog
    date: string      // 'YYYY-MM-DD', locale-independent; rendered per-locale at display time
}

// Newest first. Adding an entry here REQUIRES a matching WhatsNew.releases.<version> block
// in every messages/*.json (next-intl has no fallback — a missing key renders an error).
export const RELEASE_HIGHLIGHTS: ReleaseHighlightMeta[] = [
    { version: '1.4.0', date: '2026-06-01' }
]

export function getAllHighlights(): ReleaseHighlightMeta[]   // returns RELEASE_HIGHLIGHTS as-is
export function getLatestHighlight(): ReleaseHighlightMeta | null
export function getHighlightFor(version: string): ReleaseHighlightMeta | null
```

`getHighlightFor` compares against the **bare** version (strip any leading `v`, reuse the existing
`stripVPrefix` semantics from `lib/version.ts`).

### 2. Localized prose — `messages/*.json`

A new `WhatsNew` namespace in **all 10 catalogs**:

```json
"WhatsNew": {
    "pillLabel": "What's new",
    "popoverHeading": "What's new in v{version}",
    "seeFullHistory": "See full history",
    "dismiss": "Dismiss",
    "pageTitle": "What's new",
    "pageIntro": "A summary of what each Sentinello release delivered.",
    "releases": {
        "1.4.0": {
            "title": "MCP server + what's-new",
            "items": [
                "Connect Claude Desktop / Cursor via /api/mcp",
                "New Settings → MCP section",
                "This what's-new pill"
            ]
        }
    }
}
```

- Title: `t('WhatsNew.releases.<version>.title')`.
- Bullets: `t.raw('WhatsNew.releases.<version>.items')` (next-intl's escape hatch for arrays),
  typed/guarded to `string[]` at the read site.
- Tab label: `Nav.tabs.whatsNew` in all catalogs.
- Page meta title: `Settings.whatsNew.metaTitle` in all catalogs (pattern `What's new · <Settings>`,
  localized suffix per existing catalog, exactly like the MCP tab).

### 3. The pill — `components/layout/whats-new-pill.tsx` (server) + `whats-new-pill-client.tsx` (client)

**Server wrapper `WhatsNewPill`:**
- `const current = getCurrentVersion()`
- `const meta = getHighlightFor(current)`
- If `!meta` → render nothing (no curated entry for the running version).
- Else render `<WhatsNewPillClient version={meta.version} />`. The client reads its title/items from
  the catalog via `useTranslations` keyed by `version`.

**Client `WhatsNewPillClient`:**
- State: `show` (start `false`, reveal in effect — no SSR flash), `open` (popover).
- Dismissal key: `localStorage['sentinello-whatsnew-seen-version']`. On mount, show the pill when the
  stored value `!== version`. Fresh install (nothing stored) → shows (intended). `localStorage`
  unavailable → show anyway (won't persist), matching `UpdateBannerClient`.
- Pill is a button. Click toggles the popover. **Opening the popover does NOT mark the version seen.**
- Popover reuses the `nav-menu` styling: `absolute right-0 top-full z-40 mt-2 w-72 rounded-md border
  bg-card p-… shadow-md`, `role="menu"`, close on click-outside (useRef + document listener in an
  effect) and on Escape, mirroring how TopNav drives `NavMenu`.
- Popover content: heading `popoverHeading` (with `{version}`), the bullet list, a "Got it" /
  dismiss control, and a `See full history →` `Link` to `/settings/whats-new`.
- "Got it" / X → write `version` to `localStorage`, set `show=false`. Pill then stays gone until a
  newer curated version ships (stored value differs again).
- `See full history →` navigates but does **not** auto-dismiss (peeking ≠ acknowledging).

**Mount point:** TopNav right-side cluster (`ml-auto flex items-center gap-2`), before the
language/theme/menu controls. On narrow screens show the icon only (sparkle), label hidden via
`hidden sm:inline` so it doesn't crowd the bar.

### 4. Settings history — `app/settings/whats-new/page.tsx` + `components/settings/whats-new-content.tsx`

- `page.tsx`: `generateMetadata` → `Settings.whatsNew.metaTitle`; renders `<WhatsNewContent />`.
- `WhatsNewContent` (server component): `getAllHighlights().map(...)`, for each render version +
  the release date + title + bullet list. Newest first (already ordered). The existing helpers
  don't fit (`formatRelativeTime` is relative; `formatAbsoluteTime` is a UTC datetime), so format
  the `YYYY-MM-DD` date as an absolute, locale-aware date via
  `new Date(date + 'T00:00:00Z').toLocaleDateString(locale, { dateStyle: 'medium', timeZone: 'UTC' })`,
  with `locale` from next-intl's `getLocale()`. The `T00:00:00Z` + `timeZone: 'UTC'` pin avoids the
  date drifting a day across time zones.
- Mirror the visual language of existing settings sections (card/section styling consistent with
  `about-content.tsx`).

### 5. Tab registration — `components/settings/settings-tabs.tsx`

Add `{ href: '/settings/whats-new', key: 'whatsNew' }` after the `mcp` entry. Drives both the
desktop top-nav tab strip and the mobile tab list (single source).

### 6. Release-process documentation — `CLAUDE.md`

Add to the release-engineering section: **when cutting a release, add a `{ version, date }` entry to
`apps/web/lib/release-highlights.ts` (newest first) and a matching `WhatsNew.releases.<version>`
block (`title` + `items`) to every `messages/*.json`.** Note the next-intl no-fallback footgun: a
version present in the index but missing from a catalog renders an error in that locale.

## Edge cases & decisions

- **No entry for running version** → no pill (server returns null). The history page still lists all
  entries it does have.
- **Fresh install** → pill shows for the current version (gentle, dismissible). Accepted over
  upgrade-vs-first-run detection.
- **`localStorage` unavailable** → pill shows, dismissal just won't persist (matches existing banner).
- **Update-available banner + what's-new pill can both appear** — distinct meanings (newer version
  exists vs. what's in the one you run); both surfaces coexist.
- **Missing catalog key** → next-intl error (no fallback configured). Mitigated by the documented
  release step and by keeping the index + catalogs in lockstep.

## Out of scope (YAGNI)

- Auto-generating highlights from `CHANGELOG.md` or the GitHub Releases API.
- Auto-translating highlight prose.
- A Settings → Advanced toggle to hide the pill (dismissal already covers the per-version case).
- Rich markdown / images in highlights — plain bullet strings only.

## Testing

Per project convention, no automated tests unless requested. Manual verification:
- `SENTINELLO_VERSION=1.4.0 pnpm dev` with a `1.4.0` index entry + catalog block → pill appears;
  popover lists bullets; "Got it" hides it; reload keeps it hidden; bump index to a higher version →
  pill returns.
- No index entry for the running version → no pill.
- `/settings/whats-new` lists all entries newest-first in the active locale.
- Switch locale → pill, popover, and page render translated copy.
- `pnpm build` / `pnpm lint` / `pnpm typecheck` clean.
