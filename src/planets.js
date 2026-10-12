// Planets, from the first embryos in a field of planetesimals to a finished
// system, followed orbit-averaged: each body has a semi-major axis, an
// eccentricity and a mass made of rock, ice and gas, and those change by
// rates rather than orbit by orbit.
//
//  - Embryos appear where planetesimals have formed.
//  - They sweep up planetesimals in their feeding zones (oligarchic growth,
//    Kokubo & Ida 2002; rates as in Ida & Lin 2004) and catch drifting pebbles
//    (Lambrechts & Johansen 2014; Ormel 2017) until they are heavy enough to
//    bend the gas into a pressure bump that stops the pebbles (the pebble
//    isolation mass, Bitsch et al. 2018).
//  - A core that stops growing quickly lets its atmosphere contract and pull
//    in more gas, slowly at first and then in a runaway (Ikoma et al. 2000;
//    Ida & Lin 2004), limited by what the disk can feed it through the gap it
//    opens (Tanigawa & Tanaka 2016; gap depth from Kanagawa et al. 2015).
//  - The gas pulls planets inward (Type I migration, Tanaka et al. 2002,
//    slowed once a gap opens, Kanagawa et al. 2018) and damps their orbits
//    round (Tanaka & Ward 2004), until it is gone.
//  - Neighbours too close to stay apart for long (in mutual Hill radii, after
//    Chambers et al. 1996) cross orbits and then collide or scatter; heavy,
//    compact planets fling smaller ones away rather than hit them
//    (the Safronov number).
//  - A dying star swells and can swallow close planets, and as it sheds mass
//    the rest drift outward.
//
// Units: AU, years, solar masses (M_EARTH converts).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.PlanetsFactory = factory;
})(this, function PlanetsFactory(Rng, Disk, Star) {
  'use strict';

  const G = Disk.G, ME = Disk.MEARTH, MJ = Disk.MJUP, NR = Disk.NR;
  const SIG_CGS = Disk.SIG_CGS;
  const RE_AU = 4.2635e-5;               // Earth radius in AU
  const SEED = 0.01 * ME;                // a fresh embryo: about a Moon, what runaway growth among planetesimals makes
  const B_ISO = 10;                      // oligarchs settle about this many Hill radii apart
  const A_TRAP = 0.06;                   // the gas disk's inner edge, where inward migration stops

  function rng(d) {
    const r = Rng.makeRng(null, d.rngState);
    return { next() { const v = r.next(); d.rngState = r.state; return v; }, range(a, b) { return a + (b - a) * this.next(); } };
  }

  function makeBody(d, a, mass, iceFrac, kind) {
    const R = rng(d);
    const b = {
      id: d.nextBody++, kind: kind || 'planet', a, e: 0.005 + 0.01 * R.next(),
      mRock: mass * (1 - iceFrac), mIce: mass * iceFrac, mGas: 0,
      born: d.age, phase: 2 * Math.PI * R.next(), peri: 2 * Math.PI * R.next(),
      mdot: 0, adot: 0, iso: false, gap: false, runaway: false, marks: 0, lastSolid: 0,
    };
    d.bodies.push(b);
    return b;
  }

  function mass(b) { return b.mRock + b.mIce + b.mGas; }
  // Bodies leaving the system (flung out, swallowed, stolen) are counted, so
  // the mass budget still adds up.
  function lose(d, b, how) {
    if (b.dead) return;
    b.dead = true;
    if (b.kind === 'star') return;
    d.totals[how] = (d.totals[how] || 0) + mass(b);
  }
  function core(b) { return b.mRock + b.mIce; }

  // Radius in Earth radii: rock and ice cores, and gas envelopes that puff
  // them up (rough fits to the observed mass-radius relation).
  function radiusEarths(b) {
    const m = mass(b) / ME;
    if (b.kind === 'star') return 109 * Math.max(0.1, Math.pow(mass(b), 0.8));
    const c = Math.max(core(b) / ME, 1e-6);
    const water = b.mIce / Math.max(core(b), 1e-30);
    let r = Math.pow(c, 0.27) * (1 + 0.4 * water);
    const fg = b.mGas / Math.max(mass(b), 1e-30);
    if (fg > 0.001) {
      if (m < 60) r = r * Math.sqrt(1 + 40 * fg) * Math.min(1.6, 1 + 0.1 * Math.log10(1 + m));
      else r = 11.2 * Math.pow(m / 318, -0.04);
    }
    return Math.min(r, 14);
  }

  function hill(b, M) { return b.a * Math.cbrt(mass(b) / (3 * M)); }

  function kind(b) {
    const m = mass(b) / ME;
    if (b.kind === 'star') return mass(b) >= 0.075 ? 'star' : 'brown dwarf';
    if (m >= 13 * 317.8) return 'brown dwarf';
    const fg = b.mGas / Math.max(mass(b), 1e-30);
    const water = b.mIce / Math.max(core(b), 1e-30);
    if (m < 0.05) return 'embryo';
    if (m >= 50 && fg > 0.2) return b.a < 0.1 ? 'hot Jupiter' : 'gas giant';
    if (fg > 0.01) return m < 8 ? 'mini-Neptune' : 'ice giant';
    if (m >= 50) return 'giant core';
    if (water > 0.15) return 'ocean world';
    return m > 2 ? 'super-Earth' : 'rocky planet';
  }

  // ---- Starting the bodies ---------------------------------------------------------
  // Companion stars from the collapse become bodies too, if they're bound.
  function addCompanions(d, stars) {
    const M = d.mStar;
    for (const s of stars) {
      if (s.primary) continue;
      const r = Math.hypot(...s.pos);
      const vAU = s.vel.map((v) => v * 0.2108);           // km/s to AU/yr
      const v2 = vAU[0] * vAU[0] + vAU[1] * vAU[1] + vAU[2] * vAU[2];
      const mu = G * (M + s.mass);
      const energy = 0.5 * v2 - mu / r;
      if (energy >= 0) { d.events.push({ kind: 'sibling-escapes', t: d.age, mass: s.mass }); continue; }
      const a = -mu / (2 * energy);
      const hx = s.pos[1] * vAU[2] - s.pos[2] * vAU[1], hy = s.pos[2] * vAU[0] - s.pos[0] * vAU[2], hz = s.pos[0] * vAU[1] - s.pos[1] * vAU[0];
      const h2 = hx * hx + hy * hy + hz * hz;
      const e = Math.sqrt(Math.max(0, 1 - h2 / (mu * a)));
      const b = makeBody(d, a, s.mass, 0, 'star');
      b.mRock = s.mass; b.mIce = 0; b.e = Math.min(0.9, e);
      const c = { id: b.id, mass: s.mass, a, e: b.e, circumbinary: a < 8 };
      d.companions.push(c);
      b.companion = c;
      d.events.push({ kind: a < 8 ? 'close-binary' : 'binary', t: d.age, a, mass: s.mass });
    }
    d.companions = d.companions.filter((c) => c.a);
  }

  // ---- Local disk conditions around a radius ---------------------------------------
  function cell(a) { return Disk.cellOf(a); }

  // ---- One step of growth, migration and dynamics ------------------------------------
  function evolve(d, dt) {
    const M = d.mStar;
    const gasOn = !d.gone;
    seed(d);
    const R = rng(d);
    d.gap.fill(1);
    d.trap.fill(0);
    for (const b of d.bodies) {
      if (b.kind === 'star') continue;
      const i = cell(b.a);
      const m0 = mass(b);
      let solid = 0;

      // Planetesimals in the feeding zone (half-width 5 Hill radii).
      const rh = hill(b, M);
      const w = Math.max(0.5 * B_ISO * rh, 0.5 * (d.re[i + 1] - d.re[i]));
      const zone = cellsBetween(d, b.a - w, b.a + w);
      let mP = 0, area = 0;
      for (const [k, f] of zone) { mP += (d.sigPR[k] + d.sigPI[k]) * d.area[k] * f; area += d.area[k] * f; }
      if (mP > 0 && area > 0) {
        const sp = (mP / area) * SIG_CGS;
        const sg = Math.max(1, d.sigG[i] * SIG_CGS);
        const tau = 1.2e5 * Math.pow(sp / 10, -1) * Math.sqrt(b.a) * Math.cbrt(m0 / ME) * Math.pow(M, -1 / 6)
          * Math.pow(sg / 2400, -0.4) * Math.pow(b.a, 0.1) * 2.5;
        const want = Math.min(mP, m0 * (Math.exp(dt / tau) - 1));
        if (want > 0) solid += takeFrom(d, zone, want, d.sigPR, d.sigPI, b);
      }

      // Pebbles drifting past, until the pebble isolation mass.
      if (gasOn && !b.iso && d.sigG[i] > 0) {
        const h = d.H[i] / b.a;
        const aT = d.alpha[i];
        const iso = 25 * ME * Math.pow(h / 0.05, 3) * (0.34 * Math.pow(Math.log10(0.001) / Math.log10(aT), 4) + 0.66)
          * Math.max(0.1, 1 - (Math.min(d.gamma[i], 0) + 2.5) / 6) * M;
        if (m0 >= iso) {
          b.iso = true;
          d.events.push({ kind: 'isolation', t: d.age, id: b.id, a: b.a, mass: m0 });
        } else {
          const St = d.St1[i];
          const dust = d.sigDR[i] + d.sigDI[i];
          const sPeb = d.fm[i] * dust;
          if (St > 1e-4 && sPeb > 0) {
            const Om = d.Om[i];
            let mdot = 2 * Math.pow(St / 0.1, 2 / 3) * Om * rh * rh * sPeb;
            const rAcc = Math.pow(St / 0.1, 1 / 3) * rh;
            const hPeb = d.H[i] * Math.sqrt(aT / (aT + St));
            mdot *= Math.min(1, rAcc / (2.5 * hPeb));
            const dv = 0.5 * (d.cs[i] * d.cs[i] / d.vK[i]) * Math.abs(d.gamma[i]);
            const mT = Math.sqrt(1 / 3) * dv * dv * dv / (G * Om);
            if (m0 < mT) mdot *= m0 / mT;
            mdot = Math.min(mdot, d.mpeb[i]);
            const want = Math.min(dust * d.area[i] * 0.9, mdot * dt);
            if (want > 0) solid += takeFrom(d, [[i, 1]], want, d.sigDR, d.sigDI, b);
          }
        }
      }

      // Gas, once the core can hold onto it.
      const c = core(b);
      const sRate = solid / dt;
      b.lastSolid = sRate;
      let gas = 0;
      if (gasOn && d.sigG[i] > 0 && b.kind !== 'star') {
        const mCrit = 10 * ME * Math.pow(Math.max(sRate / ME, 1e-12) / 1e-6, 0.25);
        if (c >= Math.min(mCrit, 30 * ME) || b.mGas > 0.1 * c) {
          const mE = mass(b) / ME;
          // The envelope contracts on 10^b (M/M_Earth)^-3 years (Ida & Lin
          // 2004); b depends on the dust in the envelope and is uncertain by
          // a couple of dex. b = 10 gives giants around a quarter of
          // Sun-like stars, near what surveys find.
          // Close to the star, hot disk gas keeps flowing through the
          // atmosphere and stops it cooling (recycling: Ormel et al. 2015;
          // Lambrechts & Lega 2017), so close-in cores stay super-Earths.
          const recycle = 1 + 10 / (b.a * b.a);
          const tKH = Math.max(100, 1e10 * Math.pow(mE, -3) * recycle);
          const q = mass(b) / M, h = d.H[i] / b.a;
          const K = q * q / Math.pow(h, 5) / d.alpha[i];
          const sGap = d.sigG[i] / (1 + 0.04 * K);
          const mdotTT = (0.29 / Math.PI) * Math.pow(h, -2) * Math.pow(q, 4 / 3) * sGap * b.a * b.a * d.Om[i];
          // No faster than the disk brings gas past the planet (viscous plus
          // wind-driven inflow; Lubow & D'Angelo 2006 find a planet takes most
          // of it).
          const mdotDisk = 3 * Math.PI * d.nu[i] * d.sigG[i] + 2 * Math.PI * b.a * d.sigG[i] * Math.max(0, -d.vwind[i]);
          const mdot = Math.min(mass(b) / tKH, mdotTT, 0.8 * mdotDisk);
          const gz = cellsBetween(d, b.a - Math.max(2 * rh, d.H[i]), b.a + Math.max(2 * rh, d.H[i]));
          let avail = 0;
          for (const [k, f] of gz) avail += d.sigG[k] * d.area[k] * f;
          gas = Math.min(mdot * dt, 0.5 * avail);
          if (gas > 0) {
            for (const [k, f] of gz) {
              const share = d.sigG[k] * d.area[k] * f / avail;
              Disk.removeGas(d, k, gas * share / d.area[k]);
            }
            b.mGas += gas;
            d.totals.toPlanets += gas;
            if (!b.runaway && mdot > 1e-5 * ME && b.mGas > c) {
              b.runaway = true;
              d.events.push({ kind: 'runaway', t: d.age, id: b.id, a: b.a, mass: mass(b) });
            }
          }
        }
      }
      b.mdot = (solid + gas) / dt;
      milestones(d, b, m0);

      // Migration and eccentricity damping in the gas.
      b.adot = 0;
      if (gasOn && d.sigG[i] > 0) {
        const q = mass(b) / M, h = d.H[i] / b.a, Om = d.Om[i];
        const S = d.sigG[i];
        const ia = Math.max(0, i - 2), ib = Math.min(NR - 1, i + 2);
        let p = -Math.log((d.sigG[ib] + 1e-30) / (d.sigG[ia] + 1e-30)) / Math.log(d.r[ib] / d.r[ia]);
        if (!Number.isFinite(p)) p = 1;
        p = Math.max(-3, Math.min(4, p));
        const K = q * q / Math.pow(h, 5) / d.alpha[i];
        // Gas rising outward slows a small planet's drift, or even turns it
        // (the inner parts of wind-driven disks; Ogihara et al. 2018). But a
        // giant eating the gas that flows past it drains the disk inside its
        // own orbit, and that hollow mustn't read as a push outward.
        if (0.04 * K > 1) p = Math.max(-1, p);
        const G0 = (q / h) * (q / h) * S * Math.pow(b.a, 4) * Om * Om;
        const torque = -d.settings.migration * (1.36 + 0.54 * p) * G0 / (1 + 0.04 * K);
        b.adot = 2 * torque / (mass(b) * b.a * Om);
        const tE = (1 / 0.78) * (M / mass(b)) * (M / (S * b.a * b.a)) * Math.pow(h, 4) / Om * (1 + 0.04 * K);
        b.e *= Math.exp(-dt / Math.max(tE, 1));
        b.gap = 0.04 * K > 1;
        const move = Math.max(-0.3 * b.a, Math.min(0.3 * b.a, b.adot * dt));
        b.a = Math.max(A_TRAP, b.a + move);
      }
      // Planetesimals still around damp orbits too (dynamical friction).
      // The timescale goes as the star's mass over the local planetesimal
      // mass, in orbits.
      if (!gasOn && mP > 0 && area > 0) {
        const sp = mP / area;
        const tDF = 0.1 * (M / (sp * b.a * b.a)) * Math.pow(b.a, 1.5) / Math.sqrt(M);
        b.e *= Math.exp(-dt / Math.max(tDF, 1e3));
      }
      b.e = Math.max(0.001, Math.min(0.95, b.e));
    }
    marksAndGaps(d);
    clearAround(d, dt);
    encounters(d, dt, R);
    if (d.star) stellarEffects(d);
  }

  // Gaps planets cut in the gas (Kanagawa et al. 2017 shape) and, for those
  // at the pebble isolation mass, the pressure bump that stops pebbles.
  function marksAndGaps(d) {
    const M = d.mStar;
    for (const b of d.bodies) {
      if (b.kind === 'star') continue;
      const i = cell(b.a);
      if (d.gone || d.sigG[i] <= 0 && !b.iso) continue;
      const q = mass(b) / M, h = d.H[i] / b.a, al = d.alpha[i];
      const K = q * q / Math.pow(h, 5) / al;
      const Kp = q * q / Math.pow(h, 3) / al;
      const smin = 1 / (1 + 0.04 * K);
      if (smin > 0.98 && !b.iso) continue;
      const k4 = Math.pow(Kp, 0.25);
      const d1 = (smin / 4 + 0.08) * k4 * b.a, d2 = 0.33 * k4 * b.a;
      for (let k = 0; k < NR; k++) {
        const x = Math.abs(d.r[k] - b.a);
        if (x > d2 * 1.05) continue;
        let f;
        if (x < d1) f = smin;
        else f = Math.min(1, Math.max(smin, 4 / k4 * x / b.a - 0.32));
        d.gap[k] *= f;
        if (b.iso && d.r[k] > b.a && d.r[k] < b.a + Math.max(d2, 2 * d.H[k])) d.trap[k] = 1;
      }
    }
  }

  // The rings overlapping [r0, r1], with the fraction of each inside.
  function cellsBetween(d, r0, r1) {
    r0 = Math.max(Disk.R_IN, r0);
    const out = [];
    const i0 = cell(r0), i1 = cell(Math.max(r0, r1));
    for (let k = i0; k <= i1; k++) {
      const lo = Math.max(r0, d.re[k]), hi = Math.min(r1, d.re[k + 1]);
      if (hi <= lo) continue;
      const f = (hi * hi - lo * lo) / (d.re[k + 1] * d.re[k + 1] - d.re[k] * d.re[k]);
      out.push([k, Math.min(1, f)]);
    }
    if (!out.length) out.push([i0, 1]);
    return out;
  }

  // Take `want` of solids (rock and ice in the local proportions) from the
  // given rings of the given rock/ice arrays and add it to body b.
  function takeFrom(d, zone, want, rock, ice, b) {
    let avail = 0;
    for (const [k, f] of zone) avail += (rock[k] + ice[k]) * d.area[k] * f;
    if (avail <= 0) return 0;
    const take = Math.min(want, avail * 0.95);
    const frac = take / avail;
    let gotR = 0, gotI = 0;
    for (const [k, f] of zone) {
      const r = rock[k] * f * frac, i = ice[k] * f * frac;
      rock[k] -= r; ice[k] -= i;
      gotR += r * d.area[k]; gotI += i * d.area[k];
    }
    b.mRock += gotR; b.mIce += gotI;
    d.totals.toPlanets += gotR + gotI;
    return gotR + gotI;
  }

  // New embryos where planetesimals have gathered and no embryo is near.
  function seed(d) {
    const M = d.mStar;
    const sorted = d.bodies.slice().sort((x, y) => x.a - y.a);
    for (let i = 0; i < NR; i += 1) {
      const mP = (d.sigPR[i] + d.sigPI[i]) * d.area[i];
      if (mP < 3 * SEED) continue;
      const r = d.r[i];
      if (r > 200) break;
      let near = false;
      for (const b of sorted) {
        if (b.kind === 'star') continue;
        const reach = Math.max(0.5 * B_ISO * hill(b, M), 0.6 * (d.re[i + 1] - d.re[i]));
        if (Math.abs(b.a - r) < reach + 0.5 * (d.re[i + 1] - d.re[i])) { near = true; break; }
      }
      if (near) continue;
      const b = makeBody(d, r, 0, 0);
      takeFrom(d, [[i, 1]], SEED, d.sigPR, d.sigPI, b);
      sorted.push(b); sorted.sort((x, y) => x.a - y.a);
      if (!d.firstEmbryo) { d.firstEmbryo = true; d.events.push({ kind: 'embryos', t: d.age, a: r }); }
    }
  }

  // Notable moments in a planet's growth.
  function milestones(d, b, before) {
    const m = mass(b);
    const marks = [[0.1 * ME, 'mars'], [1 * ME, 'earth'], [10 * ME, 'core10'], [100 * ME, 'giant']];
    for (let k = 0; k < marks.length; k++) {
      if (b.marks > k) continue;
      if (m >= marks[k][0] && before < marks[k][0]) {
        b.marks = k + 1;
        if (k >= 1) d.events.push({ kind: marks[k][1], t: d.age, id: b.id, a: b.a, mass: m });
      }
    }
  }

  // Planets clear the planetesimals near their orbits (the chaotic zone,
  // about 1.3 (m/M)^(2/7) a wide, Wisdom 1980), half onto themselves.
  // (Not around companion stars: the chaotic-zone width is for bodies much
  // lighter than the star; Disk.truncate clears where a companion's pull
  // makes orbits unstable.)
  function clearAround(d, dt) {
    const M = d.mStar;
    for (const b of d.bodies) {
      const m = mass(b);
      if (m < 0.1 * ME || b.kind === 'star') continue;
      const w = 1.3 * Math.pow(m / M, 2 / 7) * b.a + 2 * hill(b, M);
      const P = Math.pow(b.a, 1.5) / Math.sqrt(M);
      const f = 1 - Math.exp(-dt / (300 * P));
      for (const [k, frac] of cellsBetween(d, b.a - w, b.a + w)) {
        const r = d.sigPR[k] * f * frac, i = d.sigPI[k] * f * frac;
        d.sigPR[k] -= r; d.sigPI[k] -= i;
        b.mRock += 0.5 * r * d.area[k]; b.mIce += 0.5 * i * d.area[k]; d.totals.toPlanets += 0.5 * (r + i) * d.area[k];
        d.totals.scattered = (d.totals.scattered || 0) + 0.5 * (r + i) * d.area[k];
      }
    }
  }

  // ---- Close encounters ---------------------------------------------------------------------
  // Neighbours whose orbits come within a few mutual Hill radii can't stay
  // apart: the closer they come, the sooner they cross (log t ≈ Δ - 2 in
  // orbits of the inner one, after Chambers et al. 1996). Then they either
  // collide or scatter.
  //
  // In gas, a planet migrating in onto a slower neighbour is usually caught
  // in a mean-motion resonance instead (3:2 for small planets, 2:1 for
  // giants) and the two migrate together, building resonant chains against
  // the disk's inner edge. Once the gas is gone most chains break within a
  // few million years and the planets collide or scatter (Izidoro et al.
  // 2017).
  const RES = { small: Math.pow(1.5, 2 / 3), giant: Math.pow(2, 2 / 3) };
  function encounters(d, dt, R) {
    const M = d.mStar;
    const list = d.bodies.slice().sort((x, y) => x.a - y.a);
    const gasOn = !d.gone;
    for (let k = 0; k + 1 < list.length; k++) {
      const p = list[k], q = list[k + 1];
      if (!p || !q || p.dead || q.dead) continue;
      // A companion star's reach isn't a Hill sphere; the binary check below
      // (Holman & Wiegert 1999) decides which orbits it allows.
      if (p.kind === 'star' || q.kind === 'star') continue;
      const mp = mass(p), mq = mass(q);
      const inGas = gasOn && d.sigG[cell(p.a)] > 0;
      // Already locked in resonance: in gas, hold the ratio; without it,
      // the chain may break.
      if (q.lock === p.id) {
        if (inGas) { q.a = Math.max(q.a, p.a * q.lockRatio); continue; }
        const P = Math.pow(p.a, 1.5) / Math.sqrt(M);
        const tBreak = 3e5 + 300 * P * Math.cbrt(M / (mp + mq));
        if (R.next() < 1 - Math.exp(-dt / tBreak)) {
          q.lock = 0;
          if (R.next() < 0.85) { q.e = Math.max(q.e, 0.05); p.e = Math.max(p.e, 0.05); resolve(d, p, q, R); }
        }
        continue;
      }
      const rhm = Math.cbrt((mp + mq) / (3 * M)) * 0.5 * (p.a + q.a);
      const sep = q.a * (1 - q.e) - p.a * (1 + p.e);
      const delta = sep / rhm;
      const P = Math.pow(p.a, 1.5) / Math.sqrt(M);
      const converging = q.adot < p.adot;
      const ratio = (mp > 30 * ME || mq > 30 * ME) ? RES.giant : RES.small;
      if (inGas && converging && q.a < p.a * ratio * 1.02 && mp > 0.05 * ME && mq > 0.05 * ME && !p.dead) {
        // Slow enough migration is caught (adiabatic); a fast plunge skips through.
        const tMig = q.a / Math.max(1e-30, p.adot - q.adot);
        if (tMig > 300 * P && R.next() < 0.9) {
          q.lock = p.id; q.lockRatio = ratio;
          q.a = p.a * ratio;
          if (!d.firstChain && mp > 0.5 * ME) { d.firstChain = true; d.events.push({ kind: 'resonance', t: d.age, id: q.id, a: q.a, ratio: ratio > 1.5 ? '2:1' : '3:2' }); }
          continue;
        }
      }
      let crossed = false;
      if (delta < 2 * Math.sqrt(3)) crossed = true;
      else if (!inGas) {
        const tInst = P * Math.pow(10, delta - 2);
        crossed = R.next() < 1 - Math.exp(-dt / tInst);
      } else if (delta < 5) {
        const tInst = P * Math.pow(10, delta - 2);
        crossed = R.next() < 1 - Math.exp(-dt / (10 * tInst));
      }
      if (!crossed) continue;
      resolve(d, p, q, R);
    }
    for (const b of d.bodies) if (b.lock && !d.bodies.some((o) => o.id === b.lock && !o.dead)) b.lock = 0;
    d.bodies = d.bodies.filter((b) => !b.dead);
    // Companion stars: planets outside the zone a binary allows are lost.
    for (const c of d.companions) {
      const cb = d.bodies.find((b) => b.id === c.id);
      if (!cb) continue;
      c.a = cb.a; c.e = cb.e;
      cb.mRock = c.mass;
      const mu = c.mass / (c.mass + M);
      for (const b of d.bodies) {
        if (b === cb || b.dead) continue;
        let unstable;
        if (c.circumbinary) {
          const aCrit = c.a * (1.6 + 5.1 * c.e - 2.22 * c.e * c.e + 4.12 * mu - 4.27 * c.e * mu - 5.09 * mu * mu + 4.61 * c.e * c.e * mu * mu);
          unstable = b.a < aCrit;
        } else {
          const aCrit = c.a * (0.464 - 0.38 * mu - 0.631 * c.e + 0.586 * mu * c.e + 0.15 * c.e * c.e - 0.198 * mu * c.e * c.e);
          unstable = b.a > aCrit && b.a < c.a * 3;
        }
        if (unstable) {
          lose(d, b, 'ejected');
          if (mass(b) > 0.05 * ME) d.events.push({ kind: 'binary-ejects', t: d.age, id: b.id, a: b.a, mass: mass(b) });
        }
      }
    }
    d.bodies = d.bodies.filter((b) => !b.dead);
  }

  function resolve(d, p, q, R) {
    const M = d.mStar;
    const big = mass(p) >= mass(q) ? p : q, small = big === p ? q : p;
    const mb = mass(big), ms = mass(small);
    // Safronov number of the bigger body: escape speed squared over orbital
    // speed squared, halved. Above about 1 it flings rather than hits.
    const theta = (mb / M) * (big.a / (radiusEarths(big) * RE_AU));
    const ratio = mb / Math.max(ms, 1e-30);
    let pCollide = 1 / (1 + theta * theta / 4);
    if (big.kind === 'star') pCollide = 0.3;
    if (R.next() < pCollide) {
      // They merge. Orbit from the combined angular momentum.
      const L = mb * Math.sqrt(big.a * (1 - big.e * big.e)) + ms * Math.sqrt(small.a * (1 - small.e * small.e));
      const m = mb + ms;
      const e = Math.min(0.5, (mb * big.e + ms * small.e) / m * 0.8 + 0.01 * R.next());
      const a = Math.pow(L / m, 2) / (1 - e * e);
      big.mRock += small.mRock; big.mIce += small.mIce; big.mGas += small.mGas;
      big.a = a; big.e = e;
      big.marks = Math.max(big.marks, small.marks);
      big.iso = big.iso || small.iso;
      small.dead = true;
      if (big.kind === 'star' && small.kind === 'star') d.events.push({ kind: 'stars-merge', t: d.age, a, mass: mass(big) });
      else if (ms > 0.05 * ME) d.events.push({ kind: 'impact', t: d.age, id: big.id, a, mass: mass(big), hit: ms });
      return;
    }
    // A scattering: the lighter one is thrown out or onto an eccentric orbit,
    // the heavier one moves in to pay for it (energy is conserved). In gas,
    // orbits are damped faster than repeated kicks can build up, so a
    // scattered body is mostly just moved outward and kept.
    const gas = !d.gone && d.sigG[cell(small.a)] > 0;
    let flung = theta > 1 && ratio > 1.5 ? 0.6 : theta > 0.5 ? 0.35 : 0.1;
    if (gas) flung *= 0.15;
    if (R.next() < flung) {
      lose(d, small, 'ejected');
      big.a = mb / (mb / big.a + ms / small.a);
      big.e = Math.min(0.9, big.e + Math.min(0.6, 0.15 * Math.sqrt(theta) * R.range(0.5, 1.5)) * Math.min(1, ms / mb * 3));
      if (ms > 0.05 * ME) d.events.push({ kind: 'ejected', t: d.age, id: small.id, by: big.id, a: small.a, mass: ms });
      return;
    }
    const kick = Math.min(0.7, 0.2 * Math.sqrt(Math.max(theta, 0.05)) * R.range(0.5, 1.5));
    small.e = Math.min(0.9, small.e + kick);
    if (gas && small === q) small.a *= 1 + kick;     // pushed out past the gap
    big.e = Math.min(0.9, big.e + kick * Math.min(1, ms / mb));
    const shift = small === q ? 1 + 0.5 * kick : 1 - 0.3 * kick;
    const aOld = small.a;
    small.a *= shift;
    big.a = mb / (mb / big.a + ms / aOld - ms / small.a);
    if (!(big.a > 0) || !Number.isFinite(big.a)) big.a = Math.max(A_TRAP, big.a || A_TRAP);
    if (ms > 0.05 * ME) d.events.push({ kind: 'scattered', t: d.age, id: small.id, by: big.id, a: small.a, mass: ms, e: small.e });
  }

  // ---- The star's late life ---------------------------------------------------------------------
  function stellarEffects(d) {
    const s = d.star;
    // Orbits widen as the star loses mass (and tighten as it gains): a M stays fixed.
    if (d.lastStarMass && Math.abs(s.mass - d.lastStarMass) > 1e-9) {
      const f = d.lastStarMass / s.mass;
      for (const b of d.bodies) b.a *= f;
      if (s.mass < 0.5 * d.lastStarMass && s.remnant) {
        // Losing over half its mass at once unbinds everything (a supernova).
        for (const b of d.bodies) { lose(d, b, 'ejected'); d.events.push({ kind: 'unbound', t: d.age, id: b.id, mass: mass(b) }); }
      }
    }
    d.lastStarMass = s.mass;
    // A swelling giant swallows planets that come within reach of its surface
    // (tides reach a few stellar radii, so allow a margin).
    const reach = 2 * s.rAU;
    for (const b of d.bodies) {
      if (b.kind === 'star') continue;
      if (b.a * (1 - b.e) < reach && !b.dead) {
        lose(d, b, 'engulfed');
        if (mass(b) > 0.01 * ME) d.events.push({ kind: 'engulfed', t: d.age, id: b.id, a: b.a, mass: mass(b), phase: s.phase });
      }
    }
    d.bodies = d.bodies.filter((b) => !b.dead);
  }

  // ---- Step size --------------------------------------------------------------------------------------
  function maxDt(d) {
    let dt = Infinity;
    for (const b of d.bodies) {
      const m = mass(b);
      if (b.mdot > 0) dt = Math.min(dt, 0.1 * m / b.mdot);
      if (b.adot !== 0) dt = Math.min(dt, 0.05 * b.a / Math.abs(b.adot));
    }
    return Math.max(dt, 10);
  }

  // ---- Fiddling --------------------------------------------------------------------------------------
  // Drop a body of `earths` Earth masses at radius a. Its make-up follows
  // where it is: icy beyond the snow line; gas giants get a gas envelope.
  function addPlanet(d, a, earths) {
    const snow = Disk.snowLineRadius(d);
    const m = earths * ME;
    const b = makeBody(d, a, 0, 0);
    let coreM = m, gas = 0;
    if (earths > 20) { coreM = Math.min(m, 15 * ME); gas = m - coreM; }
    else if (earths > 4) { coreM = m * 0.9; gas = m * 0.1; }
    const iceFrac = a > snow ? 0.5 : 0;
    b.mRock = coreM * (1 - iceFrac); b.mIce = coreM * iceFrac; b.mGas = gas;
    b.marks = earths >= 100 ? 4 : earths >= 10 ? 3 : earths >= 1 ? 2 : earths >= 0.1 ? 1 : 0;
    b.iso = earths > 15;
    b.dropped = true;
    d.events.push({ kind: 'dropped', t: d.age, id: b.id, a, mass: m });
    return b;
  }

  function moveBody(d, id, a, e) {
    const b = d.bodies.find((x) => x.id === id);
    if (!b) return null;
    b.a = Math.max(A_TRAP * 0.5, Math.min(Disk.R_OUT * 0.5, a));
    if (e !== undefined) b.e = Math.max(0.001, Math.min(0.95, e));
    if (b.companion) { b.companion.a = b.a; b.companion.e = b.e; }
    return b;
  }

  function removeBody(d, id) {
    const b = d.bodies.find((x) => x.id === id);
    if (b) lose(d, b, 'removed');
    d.bodies = d.bodies.filter((b) => b.id !== id);
    d.companions = d.companions.filter((c) => c.id !== id);
  }

  // A star passing at periastron q (AU) with mass mPass (Msun): strips the
  // disk beyond about 0.28 q (Breslau et al. 2014), steals or flings far
  // planets, and stirs up the orbits of the rest.
  function flyby(d, q, mPass) {
    const M = d.mStar;
    const R = rng(d);
    const rT = 0.28 * q * Math.pow(mPass / M, -0.32);
    let stripped = 0;
    for (let k = 0; k < NR; k++) {
      if (d.r[k] < rT) continue;
      const f = Math.min(1, (d.r[k] - rT) / rT + 0.5);
      stripped += (d.sigG[k] + d.sigDR[k] + d.sigDI[k] + d.sigPR[k] + d.sigPI[k] + d.sigV[k]) * f * d.area[k];
      d.sigG[k] *= 1 - f; d.sigDR[k] *= 1 - f; d.sigDI[k] *= 1 - f; d.sigPR[k] *= 1 - f; d.sigPI[k] *= 1 - f; d.sigV[k] *= 1 - f;
    }
    let lost = 0;
    for (const b of d.bodies) {
      const x = b.a / q;
      if (x > 0.5 || (x > 0.3 && R.next() < (x - 0.3) / 0.2)) {
        lose(d, b, 'stolen'); lost++;
        d.events.push({ kind: R.next() < 0.5 ? 'stolen' : 'flung', t: d.age, id: b.id, a: b.a, mass: mass(b) });
      } else {
        const kick = 2 * Math.pow(x, 2.5) * Math.sqrt(mPass / (M + mPass)) * R.range(0.4, 1.6);
        b.e = Math.min(0.9, Math.hypot(b.e, kick));
        b.a *= 1 + kick * (R.next() - 0.5) * 0.4;
      }
    }
    d.bodies = d.bodies.filter((b) => !b.dead);
    d.totals.stolen = (d.totals.stolen || 0) + stripped;
    d.events.push({ kind: 'flyby', t: d.age, q, mass: mPass, rT, stripped, lost });
    Disk.fields(d);
  }

  // ---- Reading ---------------------------------------------------------------------------------------
  function describe(d, b) {
    const m = mass(b);
    const s = d.star;
    const L = s ? s.L : 1;
    const teq = 278 * Math.pow(Math.max(L, 1e-8), 0.25) / Math.sqrt(b.a) * Math.pow(0.7, 0.25);
    return {
      id: b.id, a: b.a, e: b.e, mass: m, earths: m / ME, kind: kind(b), radius: radiusEarths(b),
      water: b.mIce / Math.max(core(b), 1e-30), gas: b.mGas / Math.max(m, 1e-30), teq,
      period: Math.pow(b.a, 1.5) / Math.sqrt(d.mStar), phase: b.phase, peri: b.peri, star: b.kind === 'star',
      dropped: !!b.dropped, gap: !!b.gap, iso: !!b.iso,
    };
  }

  return {
    evolve, maxDt, addCompanions, addPlanet, moveBody, removeBody, flyby, describe,
    mass, kind, radiusEarths, hill,
  };
});
