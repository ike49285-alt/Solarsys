# Project notes for Claude — Accretion Disk sim

Read this before touching anything. It's the accumulated context from the
session that built most of this project — workflow rules exist because
skipping them caused real bugs to ship.

## What this is

`accretion-disk.jsx` is a single-file canvas + React N-body gravity sim,
originally built for Claude.ai's artifact preview, now living as a real
GitHub project. It plays out a full, real-physics stellar life cycle:
nebula collapse → protoplanetary disk → planets/brown dwarfs/stars →
main-sequence lifetime → death (white dwarf / neutron star / black hole)
→ compact-object aftermath (mergers, Type Ia). There is no build tooling
in the repo — `index.html` is a **generated, self-contained artifact**:
React + the component bundled together with esbuild into one file, so it
opens directly in a browser or serves straight off GitHub Pages with zero
`npm install`.

`README.md` has the full narrative history of every bug found and fixed,
written for a human reader. This file is process/workflow notes for
whichever Claude picks this up next.

## Critical workflow rules

**1. Every change goes through: edit `accretion-disk.jsx` → rebuild
`index.html` → verify → commit both → push → PR → merge.** Never edit
`index.html` by hand; it's always regenerated. Build command (run from a
scratch directory with `react`, `react-dom`, `esbuild` installed):
```
npx esbuild entry.jsx --bundle --outfile=bundle.js --format=iife --jsx=automatic \
  --define:process.env.NODE_ENV='"production"' --loader:.jsx=jsx
```
`entry.jsx` is just:
```jsx
import React from "react";
import { createRoot } from "react-dom/client";
import AccretionDisk from "./accretion-disk.jsx";
createRoot(document.getElementById("root")).render(<AccretionDisk />);
```
Wrap `bundle.js` in a minimal HTML shell (see any recent commit's
`index.html` diff for the exact template — inline `<style>`, a `#root`
div, the bundle in a `<script>` tag, dark background `#060710` to match
the sim so there's no flash-of-white on load).

**IMPORTANT — this bit has actually gone wrong before:** always rebuild
`bundle.js` from the *current* `accretion-disk.jsx` immediately before
packaging `index.html`, and grep the packaged `index.html` for a string
unique to your change before committing. A stale bundle got shipped once
(the source was fixed, but `index.html` still had the old bug) and only
got caught because of this grep habit — do it every time, no exceptions.

**2. The designated branch is `claude/readme-review-wuj4a6`.** It gets
merged (squash) after essentially every change, so at the start of new
work it's almost always *behind* your local commits' apparent ancestry.
The pattern that works:
```
git fetch origin main
git checkout -B claude/readme-review-wuj4a6 origin/main
git cherry-pick <your-commit-sha>
# verify: diff your working files against `git show HEAD:<file>` — should be empty
git push --force-with-lease -u origin claude/readme-review-wuj4a6
```
Cherry-picking onto a fresh `main` (rather than trying to merge/rebase
the old branch tip) avoids merge-conflict errors from squash-merge
history divergence — this happens on essentially every PR in this repo
and cherry-pick has never failed to apply cleanly, since the content at
each squash point matches exactly.

**3. Verify empirically, not by reading the code.** The single biggest
lesson of this project: several "obviously correct" fixes were wrong,
and only an actual running instrumented test caught it. Pattern used
throughout:
- Copy `accretion-disk.jsx` to a scratch `probe.jsx`.
- Patch in logging (`window.__log.push(...)`) at the specific code paths
  you're testing, and/or seed deterministic test bodies (`bodiesRef.current.push({...})`
  right after the initial disk-fill) instead of waiting on random organic
  growth to reach a rare state.
- Bundle it the same way as above, load it in headless Chromium via
  `playwright-core` (already available; launch with
  `executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'`,
  `args: ['--no-sandbox']` — do NOT run `playwright install`).
- Read back `window.__log` after running for however long the bug needs
  to manifest (some needed 60-120s; one needed a 7-minute run to catch a
  slow-building issue that looked fine at 2 minutes).
