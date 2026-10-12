// The disk around a young star, from the end of the collapse until its gas
// is gone: gas, dust, water vapour and planetesimals on rings from 0.05 to
// 3000 AU (one radial dimension; the disk is taken to be round).
//
// Gas spreads by turbulent viscosity (the alpha-disk equation of Lynden-Bell
// & Pringle 1974), sped up where the disk is heavy enough to be unstable
// under its own gravity and where it is hot enough (above ~900 K) to be
// magnetically active. Most of its inflow, though, is driven by a magnetised
// wind that carries angular momentum and some gas away (the wind-driven
// disk of Tabone et al. 2022, lever arm 3). It drains onto the star at the
// inner edge, and is
// boiled off by the star's X-rays (internal photoevaporation, Owen et al.
// 2012) and by the light of nearby stars. Gas still falling in from the
// cloud lands where its spin carries it.
//
// Dust follows the two-population model of Birnstiel, Klahr & Ercolano
// (2012): grains grow until they break up in collisions or drift inward
// faster than they can grow, and the large ones (pebbles) drift toward the
// star against the gas. Water ice in the dust turns to vapour inside the
// snow line and freezes out again beyond it. Pebbles turn into planetesimals
// at the rate Lenz, Klahr & Birnstiel (2019) found, and faster wherever they
// crowd together enough for the streaming instability.
//
// Everything is solved implicitly (backward Euler), so it stays stable at
// any time step; positivity is guaranteed by the matrices' structure.
//
// Units: AU, years, solar masses. Surface densities are in Msun/AU^2.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.DiskFactory = factory;
})(this, function DiskFactory(Rng, Star) {
  'use strict';

  const G = 4 * Math.PI * Math.PI;      // AU^3 / (Msun yr^2)
  const SIG_CGS = 8.887e6;              // g/cm^2 in one Msun/AU^2
  const MEARTH = 3.0035e-6, MJUP = 9.546e-4;
  const CS_K = 0.01253;                 // isothermal sound speed, AU/yr per sqrt(K) (mean molecular weight 2.34)
  const MS_AUYR = 2.108e-4;             // 1 m/s in AU/yr
  const NR = 240, R_IN = 0.05, R_OUT = 3000;
  const T_ICE = 150, T_FLOOR = 10;
  const Z_SUN = 0.0134;
  const ROCK = 0.45;                    // share of the solids that is rock and metal; the rest is water
  const RHO_GRAIN = 1.6;                // g/cm^3
  const GAS_GONE = 1e-7;                // Msun of gas left when we call the disk gone

  // What can be set: [default, least, most].
  const SETTINGS = {
    alpha: [1e-3, 1e-5, 1e-2],     // turbulence in the midplane (stirs dust, spreads gas)
    wind: [1e-2, 0, 3e-2],         // magnetised disk wind: drives accretion and carries gas off (Tabone et al. 2022)
    field: [0.5, 0, 1],            // magnetic field threading the cloud: braking of the infall, and jets
    metals: [0, -0.5, 0.5],        // [Fe/H]: log10 of heavy elements relative to the Sun
    grains: [8, 1, 20],            // speed (m/s) at which icy grains shatter; dry ones at 80% of it
    xrays: [30, 29, 31],           // log10 of the star's X-ray luminosity, erg/s
    neighbours: [1, 0, 2],         // 0 alone, 1 in a cluster (like the Sun's), 2 beside a massive star
    migration: [0.3, 0.05, 1],     // strength of planet migration in the gas (1 = linear theory)
  };

  function clampSettings(o) {
    const s = {};
    for (const k in SETTINGS) {
      const v = o && o[k] !== undefined ? +o[k] : SETTINGS[k][0];
      s[k] = Math.min(SETTINGS[k][2], Math.max(SETTINGS[k][1], Number.isFinite(v) ? v : SETTINGS[k][0]));
    }
    return s;
  }

  const ARRAYS = ['sigG', 'sigDR', 'sigDI', 'sigV', 'sigPR', 'sigPI', 'sig0', 'alpha', 'T', 'growAge', 'gap', 'trap'];
  const WORK = ['cs', 'H', 'Om', 'vK', 'nu', 'Q', 'gamma', 'St1', 'fm', 'v1', 'vdrift', 'vbar', 'Dd', 'vgas', 'vwind', 'mpeb',
    'la', 'lb', 'lc', 'ld', 'tmp', 'tmp2'];

  function grid(d) {
    const r = new Float64Array(NR), re = new Float64Array(NR + 1), area = new Float64Array(NR);
    const dl = Math.log(R_OUT / R_IN) / NR;
    for (let i = 0; i <= NR; i++) re[i] = R_IN * Math.exp(i * dl);
    for (let i = 0; i < NR; i++) { r[i] = R_IN * Math.exp((i + 0.5) * dl); area[i] = Math.PI * (re[i + 1] * re[i + 1] - re[i] * re[i]); }
    d.dl = dl;
    for (const [k, v] of Object.entries({ r, re, area })) Object.defineProperty(d, k, { value: v, enumerable: false, writable: true });
    for (const k of WORK) Object.defineProperty(d, k, { value: new Float64Array(k === 'vgas' || k === 'vwind' ? NR + 1 : NR), enumerable: false, writable: true });
  }

  function cellOf(r) {
    const i = Math.floor(Math.log(r / R_IN) / (Math.log(R_OUT / R_IN) / NR));
    return Math.max(0, Math.min(NR - 1, i));
  }

  function blank(seed, settings) {
    const d = {
      seed: String(seed), settings: clampSettings(settings), t: 0, age: 0, mStar: 1, mdotStar: 0,
      star: null, infall: [], hole: false, gone: false, goneAt: null,
      totals: { onStar: 0, photo: 0, external: 0, infallen: 0, toPlanets: 0, dustLost: 0 },
      events: [], bodies: [], nextBody: 1, companions: [], rngState: Rng.seedNumber(seed) ^ 0x5bd1e995,
    };
    for (const k of ARRAYS) d[k] = new Float64Array(NR);
    d.gap.fill(1);
    grid(d);
    d.alpha.fill(d.settings.alpha);
    d.T.fill(100);
    return d;
  }

  function metallicity(d) { return Z_SUN * Math.pow(10, d.settings.metals); }

  // Add gas (and its dust or vapour) to the rings around radius r, spread a
  // little in log radius so no single ring takes a spike.
  function deposit(d, rAU, mass) {
    if (rAU < R_IN) { d.mStar += mass; d.totals.onStar += mass; return; }
    const c = (Math.log(Math.min(rAU, R_OUT * 0.9) / R_IN) / d.dl) - 0.5;
    const i0 = Math.floor(c), Z = metallicity(d);
    let wsum = 0;
    const w = [];
    for (let k = -2; k <= 3; k++) {
      const i = i0 + k;
      if (i < 0 || i >= NR) { w.push(0); continue; }
      const x = (i - c) / 1.0;
      const v = Math.exp(-0.5 * x * x);
      w.push(v); wsum += v;
    }
    for (let k = -2; k <= 3; k++) {
      const i = i0 + k;
      if (i < 0 || i >= NR || !w[k + 2]) continue;
      const m = mass * w[k + 2] / wsum;
      const s = m / d.area[i];
      d.sigG[i] += s;
      d.sigDR[i] += s * Z * ROCK;
      if (d.T[i] < T_ICE) d.sigDI[i] += s * Z * (1 - ROCK); else d.sigV[i] += s * Z * (1 - ROCK);
      d.growAge[i] = 0;
    }
  }

  // From the end of the collapse: the stars, and the gas, each parcel landing
  // at the radius its spin allows, some at once and some over the next tens
  // of thousands of years.
  //
  // The collapse simulation has no magnetic field. A real core is threaded
  // by one, and it does two things: it brakes the gas's spin, so the
  // flattened structure a field-free collapse calls a disk is mostly a
  // braked pseudo-disk and the true disk is smaller (Allen, Li & Shu 2003;
  // observed young disks are tens of AU), and it drives jets that throw part
  // of the gas still falling back out (core-to-star efficiency of 25-75%,
  // Matzner & McKee 2000). The `field` setting applies both here.
  function fromCollapse(seed, settings, hand) {
    const d = blank(seed, settings);
    const main = hand.stars.find((s) => s.primary);
    d.mStar = main.mass;
    d.mdotStar = main.mdot || 0;
    d.t = 0;
    d.age = hand.starAge || 0;
    d.bornAt = hand.age - d.age;
    const B = d.settings.field;
    const keepSpin = 1 - 0.9 * B;             // fraction of its spin the gas keeps
    const jets = 0.8 * B;                     // fraction of falling gas the jets throw out
    d.totals.jets = 0;
    for (const p of hand.parcels) {
      const rCyl = Math.hypot(p.x, p.y), r = Math.hypot(p.x, p.y, p.z);
      // Already orbiting in the (pseudo-)disk: braked, landing at once.
      if (Math.abs(rCyl - p.rAU) < 0.3 * p.rAU && Math.abs(p.z) < 0.3 * rCyl) { deposit(d, p.rAU * keepSpin * keepSpin, p.mass); continue; }
      // Still falling: braked, partly thrown out, and landing after its free-fall time.
      const m = p.mass * (1 - jets);
      d.totals.jets += p.mass - m;
      const tff = Math.max(p.landsIn || 0, (Math.PI / 2) * Math.sqrt(r * r * r / (2 * G * d.mStar)));
      d.infall.push({ t: tff, r: p.rAU * keepSpin * keepSpin, m });
    }
    d.infall.sort((a, b) => a.t - b.t);
    d.companions = hand.stars.filter((s) => !s.primary);
    d.sig0.set(d.sigG);
    fields(d);
    return d;
  }

  // A disk to start from without the collapse: a star of about a solar mass
  // and a disk with the classic self-similar profile (Lynden-Bell & Pringle).
  function synthetic(seed, settings, opts) {
    const d = blank(seed, settings);
    const rng = Rng.makeRng('disk:' + seed);
    d.mStar = (opts && opts.mStar) || 1;
    const mDisk = ((opts && opts.mDisk) || rng.range(0.04, 0.1)) * d.mStar;
    const rc = (opts && opts.rc) || rng.range(30, 70);
    d.age = 1e5;
    d.t = 0;
    d.bornAt = 0;
    let tot = 0;
    for (let i = 0; i < NR; i++) tot += (1 / d.r[i]) * Math.exp(-d.r[i] / rc) * d.area[i];
    for (let i = 0; i < NR; i++) {
      const m = mDisk * (1 / d.r[i]) * Math.exp(-d.r[i] / rc) * d.area[i] / tot;
      d.sigG[i] = m / d.area[i];
    }
    fields(d);
    const Z = metallicity(d);
    for (let i = 0; i < NR; i++) {
      d.sigDR[i] = d.sigG[i] * Z * ROCK;
      if (d.T[i] < T_ICE) d.sigDI[i] = d.sigG[i] * Z * (1 - ROCK); else d.sigV[i] = d.sigG[i] * Z * (1 - ROCK);
    }
    d.sig0.set(d.sigG);
    fields(d);
    return d;
  }

  // ---- The star ------------------------------------------------------------------
  function updateStar(d) {
    d.star = Star.at(d.mStar, d.age, d.mdotStar);
  }

  // ---- Local conditions -----------------------------------------------------------
  // Temperature, sound speed, scale height, viscosity, gravitational
  // stability, pressure gradient, and the dust's sizes and speeds.
  // `frozen`: keep the saved temperatures and turbulence as they are (they
  // feed each other, so recomputing them nudges both) and derive the rest.
  function fields(d, frozen) {
    updateStar(d);
    const { r, re, sigG, alpha, T, cs, H, Om, vK, nu, Q, gamma, St1, fm, v1, vbar, Dd, vgas, mpeb } = d;
    const M = d.mStar + companionMassInside(d);
    const L = Math.max(1e-4, d.star.lTotal);
    const tIrr0 = 220 * Math.pow(L, 0.25);
    const aBase = d.settings.alpha;
    const vIce = d.settings.grains * MS_AUYR, vDry = vIce * 0.8;
    const Z = metallicity(d);
    for (let i = 0; i < NR; i++) {
      Om[i] = Math.sqrt(G * M / (r[i] * r[i] * r[i]));
      vK[i] = Om[i] * r[i];
      if (!frozen) {
        const sCgs = sigG[i] * SIG_CGS;
        const dust = d.sigDR[i] + d.sigDI[i];
        const kappa = Math.max(0.05, Math.min(3, 1.5 * (dust / Math.max(sigG[i], 1e-30)) / 0.01));
        // Viscous heating in the midplane (optically thick): T^3 = 27 kappa Sigma^2 alpha k Omega / (128 sigma mu m_H).
        const tv3 = 1.314e11 * sCgs * sCgs * kappa * alpha[i] * (Om[i] / 3.156e7);
        const tIrr = tIrr0 / Math.sqrt(r[i]);
        const t4 = Math.pow(tIrr, 4) + Math.pow(Math.max(0, tv3), 4 / 3) + Math.pow(T_FLOOR, 4);
        T[i] = Math.min(3000, Math.sqrt(Math.sqrt(t4)));
      }
      cs[i] = CS_K * Math.sqrt(T[i]);
      H[i] = cs[i] / Om[i];
      // Toomre's Q; below about 1.5 the disk's own gravity raises spiral
      // waves that carry mass inward like a strong viscosity (fit of Kratter,
      // Matzner & Krumholz 2008).
      Q[i] = sigG[i] > 0 ? cs[i] * Om[i] / (Math.PI * G * sigG[i]) : 1e9;
      const gi = Q[i] < 1.5 ? Math.min(0.3, 0.14 * ((2.25 / (Q[i] * Q[i])) - 1)) : 0;
      // Gas hot enough to be thermally ionised (above ~800-1000 K) is
      // magnetically turbulent. Gas piling up in the cold zone heats until it
      // gets there, then drains in a burst: an FU Orionis outburst (Zhu et
      // al. 2010).
      const mri = 0.05 * Math.min(1, Math.max(0, (T[i] - 800) / 200));
      if (!frozen) alpha[i] = aBase + gi + mri;
      nu[i] = alpha[i] * cs[i] * cs[i] / Om[i];
    }
    // The wind's inflow speed at ring edges: v = -3/2 alpha_DW c_s^2 / v_K.
    const aw = d.settings.wind;
    for (let e = 0; e <= NR; e++) {
      const a = Math.max(0, e - 1), b = Math.min(NR - 1, e);
      const c2 = 0.5 * (cs[a] * cs[a] + cs[b] * cs[b]), v = 0.5 * (vK[a] + vK[b]);
      d.vwind[e] = e === NR || e === d.wall ? 0 : -1.5 * aw * c2 / v;
    }
    // Gas radial velocity at ring edges, from the viscous flow.
    vgas[0] = 0; vgas[NR] = 0;
    for (let i = 0; i < NR - 1; i++) {
      const k = 6 * Math.PI * Math.sqrt(re[i + 1]) / (r[i + 1] - r[i]);
      const F = -k * (nu[i + 1] * Math.sqrt(r[i + 1]) * sigG[i + 1] - nu[i] * Math.sqrt(r[i]) * sigG[i]);
      const s = 0.5 * (sigG[i] + sigG[i + 1]);
      vgas[i + 1] = (s > 1e-30 ? Math.max(-1, Math.min(1, F / (2 * Math.PI * re[i + 1] * s))) : 0) + d.vwind[i + 1];
    }
    {
      const k = 6 * Math.PI * Math.sqrt(re[0]) / (r[0] - re[0]);
      const F = -k * nu[0] * Math.sqrt(r[0]) * sigG[0];
      vgas[0] = (sigG[0] > 1e-30 ? Math.max(-1, F / (2 * Math.PI * re[0] * sigG[0])) : 0) + d.vwind[0];
    }
    // Pressure gradient, d ln P / d ln r, with P ∝ Sigma c_s Omega; gaps
    // carved by planets heavy enough to stop pebbles turn it outward there.
    const tiny = 1e-30;
    for (let i = 0; i < NR; i++) {
      const a = Math.max(0, i - 1), b = Math.min(NR - 1, i + 1);
      const pa = Math.log((sigG[a] * d.gap[a] + tiny) * cs[a] * Om[a]), pb = Math.log((sigG[b] * d.gap[b] + tiny) * cs[b] * Om[b]);
      let g = (pb - pa) / Math.log(r[b] / r[a]);
      if (!Number.isFinite(g)) g = -2.75;
      g = Math.max(-10, Math.min(10, g));
      if (d.trap[i] > 0) g = Math.max(g, d.trap[i]);
      gamma[i] = g;
    }
    // Dust sizes (as Stokes numbers) and speeds: the two-population model.
    for (let i = 0; i < NR; i++) {
      const sg = sigG[i];
      const dust = d.sigDR[i] + d.sigDI[i];
      if (sg <= 1e-30) { St1[i] = 0; fm[i] = 0; v1[i] = 0; vbar[i] = 0; Dd[i] = 0; mpeb[i] = 0; continue; }
      const z = dust / sg;
      const vf = T[i] < T_ICE ? vIce : vDry;
      const stFrag = 0.37 * vf * vf / (3 * alpha[i] * cs[i] * cs[i]);
      const stDrift = 0.55 * z * (vK[i] / cs[i]) * (vK[i] / cs[i]) / Math.max(Math.abs(gamma[i]), 0.1);
      const st0 = 2.51e-4 / (sg * SIG_CGS);
      const stGrow = st0 * Math.exp(Math.min(40, d.growAge[i] * Math.max(z, 1e-5) * Om[i]));
      let st = Math.min(stFrag, stDrift, stGrow, 2);
      st = Math.max(st, st0);
      St1[i] = st;
      fm[i] = stDrift < stFrag ? 0.97 : 0.75;
      const vg = 0.5 * (vgas[i] + vgas[i + 1]);
      const drift = (c) => (c / (1 + c * c)) * (cs[i] * cs[i] / vK[i]) * gamma[i] + vg / (1 + c * c);
      v1[i] = drift(st);
      d.vdrift[i] = (st / (1 + st * st)) * (cs[i] * cs[i] / vK[i]) * gamma[i];
      const v0 = drift(st0);
      vbar[i] = (1 - fm[i]) * v0 + fm[i] * v1[i];
      Dd[i] = nu[i] * ((1 - fm[i]) + fm[i] / (1 + st * st));
      mpeb[i] = 2 * Math.PI * r[i] * fm[i] * dust * Math.max(0, -v1[i]);
    }
    void Z;
  }

  function companionMassInside(d) {
    let m = 0;
    for (const c of d.companions) if (c.circumbinary) m += c.mass;
    return m;
  }

  // ---- Tridiagonal solve (Thomas algorithm) -----------------------------------------
  function solve(a, b, c, rhs, out, n) {
    const cp = new Float64Array(n), dp = new Float64Array(n);
    cp[0] = c[0] / b[0]; dp[0] = rhs[0] / b[0];
    for (let i = 1; i < n; i++) {
      const m = b[i] - a[i] * cp[i - 1];
      cp[i] = c[i] / m;
      dp[i] = (rhs[i] - a[i] * dp[i - 1]) / m;
    }
    out[n - 1] = dp[n - 1];
    for (let i = n - 2; i >= 0; i--) out[i] = dp[i] - cp[i] * out[i + 1];
    for (let i = 0; i < n; i++) if (!(out[i] > 0)) out[i] = 0;
  }

  // ---- Gas: viscous spreading and wind-driven inflow, implicitly ----------------------------
  // Returns the mass that flowed onto the star.
  function stepGas(d, dt) {
    const { r, re, area, nu, sigG, la, lb, lc, ld, vwind, cs, Om } = d;
    const c = new Float64Array(NR);
    for (let i = 0; i < NR; i++) c[i] = nu[i] * Math.sqrt(r[i]);
    const kIn = 6 * Math.PI * Math.sqrt(re[0]) / (r[0] - re[0]);
    const wall = d.wall === undefined ? NR : d.wall;     // no flow across the edge at index `wall`
    const aw = d.settings.wind;
    const lossK = new Float64Array(NR);
    for (let i = 0; i < NR; i++) {
      const km = i > 0 ? (i === wall ? 0 : 6 * Math.PI * Math.sqrt(re[i]) / (r[i] - r[i - 1])) : kIn;
      const kp = i < NR - 1 ? (i + 1 === wall ? 0 : 6 * Math.PI * Math.sqrt(re[i + 1]) / (r[i + 1] - r[i])) : 0;
      // Wind inflow through each edge, upwind (it always flows in, so from the outer ring).
      const wm = 2 * Math.PI * re[i] * Math.min(0, vwind[i]);
      const wp = i < NR - 1 ? 2 * Math.PI * re[i + 1] * Math.min(0, vwind[i + 1]) : 0;
      // Gas the wind carries off: 3 alpha_DW c^2 / (4 (lambda - 1) r^2 Omega) per year, lambda = 5.
      lossK[i] = 3 * aw * cs[i] * cs[i] / (16 * r[i] * r[i] * Om[i]);
      la[i] = i > 0 ? -km * c[i - 1] : 0;
      lb[i] = area[i] / dt + km * c[i] + kp * c[i] - wm + area[i] * lossK[i];
      lc[i] = i < NR - 1 ? -kp * c[i + 1] + wp : 0;
      ld[i] = area[i] * sigG[i] / dt;
    }
    const before = d.tmp2;
    before.set(sigG);
    solve(la, lb, lc, ld, sigG, NR);
    let lost = 0;
    for (let i = 0; i < NR; i++) {
      const m = lossK[i] * sigG[i] * area[i] * dt;
      lost += m;
      // The wind lifts the small grains (not the pebbles) along with the gas.
      if (before[i] > 0 && m > 0) {
        const f = Math.min(1, m / (before[i] * area[i]));
        const small = 1 - d.fm[i];
        const dr = d.sigDR[i] * f * small, di = d.sigDI[i] * f * small;
        d.sigDR[i] -= dr; d.sigDI[i] -= di; d.sigV[i] *= 1 - f;
        d.totals.dustLost += (dr + di) * area[i];
      }
    }
    d.totals.wind = (d.totals.wind || 0) + lost;
    const wIn = -2 * Math.PI * re[0] * Math.min(0, vwind[0]);
    return (kIn * c[0] + wIn) * sigG[0] * dt;
  }

  // ---- Dust and vapour: drift and diffusion, implicitly ------------------------------------
  // Advects tracer surface densities `fields` (same velocities) with
  // velocity v (cell centred) and diffusivity D against gas density sigG.
  function stepTracers(d, dt, vel, diff, tracers, vEdges) {
    const { r, re, area, sigG, la, lb, lc } = d;
    const A = new Float64Array(NR + 1), B = new Float64Array(NR + 1);   // flux = A*S_left + B*S_right at each edge
    for (let e = 0; e <= NR; e++) {
      let v;
      if (vEdges) v = vEdges[e];
      else if (e === 0) v = vel[0];
      else if (e === NR) v = 0;
      else v = 0.5 * (vel[e - 1] + vel[e]);
      const w = 2 * Math.PI * re[e] * v;
      A[e] = w > 0 ? w : 0;
      B[e] = w < 0 ? w : 0;
      if (e > 0 && e < NR) {
        const g = 0.5 * (sigG[e - 1] + sigG[e]);
        const Dk = 0.5 * (diff[e - 1] + diff[e]);
        if (g > 1e-30 && sigG[e - 1] > 1e-30 && sigG[e] > 1e-30) {
          const dk = 2 * Math.PI * re[e] * Dk * g / (r[e] - r[e - 1]);
          A[e] += dk / sigG[e - 1];
          B[e] -= dk / sigG[e];
        }
      }
    }
    A[NR] = 0; B[NR] = 0;
    // Edge 0 can only carry material out of the grid (inward).
    A[0] = 0;
    for (let i = 0; i < NR; i++) {
      la[i] = i > 0 ? -A[i] : 0;
      lb[i] = area[i] / dt - B[i] + A[i + 1];
      lc[i] = i < NR - 1 ? B[i + 1] : 0;
    }
    let lost = 0;
    const rhs = d.ld;
    for (const S of tracers) {
      for (let i = 0; i < NR; i++) rhs[i] = area[i] * S[i] / dt;
      solve(la, lb, lc, rhs, S, NR);
      lost += -B[0] * S[0] * dt;
    }
    return lost;
  }

  // ---- Photoevaporation ------------------------------------------------------------------------
  function photoevaporate(d, dt) {
    const { r, area, sigG } = d;
    const M = d.mStar;
    if (d.star && (d.star.remnant || d.star.phase === 'brown dwarf')) return 0;
    const lx = Math.pow(10, d.settings.xrays - 30);
    const mdotX = 6.25e-9 * Math.pow(M, -0.068) * Math.pow(lx, 1.14);
    let removed = 0;
    if (!d.hole) {
      // Primordial disk: X-ray heated wind from about 1 AU outward.
      const w = d.tmp;
      let norm = 0;
      for (let i = 0; i < NR; i++) {
        const x = r[i] / M;
        w[i] = x > 0.2 ? Math.pow(x, -1.5) * Math.exp(-Math.pow(0.7 / x, 2)) * Math.exp(-x / 200) : 0;
        norm += w[i] * area[i];
      }
      for (let i = 0; i < NR; i++) {
        if (!w[i]) continue;
        const want = mdotX * dt * w[i] / norm;          // Msun/AU^2 to remove here
        const take = Math.min(sigG[i], want);
        removeGas(d, i, take);
        removed += take * area[i];
      }
      // A hole opens once the wind out-eats the inflow at about 1-2 AU.
      const ih = cellOf(1.5 * M);
      if (sigG[ih] * SIG_CGS < 1e-3 && d.age > 1e5) {
        d.hole = true;
        d.events.push({ kind: 'hole', t: d.age, r: r[ih] });
      }
    } else {
      // The outer disk's inner rim now sees the star directly and is eaten
      // from the inside out.
      let rim = -1;
      const start = cellOf(1.0 * M);
      for (let i = start; i < NR; i++) if (sigG[i] * SIG_CGS > 1e-4) { rim = i; break; }
      if (rim >= 0) {
        let left = 4 * mdotX * dt;
        for (let i = rim; i < NR && left > 0; i++) {
          const take = Math.min(sigG[i] * area[i], left);
          removeGas(d, i, take / area[i]);
          removed += take;
          left -= take;
        }
      }
      // Whatever is left inside the hole drains away quickly.
      for (let i = 0; i < start; i++) {
        const take = sigG[i] * (1 - Math.exp(-dt / 2e4));
        removeGas(d, i, take);
        removed += take * area[i];
      }
    }
    // Light from nearby stars eats the disk from the outside in.
    const n = d.settings.neighbours;
    if (n > 0) {
      // Mass-loss rates for a ~100 AU disk under ~1e3 and ~1e5 times the
      // local interstellar ultraviolet (Haworth et al. 2018).
      const mdotExt = n < 1.5 ? 1e-7 * n : 1e-6 * (n - 1) + 1e-7;
      const rT = n < 1.5 ? 150 - 60 * n : 90 - 60 * (n - 1);
      let left = mdotExt * dt;
      for (let i = NR - 1; i >= 0 && left > 0 && r[i] > rT; i--) {
        const take = Math.min(sigG[i] * area[i], left);
        if (take <= 0) continue;
        removeGas(d, i, take / area[i]);
        d.totals.external += take;
        left -= take;
      }
    }
    d.totals.photo += removed;
    return removed;
  }

  // Remove gas from ring i, taking the small dust and vapour along with it.
  function removeGas(d, i, sig) {
    if (sig <= 0 || d.sigG[i] <= 0) return;
    const f = Math.min(1, sig / d.sigG[i]);
    d.sigG[i] -= f * d.sigG[i];
    const small = 1 - d.fm[i];
    const dr = d.sigDR[i] * f * small, di = d.sigDI[i] * f * small;
    d.sigDR[i] -= dr; d.sigDI[i] -= di;
    d.totals.dustLost += (dr + di) * d.area[i];
    d.sigV[i] -= f * d.sigV[i];
    if (d.sigG[i] < 1e-30) d.sigG[i] = 0;
  }

  // ---- Planetesimals -------------------------------------------------------------------------------
  // Pebbles crossing a ring turn into planetesimals at a steady small rate
  // (the prescription of Lenz et al. 2019, a share for every five scale
  // heights travelled; we use 1%, which gives systems with about the heavy
  // element content of our own), and much faster where they are crowded
  // enough for the streaming instability.
  function formPlanetesimals(d, dt) {
    const { sigDR, sigDI, sigPR, sigPI, St1, fm, v1, H, Om, sigG, alpha } = d;
    let formed = 0;
    for (let i = 0; i < NR; i++) {
      if (St1[i] < 1e-4 || sigG[i] <= 0) continue;
      // Pebbles drifting through the gas, not gas carrying them, is what counts.
      let lam = St1[i] >= 0.003 ? 0.01 * fm[i] * Math.max(0, -d.vdrift[i]) / (5 * H[i]) : 0;
      // The streaming instability: where pebbles crowd the midplane as
      // densely as the gas, and are big enough (Stokes number 0.01 or more;
      // below that it is weak, Yang et al. 2017), they clump straight into
      // planetesimals.
      const z = (sigDR[i] + sigDI[i]) / sigG[i];
      const mid = fm[i] * z * Math.sqrt((alpha[i] + St1[i]) / alpha[i]);
      if (mid >= 1 && St1[i] >= 0.01) lam += 0.01 * Om[i] / (2 * Math.PI);
      if (lam <= 0) continue;
      const f = 1 - Math.exp(-lam * dt);
      const a = sigDR[i] * f, b = sigDI[i] * f;
      sigDR[i] -= a; sigDI[i] -= b; sigPR[i] += a; sigPI[i] += b;
      formed += (a + b) * d.area[i];
    }
    return formed;
  }

  // ---- Ice and vapour ------------------------------------------------------------------------------
  function snowLine(d) {
    for (let i = 0; i < NR; i++) {
      if (d.T[i] >= T_ICE) { d.sigV[i] += d.sigDI[i]; d.sigDI[i] = 0; }
      else { d.sigDI[i] += d.sigV[i]; d.sigV[i] = 0; }
    }
  }
  function snowLineRadius(d) {
    for (let i = NR - 1; i >= 0; i--) if (d.T[i] >= T_ICE) return d.re[i + 1];
    return R_IN;
  }

  // ---- One step --------------------------------------------------------------------------------------
  // `bodies` (planets) have already taken what they accrete this step and
  // set d.gap / d.trap.
  function step(d, dt) {
    d.t += dt; d.age += dt;
    for (let i = 0; i < NR; i++) d.growAge[i] += dt;
    if (d.gone) {
      fields(d);
      return;
    }
    // Gas landing from the cloud.
    while (d.infall.length && d.infall[0].t <= d.t) {
      const p = d.infall.shift();
      deposit(d, p.r, p.m);
      d.totals.infallen += p.m;
    }
    // Companions on tight orbits clear a cavity; wide ones truncate the disk.
    truncate(d, dt);
    const onStar = stepGas(d, dt);
    d.mStar += onStar;
    d.totals.onStar += onStar;
    const k = Math.min(1, dt / 500);
    d.mdotStar += k * (onStar / dt - d.mdotStar);
    if (d.mdotStar > 1e-5 && !d.bursting) { d.bursting = true; d.events.push({ kind: 'outburst', t: d.age, mdot: d.mdotStar }); }
    else if (d.mdotStar < 3e-6) d.bursting = false;
    photoevaporate(d, dt);
    d.totals.dustLost += stepTracers(d, dt, d.vbar, d.Dd, [d.sigDR, d.sigDI]);
    const vgEdges = d.vgas;
    stepTracers(d, dt, null, d.nu, [d.sigV], vgEdges);
    snowLine(d);
    formPlanetesimals(d, dt);
    // Gone?
    let gas = 0;
    for (let i = 0; i < NR; i++) gas += d.sigG[i] * d.area[i];
    if (gas < GAS_GONE && !d.infall.length && d.age > 2e5) {
      d.gone = true;
      d.goneAt = d.age;
      let dust = 0;
      for (let i = 0; i < NR; i++) {
        dust += (d.sigDR[i] + d.sigDI[i]) * d.area[i];
        d.sigG[i] = 0; d.sigDR[i] = 0; d.sigDI[i] = 0; d.sigV[i] = 0;
      }
      d.totals.dustLost += dust;
      d.events.push({ kind: 'gas-gone', t: d.age });
    }
    fields(d);
  }

  // A companion star shapes the disk. A wide one truncates it at about a
  // third of its distance (Artymowicz & Lubow 1994): the disk can't spread
  // past that edge, and gas between there and the companion's orbit falls to
  // the companion. A close one (circumbinary) clears a cavity about two and a
  // half times its distance, and gas inside falls onto the pair.
  function truncate(d, dt) {
    d.wall = NR;
    for (const c of d.companions) {
      if (!c.a) continue;
      if (c.circumbinary) {
        const rc = 2.5 * c.a * (1 + c.e);
        for (let i = 0; i < NR && d.r[i] < rc; i++) {
          const f = 1 - Math.exp(-dt * d.Om[i] / 20);
          const m = (d.sigG[i] + d.sigDR[i] + d.sigDI[i] + d.sigV[i]) * f * d.area[i];
          const share = c.mass / (c.mass + d.mStar);
          d.mStar += m * (1 - share); c.mass += m * share;
          d.sigG[i] *= 1 - f; d.sigDR[i] *= 1 - f; d.sigDI[i] *= 1 - f; d.sigV[i] *= 1 - f;
        }
      } else {
        const rt = 0.35 * c.a * (1 - c.e), rOut = Math.min(R_OUT, 2.5 * c.a * (1 + c.e));
        const iw = cellOf(rt) + 1;
        d.wall = Math.min(d.wall, iw);
        for (let i = iw; i < NR && d.r[i] < rOut; i++) {
          const f = 1 - Math.exp(-dt * d.Om[i] / 20);
          c.mass += (d.sigG[i] + d.sigDR[i] + d.sigDI[i] + d.sigV[i] + d.sigPR[i] + d.sigPI[i]) * f * d.area[i];
          d.sigG[i] *= 1 - f; d.sigDR[i] *= 1 - f; d.sigDI[i] *= 1 - f; d.sigV[i] *= 1 - f;
          d.sigPR[i] *= 1 - f; d.sigPI[i] *= 1 - f;
        }
      }
    }
  }

  // The largest step that keeps things smooth: a fraction of the age (time
  // is followed roughly logarithmically), shorter while gas is still landing.
  //
  // Viscosity here switches on and off with temperature and self-gravity,
  // and a lagged implicit step much longer than the local viscous time lets
  // that flip back and forth into spurious rings; so no step is longer than
  // a fifth of the shortest viscous (or wind-inflow) time where the gas is.
  function maxDt(d) {
    let dt = 0.03 * Math.max(d.age, 1e4);
    if (d.infall.length) dt = Math.min(dt, Math.max(50, d.infall[0].t - d.t), 2000);
    if (!d.gone) {
      dt = Math.min(dt, 2e5);
      let tot = 0;
      for (let i = 0; i < NR; i++) tot += d.sigG[i] * d.area[i];
      const floor = 1e-4 * tot;
      for (let i = 0; i < NR; i++) {
        if (d.sigG[i] * d.area[i] < floor) continue;
        const tv = d.r[i] * d.r[i] / Math.max(d.nu[i], 1e-30);
        const tw = d.r[i] / Math.max(1e-30, -d.vwind[i]);
        dt = Math.min(dt, 0.2 * tv, 0.2 * tw);
      }
    }
    return Math.max(dt, 1);
  }

  // ---- Reading it -----------------------------------------------------------------------------------
  function totals(d) {
    let gas = 0, dust = 0, plts = 0, ice = 0;
    for (let i = 0; i < NR; i++) {
      gas += d.sigG[i] * d.area[i];
      dust += (d.sigDR[i] + d.sigDI[i]) * d.area[i];
      plts += (d.sigPR[i] + d.sigPI[i]) * d.area[i];
      ice += (d.sigDI[i] + d.sigPI[i]) * d.area[i];
    }
    let infall = 0;
    for (const p of d.infall) infall += p.m;
    return { gas, dust, planetesimals: plts, ice, infall, snowLine: snowLineRadius(d) };
  }

  // Mass inside and outside: the radius holding a given fraction of the gas.
  function radiusHolding(d, frac, arr) {
    arr = arr || d.sigG;
    let tot = 0;
    for (let i = 0; i < NR; i++) tot += arr[i] * d.area[i];
    if (tot <= 0) return 0;
    let acc = 0;
    for (let i = 0; i < NR; i++) {
      acc += arr[i] * d.area[i];
      if (acc >= frac * tot) return d.r[i];
    }
    return d.r[NR - 1];
  }

  // ---- Fiddling --------------------------------------------------------------------------------------
  // Sweep gas and dust out of the rings between r0 and r1 (a fraction f of it).
  function clear(d, r0, r1, f) {
    let removed = 0;
    for (let i = 0; i < NR; i++) {
      if (d.r[i] < r0 || d.r[i] > r1) continue;
      removed += d.sigG[i] * f * d.area[i];
      d.sigG[i] *= 1 - f; d.sigDR[i] *= 1 - f; d.sigDI[i] *= 1 - f; d.sigV[i] *= 1 - f;
    }
    fields(d);
    return removed;
  }
  // Add dust (rock and ice in the usual mix) to the rings between r0 and r1,
  // `earths` Earth masses in all.
  function addDust(d, r0, r1, earths) {
    let a = 0;
    for (let i = 0; i < NR; i++) if (d.r[i] >= r0 && d.r[i] <= r1) a += d.area[i];
    if (a <= 0) return;
    const s = earths * MEARTH / a;
    for (let i = 0; i < NR; i++) {
      if (d.r[i] < r0 || d.r[i] > r1) continue;
      if (d.sigG[i] > 0) {
        // Into the gas disk as dust; water only where it can freeze.
        d.sigDR[i] += s * ROCK;
        if (d.T[i] < T_ICE) d.sigDI[i] += s * (1 - ROCK); else d.sigV[i] += s * (1 - ROCK);
      } else {
        // No gas to hold dust: it goes straight into planetesimals.
        d.sigPR[i] += s * ROCK;
        if (d.T[i] < T_ICE) d.sigPI[i] += s * (1 - ROCK);
      }
    }
    fields(d);
  }

  // ---- Saving ---------------------------------------------------------------------------------------
  function save(d) {
    const o = {};
    for (const k of Object.keys(d)) o[k] = ARRAYS.includes(k) ? d[k].slice() : JSON.parse(JSON.stringify(d[k]));
    return o;
  }
  function restore(o) {
    const d = {};
    for (const k of Object.keys(o)) d[k] = ARRAYS.includes(k) ? Float64Array.from(o[k]) : JSON.parse(JSON.stringify(o[k]));
    grid(d);
    fields(d, true);
    return d;
  }

  return {
    NR, R_IN, R_OUT, MEARTH, MJUP, G, SIG_CGS, T_ICE, ROCK, SETTINGS, clampSettings,
    fromCollapse, synthetic, step, fields, maxDt, totals, radiusHolding, snowLineRadius, cellOf,
    removeGas, clear, addDust, metallicity, save, restore, updateStar,
  };
});
