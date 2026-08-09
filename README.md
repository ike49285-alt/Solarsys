# Accretion Disk sim — freezing, needs a real profiling pass

`accretion-disk.jsx` is a canvas-based N-body gravity sim (React component,
built for Claude.ai's artifact preview). It simulates planetesimals
accreting into planets/brown dwarfs/stars around a barycenter. It's been
built up incrementally in chat and now **freezes the browser tab**,
especially noticeable on mobile.

## What's already been fixed
A real bug was found and patched: tidal disruption events were spawning 3
fragments while only removing 1 body (net +2 per event), which let the
population grow unbounded over time — and since gravity + collision
detection are both O(n²), that silently compounds into a freeze rather
than a crash. Current mitigations already in the file:
- `MAX_BODIES = 130` hard ceiling
- Tidal fragments capped at 2 (net +1, not +2) once near the ceiling
- A hard trim-to-ceiling safety net runs every frame regardless of cause

**This did not fully fix the freeze**, so there's likely a second issue.

## Prime suspect: React re-render churn
Every animation frame (~60/sec when not frozen), `step()` calls roughly
six `setState` updates unconditionally:
`setCount`, `setStarCount`, `setDwarfCount`, `setHottest`, `setCleared`,
`setTopMass` — plus `setEnergyDrift`/`setAngMomDrift` every 15 frames.
Each call triggers a full re-render of the component, including rebuilding
the four header buttons' JSX. On a phone browser's JS engine this is a
plausible primary cause of freezing, independent of body count.

Worth trying:
- Throttle these to update state every N frames (e.g. every 6–10) instead
  of every frame, similar to how the energy/angular-momentum readout
  already only updates every 15 frames
- Or: keep the live values in refs, and only push to React state on a
  `setInterval` (e.g. 10x/sec) separate from the animation loop
- React DevTools Profiler or Chrome's Performance tab would confirm
  whether render time or physics time is dominating a frame

## Other things worth checking
- The physics loop does **three separate O(n²) passes** per relevant
  frame: gravity (`computeAccelerations`), collision detection, and (every
  15th frame) the energy/angular-momentum conservation calculation. At
  `MAX_BODIES = 130` this should be cheap (~17k pair-checks per pass) on
  desktop, but worth confirming it's not the bottleneck on mobile
  hardware specifically.
- Canvas resolution: `dpr` is capped at 2 (`Math.min(window.devicePixelRatio
  || 1, 2)`), but on a large phone screen at dpr=2 the backing canvas
  could still be quite large — worth checking if downscaling further
  helps.
- `spawnInterval` (setInterval, 1000ms) and the animation frame loop both
  mutate `bodiesRef.current` independently — confirmed safe under JS's
  single-threaded execution model, but worth double-checking there's no
  edge case where a stale closure over `bodies` causes a spawn to be lost
  or duplicated.
- Trail rendering fills the canvas with a translucent rect every frame
  (`ctx.fillRect`) rather than clearing — cheap on desktop but worth a
  sanity check on mobile GPU compositing.

## Suggested first step
Reproduce with the browser Performance/Profiler tab open (desktop
Chrome first, to isolate render-churn vs. physics-cost vs. mobile-specific
issues), record a few seconds around when it starts to lag, and see
which function dominates the flame graph before changing anything else.