- For visual issues, `page.screenshot()` and actually look at it, and/or
  `getImageData()` on the canvases directly to check real pixel alpha
  values rather than guessing from a screenshot.

Concrete example of why this matters: a fix for bodies getting stuck
bouncing off each other was first attempted with bounce restitution
alone — looked plausible, but an instrumented rerun showed the lock
getting *more* stable (4,041 consecutive bounces vs. 474 before). The
actual bug was a geometry mismatch nothing about restitution could fix.
Another: a "fix" for the density trail becoming unreadable over time
technically worked (average brightness plateaued) but pixel inspection
showed it plateaued because the *entire background* had opacified, not
just the trails — a completely different failure mode invisible in a
short test and only caught by checking `pctOver50`/`pctOver80` coverage
over several minutes.

**4. Publish a live preview after shipping, when useful.** The Artifact
tool can wrap a built `index.html`-equivalent bundle and publish it as a
clickable link. The `artifact-design` skill mostly doesn't apply here —
this is hosting an already-designed running app, not designing a new
page, so the wrapper HTML is just a `<style>` block matching the sim's
own background/theme plus a `<div id="root">` and the bundle script, no
new visual design needed. Redeploying to the *same* file path keeps the
same URL, which is worth doing so the user has one stable link across
the whole conversation rather than a new one each time.

## Architecture summary

Single React component (`AccretionDisk`), one big `useEffect` running an
imperative canvas animation loop via `requestAnimationFrame`. No other
files, no state management library, no CSS files (inline `style` objects
at the bottom of the file).

**Two stacked `<canvas>` elements** (added mid-project, see below):
- `canvasRef` (top): current body positions + a *fast* trail. Fades via
  `destination-out` (removes alpha, doesn't paint over — see the
  density-trail bug below for why this distinction matters).
- `densityCanvasRef` (bottom, `pointerEvents: none`): a much slower,
  long-exposure trail showing accumulated orbital path density. Also
  uses `destination-out` for its continuous fade for the same reason.
  User-tunable opacity via a header slider (`trailDensity` state,
  default 5%).

**Body object shape** (not a class, just plain objects in the
`bodiesRef.current` array): `{ x, y, vx, vy, mass, r, color, ax, ay,
newAx, newAy, remnant?, age?, tidalImmuneUntil? }`. `remnant` is one of
`"whiteDwarf" | "neutronStar" | "blackHole"` or absent for ordinary
matter. `age` only exists on bodies with `mass >= HYDROGEN_MASS` (tracks
main-sequence lifetime). `tidalImmuneUntil` is a frame-count deadline set
on freshly-ejected fragments so they can't be immediately re-shredded.

**Per-frame order in `step()`:** trail fades (both canvases) → Verlet
position update → `computeAccelerations` (O(n²) gravity) → velocity
update + gas drag → collision double-loop (tidal disruption check →
merge/absorb/bounce check) → stellar-death pass (age vs. lifespan) →
density-trail wipes at destruction sites → escape-boundary
bounce-reflection → population trim to `MAX_BODIES` → stats tally →
energy/momentum conservation check (throttled) → barycenter recenter →
draw bodies → draw flashes.

**Key stylized (not literal) thresholds**, all documented inline as such
in the source — real astrophysical progenitor masses are far outside
this sim's actual mass budget (~350 M♃ total disk mass vs. ~8,400 M♃ for
a real supernova progenitor), so these preserve real *ordering* while
being reachable through play:
- `DEUTERIUM_MASS = 13`, `HYDROGEN_MASS = 80` — real thresholds, in Jupiter masses
- `SUPERNOVA_MASS = 220`, `SN_REMNANT_FRACTION = 0.15`, `WHITE_DWARF_FRACTION = 0.4`
- `CHANDRASEKHAR_MASS = 95` (white dwarf → Type Ia), `TOV_MASS = 40` (neutron star → black hole)
- `STAR_BASE_LIFESPAN = 240` seconds at exactly `HYDROGEN_MASS`, scaling as `M^-2.5`
- `MAX_BODIES = 130` (hard population ceiling), `GOAL_POPULATION = 100`
- `TIDAL_IMMUNITY_FRAMES = 30`, `TIDAL_FLASH_MIN_MASS = 1`

