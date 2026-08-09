# Accretion Disk sim — freeze fix applied, needs real-device verification

`accretion-disk.jsx` is a canvas-based N-body gravity sim (React component,
built for Claude.ai's artifact preview). It simulates planetesimals
accreting into planets/brown dwarfs/stars around a barycenter. It's been
built up incrementally in chat and was **freezing the browser tab**,
especially noticeable on mobile.

## What's already been fixed

### 1. Unbounded population growth (patched earlier)
Tidal disruption events were spawning 3 fragments while only removing 1
body (net +2 per event), which let the population grow unbounded over
time — and since gravity + collision detection are both O(n²), that
silently compounds into a freeze rather than a crash. Mitigations in the
file:
- `MAX_BODIES = 130` hard ceiling
- Tidal fragments capped at 2 (net +1, not +2) once near the ceiling
- A hard trim-to-ceiling safety net runs every frame regardless of cause

This didn't fully fix the freeze, which led to a second pass below.

### 2. React re-render churn (prime suspect — now fixed)
Every animation frame (~60/sec), `step()` was calling six `setState`
updates unconditionally (`setCount`, `setStarCount`, `setDwarfCount`,
`setHottest`, `setCleared`, `setTopMass`), plus two more
(`setEnergyDrift`/`setAngMomDrift`) every 15 frames. Each call triggered a
full re-render of the component, including rebuilding the header's JSX —
up to ~480 re-renders/sec for numbers nobody perceives changing faster
than a few times a second.

Fixed by doing what the investigation notes suggested: the physics loop
now writes every frame into `statsRef` (a plain ref, no re-render), and a
separate `setInterval` at 10Hz copies `statsRef.current` into one
consolidated `stats` state object for rendering. This cuts header
re-renders from ~60/sec (~480/sec including the drift fields) down to
10/sec, and collapses 8 separate `useState` hooks into 1.

### 3. Incidental allocation/GC cleanup
While in there, three small per-frame inefficiencies were removed (same
behavior, fewer allocations per frame):
- A `totalMassNow` reduce at the top of the collision pass was computed
  but never used — dead code, removed.
- The escape-handling loop recomputed total system mass via `.reduce()`
  on every escaped body, even though the body array doesn't change within
  that loop (only a `removed` index set is being built) — so it was
  recomputing the identical value repeatedly. Hoisted to run once per
  frame instead.
- Star/dwarf counts were computed via two `.filter(...).length` calls plus
  a separate `.reduce()` for max mass — three array allocations. Replaced
  with a single `for` loop that computes all three in one pass.

None of these were expected to be the freeze's root cause on their own
(n=130 keeps them cheap even done wastefully), but they reduce
per-frame garbage-collector pressure, which compounds with render churn
on weaker mobile JS engines.

## Not yet verified
These changes haven't been run in an actual browser tab yet — only
syntax-checked (`esbuild`). Before calling this closed:
- Drop it into Claude.ai's artifact preview (or any React sandbox) and let
  it run for a few minutes on both desktop and a real mobile device.
- If it still freezes, open the Performance/Profiler tab as originally
  planned — the render-churn fix removes the prime suspect, but hasn't
  been confirmed to be *the* cause versus *a* cause.

## Other things worth checking if it still freezes
- The physics loop still does **three separate O(n²) passes** per
  relevant frame: gravity (`computeAccelerations`), collision detection,
  and (every 15th frame) the energy/angular-momentum conservation
  calculation. At `MAX_BODIES = 130` this should be cheap (~17k
  pair-checks per pass) on desktop, but worth confirming it's not the
  bottleneck on mobile hardware specifically.
- Canvas resolution: `dpr` is capped at 2 (`Math.min(window.devicePixelRatio
  || 1, 2)`), but on a large phone screen at dpr=2 the backing canvas
  could still be quite large — worth checking if downscaling further
  helps.
- `ctx.createRadialGradient` is allocated fresh every frame for every
  dwarf/star (glow effect) — gradient creation is one of the pricier
  Canvas2D calls. Scales with number of massive bodies, not total
  population, so likely small, but worth profiling if a system has many
  stars/dwarfs at once.
- `spawnInterval` (setInterval, 1000ms), the new `statsPushInterval`
  (setInterval, 100ms), and the animation frame loop all mutate/read
  `bodiesRef.current` or `statsRef.current` independently — confirmed
  safe under JS's single-threaded execution model, but worth
  double-checking there's no edge case where a stale closure causes a
  spawn to be lost or duplicated.
- Trail rendering fills the canvas with a translucent rect every frame
  (`ctx.fillRect`) rather than clearing — cheap on desktop but worth a
  sanity check on mobile GPU compositing.

## Suggested next step
Reproduce on a real device (or throttled CPU in Chrome DevTools) with the
Performance/Profiler tab open, record a few seconds, and confirm the
render-churn fix actually moved the needle before chasing anything else
on the list above.
