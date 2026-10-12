// The cloud core collapsing under its own gravity.
//
// Gas is a set of SPH particles (smoothed particle hydrodynamics): each has a
// fixed mass, and density, pressure and viscosity come from its neighbours.
// Gravity between all particles uses a Barnes-Hut octree. The gas is
// isothermal while thin and stiffens once dense (a barotropic equation of
// state, standard in collapse calculations), and is warmed by the light of
// any protostar near it. Where the gas gets dense enough a sink particle
// forms: a protostar, which swallows gas that falls inside its accretion
// radius bound to it with too little spin to orbit (Bate, Bonnell & Price
// 1995). Gas with more spin settles into a rotating disk around it.
//
// Each particle keeps its own time step, a power-of-two fraction of the
// longest (block time steps): slow gas far out takes long steps and only the
// gas whirling close to a protostar takes short ones. A particle whose
// neighbours step much faster is woken early (Saitoh & Makino 2009), so a
// shock can't run through gas that isn't looking.
//
// Units: G = 1, the starting cloud's mass is 1 and its radius is 1. `units`
// says what that is in AU, solar masses, years and km/s.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.CloudFactory = factory;
})(this, function CloudFactory(Rng) {
  'use strict';

  const CLOUD_AU = 1500;             // the core's starting radius
  const LEAF = 8, MAX_DEPTH = 26;
  const THETA2 = 0.7 * 0.7;
  const EPS = 0.006;                 // gravitational softening between gas parcels
  const ETA = 1.05;                  // smoothing length per particle spacing (~38 neighbours)
  const H_MIN = 0.005, H_MAX = 0.12;
  const MAX_NB = 160;
  const RHO_STIFF = 4000;            // above this the gas stops cooling freely (mean cloud density is 3/4π)
  const RHO_SINK = 1500;             // a protostar forms where gas gets this dense
  const R_ACC = 0.015;               // a protostar's accretion radius (about 22 AU)
  const SINK_EPS = 0.004;            // softening of a protostar's gravity
  const AV_ALPHA = 1, AV_BETA = 2;
  const C_COURANT = 0.3, C_ACCEL = 0.3;
  const MAX_LEVEL = 16;              // shortest step is DT_MAX / 2^16
  const DT_MAX = 0.01;
  const TICKS = Math.pow(2, MAX_LEVEL);
  const DTICK = DT_MAX / TICKS;
  const R_ESCAPE = 4;
  const MU_KMS = 0.188;              // isothermal sound speed at 10 K, km/s (mean molecular weight 2.33)
  const KMS_AUYR = 0.2108;           // 1 km/s in AU per year
  const G_AU = 4 * Math.PI * Math.PI;// G in AU^3 / (Msun yr^2)

  // ---- Octree ------------------------------------------------------------------
  function makeTree(cap0) {
    let cap = 0, ncx, ncy, ncz, nhf, nm, nmx, nmy, nmz, nh, child, first, leaf;
    let next = new Int32Array(cap0);
    const stack = new Int32Array(2048);
    let count = 0, X, Y, Z, H, M;
    let leaves = new Int32Array(cap0), nLeaves = 0;
    let nodeList = new Int32Array(4096), bodyList = new Int32Array(4096);

    function alloc(c) {
      cap = c;
      ncx = new Float64Array(c); ncy = new Float64Array(c); ncz = new Float64Array(c);
      nhf = new Float64Array(c); nm = new Float64Array(c);
      nmx = new Float64Array(c); nmy = new Float64Array(c); nmz = new Float64Array(c);
      nh = new Float64Array(c); child = new Int32Array(c * 8);
      first = new Int32Array(c); leaf = new Uint8Array(c);
    }
    alloc(cap0 * 2 + 64);

    function grow(a, need) {
      if (need <= a.length) return a;
      const b = new Int32Array(Math.max(need, a.length * 2));
      b.set(a);
      return b;
    }
    function newNode(cx, cy, cz, hf) {
      if (count >= cap) throw new RangeError('tree full');
      const k = count++;
      ncx[k] = cx; ncy[k] = cy; ncz[k] = cz; nhf[k] = hf;
      child.fill(-1, k * 8, k * 8 + 8);
      first[k] = -1; leaf[k] = 1;
      return k;
    }
    function insertChild(nd, i, depth) {
      const o = (X[i] > ncx[nd] ? 1 : 0) | (Y[i] > ncy[nd] ? 2 : 0) | (Z[i] > ncz[nd] ? 4 : 0);
      let c = child[nd * 8 + o];
      if (c < 0) {
        const q = nhf[nd] / 2;
        c = newNode(ncx[nd] + (o & 1 ? q : -q), ncy[nd] + (o & 2 ? q : -q), ncz[nd] + (o & 4 ? q : -q), q);
        child[nd * 8 + o] = c;
      }
      insert(c, i, depth + 1);
    }
    function insert(nd, i, depth) {
      if (!leaf[nd]) { insertChild(nd, i, depth); return; }
      next[i] = first[nd]; first[nd] = i;
      let k = 0;
      for (let b = first[nd]; b !== -1 && k <= LEAF; b = next[b]) k++;
      if (k > LEAF && depth < MAX_DEPTH) {
        leaf[nd] = 0;
        let b = first[nd]; first[nd] = -1;
        while (b !== -1) { const nb = next[b]; insertChild(nd, b, depth); b = nb; }
      }
    }
    function moments(nd) {
      let m = 0, mx = 0, my = 0, mz = 0, hm = 0;
      if (leaf[nd]) {
        for (let b = first[nd]; b !== -1; b = next[b]) {
          m += M; mx += M * X[b]; my += M * Y[b]; mz += M * Z[b];
          if (H[b] > hm) hm = H[b];
        }
      } else {
        for (let o = 0; o < 8; o++) {
          const c = child[nd * 8 + o];
          if (c < 0) continue;
          moments(c);
          m += nm[c]; mx += nm[c] * nmx[c]; my += nm[c] * nmy[c]; mz += nm[c] * nmz[c];
          if (nh[c] > hm) hm = nh[c];
        }
      }
      nm[nd] = m; nh[nd] = hm;
      if (m > 0) { nmx[nd] = mx / m; nmy[nd] = my / m; nmz[nd] = mz / m; }
      else { nmx[nd] = ncx[nd]; nmy[nd] = ncy[nd]; nmz[nd] = ncz[nd]; }
      if (leaf[nd] && first[nd] !== -1) leaves[nLeaves++] = nd;
    }

    function build(s) {
      X = s.x; Y = s.y; Z = s.z; H = s.h; M = s.m;
      if (next.length < s.cap) next = new Int32Array(s.cap);
      if (leaves.length < s.cap) leaves = new Int32Array(s.cap);
      nLeaves = 0;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, any = false;
      for (let i = 0; i < s.n; i++) {
        if (!s.alive[i]) continue;
        any = true;
        if (X[i] < x0) x0 = X[i]; if (X[i] > x1) x1 = X[i];
        if (Y[i] < y0) y0 = Y[i]; if (Y[i] > y1) y1 = Y[i];
        if (Z[i] < z0) z0 = Z[i]; if (Z[i] > z1) z1 = Z[i];
      }
      if (!any) { x0 = y0 = z0 = -1; x1 = y1 = z1 = 1; }
      const hf = Math.max(x1 - x0, y1 - y0, z1 - z0, 1e-6) * 0.5001;
      for (;;) {
        try {
          count = 0;
          newNode((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, hf);
          for (let i = 0; i < s.n; i++) if (s.alive[i]) insert(0, i, 0);
          break;
        } catch (e) {
          if (!(e instanceof RangeError) || cap > s.cap * 64) throw e;
          alloc(cap * 2);
        }
      }
      moments(0);
    }

    // The bounding box of a leaf's active particles; false if it has none.
    const box = new Float64Array(7);
    function activeBox(lf, act) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, hm = 0;
      for (let b = first[lf]; b !== -1; b = next[b]) {
        if (!act[b]) continue;
        if (X[b] < x0) x0 = X[b]; if (X[b] > x1) x1 = X[b];
        if (Y[b] < y0) y0 = Y[b]; if (Y[b] > y1) y1 = Y[b];
        if (Z[b] < z0) z0 = Z[b]; if (Z[b] > z1) z1 = Z[b];
        if (H[b] > hm) hm = H[b];
      }
      if (x0 === Infinity) return false;
      box[0] = 0.5 * (x0 + x1); box[1] = 0.5 * (y0 + y1); box[2] = 0.5 * (z0 + z1);
      box[3] = 0.5 * (x1 - x0); box[4] = 0.5 * (y1 - y0); box[5] = 0.5 * (z1 - z0); box[6] = hm;
      return true;
    }

    // Gravity on every active particle, walking the tree once per leaf rather
    // than once per particle: the leaf's particles share one list of nodes far
    // enough away to treat as points, and one list of particles near enough
    // to add up one by one.
    function gravity(act, AX, AY, AZ) {
      const e2 = EPS * EPS;
      for (let L = 0; L < nLeaves; L++) {
        const lf = leaves[L];
        if (!activeBox(lf, act)) continue;
        const gx = box[0], gy = box[1], gz = box[2];
        const gr = Math.sqrt(box[3] * box[3] + box[4] * box[4] + box[5] * box[5]);
        let nn = 0, nb = 0, sp = 0;
        stack[sp++] = 0;
        while (sp) {
          const nd = stack[--sp];
          if (nd === lf) continue;
          const dx = nmx[nd] - gx, dy = nmy[nd] - gy, dz = nmz[nd] - gz;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const ox = nmx[nd] - ncx[nd], oy = nmy[nd] - ncy[nd], oz = nmz[nd] - ncz[nd];
          const dd = d - Math.sqrt(ox * ox + oy * oy + oz * oz) - gr;
          const size = 2 * nhf[nd];
          if (dd > 0 && size * size < THETA2 * dd * dd) {
            nodeList = grow(nodeList, nn + 1);
            nodeList[nn++] = nd;
          } else if (leaf[nd]) {
            for (let b = first[nd]; b !== -1; b = next[b]) { bodyList = grow(bodyList, nb + 1); bodyList[nb++] = b; }
          } else {
            for (let o = 0; o < 8; o++) { const c = child[nd * 8 + o]; if (c >= 0) stack[sp++] = c; }
          }
        }
        for (let i = first[lf]; i !== -1; i = next[i]) {
          if (!act[i]) continue;
          const px = X[i], py = Y[i], pz = Z[i];
          let ax = 0, ay = 0, az = 0;
          for (let k = 0; k < nn; k++) {
            const nd = nodeList[k];
            const dx = nmx[nd] - px, dy = nmy[nd] - py, dz = nmz[nd] - pz;
            const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz + e2);
            const f = nm[nd] * inv * inv * inv;
            ax += f * dx; ay += f * dy; az += f * dz;
          }
          let sx = 0, sy = 0, sz = 0;
          for (let k = 0; k < nb; k++) {
            const b = bodyList[k];
            const dx = X[b] - px, dy = Y[b] - py, dz = Z[b] - pz;
            const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz + e2);
            const f = inv * inv * inv;
            sx += f * dx; sy += f * dy; sz += f * dz;
          }
          for (let b = first[lf]; b !== -1; b = next[b]) {
            if (b === i) continue;
            const dx = X[b] - px, dy = Y[b] - py, dz = Z[b] - pz;
            const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz + e2);
            const f = inv * inv * inv;
            sx += f * dx; sy += f * dy; sz += f * dz;
          }
          AX[i] = ax + M * sx; AY[i] = ay + M * sy; AZ[i] = az + M * sz;
        }
      }
    }

    // For every active particle i, every particle j within 2 max(h_i, h_j):
    // those it reaches and those that reach it. Done a leaf at a time.
    // Writes particle i's list to list[i * max ...] and its length to counts[i].
    function neighbours(act, list, counts, max) {
      for (let L = 0; L < nLeaves; L++) {
        const lf = leaves[L];
        if (!activeBox(lf, act)) continue;
        const bx = box[0], by = box[1], bz = box[2], hx = box[3], hy = box[4], hz = box[5], hA = box[6];
        let nc = 0, sp = 0;
        stack[sp++] = 0;
        while (sp) {
          const nd = stack[--sp];
          const R = 2 * Math.max(hA, nh[nd]), hf = nhf[nd];
          const dx = Math.max(0, Math.abs(ncx[nd] - bx) - hf - hx);
          const dy = Math.max(0, Math.abs(ncy[nd] - by) - hf - hy);
          const dz = Math.max(0, Math.abs(ncz[nd] - bz) - hf - hz);
          if (dx * dx + dy * dy + dz * dz > R * R) continue;
          if (leaf[nd]) {
            for (let b = first[nd]; b !== -1; b = next[b]) {
              const r = 2 * Math.max(hA, H[b]);
              const ex = Math.max(0, Math.abs(X[b] - bx) - hx), ey = Math.max(0, Math.abs(Y[b] - by) - hy), ez = Math.max(0, Math.abs(Z[b] - bz) - hz);
              if (ex * ex + ey * ey + ez * ez > r * r) continue;
              bodyList = grow(bodyList, nc + 1);
              bodyList[nc++] = b;
            }
          } else {
            for (let o = 0; o < 8; o++) { const c = child[nd * 8 + o]; if (c >= 0) stack[sp++] = c; }
          }
        }
        for (let i = first[lf]; i !== -1; i = next[i]) {
          if (!act[i]) continue;
          const px = X[i], py = Y[i], pz = Z[i], hi = H[i], base = i * max;
          let k = 0;
          for (let c = 0; c < nc; c++) {
            const b = bodyList[c];
            if (b === i) continue;
            const ex = X[b] - px, ey = Y[b] - py, ez = Z[b] - pz;
            const r = 2 * Math.max(hi, H[b]);
            if (ex * ex + ey * ey + ez * ez < r * r && k < max) list[base + k++] = b;
          }
          counts[i] = k;
        }
      }
    }

    return { build, gravity, neighbours };
  }

  // Cubic spline kernel and its radial derivative, 3D.
  function kernelW(r, h) {
    const q = r / h, s = 1 / (Math.PI * h * h * h);
    if (q < 1) return s * (1 - 1.5 * q * q + 0.75 * q * q * q);
    if (q < 2) { const u = 2 - q; return s * 0.25 * u * u * u; }
    return 0;
  }
  function kernelDW(r, h) {
    const q = r / h, s = 1 / (Math.PI * h * h * h * h);
    if (q < 1) return s * (-3 * q + 2.25 * q * q);
    if (q < 2) { const u = 2 - q; return -s * 0.75 * u * u; }
    return 0;
  }

  // ---- Settings and units ---------------------------------------------------------
  // What can be set for a new cloud: [default, least, most].
  const SETTINGS = {
    mass: [1.5, 0.3, 6],        // solar masses
    temp: [31, 8, 100],         // kelvin, before the gas is squeezed or lit
    spin: [0.02, 0.0, 0.12],    // rotational energy over gravitational energy (median for dense cores ~0.02, Goodman et al. 1993)
    turb: [0.25, 0, 1],         // turbulent energy over gravitational energy, in tenths
    lumps: [0.05, 0, 0.5],      // strength of a two-armed density ripple
  };

  function unitsFor(massSun) {
    return {
      au: CLOUD_AU,
      msun: massSun,
      years: Math.sqrt(CLOUD_AU * CLOUD_AU * CLOUD_AU / (G_AU * massSun)),
      kms: Math.sqrt(G_AU * massSun / CLOUD_AU) / KMS_AUYR,   // code velocity unit in km/s
    };
  }

  // Squared isothermal sound speed in code units for a temperature.
  function soundSpeed2(tempK, units) {
    const c = MU_KMS * Math.sqrt(tempK / 10) / units.kms;
    return c * c;
  }

  function clampSettings(settings) {
    const set = {};
    for (const k in SETTINGS) {
      const v = settings && settings[k] !== undefined ? +settings[k] : SETTINGS[k][0];
      set[k] = Math.min(SETTINGS[k][2], Math.max(SETTINGS[k][1], Number.isFinite(v) ? v : SETTINGS[k][0]));
    }
    return set;
  }

  // ---- A new cloud -----------------------------------------------------------------
  const FLOATS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'ax', 'ay', 'az', 'h', 'rho', 'pr', 'cs', 'bal', 'divv', 'tiStart', 'tiEnd', 'half'];
  const OTHERS = { temp: Float32Array, alive: Uint8Array, level: Uint8Array, minLevel: Uint8Array };

  function allocParticles(s) {
    for (const k of FLOATS) s[k] = new Float64Array(s.cap);
    for (const k in OTHERS) s[k] = new OTHERS[k](s.cap);
  }

  function create(seed, settings, opts) {
    opts = opts || {};
    const set = clampSettings(settings);
    const rng = Rng.makeRng(seed);
    const n = opts.n || 2000;
    const units = unitsFor(set.mass);
    const s = {
      n, cap: Math.ceil(n * 1.6), m: 1 / n, t: 0, ti: 0, steps: 0, dt: 0, set, units, seed: String(seed),
      c02: soundSpeed2(set.temp, units),
      sinks: [], nextSink: 1, lost: 0, added: 0, events: [], rngState: 0, pull: null,
    };
    allocParticles(s);

    const A = set.lumps;
    for (let i = 0; i < n; i++) {
      let x, y, z;
      for (;;) {
        x = 2 * rng.next() - 1; y = 2 * rng.next() - 1; z = 2 * rng.next() - 1;
        if (x * x + y * y + z * z > 1) continue;
        const phi = Math.atan2(y, x);
        if (rng.next() * (1 + A) < 1 + A * Math.cos(2 * phi)) break;
      }
      s.x[i] = x; s.y[i] = y; s.z[i] = z; s.alive[i] = 1;
    }

    // Solid-body rotation plus a few large, divergence-free turbulent modes.
    const omega = Math.sqrt(3 * set.spin);
    const modes = [];
    for (let k = 0; k < 12; k++) {
      const ct = 2 * rng.next() - 1, ph = 2 * Math.PI * rng.next(), st = Math.sqrt(1 - ct * ct);
      const kx = st * Math.cos(ph), ky = st * Math.sin(ph), kz = ct;
      let ux = rng.next() - 0.5, uy = rng.next() - 0.5, uz = rng.next() - 0.5;
      const d = ux * kx + uy * ky + uz * kz;
      ux -= d * kx; uy -= d * ky; uz -= d * kz;
      const un = Math.hypot(ux, uy, uz) || 1;
      const kk = Math.PI * (1 + 2 * rng.next());
      modes.push([kx * kk, ky * kk, kz * kk, ux / un, uy / un, uz / un, 2 * Math.PI * rng.next()]);
    }
    let sum2 = 0;
    for (let i = 0; i < n; i++) {
      let tx = 0, ty = 0, tz = 0;
      for (const md of modes) {
        const c = Math.cos(md[0] * s.x[i] + md[1] * s.y[i] + md[2] * s.z[i] + md[6]);
        tx += md[3] * c; ty += md[4] * c; tz += md[5] * c;
      }
      s.vx[i] = tx; s.vy[i] = ty; s.vz[i] = tz;
      sum2 += tx * tx + ty * ty + tz * tz;
    }
    // Turbulent kinetic energy = turb/10 of |E_grav| (0.6 for a uniform sphere).
    const vrms = Math.sqrt(2 * (set.turb / 10) * 0.6);
    const tscale = vrms / Math.sqrt(sum2 / n || 1);
    for (let i = 0; i < n; i++) {
      s.vx[i] = s.vx[i] * tscale - omega * s.y[i];
      s.vy[i] = s.vy[i] * tscale + omega * s.x[i];
      s.vz[i] *= tscale;
    }
    removeDrift(s);
    alignSpin(s);

    s.rngState = rng.state;
    const h0 = ETA * Math.cbrt(s.m / (3 / (4 * Math.PI)));
    s.h.fill(h0, 0, n);
    setup(s);
    startAll(s);
    return s;
  }

  // Working memory that isn't part of the saved state.
  function setup(s) {
    const work = {
      tree: makeTree(s.cap),
      nbList: new Int32Array(s.cap * MAX_NB),
      nbCount: new Int32Array(s.cap),
      act: new Uint8Array(s.cap), actList: new Int32Array(s.cap),
      gx: new Float64Array(s.cap), gy: new Float64Array(s.cap), gz: new Float64Array(s.cap),
      vpx: new Float64Array(s.cap), vpy: new Float64Array(s.cap), vpz: new Float64Array(s.cap),
      tau: new Float64Array(s.cap), dtWant: new Float64Array(s.cap),
    };
    for (const k in work) Object.defineProperty(s, k, { value: work[k], enumerable: false, writable: true });
  }

  function removeDrift(s) {
    let px = 0, py = 0, pz = 0, cx = 0, cy = 0, cz = 0, k = 0;
    for (let i = 0; i < s.n; i++) {
      if (!s.alive[i]) continue;
      px += s.vx[i]; py += s.vy[i]; pz += s.vz[i];
      cx += s.x[i]; cy += s.y[i]; cz += s.z[i]; k++;
    }
    if (!k) return;
    for (let i = 0; i < s.n; i++) {
      s.vx[i] -= px / k; s.vy[i] -= py / k; s.vz[i] -= pz / k;
      s.x[i] -= cx / k; s.y[i] -= cy / k; s.z[i] -= cz / k;
    }
  }

  // Turbulence adds spin in a random direction; turn the cloud so its total
  // spin points along +z, which is where its disk will lie.
  function alignSpin(s) {
    let lx = 0, ly = 0, lz = 0;
    for (let i = 0; i < s.n; i++) {
      lx += s.y[i] * s.vz[i] - s.z[i] * s.vy[i];
      ly += s.z[i] * s.vx[i] - s.x[i] * s.vz[i];
      lz += s.x[i] * s.vy[i] - s.y[i] * s.vx[i];
    }
    const L = Math.hypot(lx, ly, lz);
    if (!(L > 0)) return;
    const ux = lx / L, uy = ly / L, uz = lz / L;
    let kx = uy, ky = -ux; const sn = Math.hypot(kx, ky), cs = uz;
    if (sn < 1e-9) return;
    kx /= sn; ky /= sn;
    const rot = (ax, ay, az) => {   // Rodrigues' rotation about k = (kx, ky, 0)
      const kd = kx * ax + ky * ay;
      const cxv = ky * az, cyv = -kx * az, czv = kx * ay - ky * ax;
      return [ax * cs + cxv * sn + kx * kd * (1 - cs), ay * cs + cyv * sn + ky * kd * (1 - cs), az * cs + czv * sn];
    };
    for (let i = 0; i < s.n; i++) {
      const p = rot(s.x[i], s.y[i], s.z[i]); s.x[i] = p[0]; s.y[i] = p[1]; s.z[i] = p[2];
      const v = rot(s.vx[i], s.vy[i], s.vz[i]); s.vx[i] = v[0]; s.vy[i] = v[1]; s.vz[i] = v[2];
    }
  }

  // ---- Protostar light ----------------------------------------------------------------
  // A protostar's luminosity in solar units: its own (rising with mass) plus
  // the energy of gas landing on it, G M Mdot / R with R about 2.5 solar radii.
  function sinkLuminosity(sk, units) {
    const mSun = sk.m * units.msun;
    const mdot = Math.max(0, sk.mdot) * units.msun / units.years;   // Msun per year
    const lAcc = 1.2566e7 * mSun * mdot;                             // G Msun (Msun/yr) / 2.5 Rsun, in Lsun
    return 2 * mSun * mSun + lAcc;
  }

  // ---- Forces on the active particles ------------------------------------------------
  // Density, pressure, gravity, viscosity, and the time step each wants next.
  function forces(s, nAct) {
    const { x, y, z, vpx, vpy, vpz, h, rho, pr, cs, bal, divv, act, actList, tree, nbList, nbCount, units } = s;
    const m = s.m, c02 = s.c02, T0 = s.set.temp;
    tree.build(s);
    tree.neighbours(act, nbList, nbCount, MAX_NB);

    // Light from the protostars: a temperature floor falling off as r^-1/2.
    const lights = s.sinks.map((sk) => ({ x: sk.x, y: sk.y, z: sk.z, l4: Math.sqrt(Math.sqrt(sinkLuminosity(sk, units))) }));

    // Density, temperature, sound speed, and the Balsara switch (which keeps
    // artificial viscosity for shocks and off a disk's smooth shear).
    for (let a = 0; a < nAct; a++) {
      const i = actList[a];
      const base = i * MAX_NB, k = nbCount[i], hi = h[i];
      let r = m * kernelW(0, hi), div = 0, cx = 0, cy = 0, cz = 0;
      for (let q = 0; q < k; q++) {
        const j = nbList[base + q];
        const dx = x[i] - x[j], dy = y[i] - y[j], dz = z[i] - z[j];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d >= 2 * hi || d === 0) continue;
        r += m * kernelW(d, hi);
        const g = m * kernelDW(d, hi) / d;
        const ux = vpx[i] - vpx[j], uy = vpy[i] - vpy[j], uz = vpz[i] - vpz[j];
        div -= g * (ux * dx + uy * dy + uz * dz);
        cx += g * (uy * dz - uz * dy); cy += g * (uz * dx - ux * dz); cz += g * (ux * dy - uy * dx);
      }
      rho[i] = r;
      divv[i] = div / r;
      let tFloor = 0;
      for (const L of lights) {
        const rAU = Math.max(1, Math.hypot(x[i] - L.x, y[i] - L.y, z[i] - L.z) * units.au);
        const t = 280 * L.l4 / Math.sqrt(rAU);
        tFloor += t * t * t * t;
      }
      tFloor = Math.min(1500, Math.sqrt(Math.sqrt(tFloor)));
      const st = Math.pow(r / RHO_STIFF, 0.4);
      const tBaro = T0 * (1 + st);
      const T = Math.max(tBaro, tFloor);
      s.temp[i] = T;
      const c2 = c02 * T / T0;
      pr[i] = c2 * r;
      cs[i] = Math.sqrt(c2 * (T === tBaro ? 1 + 1.4 * st / (1 + st) : 1));
      const ad = Math.abs(div), ac = Math.hypot(cx, cy, cz);
      bal[i] = ad / (ad + ac + 1e-4 * cs[i] * r / hi);
    }

    // Gravity, pressure and viscosity.
    tree.gravity(act, s.gx, s.gy, s.gz);
    const se2 = SINK_EPS * SINK_EPS;
    const pull = s.pull;
    for (let a = 0; a < nAct; a++) {
      const i = actList[a];
      let ax = s.gx[i], ay = s.gy[i], az = s.gz[i];
      for (const sk of s.sinks) {
        const dx = sk.x - x[i], dy = sk.y - y[i], dz = sk.z - z[i];
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz + se2);
        const f = sk.m * inv * inv * inv;
        ax += f * dx; ay += f * dy; az += f * dz;
      }
      if (pull) {
        const dx = pull.x - x[i], dy = pull.y - y[i], dz = pull.z - z[i];
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz + pull.soft * pull.soft);
        const f = pull.m * inv * inv * inv;
        ax += f * dx; ay += f * dy; az += f * dz;
      }
      const base = i * MAX_NB, k = nbCount[i];
      const pi = pr[i] / (rho[i] * rho[i]);
      let vsig = cs[i];
      for (let q = 0; q < k; q++) {
        const j = nbList[base + q];
        const dx = x[i] - x[j], dy = y[i] - y[j], dz = z[i] - z[j];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const hij = 0.5 * (h[i] + h[j]);
        if (d >= 2 * hij || d === 0) continue;
        const dw = kernelDW(d, hij);
        const w = (vpx[i] - vpx[j]) * dx + (vpy[i] - vpy[j]) * dy + (vpz[i] - vpz[j]) * dz;
        let visc = 0;
        if (w < 0) {
          const mu = hij * w / (d * d + 0.01 * hij * hij);
          const cbar = 0.5 * (cs[i] + cs[j]), rbar = 0.5 * (rho[i] + rho[j]);
          visc = 0.5 * (bal[i] + bal[j]) * (-AV_ALPHA * cbar * mu + AV_BETA * mu * mu) / rbar;
        }
        const f = -m * (pi + pr[j] / (rho[j] * rho[j]) + visc) * dw / d;
        ax += f * dx; ay += f * dy; az += f * dz;
        const v = cs[i] + cs[j] - 3 * Math.min(0, w / d);
        if (v > vsig) vsig = v;
      }
      s.ax[i] = ax; s.ay[i] = ay; s.az[i] = az;
      s.dtWant[i] = Math.min(DT_MAX, C_COURANT * h[i] / vsig, C_ACCEL * Math.sqrt(h[i] / (Math.hypot(ax, ay, az) + 1e-12)));
    }

    // New smoothing lengths for the next step, from this step's density.
    for (let a = 0; a < nAct; a++) {
      const i = actList[a];
      const target = ETA * Math.cbrt(m / rho[i]);
      h[i] = Math.min(H_MAX, Math.max(H_MIN, Math.min(h[i] * 1.2, Math.max(h[i] * 0.8, target))));
    }
  }

  // The level (time step 2^-level of the longest) a particle may take next,
  // starting at tick `ti`: no longer than it wants, at most twice its last,
  // no slower than two levels below its fastest neighbour, and lined up so
  // the step ends on a multiple of its own length.
  function chooseLevel(s, i, ti) {
    let L = Math.ceil(Math.log2(DT_MAX / Math.max(s.dtWant[i], DTICK)));
    L = Math.max(L, s.level[i] - 1, s.minLevel[i]);
    const base = i * MAX_NB, k = s.nbCount[i];
    for (let q = 0; q < k; q++) {
      const lj = s.level[s.nbList[base + q]] - 2;
      if (lj > L) L = lj;
    }
    L = Math.max(0, Math.min(MAX_LEVEL, L));
    while (L < MAX_LEVEL && ti % Math.pow(2, MAX_LEVEL - L) !== 0) L++;
    return L;
  }

  // Wake any neighbour stepping much slower than particle i now will, so it
  // ends its step at the next chance.
  function wakeNeighbours(s, i, ti) {
    const base = i * MAX_NB, k = s.nbCount[i], want = s.level[i] - 2;
    if (want <= 0) return;
    const st = Math.pow(2, MAX_LEVEL - want);
    const end = ti - (ti % st) + st;
    for (let q = 0; q < k; q++) {
      const j = s.nbList[base + q];
      if (s.act[j] || s.level[j] >= want) continue;
      if (end < s.tiEnd[j]) s.tiEnd[j] = end;
      if (s.minLevel[j] < want) s.minLevel[j] = want;
    }
  }

  // Velocities predicted to the current moment, for every particle: each
  // holds its mid-step velocity, so add its acceleration over the time since.
  function predict(s) {
    const { n, alive, vx, vy, vz, ax, ay, az, vpx, vpy, vpz, tiStart, half } = s;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const dtp = (s.ti - tiStart[i]) * DTICK - half[i];
      vpx[i] = vx[i] + ax[i] * dtp; vpy[i] = vy[i] + ay[i] * dtp; vpz[i] = vz[i] + az[i] * dtp;
    }
  }

  // Forces on the protostars, from all the gas and from each other.
  function sinkForces(s) {
    const se2 = SINK_EPS * SINK_EPS, m = s.m;
    let dtS = DT_MAX;
    for (const sk of s.sinks) {
      let ax = 0, ay = 0, az = 0;
      for (let i = 0; i < s.n; i++) {
        if (!s.alive[i]) continue;
        const dx = s.x[i] - sk.x, dy = s.y[i] - sk.y, dz = s.z[i] - sk.z;
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz + se2);
        const f = m * inv * inv * inv;
        ax += f * dx; ay += f * dy; az += f * dz;
      }
      sk.ax = ax; sk.ay = ay; sk.az = az;
    }
    for (let a = 0; a < s.sinks.length; a++) {
      for (let b = a + 1; b < s.sinks.length; b++) {
        const A = s.sinks[a], B = s.sinks[b];
        const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
        const r2 = dx * dx + dy * dy + dz * dz;
        const inv = 1 / Math.sqrt(r2 + se2);
        const f = inv * inv * inv;
        A.ax += B.m * f * dx; A.ay += B.m * f * dy; A.az += B.m * f * dz;
        B.ax -= A.m * f * dx; B.ay -= A.m * f * dy; B.az -= A.m * f * dz;
        const tOrb = Math.sqrt((r2 + se2) * Math.sqrt(r2 + se2) / (A.m + B.m));
        dtS = Math.min(dtS, 0.02 * tOrb);
      }
    }
    s.dtSinks = dtS;
  }

  // Every particle starts a step now (at the beginning, or after a shake-up).
  function startAll(s) {
    let nAct = 0;
    for (let i = 0; i < s.n; i++) {
      s.act[i] = s.alive[i];
      if (s.alive[i]) s.actList[nAct++] = i;
      s.tiStart[i] = s.ti; s.half[i] = 0; s.level[i] = 0; s.minLevel[i] = 0;
    }
    predict(s);
    forces(s, nAct);
    sinkForces(s);
    for (let a = 0; a < nAct; a++) {
      const i = s.actList[a];
      begin(s, i, s.ti);
    }
  }

  // Begin a particle's next step at tick ti: pick its length and give it the
  // first half of its kick.
  function begin(s, i, ti) {
    const L = chooseLevel(s, i, ti);
    s.level[i] = L; s.minLevel[i] = 0;
    const st = Math.pow(2, MAX_LEVEL - L);
    const dt = st * DTICK;
    s.vx[i] += s.ax[i] * dt / 2; s.vy[i] += s.ay[i] * dt / 2; s.vz[i] += s.az[i] * dt / 2;
    s.half[i] = dt / 2;
    s.tiStart[i] = ti; s.tiEnd[i] = ti + st;
  }

  // ---- Protostars ----------------------------------------------------------------------
  function absorb(s, sk, i) {
    const m = s.m, M = sk.m + m;
    sk.x = (sk.m * sk.x + m * s.x[i]) / M; sk.y = (sk.m * sk.y + m * s.y[i]) / M; sk.z = (sk.m * sk.z + m * s.z[i]) / M;
    sk.vx = (sk.m * sk.vx + m * s.vx[i]) / M; sk.vy = (sk.m * sk.vy + m * s.vy[i]) / M; sk.vz = (sk.m * sk.vz + m * s.vz[i]) / M;
    sk.m = M;
    sk.gained += m;
    s.alive[i] = 0;
  }

  function newSink(s, i) {
    const sk = {
      id: s.nextSink++, x: s.x[i], y: s.y[i], z: s.z[i], vx: s.vx[i], vy: s.vy[i], vz: s.vz[i],
      m: 0, ax: 0, ay: 0, az: 0, born: s.t, gained: 0, mdot: 0,
    };
    for (let j = 0; j < s.n; j++) {
      if (!s.alive[j]) continue;
      const dx = s.x[j] - sk.x, dy = s.y[j] - sk.y, dz = s.z[j] - sk.z;
      if (dx * dx + dy * dy + dz * dz < R_ACC * R_ACC) absorb(s, sk, j);
    }
    s.sinks.push(sk);
    s.events.push({ kind: 'protostar', id: sk.id, count: s.sinks.length, t: s.t });
  }

  function accrete(s) {
    const { n, x, y, z, vx, vy, vz, rho, alive } = s;
    // A new protostar: the densest collapsing gas that isn't already next to one.
    let best = -1;
    for (let i = 0; i < n; i++) {
      if (!alive[i] || rho[i] < RHO_SINK || s.divv[i] >= 0) continue;
      if (best >= 0 && rho[i] <= rho[best]) continue;
      let clear = true;
      for (const sk of s.sinks) {
        const dx = x[i] - sk.x, dy = y[i] - sk.y, dz = z[i] - sk.z;
        if (dx * dx + dy * dy + dz * dz < 4 * R_ACC * R_ACC) { clear = false; break; }
      }
      if (clear) best = i;
    }
    if (best >= 0) newSink(s, best);

    if (!s.sinks.length) return;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      let near = null, nr2 = R_ACC * R_ACC;
      for (const sk of s.sinks) {
        const dx = x[i] - sk.x, dy = y[i] - sk.y, dz = z[i] - sk.z;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 < nr2) { nr2 = r2; near = sk; }
      }
      if (!near) continue;
      const dx = x[i] - near.x, dy = y[i] - near.y, dz = z[i] - near.z;
      const r = Math.sqrt(nr2);
      const ux = vx[i] - near.vx, uy = vy[i] - near.vy, uz = vz[i] - near.vz;
      const energy = 0.5 * (ux * ux + uy * uy + uz * uz) - near.m / r;
      const j = Math.hypot(dy * uz - dz * uy, dz * ux - dx * uz, dx * uy - dy * ux);
      if (r < 0.5 * R_ACC || (energy < 0 && j < Math.sqrt(near.m * R_ACC))) absorb(s, near, i);
    }

    // Two protostars closer than we can follow, and bound, become one.
    for (let a = 0; a < s.sinks.length; a++) {
      for (let b = a + 1; b < s.sinks.length; b++) {
        const A = s.sinks[a], B = s.sinks[b];
        const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (r > 0.5 * R_ACC) continue;
        const ux = B.vx - A.vx, uy = B.vy - A.vy, uz = B.vz - A.vz;
        if (0.5 * (ux * ux + uy * uy + uz * uz) - (A.m + B.m) / Math.max(r, 1e-6) > 0) continue;
        const M = A.m + B.m;
        A.x = (A.m * A.x + B.m * B.x) / M; A.y = (A.m * A.y + B.m * B.y) / M; A.z = (A.m * A.z + B.m * B.z) / M;
        A.vx = (A.m * A.vx + B.m * B.vx) / M; A.vy = (A.m * A.vy + B.m * B.vy) / M; A.vz = (A.m * A.vz + B.m * B.vz) / M;
        A.m = M; A.gained += B.gained;
        s.sinks.splice(b, 1);
        s.events.push({ kind: 'merge', id: A.id, other: B.id, t: s.t });
        b--;
      }
    }
  }

  // ---- One step: to the next moment any particle's step ends -------------------------
  function step(s) {
    const { n, x, y, z, vx, vy, vz, alive, tiEnd } = s;
    const ti = s.ti;
    let next = Infinity;
    for (let i = 0; i < n; i++) if (alive[i] && tiEnd[i] < next) next = tiEnd[i];
    if (s.sinks.length) {
      let st = Math.pow(2, Math.floor(Math.log2(Math.max(1, (s.dtSinks || DT_MAX) / DTICK))));
      st = Math.min(st, TICKS);
      const nx = ti - (ti % st) + st;
      if (nx < next) next = nx;
    }
    if (!Number.isFinite(next)) next = ti - (ti % TICKS) + TICKS;
    const dt = (next - ti) * DTICK;

    // Protostars: first half kick. Then everything drifts to the new moment.
    for (const sk of s.sinks) {
      sk.vx += sk.ax * dt / 2; sk.vy += sk.ay * dt / 2; sk.vz += sk.az * dt / 2;
      sk.x += sk.vx * dt; sk.y += sk.vy * dt; sk.z += sk.vz * dt;
      sk.gained = 0;
    }
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      x[i] += vx[i] * dt; y[i] += vy[i] * dt; z[i] += vz[i] * dt;
    }
    s.ti = next; s.t = (s.tiBase || 0) + next * DTICK; s.dt = dt; s.steps++;
    if (s.ti >= TICKS * 1024) rebase(s);

    accrete(s);
    // Gas thrown far out, or broken, leaves the simulation.
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const r2 = x[i] * x[i] + y[i] * y[i] + z[i] * z[i];
      if (!(r2 < R_ESCAPE * R_ESCAPE) || !Number.isFinite(vx[i] + vy[i] + vz[i])) { alive[i] = 0; s.lost += s.m; }
    }

    // Particles whose step ends now.
    let nAct = 0;
    const tiNow = s.ti;
    for (let i = 0; i < n; i++) {
      const on = alive[i] && tiEnd[i] <= tiNow ? 1 : 0;
      s.act[i] = on;
      if (on) s.actList[nAct++] = i;
    }
    predict(s);
    // Settle the first half kick: it assumed the whole planned step, and a
    // woken particle stops short.
    for (let a = 0; a < nAct; a++) {
      const i = s.actList[a];
      const tau = (tiNow - s.tiStart[i]) * DTICK;
      s.tau[i] = tau;
      const c = tau / 2 - s.half[i];
      vx[i] += s.ax[i] * c; vy[i] += s.ay[i] * c; vz[i] += s.az[i] * c;
    }
    if (nAct) forces(s, nAct);
    for (let a = 0; a < nAct; a++) {
      const i = s.actList[a];
      const c = s.tau[i] / 2;
      vx[i] += s.ax[i] * c; vy[i] += s.ay[i] * c; vz[i] += s.az[i] * c;
    }
    for (let a = 0; a < nAct; a++) begin(s, s.actList[a], tiNow);
    for (let a = 0; a < nAct; a++) wakeNeighbours(s, s.actList[a], tiNow);

    // Protostars: forces now, second half kick, accretion rates.
    sinkForces(s);
    const k = Math.min(1, dt / 0.03);
    for (let a = s.sinks.length - 1; a >= 0; a--) {
      const sk = s.sinks[a];
      sk.vx += sk.ax * dt / 2; sk.vy += sk.ay * dt / 2; sk.vz += sk.az * dt / 2;
      sk.mdot += k * (sk.gained / Math.max(dt, 1e-9) - sk.mdot);
      if (!Number.isFinite(sk.x + sk.y + sk.z + sk.vx + sk.vy + sk.vz + sk.m)) throw new Error('a protostar\'s position became invalid');
      if (sk.x * sk.x + sk.y * sk.y + sk.z * sk.z > R_ESCAPE * R_ESCAPE) {
        s.sinks.splice(a, 1);
        s.lost += sk.m;
        s.events.push({ kind: 'escape', id: sk.id, mass: sk.m, t: s.t });
      }
    }
  }

  // Keep tick counts small: shift every particle's clock back by a whole
  // number of the longest steps.
  function rebase(s) {
    const shift = s.ti - (s.ti % TICKS);
    for (let i = 0; i < s.n; i++) { s.tiStart[i] -= shift; s.tiEnd[i] -= shift; }
    s.tiBase = (s.tiBase || 0) + shift * DTICK;
    s.ti -= shift;
    s.t = s.tiBase + s.ti * DTICK;
  }

  // Advance by at least `dt` code time units (one step at least).
  function advance(s, dt) {
    const until = s.t + dt;
    do step(s); while (s.t < until);
  }

  // ---- Fiddling ------------------------------------------------------------------------------
  // Particles within `radius` of the line through p along unit vector d.
  function forNear(s, p, d, radius, fn) {
    for (let i = 0; i < s.n; i++) {
      if (!s.alive[i]) continue;
      const rx = s.x[i] - p[0], ry = s.y[i] - p[1], rz = s.z[i] - p[2];
      const along = rx * d[0] + ry * d[1] + rz * d[2];
      const qx = rx - along * d[0], qy = ry - along * d[1], qz = rz - along * d[2];
      const r2 = qx * qx + qy * qy + qz * qz;
      if (r2 < radius * radius) fn(i, 1 - Math.sqrt(r2) / radius);
    }
  }

  // End a particle's step at the next tick, after its velocity was changed by hand.
  function wake(s, i) {
    s.tiEnd[i] = s.ti + 1;
    s.minLevel[i] = 0;
  }

  // Push the gas under a finger toward velocity v (code units, in the view plane).
  function stir(s, p, d, v, radius) {
    forNear(s, p, d, radius, (i, w) => {
      const k = 0.5 * w;
      s.vx[i] += k * (v[0] - s.vx[i]); s.vy[i] += k * (v[1] - s.vy[i]); s.vz[i] += k * (v[2] - s.vz[i]);
      wake(s, i);
    });
  }

  // A point of gravity under the finger while it's down, or null to let go.
  function setPull(s, p, mass) {
    s.pull = p ? { x: p[0], y: p[1], z: p[2], m: mass, soft: 0.05 } : null;
    if (p) forNear(s, p, [0, 0, 1], 1e9, (i) => {
      const dx = s.x[i] - p[0], dy = s.y[i] - p[1], dz = s.z[i] - p[2];
      if (dx * dx + dy * dy + dz * dz < 0.09 && s.level[i] < 6) wake(s, i);
    });
  }

  // A puff of fresh gas, moving with whatever is already there.
  function addGas(s, p, count, radius, rng) {
    let mx = 0, my = 0, mz = 0, w = 0;
    for (let i = 0; i < s.n; i++) {
      if (!s.alive[i]) continue;
      const dx = s.x[i] - p[0], dy = s.y[i] - p[1], dz = s.z[i] - p[2];
      if (dx * dx + dy * dy + dz * dz < 4 * radius * radius) { mx += s.vx[i]; my += s.vy[i]; mz += s.vz[i]; w++; }
    }
    if (w) { mx /= w; my /= w; mz /= w; }
    let added = 0, from = 0;
    for (let k = 0; k < count; k++) {
      let i = -1;
      for (let j = from; j < s.cap; j++) if (!s.alive[j]) { i = j; break; }
      if (i < 0) break;
      from = i + 1;
      let x, y, z;
      do { x = rng.next() * 2 - 1; y = rng.next() * 2 - 1; z = rng.next() * 2 - 1; } while (x * x + y * y + z * z > 1);
      s.x[i] = p[0] + x * radius; s.y[i] = p[1] + y * radius; s.z[i] = p[2] + z * radius;
      s.vx[i] = mx; s.vy[i] = my; s.vz[i] = mz;
      s.ax[i] = 0; s.ay[i] = 0; s.az[i] = 0;
      s.h[i] = Math.max(H_MIN, radius * 0.6);
      s.rho[i] = s.m * count / (4.2 * radius * radius * radius);
      s.pr[i] = s.c02 * s.rho[i]; s.cs[i] = Math.sqrt(s.c02); s.temp[i] = s.set.temp;
      s.bal[i] = 1; s.divv[i] = 0;
      s.half[i] = 0; s.level[i] = MAX_LEVEL; s.tiStart[i] = s.ti;
      s.alive[i] = 1;
      wake(s, i);
      if (i >= s.n) s.n = i + 1;
      added++;
    }
    s.added += added * s.m;
    return added;
  }

  // A supernova blast arriving from direction d (unit vector from the cloud
  // toward the explosion, 3 cloud radii away): the near side is hit hardest.
  function blast(s, d, speed) {
    const ex = d[0] * 3, ey = d[1] * 3, ez = d[2] * 3;
    for (let i = 0; i < s.n; i++) {
      if (!s.alive[i]) continue;
      const rx = s.x[i] - ex, ry = s.y[i] - ey, rz = s.z[i] - ez;
      const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
      const k = speed * 4 / (r * r);
      s.vx[i] += k * rx / r; s.vy[i] += k * ry / r; s.vz[i] += k * rz / r;
      wake(s, i);
    }
  }

  function setTemperature(s, tempK) {
    s.set.temp = Math.min(SETTINGS.temp[2], Math.max(SETTINGS.temp[1], tempK));
    s.c02 = soundSpeed2(s.set.temp, s.units);
  }

  // ---- Reading it -----------------------------------------------------------------------------
  function primary(s) {
    let best = null;
    for (const sk of s.sinks) if (!best || sk.m > best.m) best = sk;
    return best;
  }

  // Where the mass is: in protostars, settled in disks, or still falling.
  function census(s) {
    const p = primary(s);
    let stars = 0, disk = 0, envelope = 0;
    for (const sk of s.sinks) stars += sk.m;
    const cx = p ? p.x : 0, cy = p ? p.y : 0, cz = p ? p.z : 0;
    const r2s = [];
    for (let i = 0; i < s.n; i++) {
      if (!s.alive[i]) continue;
      const dx = s.x[i] - cx, dy = s.y[i] - cy, dz = s.z[i] - cz;
      const rc = Math.hypot(dx, dy);
      if (p && rc < 0.35 && Math.abs(dz) < 0.3 * rc + 0.01) disk += s.m; else envelope += s.m;
      r2s.push(dx * dx + dy * dy + dz * dz);
    }
    r2s.sort((a, b) => a - b);
    const r90 = r2s.length ? Math.sqrt(r2s[Math.floor(0.9 * (r2s.length - 1))]) : 0;
    const r50 = r2s.length ? Math.sqrt(r2s[Math.floor(0.5 * (r2s.length - 1))]) : 0;
    return { stars, disk, envelope, gas: disk + envelope, r90, r50, count: s.sinks.length };
  }

  // Done once the main protostar has had time to gather a disk around it.
  // Gas still falling in by then is handed on with the time it will take to
  // land, so the disk model can keep adding it.
  const SETTLE = 0.6;
  function finished(s) {
    const p = primary(s);
    return !!p && s.t - p.born >= SETTLE;
  }
  // How far along: 0 at the start, about 0.6 when the first protostar forms,
  // 1 when finished.
  function progress(s) {
    const p = primary(s);
    if (!p) return Math.min(0.6, 0.6 * s.t / 1.2);
    return Math.min(1, 0.6 + 0.4 * (s.t - p.born) / SETTLE);
  }

  // The system handed on to the disk model: the stars, and each bound gas
  // parcel placed at the radius where its spin would hold it in a circular
  // orbit around the main star.
  function handoff(s) {
    const p = primary(s);
    const U = s.units;
    const stars = s.sinks.map((sk) => {
      const dx = sk.x - p.x, dy = sk.y - p.y, dz = sk.z - p.z;
      const ux = sk.vx - p.vx, uy = sk.vy - p.vy, uz = sk.vz - p.vz;
      return {
        id: sk.id, mass: sk.m * U.msun, primary: sk === p, mdot: sk.mdot * U.msun / U.years,
        pos: [dx * U.au, dy * U.au, dz * U.au], vel: [ux * U.kms, uy * U.kms, uz * U.kms],
      };
    });
    const M = p.m;
    const parcels = [];
    let lost = s.lost;
    for (let i = 0; i < s.n; i++) {
      if (!s.alive[i]) continue;
      const dx = s.x[i] - p.x, dy = s.y[i] - p.y, dz = s.z[i] - p.z;
      const ux = s.vx[i] - p.vx, uy = s.vy[i] - p.vy, uz = s.vz[i] - p.vz;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Bound to the system (the star plus, roughly, the gas inside this parcel's orbit)?
      const energy = 0.5 * (ux * ux + uy * uy + uz * uz) - (M + 0.5 * Math.min(1, r)) / r;
      if (energy > 0) { lost += s.m; continue; }
      const jx = dy * uz - dz * uy, jy = dz * ux - dx * uz, jz = dx * uy - dy * ux;
      const rc = (jx * jx + jy * jy + jz * jz) / M;
      // How long it takes to land: about the free-fall time from where it is.
      const tFall = r > 0.4 ? Math.PI / 2 * Math.sqrt(r * r * r / (2 * M)) : 0;
      parcels.push({ rAU: Math.max(rc, 1e-5) * U.au, mass: s.m * U.msun, x: dx * U.au, y: dy * U.au, z: dz * U.au, landsIn: tFall * U.years });
    }
    return { stars, parcels, lostMass: lost * U.msun, age: s.t * U.years, starAge: (s.t - p.born) * U.years };
  }

  // Positions, for drawing: in AU around the main star (or the cloud's centre
  // before there is one), with velocity (km/s), density and temperature.
  function snapshot(s) {
    const p = primary(s);
    const cx = p ? p.x : 0, cy = p ? p.y : 0, cz = p ? p.z : 0;
    const pvx = p ? p.vx : 0, pvy = p ? p.vy : 0, pvz = p ? p.vz : 0;
    let k = 0;
    for (let i = 0; i < s.n; i++) if (s.alive[i]) k++;
    const pos = new Float32Array(k * 3), vel = new Float32Array(k * 3), rho = new Float32Array(k), temp = new Float32Array(k);
    const au = s.units.au, kms = s.units.kms;
    let j = 0;
    for (let i = 0; i < s.n; i++) {
      if (!s.alive[i]) continue;
      pos[j * 3] = (s.x[i] - cx) * au; pos[j * 3 + 1] = (s.y[i] - cy) * au; pos[j * 3 + 2] = (s.z[i] - cz) * au;
      vel[j * 3] = (s.vx[i] - pvx) * kms; vel[j * 3 + 1] = (s.vy[i] - pvy) * kms; vel[j * 3 + 2] = (s.vz[i] - pvz) * kms;
      rho[j] = s.rho[i]; temp[j] = s.temp[i];
      j++;
    }
    const stars = s.sinks.map((sk) => ({
      id: sk.id, x: (sk.x - cx) * au, y: (sk.y - cy) * au, z: (sk.z - cz) * au,
      mass: sk.m * s.units.msun, lum: sinkLuminosity(sk, s.units), primary: sk === p,
      mdot: Math.max(0, sk.mdot) * s.units.msun / s.units.years,
    }));
    return { pos, vel, rho, temp, stars };
  }

  // The density a protostar forms at, in solar masses per cubic AU, and the
  // cloud's starting density, for the page's colour scale.
  function densityScale(s) {
    const u = s.units;
    return { mean: (3 / (4 * Math.PI)) * u.msun / (u.au * u.au * u.au), sink: RHO_SINK * u.msun / (u.au * u.au * u.au), code: u.msun / (u.au * u.au * u.au) };
  }

  // ---- Saving ----------------------------------------------------------------------------------
  function save(s) {
    const out = {};
    for (const k of Object.keys(s)) {
      if (FLOATS.includes(k) || k in OTHERS) out[k] = s[k].slice(0, s.n);
      else out[k] = JSON.parse(JSON.stringify(s[k]));
    }
    return out;
  }
  function restore(o) {
    const s = {};
    for (const k of Object.keys(o)) if (!FLOATS.includes(k) && !(k in OTHERS)) s[k] = JSON.parse(JSON.stringify(o[k]));
    allocParticles(s);
    for (const k of FLOATS.concat(Object.keys(OTHERS))) if (o[k]) s[k].set(o[k].length > s.n ? o[k].subarray(0, s.n) : o[k]);
    s.pull = null;
    setup(s);
    // Saved velocities are mid-step; bring them to the saved moment, then
    // start every particle afresh from there.
    predict(s);
    s.vx.set(s.vpx); s.vy.set(s.vpy); s.vz.set(s.vpz);
    startAll(s);
    return s;
  }

  return {
    SETTINGS, CLOUD_AU, R_ACC, unitsFor, clampSettings,
    create, step, advance, census, finished, progress, handoff, snapshot, primary, densityScale,
    luminosity: (s) => s.sinks.reduce((a, sk) => a + sinkLuminosity(sk, s.units), 0),
    stir, setPull, addGas, blast, setTemperature, save, restore,
  };
});
