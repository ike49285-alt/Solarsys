import { useRef, useEffect, useState } from "react";

// Real constants (SI units) used to derive the core-temperature estimate below.
const G_SI = 6.674e-11; // gravitational constant, m^3 kg^-1 s^-2
const M_JUP_KG = 1.898e27; // Jupiter's mass, kg — our sim's mass unit
const R_JUP_M = 6.9911e7; // Jupiter's radius, m — our sim's radius calibration
const M_H_KG = 1.673e-27; // hydrogen atom mass, kg
const K_B = 1.381e-23; // Boltzmann constant, J/K

// Real, well-established astrophysical thresholds, in Jupiter masses:
// ~13 M_Jup is the deuterium-burning limit (the planet/brown-dwarf line);
// ~80 M_Jup (~0.08 solar masses) is the hydrogen-burning limit (the star line).
const DEUTERIUM_MASS = 13;
const HYDROGEN_MASS = 80;
const GOAL_POPULATION = 100; // target body count when spawning is on

// Stellar death thresholds. A real core-collapse supernova needs a
// progenitor above ~8 solar masses (~8,400 M_Jup) — completely out of
// reach of this sim's actual mass budget (a full disk starts around only
// ~350 M_Jup total, hard-capped at 130 bodies). Rather than fake the
// literal numbers, these are stylized thresholds in the same spirit as
// the sim's existing time compression: real ORDER preserved (only an
// unusually massive star goes supernova; only the most massive of those
// leaves a black hole instead of a neutron star), values rescaled to be
// reachable through play and to resolve within a session.
const SUPERNOVA_MASS = 220; // stylized "~8 solar mass" line
const SN_REMNANT_FRACTION = 0.15; // core collapse leaves ~10-20% of the progenitor behind, real ballpark
const WHITE_DWARF_FRACTION = 0.4; // envelope loss leaves ~40% behind as a white dwarf, real ballpark
const CHANDRASEKHAR_MASS = 95; // stylized "~1.4 solar mass" line — a white dwarf pushed past this (accretion OR merger) goes Type Ia
const TOV_MASS = 40; // stylized "~2.5 solar mass" line (Tolman-Oppenheimer-Volkoff) — the neutron-star/black-hole boundary
const STAR_BASE_LIFESPAN = 240; // seconds a star right at HYDROGEN_MASS lives before it dies

// Mass-radius relation, piecewise by real regime. Below the deuterium line,
// bodies are constant-density rock/ice (R ∝ M^(1/3)). Between deuterium and
// hydrogen ignition, real substellar objects are held up by electron
// degeneracy pressure, not thermal pressure — radius stays close to flat
// across that whole mass range rather than continuing to grow. Past
// hydrogen ignition, fusion's thermal pressure takes back over and radius
// grows with mass again (~M^0.8, roughly matching low-mass main-sequence
// stars).
const PLATEAU_R = Math.cbrt(DEUTERIUM_MASS) * 1.9;
function bodyRadius(mass) {
  if (mass < DEUTERIUM_MASS) return Math.cbrt(mass) * 1.9;
  if (mass < HYDROGEN_MASS) return PLATEAU_R;
  return PLATEAU_R * Math.pow(mass / HYDROGEN_MASS, 0.8);
}

// Compact-remnant mass-radius relations — three real, genuinely different
// laws, a nice contrast with the single law above:
//  - white dwarf: electron degeneracy pressure again, but for the WHOLE
//    object now, not just a plateau — real white dwarfs get SMALLER as
//    they get MORE massive (R ∝ M^-1/3), the opposite of everything else
//    in this sim.
//  - neutron star: neutron degeneracy pressure holds radius almost
//    perfectly flat (~10km) across the real neutron-star mass range —
//    modeled here as a genuine constant, not just a plateau.
//  - black hole: the Schwarzschild radius is exactly linear in mass
//    (R ∝ M) — no pressure holds it up at all, gravity simply wins.
const WD_RADIUS_COEFF = 7;
function whiteDwarfRadius(mass) {
  return WD_RADIUS_COEFF / Math.cbrt(mass);
}
const NEUTRON_STAR_RADIUS = 1.8;
const BH_RADIUS_COEFF = 0.12; // stylized for visibility — a real Schwarzschild radius at these masses would be far too small to render on a canvas at all
function blackHoleRadius(mass) {
  return BH_RADIUS_COEFF * mass;
}

// Main-sequence lifetime: real luminosity scales L ∝ M^3.5, so lifetime
// (fuel / burn rate) scales t ∝ M/L ∝ M^-2.5 — a star twice as massive
// lives roughly 1/6th as long, a real and important astrophysical fact.
// Calibrated so a star right at the hydrogen line lives minutes of
// sim-time, while a monster built from repeated mergers burns out in
// seconds — the same "real shape, rescaled timescale" compromise the sim
// already makes for orbital speeds.
function starLifespanSeconds(mass) {
  return STAR_BASE_LIFESPAN * Math.pow(mass / HYDROGEN_MASS, -2.5);
}

// Virial-theorem estimate of core temperature for a self-gravitating,
// constant-density sphere: T ~ (2/5) G M m_H / (k_B R), with R scaled from
// Jupiter's actual radius assuming constant density (R ∝ M^(1/3)).
// This is an order-of-magnitude estimate, not a stellar-structure solution —
// real substellar objects are held up by electron degeneracy pressure, which
// this doesn't model, so treat the number as illustrative, not exact.
const T_COEFF = (0.4 * G_SI * M_JUP_KG * M_H_KG) / (K_B * R_JUP_M);
function coreTemp(massInJupiterMasses) {
  return T_COEFF * Math.pow(massInJupiterMasses, 2 / 3);
}

// Surface temperature past ignition, from real main-sequence scaling
// relations: luminosity L ∝ M^3.5, radius R ∝ M^0.8 (matching bodyRadius
// above), and T ∝ (L/R²)^0.25 ⇒ T ∝ M^0.475. Calibrated so a star right at
// the hydrogen line reads ~3000K, matching real, dim M-dwarf stars.
function surfaceTemp(mass) {
  return 3000 * Math.pow(mass / HYDROGEN_MASS, 0.475);
}

// Standard blackbody-to-RGB approximation (valid roughly 1000K–40000K).
// This is what actually gives a star its mass-appropriate color instead
// of one fixed gold — a star just past ignition burns a dim red-orange,
// a much heavier one burns blue-white, same as real main-sequence stars.
function blackbodyRGB(kelvin) {
  const t = Math.max(1000, Math.min(40000, kelvin)) / 100;
  let r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  let g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661
                  : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  let b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return [clamp(r), clamp(g), clamp(b)];
}
function starRGB(mass) {
  return blackbodyRGB(surfaceTemp(mass));
}

// "#rrggbb" -> "r, g, b", for reusing a body's own hex color in an rgba()
// string (the density trail below needs this; ordinary bodies only ever
// carry a hex color, unlike the "r, g, b" tuples starRGB already returns).
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

