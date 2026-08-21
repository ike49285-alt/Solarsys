# Eldritch Cartographer

A procedural map generator for **Call of Cthulhu** (and other Lovecraftian
horror tabletop games), built as a single self-contained `index.html` —
no install, no build step. Open the file in a browser, or serve it from
GitHub Pages.

**The generator's job stops at the map.** It draws terrain, rooms, and
buildings, and labels each one with a generic type (Study, Ossuary,
General Store, ...) — none of that is plot. Everything narrative — what's
actually in a room, who a threat is and what its stats are, what the
Keeper needs to remember about this location — is a blank field the
Keeper fills in themselves, right on the map. Nothing here invents a
storyline for you.

It generates five kinds of location, each with its own algorithm and
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
  disturbed grave.
- **Village** — a winding main road and side lanes scattered with named
  buildings (General Store, Sheriff's Office, Boarding House, a handful
  of family residences, ...).

Every map is seeded — the same seed + map type always produces the same
layout, so a Keeper can save or share a seed string to regenerate a
specific map later. The seed field accepts anything; the dice button
rolls a themed random one (e.g. `Whispering-Hollow-41`).

**Keeper Notes**: the map title is an editable field (rename it to your
own town/house/vault), and there's a blank "Keeper Notes" box for the
map as a whole. Every room, chamber, or building in the sidebar has its
own blank notes textarea too — that's where the actual scenario lives:
what's really in the General Store, why the Ossuary matters, what the
party will find. It's all typed by you. By default it's tied to the map
currently on screen and clears whenever you generate a new one — see
**Saved Locations** below for keeping it around.

**Saved Locations**: click **💾 Save this location** to keep the whole
prepped map — title, Keeper Notes, every room's notes, every placed
threat's full stat block — under a name in the browser's local storage.
The dropdown at the top of the sidebar lists everything you've saved
(most recent first); **Load** brings one back exactly as you left it,
on any map type, any time, even after closing the tab. If the current
map has any notes or threats that aren't saved yet, hitting Generate
(or switching type/size) asks before discarding them — save first if
you want to keep it. 🗑 deletes whichever saved location is selected.
This is what makes "prep a few locations ahead of a session" actually
work: prep the Cave, save it, prep the Village, save it, and pull
either back up mid-session without losing anything.

**Placing threats**: click **+ Threat** to arm placement, then click the
map to drop a numbered marker; click a marker again (or its ✕ in the
sidebar) to remove it. Each marker opens as a blank Call of Cthulhu 7th
edition-style stat block — real characteristic fields (STR/CON/SIZ/DEX/
APP/INT/POW/EDU), plus Move, Armor, Attacks, Skills, Sanity Loss, and
Notes — with **HP, Magic Points, and Damage Bonus/Build calculated live**
from whatever numbers you type in, using the actual 7e formulas. No
creature names, flavor text, or stats are pre-written; this tool can't
(and shouldn't) reproduce Chaosium's Malleus Monstrorum — the sheet
structure and derived-stat math are just game mechanics, so filling in
your own numbers gives you a real, correctly-computed stat block. The
"Show markers" checkbox hides the marker overlay without losing what
you've entered, so you can flip it off before sharing a clean copy of
the map with players. Switching map type or generating a new layout
clears placed markers, since their grid positions no longer apply.

**Reusing a stat block**: hit 💾 on a filled-in threat card to save it
by name (e.g. "Deep One Hybrid") — it's kept in the browser's local
storage, so it's there next time you open the page, on any map. The
dropdown next to **+ Threat** picks what a *new* marker starts from:
leave it on "Blank threat," or pick a saved one to pre-fill everything
(name, stats, attacks, all of it) the moment you place it, still fully
editable per-marker afterward. 🗑 deletes whichever saved entry is
currently selected in that dropdown.

## Using it

1. Open `index.html` in any modern browser (double-click it, or visit it
   via GitHub Pages). Built to work first as a phone-in-hand tool at the
   table in mobile Safari, not just at a desk.
2. Pick a map type, a size (Small / Medium / Large), and optionally type
   a seed.
3. Click **Generate**. Click it again (or the dice) for a new location.
4. **Download PNG** saves the current canvas as an image for use at the
   table or in a VTT.

**Zoom and pan**: the map loads fit to the screen, then it's yours to
move around — pinch to zoom and drag with one finger on a touchscreen,
or scroll/wheel to zoom and click-drag with a mouse. This is a viewer
transform on top of the drawn map, independent of the browser's own
page zoom, so it stays sharp and doesn't drag the header/sidebar along
with it. **Reset View** snaps back to the initial fit-to-screen framing
(also happens automatically on generate, and on rotating/resizing the
window). Placing or removing a threat marker still lands on the exact
grid cell under your finger/cursor at whatever zoom level you're at.

The sidebar shows the map's title, a short flavor line, a key explaining
the symbols on the map, and — for mansions, crypts, graveyards, and
villages — a list of the named rooms/buildings found, with hidden ones
marked (`†`) so the Keeper can decide when (or whether) to reveal them.

## How it's built

Plain HTML + CSS + vanilla JavaScript in one file. No framework, no
bundler, no dependencies — it runs straight off the filesystem or a
static host. All five generators work on a shared grid model
(`WALL` / `FLOOR` / `DOOR` / `WATER` / `PATH` cells, plus a `features`
array for glyphs like headstones or sarcophagi that sit on top of the
grid) and share rendering helpers (a seeded PRNG, flood-fill region
detection, multi-source BFS for cave/crypt depth-shading, and a common
ink-outline/door/feature renderer). Each generator is a self-contained
function — see `index.html`, search for `generateCave`, `generateMansion`,
`generateCrypt`, `generateGraveyard`, `generateVillage`.

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
- **Rooms carry secrets**: mansion rooms, crypt chambers, and village
  buildings each have a small chance of being generated as "secret"
  (locked room, sealed vault, boarded-up cottage, etc.). These use the
  same door/wall rendering as everything else — nothing on the map
  itself gives them away — but are flagged in the sidebar's room list so
  the person running the game knows where they are without the map
  spoiling it visually.
- **Shared surname pool**: mansion, graveyard, and village generators
  all draw family names from the same `SURNAME_POOL` — a mausoleum's
  "Family," a village "Residence," and (already) a mansion called
  "Ashcombe Hall" can share a surname, so the same seed's worth of
  fictional town feels like one town rather than three unrelated casts.
- **Threats are Keeper-authored, not generated**: a placed marker starts
  completely blank (`blankThreat()`) — no name, no stats, no flavor text.
  The stat block's derived fields (HP, MP, Damage Bonus/Build) are
  computed live from the 7e core-rulebook formulas as the Keeper types
  in characteristics, but the characteristics themselves, and everything
  else (name, attacks, skills, notes), are entirely the Keeper's own.
  Markers are drawn as a separate overlay pass after the base map, gated
  by "Show markers," so they're never part of a generator's output.
