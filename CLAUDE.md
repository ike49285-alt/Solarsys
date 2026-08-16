# Project notes for Claude — Eldritch Cartographer

This project was a fresh start (see git history before this point for the
prior project, an accretion-disk N-body sim — unrelated, fully replaced).
Read this before making changes.

## What this is

`index.html` is a single self-contained procedural map generator for
Call of Cthulhu, covering five location types: caves, mansions, crypts,
graveyards, and villages. No build tooling, no dependencies — it's plain HTML/CSS
and vanilla JS in one file, opens directly in a browser or serves
straight off GitHub Pages. There is no separate source file to build
from; `index.html` **is** the source. Edit it directly.

Full design rationale (grid model, seeding, why caves/crypts get
depth-shading and mansions/graveyards don't, the "secret rooms" convention)
is in `README.md` — read that before changing generator behavior, so
changes stay consistent with the existing visual language rather than
introducing a second style.

## Architecture summary

Everything lives in `index.html`'s one `<script>` block:

- **PRNG**: `cyrb53` (string → 32-bit hash) feeding `mulberry32`. Seed
  string + map type are combined before hashing, so the same seed text
  produces a different map per type (not the same layout re-skinned).
- **Grid model**: a flat `Uint8Array` per map, cell types
  `WALL / FLOOR / DOOR / WATER / PATH`. Helpers: `idx`, `inBounds`,
  `bfsDistance` (multi-source BFS, used for cave/crypt depth shading),
  `findRegions` (flood fill, used to detect and reconnect isolated cave
  pockets), `carveLine` (biased random walk between two points, used for
  tunnel-connecting regions).
- **Five generators**, each a standalone function returning
  `{ cols, rows, grid, features, rooms, mapType, title, flavor, key }`:
  `generateCave`, `generateMansion`, `generateCrypt`, `generateGraveyard`,
  `generateVillage`. `features` is an array of `{ type, x, y, ... }`
  glyphs drawn on top of the grid (headstones, sarcophagi, furniture,
  a village well, etc.) — see `drawFeature` for the full switch of
  supported types. `rooms` is only populated by mansion/crypt/graveyard/
  village (named rooms/chambers/buildings, some flagged `secret`).
  `ROOM_HEADINGS` maps mapType to that section's sidebar heading text
  ("Village Locations" vs. "Rooms & Chambers" elsewhere) — add an entry
  there for any new map type that populates `rooms`.
- **Investigation leads**: a village room may also carry a `lead` — a
  one-line, building-specific investigation hook string. `updateSidebar`
  renders it under the room's label (`.room-lead`) whenever present; it's
  optional per room, so this is safe to leave unset on other map types
  rather than adding empty leads everywhere.
- **Shared surname pool**: `SURNAME_POOL` (top-level, near `carveLine`)
  is used by both `generateGraveyard` (mausolea) and `generateVillage`
  (family residences, and the "no one will say why the ___ place has
  stood empty" flavor line) so the same families recur across a seed's
  worth of map types instead of each generator inventing its own cast.
- **Renderer**: `renderMap` draws terrain fill → ink boundary outline
  (drawn once, only on edges between non-wall and wall, so it works for
  every map type without per-type special-casing) → door glyphs →
  features → frame/compass. `PALETTES` holds per-map-type colors.
- **Lurking threats**: `MONSTER_POOLS` (per map type) is reference data
  only, not generator output — nothing places a threat automatically.
  The Keeper picks one from `#monsterSelect` (repopulated per type by
  `populateMonsterSelect`, plus a "Custom…" option backed by
  `#customMonsterInput`) and clicks the canvas to place it; the click
  handler and `placedThreats` array live in the App wiring section.
  `drawThreatMarker` draws each placement as a numbered overlay *after*
  `renderMap` returns (see `redraw()`), gated by `#showThreatsToggle`,
  so markers are never part of the generator's own grid/features output.
- **App wiring** at the bottom: DOM lookups, `regenerate()`,
  `updateSidebar()`, event listeners, `init()` IIFE that runs on load.

## Workflow rules

**1. This is a plain-JS single-file project — no build step exists or
should be added.** If a future change genuinely needs a build (e.g.
switching to a framework), that's a bigger conversation to have with the
user first, not something to introduce unilaterally.

**2. Verify empirically, not by reading the code.** Procedural
generation is exactly the kind of code where "looks right" and "is
right" diverge — a generator can run with zero errors and still produce
disconnected caves, overlapping rooms, or off-by-one grid bugs that only
show up visually or after many seeds. Pattern used to build this
project, worth reusing for changes:
- Extract the `<script>` contents and run `node --check` on them first
  for a fast syntax pass.
- Render with headless Chromium via `playwright-core`
  (`/opt/node22/lib/node_modules/playwright/node_modules/playwright-core`),
  launched with `executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'`,
  `args: ['--no-sandbox']` — do NOT run `playwright install`.
- Click through all five map types, and re-generate several times per
  type (different seeds) — single-seed testing will miss generator bugs
  that only occur for some random layouts (e.g. a BSP split that
  produces a degenerate 0-width room, a crypt spine that walks off the
  grid edge, a village's rejection-sampled buildings landing far short
  of the target count on an unlucky seed).
- Check both `page.on('pageerror')` and `page.on('console')` for errors,
  and pull real pixel data via `getImageData` (or at minimum a
  screenshot you actually look at) rather than assuming "canvas.width is
  nonzero" means the map rendered correctly.
- Test the Small/Medium/Large size switch and a narrow mobile viewport
  (390px) — the header control row uses `flexWrap` for this; don't
  remove it.

**3. Keep the five generators visually distinct on purpose.** Caves and
crypts are "carved out of a solid mass" (depth-shaded rock/earth,
organic or winding shapes). Mansions, graveyards, and villages are
"built" (thin single-cell walls/fences, flat colors, rectilinear). Don't
homogenize these without a reason — the contrast is what makes each map
type read correctly at a glance. Within the "built" group, keep each
type's own identity too — village isn't just a graveyard with more
buildings: it has no perimeter wall (open, not enclosed), a browner/
woodier palette than graveyard's greens, and roads instead of gravel
paths radiating from a gate.

**4. Rooms/chambers/buildings with `secret: true` must stay visually
indistinguishable on the canvas itself** — same wall/door rendering as
any other room. The only place a secret room is revealed is the sidebar
room list (marked with `†`), which is meant for the Keeper's eyes, not
the players'. If you add new secret-room types, follow this convention.

Lurking threats work differently on purpose: unlike secret rooms, a
placed monster *is* drawn as its own marker (`drawThreatMarker`) — that's
the point, the Keeper is placing it deliberately, not the generator
hiding it. What keeps this from spoiling a player-facing map is the
`#showThreatsToggle`: markers must stay a separate overlay pass drawn
*after* `renderMap`/`redraw()`, never baked into the generator's own
`features`/`grid` output, so hiding them is always just "redraw without
the overlay," not "regenerate a different map." Keep monster flavor text
original/non-mechanical (no stat blocks) — Mythos creature names and
vibes are fair game, but Chaosium's actual Malleus Monstrorum stats are
not ours to reproduce.

## Known intentional loose ends

- Furniture/feature glyphs are simple vector shapes (rectangles, lines,
  arcs) rather than icons or images, to keep the file dependency-free
  and self-contained. Keep new glyphs in that style rather than reaching
  for an icon font or external asset.
- The "disturbed grave" feature in graveyards is a flavor/plot hook, not
  a mechanically meaningful map element — it's fine for it to appear or
  not per-seed.
- GitHub Pages status for this repo has not been independently confirmed
  by any Claude session yet — check repo Settings → Pages, or ask the
  user, before claiming a live URL exists.