## Chronological feature/fix log

Oldest first. Full technical detail for each is in `README.md` and in
the corresponding commit message (`git log` on `main` — commit messages
in this repo are written long-form on purpose, treat them as
documentation, not just change descriptions).

1. **Freeze investigation** (pre-existing, before this project's Claude
   session started) — unbounded population growth from a tidal-fragment
   accounting bug; already mitigated with `MAX_BODIES` + fragment caps
   by the time this session picked it up.
2. **React re-render churn** — 6-8 `setState` calls/frame collapsed into
   a ref written every frame + a 10Hz interval pushing to actual state.
3. **`index.html` added** — self-contained build so the sim runs with no
   npm/build step; opens by double-click or via GitHub Pages.
4. **JSX-runtime bug** — first `index.html` build silently failed
   (`ReferenceError: React is not defined`) because the classic JSX
   transform needs `React` in scope and the source only imports named
   hooks; fixed by building with `--jsx=automatic`.
5. **Stuck-bouncing lock** — two bodies could settle into a near-circular
   orbit at contact distance that the geometric `headOn` test could never
   pass regardless of speed. Fixed by widening the grazing threshold
   toward the full combined radius as relative speed drops toward zero
   (plus added bounce restitution, which alone was insufficient).
6. **Full stellar life cycle added** — nebula collapse (turbulent initial
   velocities), main-sequence aging, supernovae, three real compact-remnant
   mass-radius laws, Type Ia, compact-object mergers. Caught and fixed a
   real classification bug in the same PR: the TOV check was gating *any*
   remnant merger including pure white-dwarf pairs, before ever reaching
   the intended Chandrasekhar check.
7. **Tidal-disruption cascade** — fragments ejected at a random angle
   could land back inside the same Roche zone and re-shred every frame
   (46,251 events in 2 minutes on one pair). Fixed with outward-biased
   ejection + an immunity window on fresh fragments.
8. **Forced absorption** — stars/black holes have no rigid surface to
   bounce off of; any physical touch against one is now an unconditional,
   lossless merge instead of going through the rock-on-rock bounce logic.
9. **Two-trail system** — added the density canvas described above. Went
   through two rounds of "too opaque, can't see bodies" (opacity tuned
   down + made a live slider) and then a real bug where the long-term
   fade opacified the *entire background*, not just trails (fixed by
   switching to `destination-out`).
10. **Reflecting boundary** — bodies that exceed the escape radius now
    bounce (mass/momentum-conserving) instead of being removed and
    replaced with a comet, which was causing large barycenter jumps.
11. **Trail wipes on destruction** — a destroyed body's local patch of
    density trail clears fast (localized `destination-out` circle) at
    every removal site, so a merged/shredded/absorbed body's path stops
    reading as "still active."
12. **Mobile layout fix** — header buttons row had no `flexWrap`, cutting
    off controls on narrow phone screens.
13. **Tidal flash floor** — cascaded shred fragments below mass 1 no
    longer draw their own flash ring (the shred itself is unaffected,
    purely a visual-clutter fix for multi-generation cascades).

## Known intentional loose ends

- The `"comet"` spawn mode in `spawnBody()` is dead code — it was only
  ever called from the escape-replacement path removed in fix #10.
  Left in place rather than deleted in case a future "occasional icy
  visitor" feature wants it.
- NS+NS merger → black hole is the same code path as NS+ordinary-matter
  → black hole (both just check `eitherIsNS`), and was verified
  correct via the ordinary-matter case; not separately re-verified with
  a dedicated NS+NS test, though there's no reason to expect it differs.
- GitHub Pages: the user was walked through enabling it (Settings →
  Pages → Deploy from branch → `main` → `/root`) but this session never
  independently confirmed it's live — ask the user for the URL if you
  need it, or check repo Settings → Pages directly.
- The live artifact preview URL used throughout this session is
  `https://claude.ai/code/artifact/982ce22b-1928-4c14-980b-2188193542d7`
  — redeploy to that same path if you want to keep using it, or ask the
  user whether they still want it kept in sync.
