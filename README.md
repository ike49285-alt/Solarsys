# Accretion Disk sim — nebula to black hole

`accretion-disk.jsx` is a canvas-based N-body gravity sim (React component,
built for Claude.ai's artifact preview). It plays out a full, real-physics
stellar life cycle: a turbulent collapsing gas cloud settles into a
protoplanetary disk, planetesimals accrete into planets/brown dwarfs/stars,
and — new — stars actually age, die, and leave behind white dwarfs, neutron
stars, or black holes, with real merger physics (including gravitational-wave-style
compact-object mergers and Type Ia supernovae) along the way.

## How to open it
`index.html` in this repo is a self-contained build of `accretion-disk.jsx`
(React bundled right in) — no `npm install`, no build step, no server.

- **Fastest, no setup:** on GitHub, open `index.html` → "Download raw file"
  (or clone/download the whole repo as a ZIP) → double-click the downloaded
  `index.html` → it opens straight in your browser and runs.
- **A real shareable link:** turn on GitHub Pages once — repo **Settings →
  Pages → Source → Deploy from a branch**, pick this branch and `/ (root)`,
  **Save**. GitHub gives you a URL like
  `https://ike49285-alt.github.io/Solarsys/` that anyone (including your
  phone) can open directly, and it updates automatically every time this
  `index.html` is pushed.

`index.html` is a generated file — if you change `accretion-disk.jsx`, it
needs to be rebuilt (ask Claude to rebuild it, or run the same bundling
step yourself once you're comfortable with `npm`/`esbuild`).

## The life cycle, stage by stage

1. **Nebula collapse.** The disk doesn't start pre-formed — bodies seed in
   with genuinely turbulent velocities (wide spread, mostly but not
   uniformly prograde, real radial motion) instead of tidy circular orbits.
   Gas drag (already modeling Keplerian circularization) settles this into
   an orderly disk over the first several seconds. This sim has no z-axis
   to flatten a cloud along the way a real 3D collapse would, so the 2D
   stand-in is chaos-settling-into-order in-plane — same dissipation
   mechanism, different visual.
2. **Protoplanetary disk → planets/brown dwarfs/stars.** The pre-existing
   accretion model: minimum-mass-solar-nebula density falloff, a snow line,
   gravitational focusing, giant-impact ejecta, tidal disruption, and real
   deuterium/hydrogen ignition thresholds.
3. **Main-sequence lifetime.** A star's lifespan scales like the real
   L ∝ M^3.5 relation (`starLifespanSeconds` — lifespan ∝ M^-2.5),
   calibrated so a star right at the hydrogen line lives minutes of
   sim-time while a monster built from repeated mergers burns out in
   seconds.
4. **Death.** Below `SUPERNOVA_MASS`: a quiet white dwarf (envelope shed as
   a "planetary nebula" puff). At or above it: a real core-collapse
   supernova, most of the mass blown out violently, with the remnant's
   fate — neutron star or black hole — decided by whether its own mass
   clears `TOV_MASS`, mirroring the real Tolman-Oppenheimer-Volkoff limit.
5. **Compact-object aftermath.** Remnants keep participating in normal
   gravity/collision physics: a white dwarf can keep accreting (or merge
   with another white dwarf) and go **Type Ia** if it crosses
   `CHANDRASEKHAR_MASS`; a neutron star or black hole can merge with
   anything else and grow, with mass thresholds re-checked on every merge —
   so a neutron star pushed over `TOV_MASS` correctly collapses further
   into a black hole, the same event LIGO detects as gravitational waves.

Three compact-remnant mass-radius laws are modeled, each a real, different
astrophysical relation: white dwarfs get **smaller** as they get heavier
(electron degeneracy, R ∝ M^-1/3), neutron stars stay almost exactly the
same tiny size across their whole mass range (neutron degeneracy), and
black holes grow **linearly** with mass (Schwarzschild radius, R ∝ M) —
gravity with nothing left to push back.

### Honesty about the numbers
Real core-collapse supernovae need a progenitor above ~8 solar masses
(~8,400 M♃) — completely out of reach of this sim's actual mass budget (a
full disk starts around only ~350 M♃ total, hard-capped at 130 bodies).
`SUPERNOVA_MASS`, `CHANDRASEKHAR_MASS`, `TOV_MASS`, and `STAR_BASE_LIFESPAN`
are stylized thresholds in the same spirit as the sim's existing time
compression: real physics, real *ordering* preserved (only an unusually
massive star goes supernova; only the most massive of those leaves a black
hole instead of a neutron star), values rescaled to be reachable through
play and resolve within a session rather than literal astronomical numbers.

### A bug this caught (worth knowing about if you touch this code)
The compact-merger classification originally checked "does the merged mass
exceed `TOV_MASS`?" for *any* remnant merger, including a pure
white-dwarf + white-dwarf merger. Since `TOV_MASS` (the neutron-degenerate
ceiling) is much lower than `CHANDRASEKHAR_MASS` (the electron-degenerate
ceiling) in this sim's units, that meant ordinary white dwarfs merging
would short-circuit straight to "black hole" before ever reaching the
intended Chandrasekhar/Type-Ia check — and the mislabeling then cascaded
into later, unrelated mergers that touched the same body. Caught by an
instrumented test harness (unique body IDs + full event logging run
against the live sim, headless Chromium) before shipping — the fix gates
the TOV check on an actual neutron star or black hole being involved,
never a lone white dwarf.

## Prior work: the freeze fix
Before this, the sim had been **freezing the browser tab**, especially on
mobile. Root causes found and fixed, in order:

1. **Unbounded population growth.** Tidal disruption events were spawning 3
   fragments while only removing 1 body (net +2 per event) — combined with
   O(n²) gravity/collisions, unbounded growth silently became a freeze
   rather than a crash. Fixed with a `MAX_BODIES = 130` hard ceiling, a
   fragment cap near that ceiling, and a hard trim-to-ceiling safety net.
2. **React re-render churn (the actual prime suspect).** The physics loop
   was firing 6–8 `setState` calls every animation frame (~60/sec),
   forcing a full header re-render each time. Fixed by writing per-frame
   values into a plain ref and only pushing to React state via a separate
   10Hz interval — cuts re-renders from ~60/sec to ~10/sec.
3. **Bodies getting stuck bouncing off each other indefinitely.** Two
   bodies could get mutually captured into a tight, near-circular orbit
   sitting almost exactly at their combined radius, bouncing every single
   frame for dozens of seconds — confirmed via the same instrumented test
   harness (474 consecutive bounces in one trial). The geometric
   `headOn`/impact-parameter test assumed a real flyby with kinetic energy
   behind it, which a decayed circular orbit can never satisfy regardless
   of speed. Fixed by widening the grazing threshold toward the full
   combined radius as relative speed drops toward zero — a deeply
   sub-escape-velocity contact has no kinetic budget left to genuinely
   graze past with, so it should behave like a capture, not a flyby.

All three were verified with an instrumented test harness (unique body IDs,
full event logging, headless Chromium) before shipping, not just read from
the source — the collision-lock fix in particular went through two failed
attempts (adding bounce restitution alone made the lock *more* stable, not
less) before the actual geometry mismatch was identified and confirmed
fixed.
