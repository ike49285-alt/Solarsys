# Working on this repo

Solar Nebula: a gas cloud collapses into a star and disk, planets form,
and the system ages to its end. `README.md` covers what it does for a
player; this file covers how to work on it.

## Workflow rules from the user

- **Publish the artifact before testing.** Whenever something is updated,
  rebuild and republish the Solar Nebula artifact first. Then run the
  tests and take screenshots. If fixes were needed, republish.
- **End every build with the artifact.** Finish by publishing to the same
  artifact URL and opening it for the user:
  https://claude.ai/artifact/2av6xgeCZqUp58MpxnKPLT

## Priorities from the user

- They want a toy to fiddle with: tools and sliders that visibly change
  what happens, like their stream-table sim.
- Realism as far as possible, but stability of operation comes first. A
  slow but steady simulation beats a fast one that can freeze or crash.
- It must work well on a phone. Avoid features that don't.

## Building the artifact

The artifact is `index.html` with its `<script src>` files inlined and the
document wrapper removed (the artifact host adds its own). Everything
between `<!-- page:start -->` and `<!-- page:end -->` is the page.

```sh
node tools/build.mjs /path/to/out.html     # default dist/solar-nebula.html
```

## Layout

- `src/cloud.js`: the collapse, using SPH with a Barnes–Hut tree, block
  time steps and sink particles. Code units have G = 1 and a cloud of
  mass 1 and radius 1; `units` converts them. It hands off to the disk
  0.6 time units (~4.5 kyr) after the first protostar forms (`SETTLE`).
- `src/disk.js`: the 1D disk (gas, two-population dust, vapour,
  planetesimals) on 240 log-spaced rings, solved implicitly.
- `src/planets.js`: orbit-averaged planets (growth, migration,
  resonances, instabilities, flybys, the star's late effects).
- `src/star.js`: stellar evolution fits.
- `src/system.js`: one world, holding the stages, tools, log, readings
  and save/restore.
- `src/engine.js`: runs a world in a Web Worker built from the modules'
  factory functions, falling back to the page if workers are unavailable.
  Work runs in 14 ms slices, frames go out at most every 33 ms, and any
  error pauses the world instead of losing it. Skip is a fast-forward of
  back-to-back slices that keeps sending frames. Never block the worker
  for long.
- **The clock's pace** is set in `engine.js` (`CLOUD_RATE`, `LOG_RATE`
  per stage, `STAR_STEPS`). At ×1 the user wanted a whole system to take
  longer than ten minutes, so it now takes about half an hour, most of
  it in the disk and planet-forming stages. Check with
  `node tools/pace.js [seed]` after changing it. A collapse step can't be
  split, and early on one covers 75 years. So the engine takes a step only
  once the clock owes it, carrying any overshoot, and the view glides
  particles along their velocities in between. Forcing a step every slice
  made the early collapse run about 17 times too fast.
- `src/render.js`: canvas drawing. The disk is a smooth radial-gradient
  glow from the rings' surface density, so gaps and pebble traps show,
  with drifting particles on top.
- `src/app.js`: the page wiring. It runs no physics and talks to the
  engine only by messages.

Every module is wrapped so it works as a classic script, inside the
worker blob (via the factory's `toString()`), and in Node (`require`).
Keep that wrapper, and keep the modules free of DOM code except render
and app.

## Tests

- `node tests/soak.js --quick` after any change to the simulation (about
  a minute); the full `node tests/soak.js` before committing big ones.
  It fails on errors, NaNs, slow steps, a mass budget that doesn't close
  within 2%, or a save that doesn't restore exactly. GitHub Actions runs
  the quick soak and a build on every push.
- `node tests/ui.js [page] [shots-dir]` drives the page in headless
  Chromium at phone size. It uses every tool and view, skips through the
  stages, and checks that a reload picks the world back up. It also
  saves screenshots; look at them.

## Things that are easy to break

- **Exact restore.** Every array the disk evolves must be saved,
  including `gap` and `trap`. `Disk.restore` calls `fields(d, true)` so
  temperature and alpha aren't recomputed from a different starting
  point. If a save drifts, the soak test says so.
- **The mass budget.** Anything that removes mass must add it to a
  `totals` bucket (`Planets.lose`, wind, jets, photoevaporation, the
  sweep and flyby tools). Tools that add mass (planet, dust, and gas in
  the cloud) raise the starting mass instead. `System.budget` adds it
  all up, and the soak test checks it with every tool in use.
- **Companion stars are bodies too** (`kind: 'star'`, in `d.bodies` as
  well as `d.companions`). Rules made for planets must skip them,
  because Hill spheres, chaotic zones and embryo spacing are only valid
  for bodies much lighter than the star. Treating a companion as a
  planet once wiped out every binary's inner disk. What a companion
  allows is `Disk.truncate` (the disk's edge and the streams across the
  gap) plus the Holman–Wiegert check in `encounters`.
- **The star's late phases are brief.** `Star.stepLimit` keeps steps
  short enough not to jump over the red-giant tip, the asymptotic giant
  branch and the planetary nebula. Keep it in `Disk.maxDt`.
- **The clock.** The page's age runs from the start of the collapse. The
  disk keeps the star's own age in `d.age`, which the physics needs, and
  the star's birth time in `d.bornAt`; `clock()` in system.js adds
  them.
- **Calibration.** The defaults were tuned together so that:
  - a 1.5 M☉, 31 K, spin 0.02 cloud makes a star of about 1 M☉;
  - the gas lasts about 1.5–2 Myr;
  - giants form in some systems, not all;
  - inner systems hold rocky planets, super-Earths and ocean worlds.

  The main knobs are:
  - disk: α 1e-3, wind 1e-2 with lever arm 5, migration at 30% of
    Tanaka;
  - collapse: magnetic braking and jets;
  - growth: envelope recycling near the star, and dry grains 80% as
    tough as icy ones;
  - envelope contraction: 10¹⁰ (M/M⊕)⁻³ yr. With 10⁹, nearly every
    single star grew a giant.
  - For gap-opening planets only, the slope the Type I torque sees is
    held at ≥ −1, so a giant that drains the disk inside its orbit isn't
    pushed outward. Small planets keep the real slope, since wind-driven
    disks can slow them that way.

  Check a change against several seeds (`--seeds`), not one. Giants
  should turn up around a quarter of single Sun-like stars.
