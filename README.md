# Solar Nebula

A cloud of gas collapses into a star, a disk forms around it, planets
grow in the disk, and the system ages for billions of years. You can
poke it at every stage and watch what changes.

Open `index.html` in a browser. It needs no install and no build step,
and it runs on a phone. The simulation runs in a Web Worker and saves
itself to the browser every 30 seconds, so a reload picks up where you
left off.

## What happens

1. **Cloud.** A dense core of gas 3000 AU across, about 1.5 solar masses,
   slowly turning and stirred by turbulence, falls in on itself.
2. **Protostar.** The centre gets dense enough to hold itself up, and a
   protostar forms. Gas with too much spin to fall straight in starts to
   circle it. Sometimes a second clump collapses on its own and makes a
   binary.
3. **Disk.** The gas settles into a spinning disk. A magnetised wind,
   turbulence and the disk's own gravity carry gas inward onto the star,
   and jets throw some of it back out.
4. **Planets form.** Dust grows into pebbles. The pebbles drift toward
   the star, and where they crowd together they collapse into
   planetesimals. The first embryos sweep up planetesimals and pebbles.
   Heavy cores pull in gas and become giants, which cut gaps in the disk.
   Planets migrate inward and get caught in resonances.
5. **Clearing.** The star's X-rays open a hole in the disk and eat it
   away from the inside out. The gas is gone in a few million years.
6. **Giant impacts.** Without gas to keep them apart, crowded planets
   cross orbits, collide and scatter.
7. **Mature.** The survivors settle into a long, quiet main-sequence
   life.
8. **Old age.** The star swells into a giant and swallows close planets,
   and the rest drift outward as it sheds mass. In the end only a white
   dwarf is left.

## Things to fiddle with

**Tools in the cloud**
- **Stir:** drag to push the gas the way you move.
- **Pull:** hold a finger down and it pulls on the gas like a heavy star.
- **Gas:** tap to add a puff of fresh gas.
- **Blast:** tap off to one side and a supernova shock hits the cloud
  from there.

**Tools in the disk**
- **Planet:** tap to place a Moon, an Earth, a Neptune or a Jupiter.
- **Move:** drag a planet to a new orbit.
- **Sweep:** drag to clear the gas and dust out of a band.
- **Dust:** tap to scatter a ring of dust.
- **Flyby:** tap a distance, and another star passes that close.

**Settings** (Settings tab): the cloud's mass, temperature, spin,
turbulence and lumpiness, its magnetic field and metals; the disk's
turbulence, wind, grain toughness, X-rays, migration strength and
neighbourhood (alone, in a cluster, or near a massive star). Disk
settings act at once; cloud settings take effect on the next cloud.

**Views:** light, heat, and motion in the cloud; light, heat, dust and
orbits in the disk. The Profile tab charts the disk's gas, dust,
planetesimals and temperature against distance from the star.

**Skip** hurries on to the next stage, still showing it as it goes.
Tap it again to stop.

## The physics

- **Collapse:** smoothed particle hydrodynamics with Barnes–Hut
  gravity, individual block time steps (Saitoh & Makino 2009) and sink
  particles for protostars (Bate, Bonnell & Price 1995). The gas is
  isothermal while thin and stiffens once dense. It is warmed by the
  protostars' light.
- **Disk:** a one-dimensional disk solved implicitly, with:
  - viscous turbulence plus gravitational and magnetic instability;
  - wind-driven accretion (Tabone et al. 2022);
  - X-ray and external photoevaporation (Owen et al. 2012);
  - two-population dust growth and drift (Birnstiel et al. 2012);
  - the snow line;
  - planetesimal formation (Lenz et al. 2019) and the streaming
    instability.
- **Planets:** orbit-averaged, with:
  - oligarchic growth (Kokubo & Ida 2002; Ida & Lin 2004);
  - pebble accretion (Lambrechts & Johansen 2014; Ormel 2017) up to the
    pebble isolation mass (Bitsch et al. 2018);
  - gas accretion limited by the gap the planet opens (Tanigawa &
    Tanaka 2016; Kanagawa et al. 2015);
  - Type I migration (Tanaka et al. 2002), slowed in gaps;
  - resonance capture;
  - orbit-crossing instabilities (Chambers et al. 1996);
  - flybys, and binary companions.
- **Star:** fits to stellar evolution tracks, from protostar to white
  dwarf (or to a supernova for heavy stars).

Each module's header gives the details and references.

## Layout

| File | What it does |
| --- | --- |
| `index.html` | The page: layout, styles, and the script tags. |
| `src/app.js` | Wires the controls and readings to the engine. It runs no physics. |
| `src/render.js` | Draws the cloud, the disk, the star and the planets on a canvas. |
| `src/engine.js` | Runs the world against a clock in a Web Worker, in time-budgeted slices. |
| `src/system.js` | One world: its stages, tools, event log and saving. |
| `src/cloud.js` | The collapse (SPH). |
| `src/disk.js` | The gas and dust disk. |
| `src/planets.js` | Planet growth, migration and dynamics. |
| `src/star.js` | Stellar evolution. |
| `src/rng.js` | Seeded random numbers, so a seed always gives the same world. |

Every module works as a plain script on the page, inside the worker, and
under Node.

## Tests

```sh
node tests/soak.js --quick    # 2 clouds to 1 Gyr, about a minute
node tests/soak.js            # 3 clouds to 10 Gyr
node tests/ui.js              # drives the page in headless Chromium
```

The soak test runs whole systems headless. It fails on errors, broken
numbers, slow steps, a mass budget that doesn't add up, or a save that
doesn't restore exactly. The page test uses every tool and view on a
phone-sized screen and fails on any page error.

`node tools/build.mjs` writes `dist/solar-nebula.html`: the page with
its scripts inlined into one file.
