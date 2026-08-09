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

export default function AccretionDisk() {
  const canvasRef = useRef(null);
  const bodiesRef = useRef([]);
  const pointerRef = useRef({ x: null, y: null, active: false });
  const [pointerMassOn, setPointerMassOn] = useState(false);
  const [spawningOn, setSpawningOn] = useState(true);
  const [count, setCount] = useState(0);
  const [starCount, setStarCount] = useState(0);
  const [dwarfCount, setDwarfCount] = useState(0);
  const [hottest, setHottest] = useState(0);
  const [cleared, setCleared] = useState(0);
  const [topMass, setTopMass] = useState(0);
  const [energyDrift, setEnergyDrift] = useState(0);
  const [angMomDrift, setAngMomDrift] = useState(0);
  const [trails, setTrails] = useState(true);
  const [speed, setSpeed] = useState(1);
  const trailsRef = useRef(trails);
  const pointerMassRef = useRef(pointerMassOn);
  const speedRef = useRef(speed);
  const spawningOnRef = useRef(spawningOn);

  useEffect(() => { trailsRef.current = trails; }, [trails]);
  useEffect(() => { pointerMassRef.current = pointerMassOn; }, [pointerMassOn]);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { spawningOnRef.current = spawningOn; }, [spawningOn]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    let width, height, dpr, cx, cy;

    const rockPalette = ["#7dd3fc", "#a78bfa", "#f472b6", "#fbbf24", "#34d399"];
    const DWARF_COLOR = "#b6486c";
    const G = 0.02; // scaled, not SI — see note below
    const SOFTEN = 14;
    const N = 100;

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
        tangentialFrac = 0.6 + Math.random() * 0.6;
        inwardFrac = mode === "edge" ? 0.12 : 0;
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

    const seedTotalMass = N * 3.5;
    bodiesRef.current = Array.from({ length: N }, () => spawnBody(seedTotalMass));
    setCount(N);

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
      ctx.fillStyle = trailsRef.current ? "rgba(6, 7, 16, 0.16)" : "#060710";
      ctx.fillRect(0, 0, width, height);

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
      const totalMassNow = bodies.reduce((s, b) => s + b.mass, 0);

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
          const headOn = impactParam < 0.75 * (a.r + b.r);

          // tidal disruption: when a much smaller body passes within the
          // Roche limit of a much larger one, tidal forces shred it
          // rather than letting it merge or bounce cleanly. Real formula:
          // d_Roche ≈ 2.44 R_primary (ρ_primary/ρ_secondary)^(1/3)
          const bigger = a.mass >= b.mass ? a : b;
          const smaller = a.mass >= b.mass ? b : a;
          const smallerIsI = a.mass < b.mass;
          if (bigger.mass > smaller.mass * 9) {
            const densBig = bigger.mass / (bigger.r * bigger.r * bigger.r);
            const densSmall = smaller.mass / (smaller.r * smaller.r * smaller.r);
            const rocheLimit = 2.44 * bigger.r * Math.cbrt(densBig / densSmall);
            if (dist < rocheLimit && dist > bigger.r) {
              const shredIdx = smallerIsI ? i : j;
              removed.add(shredIdx);
              // spawn at most 2 fragments (net +1 body) even though a
              // real shredding event scatters more debris than that —
              // capped so this can't be the mechanism that runs the
              // population away unbounded
              const fragCount = bodies.length + spawned.length - removed.size < MAX_BODIES ? 2 : 1;
              const fragMass = smaller.mass / fragCount;
              for (let k = 0; k < fragCount; k++) {
                const ang = Math.random() * Math.PI * 2;
                const jitter = 0.3 * Math.sqrt((G * bigger.mass) / dist);
                spawned.push({
                  x: smaller.x + Math.cos(ang) * smaller.r * 0.5,
                  y: smaller.y + Math.sin(ang) * smaller.r * 0.5,
                  vx: smaller.vx + Math.cos(ang) * jitter,
                  vy: smaller.vy + Math.sin(ang) * jitter,
                  mass: fragMass,
                  r: bodyRadius(fragMass),
                  color: smaller.color,
                });
              }
              flashes.push({ x: smaller.x, y: smaller.y, age: 0, kind: "tidal" });
              if (smallerIsI) break;
              else continue;
            }
          }

          if (relSpeed < escapeV && headOn) {
            const rawTotal = a.mass + b.mass;
            // even accreting impacts eject some debris rather than
            // retaining every bit of mass — real giant-impact simulations
            // show more ejecta the closer the impact speed runs to the
            // escape-velocity threshold (a gentle graze loses ~nothing; a
            // hit just barely slow enough to stick loses the most)
            const violence = relSpeed / escapeV;
            const lossFraction = 0.2 * violence * violence;
            const totalMass = rawTotal * (1 - lossFraction);
            const priorMax = Math.max(a.mass, b.mass);
            const justHydrogen = totalMass >= HYDROGEN_MASS && priorMax < HYDROGEN_MASS;
            const justDeuterium = !justHydrogen && totalMass >= DEUTERIUM_MASS && priorMax < DEUTERIUM_MASS;

            const merged = {
              x: (a.x * a.mass + b.x * b.mass) / rawTotal,
              y: (a.y * a.mass + b.y * b.mass) / rawTotal,
              vx: (a.vx * a.mass + b.vx * b.mass) / rawTotal,
              vy: (a.vy * a.mass + b.vy * b.mass) / rawTotal,
              mass: totalMass,
              r: bodyRadius(totalMass),
              color:
                totalMass >= HYDROGEN_MASS ? `rgb(${starRGB(totalMass).join(",")})` :
                totalMass >= DEUTERIUM_MASS ? DWARF_COLOR :
                a.mass >= b.mass ? a.color : b.color,
            };
            removed.add(i); removed.add(j);
            if (justHydrogen) { flashes.push({ x: merged.x, y: merged.y, age: 0, kind: "star" }); clearing = true; }
            else if (justDeuterium) flashes.push({ x: merged.x, y: merged.y, age: 0, kind: "dwarf" });
            spawned.push(merged);
            break;
          } else if (dist < a.r + b.r) {
            // only a genuine physical touch bounces — a fast flyby that's
            // merely within the gravitationally focused capture radius,
            // but not actually touching, should just continue past
            const nx = dx / dist, ny = dy / dist;
            const rel = relVx * nx + relVy * ny;
            if (rel < 0) {
              const impulse = (2 * rel) / (a.mass + b.mass);
              a.vx += impulse * b.mass * nx; a.vy += impulse * b.mass * ny;
              b.vx -= impulse * a.mass * nx; b.vy -= impulse * a.mass * ny;
            }
            const overlap = a.r + b.r - dist;
            a.x -= (nx * overlap) / 2; a.y -= (ny * overlap) / 2;
            b.x += (nx * overlap) / 2; b.y += (ny * overlap) / 2;
          }
        }
      }

      // a body flung past the disk edge has exceeded the system's escape
      // velocity — let it actually leave, rather than artificially
      // wrapping it back in, and replace it with a fresh comet drifting
      // in from the edge so the population doesn't just drain away
      const maxR = diskRadius() * 1.35;
      for (let i = 0; i < bodies.length; i++) {
        if (removed.has(i)) continue;
        const a = bodies[i];
        const dx = a.x - cx, dy = a.y - cy;
        if (dx * dx + dy * dy > maxR * maxR) {
          removed.add(i);
          const totalMassNow = bodies.reduce((s, b) => s + b.mass, 0);
          spawned.push(spawnBody(totalMassNow, "comet"));
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

      setCount(bodies.length);
      setStarCount(bodies.filter((b) => b.mass >= HYDROGEN_MASS).length);
      setDwarfCount(bodies.filter((b) => b.mass >= DEUTERIUM_MASS && b.mass < HYDROGEN_MASS).length);
      const maxMass = bodies.reduce((m, b) => Math.max(m, b.mass), 0);
      setHottest(coreTemp(maxMass));
      setCleared(clearProgress);
      setTopMass(maxMass);

      // conservation check: total energy and angular momentum should stay
      // roughly constant for an isolated system — this isn't a fully
      // closed system though (comets arrive, escapees leave, mergers now
      // shed some mass as ejecta), so some drift is expected from real
      // mass/momentum entering and leaving, not just integrator error.
      // Wild, sudden jumps would flag an actual bug; slow drift here is
      // mostly the system being open, not the integrator failing.
      frameCount++;
      if (frameCount % 15 === 0) {
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
          setEnergyDrift(baselineEnergy !== 0 ? ((totalEnergy - baselineEnergy) / Math.abs(baselineEnergy)) * 100 : 0);
          setAngMomDrift(baselineAngMom !== 0 ? ((AM - baselineAngMom) / Math.abs(baselineAngMom)) * 100 : 0);
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
        const span = f.kind === "star" ? 42 : f.kind === "tidal" ? 20 : 26;
        const t = f.age / span;
        if (t >= 1) { flashes.splice(i, 1); continue; }
        const rgb = f.kind === "star" ? "255,224,138" : f.kind === "tidal" ? "220,225,235" : "182,72,108";
        ctx.beginPath();
        ctx.strokeStyle = `rgba(${rgb},${1 - t})`;
        ctx.lineWidth = f.kind === "star" ? 3 : 2;
        const maxSpread = f.kind === "star" ? 62 : f.kind === "tidal" ? 18 : 30;
        ctx.arc(f.x, f.y, 5 + t * maxSpread, 0, Math.PI * 2);
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
    };
  }, []);

  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <div>
          <div style={styles.title}>Accretion Disk</div>
          <div style={styles.subtitle}>
            {count} bodies · largest {topMass.toFixed(1)} M♃ · {dwarfCount} brown dwarf{dwarfCount === 1 ? "" : "s"} ·{" "}
            {starCount} star{starCount === 1 ? "" : "s"} · hottest core ~{(hottest / 1e6).toFixed(2)}M K
            {cleared > 0 ? ` · gas ${cleared >= 1 ? "cleared" : Math.round(cleared * 100) + "% cleared"}` : ""}
            {" · "}ΔE {energyDrift.toFixed(1)}% · ΔL {angMomDrift.toFixed(1)}%
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
        </div>
      </div>
      <canvas ref={canvasRef} style={styles.canvas} />
    </div>
  );
}

const styles = {
  wrap: { width: "100%", height: "100vh", background: "#060710", display: "flex", flexDirection: "column", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", overflow: "hidden" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 18px", color: "#e7e7f4", gap: 12, flexWrap: "wrap" },
  title: { fontSize: 16, fontWeight: 700, letterSpacing: "-0.01em" },
  subtitle: { fontSize: 12, color: "#8b8ca8", marginTop: 2 },
  buttons: { display: "flex", gap: 8 },
  toggle: { border: "none", borderRadius: 999, padding: "8px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  canvas: { flex: 1, width: "100%", touchAction: "none" },
};
