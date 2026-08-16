# Eldritch Cartographer

A procedural map generator for **Call of Cthulhu** (and other Lovecraftian
horror tabletop games), built as a single self-contained `index.html` —
no install, no build step. Open the file in a browser, or serve it from
GitHub Pages.

It generates four kinds of location, each with its own algorithm and
visual style tuned to fit the trope:

- **Cave** — cellular-automata cavern with organic walls, depth-shaded
  rock, water pools, stalagmite clusters, and an occasional strange
  carved idol tucked in a dead end.
- **Mansion** — a BSP (binary space partition) room layout connected by
  corridors and doors, with rooms auto-labeled (Study, Library, Cellar
  Stair, ...) and simple furniture glyphs. A small chance of a locked or
  hidden ritual room, flagged in the room list.
- **Crypt** — a winding underground spine corridor with branching burial
  chambers, sarcophagi, and a chance of a sealed vault that probably
  shouldn't be opened.
- **Graveyard** — a walled plot with a gate, gravel paths, scattered
  headstones, a mausoleum or two, dead trees, and (usually) one freshly
  disturbed grave as a ready-made Keeper hook.

Every map is seeded — the same seed + map type always produces the same
layout, so a Keeper can save or share a seed string to regenerate a
specific map later. The seed field accepts anything; the dice button
rolls a themed random one (e.g. `Whispering-Hollow-41`).

**Placing threats**: each map type has its own dropdown of Mythos-flavored
dangers (plus a "Custom…" option for typing your own). Pick one and click
the map to drop a numbered marker there; click a marker again (or its ✕
in the sidebar) to remove it. Placed threats are listed in the sidebar
with their tier and a line of flavor, numbered to match the markers on
the map. The "Show markers" checkbox hides the marker overlay without
losing the placements, so you can flip it off before sharing a clean copy
of the map with players. Switching map type or generating a new layout
clears any placed markers, since their grid positions no longer apply.

## Using it

1. Open `index.html` in any modern browser (double-click it, or visit it
   via GitHub Pages).
2. Pick a map type, a size (Small / Medium / Large), and optionally type
   a seed.
3. Click **Generate**. Click it again (or the dice) for a new location.
4. **Download PNG** saves the current canvas as an image for use at the
   table or in a VTT.

The sidebar shows the map's title, a short flavor line, a key explaining
the symbols on the map, and — for mansions, crypts, and graveyards — a
list of the named rooms/chambers found, with hidden ones marked (`†`) so
the Keeper can decide when (or whether) to reveal them.

## How it's built

Plain HTML + CSS + vanilla JavaScript in one file. No framework, no
bundler, no dependencies — it runs straight off the filesystem or a
static host. All four generators work on a shared grid model
(`WALL` / `FLOOR` / `DOOR` / `WATER` / `PATH` cells, plus a `features`
array for glyphs like headstones or sarcophagi that sit on top of the
grid) and share rendering helpers (a seeded PRNG, flood-fill region
detection, multi-source BFS for cave/crypt depth-shading, and a common
ink-outline/door/feature renderer). Each generator is a self-contained
function — see `index.html`, search for `generateCave`, `generateMansion`,
`generateCrypt`, `generateGraveyard`.

## Design notes

- **Seeding**: seed strings are hashed with `cyrb53` into a 32-bit int,
  which feeds a `mulberry32` PRNG. The map type is folded into the hash
  so switching type on the same seed doesn't just reuse the same random
  stream.
- **Cave connectivity**: cellular automata can produce disconnected
  pockets. Regions are found via flood fill, sorted by size, and every
  region smaller than the main cavern is either filled back in (if
  tiny) or tunnel-connected to the main region with a biased random
  walk, so the map is always fully navigable.
- **Depth shading**: caves and crypts run a multi-source BFS from every
  floor cell to shade "deep rock" darker than rock immediately next to
  a passage — this reads as depth without needing a lighting model.
  Mansions and graveyards skip this (their walls are thin partitions,
  not a rock mass), so they stay flat and blueprint-like by contrast.
- **Rooms carry secrets**: mansion rooms and crypt chambers each have a
  small chance of being generated as "secret" (locked room, sealed
  vault, etc.). These use the same door/wall rendering as everything
  else — nothing on the map itself gives them away — but are flagged in
  the sidebar's room list so the person running the game knows where
  they are without the map spoiling it visually.
- **Threats are Keeper-placed, not generated**: monster markers are never
  part of a generator's output — they're added afterward, by hand, from
  `MONSTER_POOLS`, and drawn as a separate overlay pass so they can be
  hidden (via "Show markers") independently of the base map. Monster
  flavor text is original and non-mechanical by design — no stat blocks
  — since Mythos creature names and vibes are fair game for a fan tool
  but Chaosium's actual Malleus Monstrorum stats aren't ours to reproduce.