export default function AccretionDisk() {
  const canvasRef = useRef(null);
  // second, much-slower-fading canvas sitting behind the main one — a
  // long-exposure record of where bodies actually spend their time
  // (orbital density), distinct from the short motion-blur trail on the
  // main canvas. Needs its own canvas because a single canvas can't fade
  // two things at two different rates independently.
  const densityCanvasRef = useRef(null);
  const bodiesRef = useRef([]);
  const pointerRef = useRef({ x: null, y: null, active: false });
  const [pointerMassOn, setPointerMassOn] = useState(false);
  const [spawningOn, setSpawningOn] = useState(true);
  const [trails, setTrails] = useState(true);
  const [speed, setSpeed] = useState(1);
  // how opaque a single density-trail mark is per body per frame — the
  // whole point is that it should barely register on one pass and only
  // read as a bright streak once a path is genuinely well-traveled, so
  // this defaults low and is user-tunable rather than fixed
  const [trailDensity, setTrailDensity] = useState(0.05);
  // All the per-frame readout numbers (population, masses, drift, ...) are
  // collapsed into one state object updated at most 10x/sec — see
  // statsRef below. They used to be 8 separate setState calls fired every
  // animation frame (~60/sec), which was the prime suspect for the mobile
  // freeze: that's up to 480 React re-renders/sec of the header for values
  // nobody can perceive changing faster than a few times a second anyway.
  const [stats, setStats] = useState({
    count: 0,
    starCount: 0,
    dwarfCount: 0,
    whiteDwarfCount: 0,
    neutronStarCount: 0,
    blackHoleCount: 0,
    hottest: 0,
    cleared: 0,
    topMass: 0,
    energyDrift: 0,
    angMomDrift: 0,
  });
  // Live values the physics loop writes to every frame without touching
  // React state. A separate low-frequency interval (below) copies this
  // into `stats` for rendering.
  const statsRef = useRef(stats);
  const trailsRef = useRef(trails);
  const pointerMassRef = useRef(pointerMassOn);
  const speedRef = useRef(speed);
  const spawningOnRef = useRef(spawningOn);
  const trailDensityRef = useRef(trailDensity);

  useEffect(() => { trailsRef.current = trails; }, [trails]);
  useEffect(() => { pointerMassRef.current = pointerMassOn; }, [pointerMassOn]);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { spawningOnRef.current = spawningOn; }, [spawningOn]);
  useEffect(() => { trailDensityRef.current = trailDensity; }, [trailDensity]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const densityCanvas = densityCanvasRef.current;
    const densityCtx = densityCanvas.getContext("2d");
    let width, height, dpr, cx, cy;

    const rockPalette = ["#7dd3fc", "#a78bfa", "#f472b6", "#fbbf24", "#34d399"];
    const DWARF_COLOR = "#b6486c";
    const G = 0.02; // scaled, not SI — see note below
    const SOFTEN = 14;
    const N = 100;

    // { span: how many frames it lives, rgb: color, spread: how far the
    // ring expands, width: line thickness } — one entry per flash kind,
    // in place of a growing chain of ternaries as new event types (below)
    // add new kinds.
    const FLASH_STYLES = {
      star: { span: 42, rgb: "255,224,138", spread: 62, width: 3 },
      dwarf: { span: 26, rgb: "182,72,108", spread: 30, width: 2 },
      tidal: { span: 20, rgb: "220,225,235", spread: 18, width: 2 },
      whiteDwarf: { span: 30, rgb: "220,225,255", spread: 22, width: 2 },
      supernova: { span: 70, rgb: "255,241,214", spread: 100, width: 4 },
      typeIa: { span: 80, rgb: "214,225,255", spread: 110, width: 4 },
      collapse: { span: 22, rgb: "200,200,220", spread: 14, width: 2 },
    };

    // NOTE ON UNITS: dynamics run in scaled sim units (screen pixels, frames)
    // so the whole thing plays out in real time on a canvas — literal SI
    // gravity over solar-system distances would take these bodies minutes
    // just to complete one orbit. What's "real" here is the shape of the
    // physics: inverse-square gravity, escape-velocity accretion, and the
    // actual mass thresholds and temperature scaling for fusion above.

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // both canvases are absolutely positioned over the same wrap div,
      // so they always share the same rendered size — reading dimensions
      // off `canvas` alone is enough for both. Resizing (like the main
      // canvas) unavoidably wipes whatever density trail had built up;
      // same forgivable limitation the existing fast trail already has.
      densityCanvas.width = width * dpr;
      densityCanvas.height = height * dpr;
      densityCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = width / 2;
      cy = height / 2;
    }
    resize();
    window.addEventListener("resize", resize);

    function diskRadius() {
      return Math.min(width, height) * 0.46;
    }

    function snowLineRadius() {
      return diskRadius() * 0.55; // past here, ices boost solid mass
    }

    function spawnBody(totalMassEstimate, mode) {
      // mode: undefined (initial disk fill), "edge" (ongoing disk
      // replenishment), or "comet" (escape replacement — a small icy
      // body plunging in on a near-radial path, not disk-formed material)
      const rMin = 24;
      const rMax = diskRadius();
      const r = mode ? rMax * (0.97 + Math.random() * 0.1) : rMin + Math.random() * (rMax - rMin);
      const angle = Math.random() * Math.PI * 2;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;

      const vCirc = Math.sqrt((G * totalMassEstimate) / r) * 0.5;
      const tx = -Math.sin(angle);
      const ty = Math.cos(angle);

      let mass, tangentialFrac, inwardFrac;
      if (mode === "comet") {
        // small icy body, highly eccentric near-radial infall — the
        // defining trait of a real comet, distinct from orderly disk
        // material on roughly circular orbits
        mass = 1 + Math.random() * 2;
        tangentialFrac = 0.15 + Math.random() * 0.2;
        inwardFrac = 0.85;
      } else {
        // surface density falls off ~r^-1.5 (minimum-mass solar nebula
        // model) — more raw material close in, which is what makes one
        // central body outgrow the rest instead of several rivals forming
        const densityFactor = Math.min(4, Math.pow(rMin / r, 1.5));
        // past the snow line, condensed ice roughly quadruples the solid
        // material available — this is what gives real systems a big
        // outer world instead of a flat gradient
        const snowBoost = r > snowLineRadius() ? 2.6 : 1;
        const baseMass = 1 + Math.random() * Math.random() * 5;
        mass = baseMass * densityFactor * snowBoost;
        if (mode === undefined) {
          // nebula collapse, thin version: the initial cloud isn't
          // already an orderly disk. A real protoplanetary disk forms
          // when a turbulent, roughly spherical collapsing cloud's
          // angular momentum flattens it (the "figure skater pulling
          // their arms in" effect). This sim has no z-axis to flatten
          // along, so the 2D stand-in is: seed genuinely turbulent
          // velocities — a wide spread, mostly but not uniformly
          // prograde, real radial motion too — instead of tidy circular
          // orbits, and let the gas-drag term below do the actual
          // circularizing over the opening several seconds. Same
          // dissipation mechanism as the real flattening, just visualized
          // as chaos-settling-into-order in-plane rather than in 3D.
          tangentialFrac = (0.3 + Math.random() * 1.4) * (Math.random() < 0.85 ? 1 : -1);
          inwardFrac = (Math.random() - 0.5) * 1.2;
        } else {
          tangentialFrac = 0.6 + Math.random() * 0.6;
          inwardFrac = mode === "edge" ? 0.12 : 0;
        }
      }

      return {
        x, y,
        vx: tx * vCirc * tangentialFrac - Math.cos(angle) * vCirc * inwardFrac,
        vy: ty * vCirc * tangentialFrac - Math.sin(angle) * vCirc * inwardFrac,
        mass,
        r: bodyRadius(mass),
        color: rockPalette[Math.floor(Math.random() * rockPalette.length)],
      };
    }

    // how many frames a freshly ejected fragment is exempt from being
    // picked as the "smaller" party in a NEW tidal disruption check —
    // belt-and-suspenders alongside the outward-ejection fix above: even
    // if some future case still drops a fragment somewhere it shouldn't
    // be, this caps how many times in a row it can happen, the same
    // "hard ceiling regardless of cause" philosophy as MAX_BODIES. Once
    // immune, the pair falls through to the ordinary merge/bounce check
    // instead, using the distance/speed already computed for it.
    const TIDAL_IMMUNITY_FRAMES = 30;

    // A small chunk of debris thrown outward from `parent` (a real body,
    // or a synthetic {x,y,vx,vy,r} standing in for a merger's combined
    // point) at `angle`/`speed` relative to it. Shared by every violent
    // event that sheds mass as fragments instead of retaining it all:
    // a white dwarf's planetary-nebula puff, core-collapse supernova
    // ejecta, and Type Ia disruption (tidal disruption spawns its own
    // fragments inline, just below, since it needs the parent's color).
    function spawnEjecta(parent, angle, speed, mass) {
      return {
        x: parent.x + Math.cos(angle) * (parent.r || 4) * 0.5,
        y: parent.y + Math.sin(angle) * (parent.r || 4) * 0.5,
        vx: parent.vx + Math.cos(angle) * speed,
        vy: parent.vy + Math.sin(angle) * speed,
        mass,
        r: bodyRadius(mass),
        color: rockPalette[Math.floor(Math.random() * rockPalette.length)],
        tidalImmuneUntil: frameCount + TIDAL_IMMUNITY_FRAMES,
      };
    }

    const seedTotalMass = N * 3.5;
    bodiesRef.current = Array.from({ length: N }, () => spawnBody(seedTotalMass));
    statsRef.current = { ...statsRef.current, count: N };
    setStats((s) => ({ ...s, count: N }));

    const flashes = [];
    let clearing = false; // starts ramping once a star first ignites
    let clearProgress = 0; // 0 = full gas drag, 1 = fully cleared
    const CLEAR_SECONDS = 6;
    let baselineEnergy = null, baselineAngMom = null;
    let frameCount = 0;
    const MAX_BODIES = 130; // hard ceiling — gravity and collisions are both
    // O(n²), so unbounded population growth (e.g. tidal disruption adding
    // more fragments than it removes) silently turns into a runaway
    // slowdown rather than a crash, which is what freezing looks like

    function computeAccelerations(bodies, pointerActive, pointerWorld) {
      const POINTER_MASS = 1400;
      for (let i = 0; i < bodies.length; i++) {
        const a = bodies[i];
        let fx = 0, fy = 0;
        for (let j = 0; j < bodies.length; j++) {
          if (i === j) continue;
          const b = bodies[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          // softening scaled to the pair's actual combined size, not a
          // flat constant — softening approximates smoothing gravity over
          // a body's own finite extent, so it should grow as a body
          // grows (a star many times its original radius) rather than
          // staying pinned to whatever was right for a tiny planetesimal
          const soft = Math.max(10, (a.r + b.r) * 0.6);
          const distSq = dx * dx + dy * dy + soft * soft;
          const dist = Math.sqrt(distSq);
          const force = (G * a.mass * b.mass) / distSq;
          fx += (dx / dist) * force;
          fy += (dy / dist) * force;
        }
        if (pointerActive) {
          const dx = pointerWorld.x - a.x, dy = pointerWorld.y - a.y;
          const distSq = dx * dx + dy * dy + SOFTEN;
          const dist = Math.sqrt(distSq);
          const force = (G * a.mass * POINTER_MASS) / distSq;
          fx += (dx / dist) * force;
          fy += (dy / dist) * force;
        }
        a.newAx = fx / a.mass;
        a.newAy = fy / a.mass;
      }
    }

    function step() {
      const dt = speedRef.current;

      // long-exposure density trail: fades far slower than the fast
      // trail below on a per-frame basis. This has to fade toward
      // TRANSPARENT (destination-out), not toward opaque black
      // (source-over) — painting translucent black doesn't just fade
      // existing marks, it also slowly opacifies every UNTOUCHED pixel
      // toward that same background color. The color ends up matching
      // either way, but the alpha climbs regardless, and once nearly the
      // whole canvas sits at similar high alpha, the actual contrast
      // between busy and empty areas is gone — everything reads as a
      // uniform wash instead of a legible density map. Confirmed via a
      // 5+ minute instrumented run: with source-over fade, average
      // brightness climbed without leveling off and then plateaued at
      // ~130/255 with 100% of the canvas over 50% opacity — the entire
      // background had opacified, not just the trails. destination-out
      // only ever removes alpha, so an untouched pixel (already at zero)
      // is completely unaffected no matter how many frames pass.
      densityCtx.globalCompositeOperation = "destination-out";
      densityCtx.fillStyle = "rgba(0, 0, 0, 0.006)";
      densityCtx.fillRect(0, 0, width, height);
      densityCtx.globalCompositeOperation = "source-over";

      // the fast trail has to fade toward TRANSPARENT, not toward opaque
      // black — this canvas sits ON TOP of the density one, and
      // repeatedly painting translucent black with the normal
      // source-over blend would, after ~30-40 frames, converge to fully
      // opaque and permanently hide the density trail underneath it.
      // destination-out shrinks existing alpha instead of mixing in more
      // black, so old pixels fade toward "reveal what's behind me."
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = trailsRef.current ? "rgba(0, 0, 0, 0.16)" : "rgba(0, 0, 0, 1)";
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = "source-over";

      let bodies = bodiesRef.current;
      const p = pointerRef.current;
      const pointerActive = pointerMassRef.current && p.active;
      // the barycenter is pinned at (cx, cy) at the end of every frame
      // (see the recenter step below), so screen and world coordinates
      // stay aligned — the pointer's screen position IS its world position
      const pointerWorld = p;
      const totalMassForKepler = bodies.reduce((s, b) => s + b.mass, 0);

      // velocity Verlet: a proper symplectic integrator, not plain Euler.
      // Same single force-evaluation cost per frame as before — it just
      // reuses last frame's acceleration for the position step, then
      // computes the new acceleration once, and averages old + new for
      // the velocity step. This keeps orbital energy from drifting over
      // long runs the way naive Euler integration does.
      for (const a of bodies) {
        if (a.ax === undefined) { a.ax = 0; a.ay = 0; }
        a.x += a.vx * dt + 0.5 * a.ax * dt * dt;
        a.y += a.vy * dt + 0.5 * a.ay * dt * dt;
      }

      computeAccelerations(bodies, pointerActive, pointerWorld);

      for (const a of bodies) {
        a.vx += 0.5 * (a.ax + a.newAx) * dt;
        a.vy += 0.5 * (a.ay + a.newAy) * dt;
        a.ax = a.newAx;
        a.ay = a.newAy;

        // gas drag relative to the local Keplerian flow, not absolute
        // velocity: real disk gas orbits too, so drag damps a body's
        // eccentricity relative to that flow rather than just bleeding
        // speed — this is what actually circularizes orbits over time.
        // Once a star ignites, its radiation and wind clear the leftover
        // gas (photoevaporation) — a real process that takes real time,
        // not one frame, so drag ramps down over CLEAR_SECONDS rather
        // than switching off instantly.
        const dragActive = 1 - clearProgress;
        if (dragActive > 0) {
          const dx = a.x - cx, dy = a.y - cy;
          const rFromCenter = Math.sqrt(dx * dx + dy * dy) || 1;
          const angle = Math.atan2(dy, dx);
          const vKepler = Math.sqrt((G * totalMassForKepler) / rFromCenter);
          const vKx = -Math.sin(angle) * vKepler;
          const vKy = Math.cos(angle) * vKepler;
          const dragCoeff = Math.min(1, (0.02 * dt) / a.r) * dragActive;
          a.vx -= (a.vx - vKx) * dragCoeff;
          a.vy -= (a.vy - vKy) * dragCoeff;
        }
      }
      if (clearing) clearProgress = Math.min(1, clearProgress + dt / (60 * CLEAR_SECONDS));

      // collisions: perfect accretion below mutual escape velocity, a
      // bounce (hit-and-run) above it — the standard first-order criterion
      // used in planetesimal accretion models
      const removed = new Set();
      const spawned = [];
      // every point where something is actually destroyed this frame
      // (shredded, merged away, absorbed, or a star at the end of its
      // life) — collected so the density trail can be locally cleared
      // faster than its normal slow fade right where each one happened,
      // separate from the flash effects (which only fire for dramatic
      // threshold crossings, not routine mergers)
      const trailWipes = [];

      for (let i = 0; i < bodies.length; i++) {
        if (removed.has(i)) continue;
        const a = bodies[i];
        for (let j = i + 1; j < bodies.length; j++) {
          if (removed.has(j)) continue;
          const b = bodies[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          const relVx = b.vx - a.vx, relVy = b.vy - a.vy;
          const relSpeed = Math.sqrt(relVx * relVx + relVy * relVy) || 0.0001;
          const escapeV = Math.sqrt((2 * G * (a.mass + b.mass)) / (a.r + b.r));

          // gravitational focusing: a real effect where a body's own
          // gravity bends nearby paths inward, giving it a bigger capture
          // radius than its physical size — pronounced for slow, close
          // encounters, which is exactly what lets a growing planet start
          // sweeping its orbit clean rather than just occasionally
          // bumping into things it directly touches
          const focusFactor = Math.min(3, Math.sqrt(1 + (escapeV * escapeV) / (relSpeed * relSpeed)));
          const captureRadius = (a.r + b.r) * focusFactor;
          if (dist >= captureRadius) continue;

          // impact parameter: the perpendicular offset between the two
          // bodies' closing paths, using the standard cross-product form.
          // A near-zero value means a head-on hit; a value close to the
          // combined radius means a graze. Real accretion outcomes depend
          // on this as much as on closing speed (Leinhardt & Stewart
          // 2012) — a slow but very grazing pass often "hit-and-runs"
          // rather than sticking, which a speed-only criterion misses.
          const impactParam = Math.abs(dx * relVy - dy * relVx) / relSpeed;
          // The 0.75x threshold above assumes a real flyby with kinetic
          // energy behind it. It doesn't account for a pair that's decayed
          // into a near-circular mutual orbit sitting right at contact
          // distance — that orbit's closing velocity at contact is always
          // almost purely tangential, so impactParam sits near its own
          // geometric ceiling (~dist, ~= a.r+b.r) forever regardless of how
          // slow or damped the encounter gets. No amount of speed loss can
          // ever satisfy a fixed 0.75x test in that shape, which without
          // this widening let two bodies get stuck bouncing off each other
          // every frame for dozens of seconds straight (confirmed via
          // instrumented test run — see PR). So: the less kinetic budget an
          // approach has left relative to escape velocity, the less able it
          // realistically is to graze past rather than get captured — widen
          // the threshold toward (and just past) the full combined radius
          // as relSpeed -> 0, while leaving genuine energetic flybys at
          // their original 0.75x test.
          const grazeThreshold = 0.75 + 0.3 * Math.max(0, 1 - relSpeed / escapeV);
          const headOn = impactParam < grazeThreshold * (a.r + b.r);

          // tidal disruption: when a much smaller body passes within the
          // Roche limit of a much larger one, tidal forces shred it
          // rather than letting it merge or bounce cleanly. Real formula:
          // d_Roche ≈ 2.44 R_primary (ρ_primary/ρ_secondary)^(1/3)
          const bigger = a.mass >= b.mass ? a : b;
          const smaller = a.mass >= b.mass ? b : a;
          const smallerIsI = a.mass < b.mass;
          // a body still on its post-ejection immunity window skips
          // straight past tidal disruption for this pair and falls
          // through to the ordinary merge/bounce check below instead —
          // see TIDAL_IMMUNITY_FRAMES above
          const tidalEligible = !(smaller.tidalImmuneUntil > frameCount);
          if (tidalEligible && bigger.mass > smaller.mass * 9) {
            const densBig = bigger.mass / (bigger.r * bigger.r * bigger.r);
            const densSmall = smaller.mass / (smaller.r * smaller.r * smaller.r);
            const rocheLimit = 2.44 * bigger.r * Math.cbrt(densBig / densSmall);
            if (dist < rocheLimit && dist > bigger.r) {
              const shredIdx = smallerIsI ? i : j;
              removed.add(shredIdx);
              trailWipes.push({ x: smaller.x, y: smaller.y, r: smaller.r });
              // spawn at most 2 fragments (net +1 body) even though a
              // real shredding event scatters more debris than that —
              // capped so this can't be the mechanism that runs the
              // population away unbounded
              const fragCount = bodies.length + spawned.length - removed.size < MAX_BODIES ? 2 : 1;
              const fragMass = smaller.mass / fragCount;
              // real tidal streams are elongated radially away from (and
              // toward) the disruptor, not scattered in every direction —
              // and it matters here for more than realism: a fully random
              // ejection angle could kick a fragment sideways or back
              // toward the primary, leaving it inside the same Roche zone
              // it was just shredded in, which re-triggers this exact
              // event again the very next frame. Confirmed via an
              // instrumented run: this was firing ~46,000 times in 2
              // minutes on a single pair, reading as one small rock that
              // "can't be absorbed," constantly flashing. Aiming outward
              // with a real escape-scale kick (not a token nudge) gives a
              // fragment an actual chance to clear the zone instead of
              // re-entering it.
              const outwardAngle = Math.atan2(smaller.y - bigger.y, smaller.x - bigger.x);
              for (let k = 0; k < fragCount; k++) {
                const ang = outwardAngle + (Math.random() - 0.5) * 1.4;
                const jitter = 0.9 * Math.sqrt((2 * G * bigger.mass) / dist);
                spawned.push({
                  x: smaller.x + Math.cos(ang) * smaller.r * 0.5,
                  y: smaller.y + Math.sin(ang) * smaller.r * 0.5,
                  vx: smaller.vx + Math.cos(ang) * jitter,
                  vy: smaller.vy + Math.sin(ang) * jitter,
                  mass: fragMass,
                  r: bodyRadius(fragMass),
                  color: smaller.color,
                  tidalImmuneUntil: frameCount + TIDAL_IMMUNITY_FRAMES,
                });
              }
              flashes.push({ x: smaller.x, y: smaller.y, age: 0, kind: "tidal" });
              if (smallerIsI) break;
              else continue;
            }
          }

          // Stars and black holes have no rigid surface to bounce off
          // of — the headOn/escape-velocity hit-and-run model above is
          // built for two solid bodies grazing past each other, which
          // isn't physically meaningful for a body that actually reaches
          // a star's photosphere or a black hole's event horizon. Real
          // sun-grazing comets that touch the photosphere are vaporized,
          // not deflected; nothing that touches an event horizon escapes
          // it, elastically or otherwise (tidal disruption, above,
          // already covers the "torn apart before contact" case at
          // greater range — this is what happens once contact is real).
          // So any physical touch against an already-ignited star or a
          // black hole is absorbed unconditionally, bypassing the
          // geometry/speed nuance that's appropriate for rock-on-rock.
          const absorptive = bigger.remnant === "blackHole" || bigger.mass >= HYDROGEN_MASS;
          const forcedAbsorb = absorptive && dist < a.r + b.r;

          if ((relSpeed < escapeV && headOn) || forcedAbsorb) {
            const rawTotal = a.mass + b.mass;
            // even accreting impacts eject some debris rather than
            // retaining every bit of mass — real giant-impact simulations
            // show more ejecta the closer the impact speed runs to the
            // escape-velocity threshold (a gentle graze loses ~nothing; a
            // hit just barely slow enough to stick loses the most).
            // Forced absorption skips this entirely: an event horizon
            // keeps everything that crosses it, and a full swallow into
            // a star's photosphere isn't a grazing impact either — both
            // are complete, lossless captures.
            const violence = relSpeed / escapeV;
            const lossFraction = forcedAbsorb ? 0 : 0.2 * violence * violence;
            const totalMass = rawTotal * (1 - lossFraction);
            const mx = (a.x * a.mass + b.x * b.mass) / rawTotal;
            const my = (a.y * a.mass + b.y * b.mass) / rawTotal;
            const mvx = (a.vx * a.mass + b.vx * b.mass) / rawTotal;
            const mvy = (a.vy * a.mass + b.vy * b.mass) / rawTotal;
            removed.add(i); removed.add(j);
            trailWipes.push({ x: a.x, y: a.y, r: a.r }, { x: b.x, y: b.y, r: b.r });

            // if either party is already a compact remnant, its fate
            // isn't decided by the ordinary planetesimal mass-radius
            // relation anymore — it's decided by the SAME thresholds a
            // remnant is born under (see the stellar-death pass below),
            // just re-applied to the merged mass. A neutron star or black
            // hole merger is real astrophysics too — it's exactly what
            // LIGO's gravitational-wave detections are.
            // TOV_MASS is the neutron-degenerate ceiling and only means
            // anything once a neutron star (or black hole) is actually
            // involved — it must NOT gate a pure white-dwarf merger, whose
            // own, much-lower electron-degenerate ceiling is
            // CHANDRASEKHAR_MASS, checked separately below. Confirmed via
            // an instrumented test run that getting this gating wrong
            // makes ordinary white-dwarf mergers misclassify as black
            // holes, and the mislabeling then cascades through later,
            // unrelated mergers touching that same body.
            const eitherIsNS = a.remnant === "neutronStar" || b.remnant === "neutronStar";
            const eitherIsBH = a.remnant === "blackHole" || b.remnant === "blackHole";
            const remnantType = eitherIsBH || eitherIsNS ? (eitherIsBH || totalMass > TOV_MASS ? "blackHole" : "neutronStar")
              : (a.remnant || b.remnant) ? "whiteDwarf" // only remnant left is whiteDwarf
              : null;

            if (remnantType === "whiteDwarf" && totalMass > CHANDRASEKHAR_MASS) {
              // Type Ia supernova: a white dwarf pushed over the
              // Chandrasekhar-equivalent limit — whether by merging with
              // another white dwarf (double-degenerate) or by consuming
              // enough ordinary matter (single-degenerate, the real
              // mechanism this instant full-merger case stands in for) —
              // detonates completely. Unlike core collapse, there's no
              // compact remnant left behind at all.
              const blastCenter = { x: mx, y: my, vx: mvx, vy: mvy, r: Math.max(a.r, b.r) };
              const fragCount = bodies.length + spawned.length - removed.size < MAX_BODIES - 6 ? 8 : 3;
              for (let k = 0; k < fragCount; k++) {
                const ang = Math.random() * Math.PI * 2;
                const blast = 1.4 * Math.sqrt((G * totalMass) / blastCenter.r);
                spawned.push(spawnEjecta(blastCenter, ang, blast, totalMass / fragCount));
              }
              flashes.push({ x: mx, y: my, age: 0, kind: "typeIa" });
            } else if (remnantType) {
              const wasAlreadyThatType = a.remnant === remnantType || b.remnant === remnantType;
              spawned.push({
                x: mx, y: my, vx: mvx, vy: mvy,
                mass: totalMass,
                r: remnantType === "blackHole" ? blackHoleRadius(totalMass)
                   : remnantType === "neutronStar" ? NEUTRON_STAR_RADIUS
                   : whiteDwarfRadius(totalMass),
                remnant: remnantType,
                color: remnantType === "blackHole" ? "#000000" : remnantType === "neutronStar" ? "#eafcff" : "#eef2ff",
              });
              // only flash on an actual collapse to a NEW, denser type —
              // not on an ordinary same-type remnant just gaining mass
              if (!wasAlreadyThatType) flashes.push({ x: mx, y: my, age: 0, kind: "collapse" });
            } else {
              const priorMax = Math.max(a.mass, b.mass);
              const justHydrogen = totalMass >= HYDROGEN_MASS && priorMax < HYDROGEN_MASS;
              const justDeuterium = !justHydrogen && totalMass >= DEUTERIUM_MASS && priorMax < DEUTERIUM_MASS;
              const merged = {
                x: mx, y: my, vx: mvx, vy: mvy,
                mass: totalMass,
                r: bodyRadius(totalMass),
                color:
                  totalMass >= HYDROGEN_MASS ? `rgb(${starRGB(totalMass).join(",")})` :
                  totalMass >= DEUTERIUM_MASS ? DWARF_COLOR :
                  a.mass >= b.mass ? a.color : b.color,
                // a star's age carries over from whichever parent was
                // already burning (an ordinary merger just adds fuel to
                // an existing star); a brand-new ignition starts at 0
                age: totalMass >= HYDROGEN_MASS
                  ? (justHydrogen ? 0 : (a.mass >= HYDROGEN_MASS ? a.age : b.mass >= HYDROGEN_MASS ? b.age : 0) || 0)
                  : undefined,
              };
              if (justHydrogen) { flashes.push({ x: merged.x, y: merged.y, age: 0, kind: "star" }); clearing = true; }
              else if (justDeuterium) flashes.push({ x: merged.x, y: merged.y, age: 0, kind: "dwarf" });
              spawned.push(merged);
            }
            break;
          } else if (dist < a.r + b.r) {
            // only a genuine physical touch bounces — a fast flyby that's
            // merely within the gravitationally focused capture radius,
            // but not actually touching, should just continue past
            const nx = dx / dist, ny = dy / dist;
            const rel = relVx * nx + relVy * ny;
            if (rel < 0) {
              // restitution < 1: a touch this close is realistically
              // dissipative (surface friction, debris, deformation), so
              // bleed a little relative speed on every bounce rather than
              // reflecting it perfectly. On its own this only shrinks a
              // locked orbit's radial wobble — it's the widened grazeThreshold
              // above that actually lets a decayed, near-circular contact
              // qualify as headOn and merge; this just makes that decay
              // happen faster and keeps a normal energetic bounce from
              // being perfectly, unrealistically elastic.
              const restitution = 0.85;
              const impulse = ((1 + restitution) * rel) / (a.mass + b.mass);
              a.vx += impulse * b.mass * nx; a.vy += impulse * b.mass * ny;
              b.vx -= impulse * a.mass * nx; b.vy -= impulse * a.mass * ny;
            }
            const overlap = a.r + b.r - dist;
            a.x -= (nx * overlap) / 2; a.y -= (ny * overlap) / 2;
            b.x += (nx * overlap) / 2; b.y += (ny * overlap) / 2;
          }
        }
      }

      // stellar death: once a star's accumulated `age` exceeds its scaled
      // main-sequence lifespan (starLifespanSeconds — real L ∝ M^3.5 ⇒
      // lifespan ∝ M^-2.5), it ends. Below SUPERNOVA_MASS: a quiet white
      // dwarf, envelope shed as a slow "planetary nebula" puff. At or
      // above it: a real core-collapse supernova, most of the mass blown
      // out violently, and a remnant left behind whose fate — neutron
      // star or black hole — is decided by whether ITS OWN mass clears
      // TOV_MASS, mirroring the real threshold exactly.
      for (let i = 0; i < bodies.length; i++) {
        if (removed.has(i)) continue;
        const a = bodies[i];
        if (a.remnant || a.mass < HYDROGEN_MASS) continue;
        a.age = (a.age || 0) + dt / 60;
        if (a.age < starLifespanSeconds(a.mass)) continue;

        removed.add(i);
        trailWipes.push({ x: a.x, y: a.y, r: a.r });
        if (a.mass < SUPERNOVA_MASS) {
          const remnantMass = a.mass * WHITE_DWARF_FRACTION;
          spawned.push({
            x: a.x, y: a.y, vx: a.vx, vy: a.vy,
            mass: remnantMass,
            r: whiteDwarfRadius(remnantMass),
            remnant: "whiteDwarf",
            color: "#eef2ff",
          });
          const puffMass = (a.mass - remnantMass) / 3;
          for (let k = 0; k < 3; k++) {
            const ang = Math.random() * Math.PI * 2;
            const puffSpeed = 0.2 * Math.sqrt((G * a.mass) / a.r);
            spawned.push(spawnEjecta(a, ang, puffSpeed, puffMass));
          }
          flashes.push({ x: a.x, y: a.y, age: 0, kind: "whiteDwarf" });
        } else {
          const remnantMass = a.mass * SN_REMNANT_FRACTION;
          const isBlackHole = remnantMass > TOV_MASS;
          spawned.push({
            x: a.x, y: a.y, vx: a.vx, vy: a.vy,
            mass: remnantMass,
            r: isBlackHole ? blackHoleRadius(remnantMass) : NEUTRON_STAR_RADIUS,
            remnant: isBlackHole ? "blackHole" : "neutronStar",
            color: isBlackHole ? "#000000" : "#eafcff",
          });
          const ejectaMass = a.mass - remnantMass;
          const fragCount = bodies.length + spawned.length - removed.size < MAX_BODIES - 8 ? 8 : 3;
          for (let k = 0; k < fragCount; k++) {
            const ang = Math.random() * Math.PI * 2;
            const blast = 1.3 * Math.sqrt((G * a.mass) / a.r);
            spawned.push(spawnEjecta(a, ang, blast, ejectaMass / fragCount));
          }
          flashes.push({ x: a.x, y: a.y, age: 0, kind: "supernova" });
        }
      }

      // a destroyed body's OWN slice of the density trail clears fast
      // here, rather than lingering at the same slow decay as an
      // actively-orbiting path — the trail is a record of where
      // something has been, and once it's gone that record shouldn't
      // keep reading as "this is still a busy lane." Only the area right
      // at the destruction site clears (there's no history of the
      // body's full path kept to erase, just where it currently was),
      // but that's exactly where a merge/shred/absorb's own flash draws
      // the eye anyway, so the two effects read as one event.
      for (const w of trailWipes) {
        densityCtx.globalCompositeOperation = "destination-out";
        densityCtx.fillStyle = "rgba(0, 0, 0, 0.5)";
        densityCtx.beginPath();
        densityCtx.arc(w.x, w.y, Math.max(6, w.r * 3), 0, Math.PI * 2);
        densityCtx.fill();
        densityCtx.globalCompositeOperation = "source-over";
      }

      // a body flung past the disk edge has exceeded the system's escape
      // velocity. This used to remove it and spawn a fresh comet in its
      // place — but yanking a body's mass out of the system entirely,
      // discontinuously, jerks the barycenter (recomputed every frame,
      // below) hard enough to visibly destabilize the whole rendered
      // system when it happens to a large body. A reflecting boundary —
      // a standard technique in bounded-volume N-body simulations —
      // fixes this by construction: mass and momentum are conserved
      // exactly, so there's no discontinuity for the barycenter to react
      // to at all, regardless of how big the body is.
      const maxR = diskRadius() * 1.35;
      for (let i = 0; i < bodies.length; i++) {
        if (removed.has(i)) continue;
        const a = bodies[i];
        const dx = a.x - cx, dy = a.y - cy;
        const distSq = dx * dx + dy * dy;
        if (distSq > maxR * maxR) {
          const dist = Math.sqrt(distSq);
          const nx = dx / dist, ny = dy / dist;
          const vRadial = a.vx * nx + a.vy * ny;
          if (vRadial > 0) {
            // reflect only the outward-moving component (standard wall-
            // bounce formula), leaving the tangential component alone —
            // a slight restitution (<1) bleeds a little energy so a body
            // settles toward a contained orbit instead of bouncing at
            // the boundary at the exact same amplitude forever
            const restitution = 0.9;
            a.vx -= (1 + restitution) * vRadial * nx;
            a.vy -= (1 + restitution) * vRadial * ny;
          }
          // clamp position to the boundary itself, rather than leaving it
          // rendered outside the system for the one frame this triggers
          a.x = cx + nx * maxR;
          a.y = cy + ny * maxR;
        }
      }

      if (removed.size > 0) {
        bodies = bodies.filter((_, idx) => !removed.has(idx)).concat(spawned);
        bodiesRef.current = bodies;
      }
      // hard safety net: trim the smallest bodies if anything ever pushes
      // the population past the ceiling, regardless of which mechanism
      // caused it — this is what actually prevents freezing
      if (bodies.length > MAX_BODIES) {
        bodies = bodies.slice().sort((x, y) => y.mass - x.mass).slice(0, MAX_BODIES);
        bodiesRef.current = bodies;
      }

      // single pass instead of two .filter().length calls plus a
      // .reduce() — same result, three fewer array allocations per frame
      let starCountNow = 0, dwarfCountNow = 0, maxMass = 0;
      let whiteDwarfCountNow = 0, neutronStarCountNow = 0, blackHoleCountNow = 0;
      for (const b of bodies) {
        if (b.remnant === "whiteDwarf") whiteDwarfCountNow++;
        else if (b.remnant === "neutronStar") neutronStarCountNow++;
        else if (b.remnant === "blackHole") blackHoleCountNow++;
        else if (b.mass >= HYDROGEN_MASS) starCountNow++;
        else if (b.mass >= DEUTERIUM_MASS) dwarfCountNow++;
        if (b.mass > maxMass) maxMass = b.mass;
      }
      // write-only: no setState here, so this doesn't trigger a re-render.
      // A low-frequency interval (below) copies these into `stats`.
      const liveStats = statsRef.current;
      liveStats.count = bodies.length;
      liveStats.starCount = starCountNow;
      liveStats.dwarfCount = dwarfCountNow;
      liveStats.whiteDwarfCount = whiteDwarfCountNow;
      liveStats.neutronStarCount = neutronStarCountNow;
      liveStats.blackHoleCount = blackHoleCountNow;
      liveStats.hottest = coreTemp(maxMass);
      liveStats.cleared = clearProgress;
      liveStats.topMass = maxMass;

      // conservation check: total energy and angular momentum should stay
      // roughly constant for an isolated system — this isn't a fully
      // closed system though (comets arrive, escapees leave, mergers now
      // shed some mass as ejecta), so some drift is expected from real
      // mass/momentum entering and leaving, not just integrator error.
      // Wild, sudden jumps would flag an actual bug; slow drift here is
      // mostly the system being open, not the integrator failing.
      // Baseline is captured after ~5s, not immediately — the nebula's
      // turbulent opening seconds are SUPPOSED to bleed a lot of kinetic
      // energy via gas drag as they settle into a disk (that's the actual
      // mechanism this sim's 2D nebula-collapse stand-in relies on), so
      // measuring from frame 1 would read as ~90% "drift" that's really
      // just the intended settling, not an integrator problem.
      frameCount++;
      if (frameCount > 300 && frameCount % 15 === 0) {
        let KE = 0, PE = 0, AM = 0;
        for (const b of bodies) {
          KE += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy);
          AM += b.mass * ((b.x - cx) * b.vy - (b.y - cy) * b.vx);
        }
        for (let i = 0; i < bodies.length; i++) {
          for (let j = i + 1; j < bodies.length; j++) {
            const bi = bodies[i], bj = bodies[j];
            const dx = bj.x - bi.x, dy = bj.y - bi.y;
            const soft = Math.max(10, (bi.r + bj.r) * 0.6);
            PE -= (G * bi.mass * bj.mass) / Math.sqrt(dx * dx + dy * dy + soft * soft);
          }
        }
        const totalEnergy = KE + PE;
        if (baselineEnergy === null) { baselineEnergy = totalEnergy; baselineAngMom = AM; }
        else {
          statsRef.current.energyDrift = baselineEnergy !== 0 ? ((totalEnergy - baselineEnergy) / Math.abs(baselineEnergy)) * 100 : 0;
          statsRef.current.angMomDrift = baselineAngMom !== 0 ? ((AM - baselineAngMom) / Math.abs(baselineAngMom)) * 100 : 0;
        }
      }

      // recenter the whole system on its barycenter (mass-weighted center),
      // not any single body. This is a pure translation — every body
      // shifts by the same amount, so all relative distances (and
      // therefore all forces) are completely unaffected. The barycenter
      // is the right choice here, rather than pinning on whoever's
      // heaviest: it's the system's true inertial rest frame (by
      // conservation of momentum it doesn't accelerate on its own), so it
      // doesn't jump around when mass leadership changes hands, and it
      // won't drift the way a fixed arbitrary point would.
      const totalSystemMass = bodies.reduce((s, b) => s + b.mass, 0);
      let comX = 0, comY = 0;
      for (const b of bodies) { comX += b.x * b.mass; comY += b.y * b.mass; }
      comX /= totalSystemMass; comY /= totalSystemMass;
      const shiftX = cx - comX, shiftY = cy - comY;
      for (const a of bodies) { a.x += shiftX; a.y += shiftY; }
      for (const f of flashes) { f.x += shiftX; f.y += shiftY; }

      for (const a of bodies) {
        const sx = a.x, sy = a.y;

        // second trail, on the density canvas: a low-alpha mark per body
        // per frame. A single pass barely registers; a body that keeps
        // returning to the same stretch of orbit (or a slow one that
        // lingers) builds up a visibly brighter streak — path density,
        // not just current motion, and colored by what's actually been
        // passing through, not a flat heatmap tint.
        const densityColor =
          a.remnant === "blackHole" ? "255, 235, 200" :
          a.remnant === "neutronStar" ? "220, 245, 255" :
          a.remnant === "whiteDwarf" ? "238, 242, 255" :
          a.mass >= HYDROGEN_MASS ? starRGB(a.mass).join(", ") :
          a.mass >= DEUTERIUM_MASS ? "182, 72, 108" :
          hexToRgb(a.color);
        densityCtx.beginPath();
        densityCtx.fillStyle = `rgba(${densityColor}, ${trailDensityRef.current})`;
        densityCtx.arc(sx, sy, Math.max(1, a.r * 0.7), 0, Math.PI * 2);
        densityCtx.fill();

        ctx.globalAlpha = 1; // reset every body: a remnant draw below doesn't set 0.92 like the normal path does, and alpha otherwise leaks across iterations
        if (a.remnant === "blackHole") {
          // absorbs light rather than emitting it — the opposite of every
          // other glow here — with a thin bright photon-ring rim, the
          // cheapest real nod to what the Event Horizon Telescope
          // actually imaged around a real black hole
          ctx.beginPath();
          ctx.fillStyle = "#000000";
          ctx.arc(sx, sy, a.r, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.strokeStyle = "rgba(255, 235, 200, 0.85)";
          ctx.lineWidth = Math.max(1, a.r * 0.15);
          ctx.arc(sx, sy, a.r, 0, Math.PI * 2);
          ctx.stroke();
          continue;
        }
        if (a.remnant === "neutronStar") {
          // pulsar flavor: real neutron stars are DISCOVERED by this
          // exact periodic brightness sweep, not just decorated with one.
          // Phase offset by position so multiple neutron stars don't all
          // pulse in lockstep.
          const pulse = 0.5 + 0.5 * Math.sin(frameCount * 0.35 + sx);
          const glowR = a.r * 6;
          const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowR);
          glow.addColorStop(0, `rgba(220, 245, 255, ${0.55 * pulse})`);
          glow.addColorStop(1, "rgba(220, 245, 255, 0)");
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(sx, sy, glowR, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.fillStyle = "#eafcff";
          ctx.arc(sx, sy, a.r, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        if (a.remnant === "whiteDwarf") {
          const glowR = a.r * 3;
          const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowR);
          glow.addColorStop(0, "rgba(238, 242, 255, 0.4)");
          glow.addColorStop(1, "rgba(238, 242, 255, 0)");
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(sx, sy, glowR, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.fillStyle = "#eef2ff";
          ctx.arc(sx, sy, a.r, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        if (a.mass >= DEUTERIUM_MASS) {
          const isStar = a.mass >= HYDROGEN_MASS;
          const glowColor = isStar ? starRGB(a.mass).join(", ") : "182, 72, 108";
          const glowR = a.r * (isStar ? 4 : 2.6);
          const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowR);
          glow.addColorStop(0, `rgba(${glowColor}, ${isStar ? 0.5 : 0.35})`);
          glow.addColorStop(1, `rgba(${glowColor}, 0)`);
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(sx, sy, glowR, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.fillStyle = a.mass >= HYDROGEN_MASS ? `rgb(${starRGB(a.mass).join(",")})` : a.color;
        ctx.globalAlpha = 0.92;
        ctx.arc(sx, sy, a.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      for (let i = flashes.length - 1; i >= 0; i--) {
        const f = flashes[i];
        f.age += 1;
        const style = FLASH_STYLES[f.kind] || FLASH_STYLES.dwarf;
        const t = f.age / style.span;
        if (t >= 1) { flashes.splice(i, 1); continue; }
        ctx.beginPath();
        ctx.strokeStyle = `rgba(${style.rgb},${1 - t})`;
        ctx.lineWidth = style.width;
        ctx.arc(f.x, f.y, 5 + t * style.spread, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (pointerActive) {
        ctx.beginPath();
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 1.5;
        ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
        ctx.stroke();
      }

      animRef.current = requestAnimationFrame(step);
    }

    const animRef = { current: null };
    animRef.current = requestAnimationFrame(step);

    // every real second, if spawning is on, split the difference between
    // the current population and the goal — e.g. at 70 vs a goal of 100,
    // spawn 15, not all 30 at once, so growth eases in rather than jumping
    const spawnInterval = setInterval(() => {
      if (!spawningOnRef.current) return;
      const bodies = bodiesRef.current;
      const diff = Math.min(GOAL_POPULATION, MAX_BODIES) - bodies.length;
      if (diff <= 0) return;
      const toSpawn = Math.ceil(diff / 2);
      const totalMassNow = bodies.reduce((s, b) => s + b.mass, 0);
      const additions = Array.from({ length: toSpawn }, () => spawnBody(totalMassNow, "edge"));
      bodiesRef.current = bodies.concat(additions);
    }, 1000);

    // decoupled from the animation loop on purpose: this is the only place
    // the readout numbers actually reach React state, at 10/sec instead of
    // ~60/sec. Nobody can read a number changing faster than this anyway,
    // and it turns ~60 header re-renders/sec into ~10.
    const statsPushInterval = setInterval(() => {
      setStats({ ...statsRef.current });
    }, 100);

    function setPointer(x, y, active) {
      const rect = canvas.getBoundingClientRect();
      pointerRef.current = { x: x - rect.left, y: y - rect.top, active };
    }
    function onMove(e) { setPointer(e.clientX, e.clientY, true); }
    function onLeave() { pointerRef.current.active = false; }
    function onTouchMove(e) {
      if (e.touches[0]) setPointer(e.touches[0].clientX, e.touches[0].clientY, true);
      e.preventDefault();
    }
    function onTouchEnd() { pointerRef.current.active = false; }

    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd);
    canvas.addEventListener("touchstart", onTouchMove, { passive: false });

    return () => {
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("touchstart", onTouchMove);
      cancelAnimationFrame(animRef.current);
      clearInterval(spawnInterval);
      clearInterval(statsPushInterval);
    };
  }, []);

  // remnants only show up in the readout once they exist — same pattern
  // as "gas cleared" below, no point cluttering the header with "0 white
  // dwarfs" before the sim's first star has even died
  const remnantParts = [
    stats.whiteDwarfCount > 0 ? `${stats.whiteDwarfCount} white dwarf${stats.whiteDwarfCount === 1 ? "" : "s"}` : null,
    stats.neutronStarCount > 0 ? `${stats.neutronStarCount} neutron star${stats.neutronStarCount === 1 ? "" : "s"}` : null,
    stats.blackHoleCount > 0 ? `${stats.blackHoleCount} black hole${stats.blackHoleCount === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <div>
          <div style={styles.title}>Accretion Disk</div>
          <div style={styles.subtitle}>
            {stats.count} bodies · largest {stats.topMass.toFixed(1)} M♃ · {stats.dwarfCount} brown dwarf{stats.dwarfCount === 1 ? "" : "s"} ·{" "}
            {stats.starCount} star{stats.starCount === 1 ? "" : "s"} · hottest core ~{(stats.hottest / 1e6).toFixed(2)}M K
            {stats.cleared > 0 ? ` · gas ${stats.cleared >= 1 ? "cleared" : Math.round(stats.cleared * 100) + "% cleared"}` : ""}
            {remnantParts ? ` · ${remnantParts}` : ""}
            {" · "}ΔE {stats.energyDrift.toFixed(1)}% · ΔL {stats.angMomDrift.toFixed(1)}%
          </div>
        </div>
        <div style={styles.buttons}>
          <button
            style={{ ...styles.toggle, background: spawningOn ? "#7dd3fc" : "#2a2b3d", color: spawningOn ? "#0a0a14" : "#8b8ca8" }}
            onClick={() => setSpawningOn((v) => !v)}
          >
            {spawningOn ? "Spawning on" : "Spawning off"}
          </button>
          <button
            style={{ ...styles.toggle, background: pointerMassOn ? "#a78bfa" : "#2a2b3d", color: pointerMassOn ? "#0a0a14" : "#8b8ca8" }}
            onClick={() => setPointerMassOn((v) => !v)}
          >
            {pointerMassOn ? "Cursor gravity on" : "Cursor gravity off"}
          </button>
          <button
            style={{ ...styles.toggle, background: trails ? "#34d399" : "#2a2b3d", color: trails ? "#0a0a14" : "#8b8ca8" }}
            onClick={() => setTrails((v) => !v)}
          >
            {trails ? "Trails on" : "Trails off"}
          </button>
          <button
            style={{ ...styles.toggle, background: "#2a2b3d", color: "#8b8ca8" }}
            onClick={() => setSpeed((s) => (s >= 2 ? 0.5 : s + 0.5))}
          >
            Speed {speed}x
          </button>
          <label style={styles.slider}>
            Density {Math.round(trailDensity * 100)}%
            <input
              type="range"
              min="0.01"
              max="0.2"
              step="0.01"
              value={trailDensity}
              onChange={(e) => setTrailDensity(Number(e.target.value))}
              style={styles.sliderInput}
            />
          </label>
        </div>
      </div>
      <div style={styles.canvasWrap}>
        <canvas ref={densityCanvasRef} style={{ ...styles.canvasLayer, pointerEvents: "none" }} />
        <canvas ref={canvasRef} style={{ ...styles.canvasLayer, touchAction: "none" }} />
      </div>
    </div>
  );
}

const styles = {
  wrap: { width: "100%", height: "100vh", background: "#060710", display: "flex", flexDirection: "column", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", overflow: "hidden" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 18px", color: "#e7e7f4", gap: 12, flexWrap: "wrap" },
  title: { fontSize: 16, fontWeight: 700, letterSpacing: "-0.01em" },
  subtitle: { fontSize: 12, color: "#8b8ca8", marginTop: 2 },
  buttons: { display: "flex", gap: 8, flexWrap: "wrap" },
  toggle: { border: "none", borderRadius: 999, padding: "8px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  slider: { display: "flex", alignItems: "center", gap: 8, background: "#2a2b3d", color: "#8b8ca8", borderRadius: 999, padding: "8px 14px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" },
  sliderInput: { width: 70, accentColor: "#7dd3fc", cursor: "pointer" },
  canvasWrap: { flex: 1, width: "100%", position: "relative" },
  canvasLayer: { position: "absolute", top: 0, left: 0, width: "100%", height: "100%" },
};
