// Draws the world onto a canvas: the collapsing cloud as glowing gas, then
// the disk (gas, dust and planetesimals laid out to follow the model's
// radial profiles), the star by its true colour, and the planets on their
// orbits. Has a camera you can turn and zoom, and turns screen points back
// into positions for the tools. Page only.
//
// Orbits are drawn slowed down: real ones would be a blur at these speeds.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.RenderFactory = factory;
})(this, function RenderFactory(Star) {
  'use strict';

  const TAU = Math.PI * 2;
  const N_GAS = 1700, N_DUST = 900, N_PLTS = 900;
  const KIND_COLOURS = {
    embryo: '#8d93a6', 'rocky planet': '#d9ab80', 'super-Earth': '#e8b98c', 'ocean world': '#6fb3ff',
    'mini-Neptune': '#a3dbe8', 'ice giant': '#78d0d6', 'gas giant': '#ecca98', 'hot Jupiter': '#ff9a6a',
    'brown dwarf': '#c66a52', star: '#ffd48a',
  };

  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mixRGB(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  function ramp(stops, t) {
    t = clamp(t, 0, 1) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(t));
    return mixRGB(stops[i], stops[i + 1], t - i);
  }
  // Emission: cold gas glows deep red, warm orange, hot gold and white.
  const LIGHT = [[110, 18, 52], [214, 52, 92], [255, 112, 92], [255, 182, 108], [255, 232, 180], [255, 250, 240]];
  // Heat: blue cold to white hot.
  const HEAT = [[38, 60, 190], [40, 160, 230], [120, 230, 200], [250, 230, 110], [255, 140, 60], [255, 245, 235]];
  const tempT = (T) => clamp(Math.log10(Math.max(T, 8) / 8) / Math.log10(1500 / 8), 0, 1);

  function createView(canvas) {
    const ctx = canvas.getContext('2d', { alpha: false });
    let W = 0, H = 0, dpr = 1;
    const cam = { yaw: 0.6, tilt: 1.05, scale: 0.2, cx: 0, cy: 0, auto: true, target: 0.2 };
    let frame = null, layer = 'light', selected = null, paused = false;
    let refR = 1000, vt = 0;
    const marks = [];        // transient effects (flyby tracks, taps)
    let pointerMark = null;  // a live marker under the finger

    // ---- Sprites ---------------------------------------------------------------------------
    const spriteCache = new Map();
    function sprite(rgb, size) {
      const key = `${Math.round(rgb[0] / 8)}|${Math.round(rgb[1] / 8)}|${Math.round(rgb[2] / 8)}|${size}`;
      let s = spriteCache.get(key);
      if (s) return s;
      s = document.createElement('canvas');
      s.width = s.height = size * 2;
      const g = s.getContext('2d');
      const grad = g.createRadialGradient(size, size, 0, size, size, size);
      const c = `${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])}`;
      grad.addColorStop(0, `rgba(${c},1)`);
      grad.addColorStop(0.25, `rgba(${c},0.55)`);
      grad.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, size * 2, size * 2);
      if (spriteCache.size > 600) spriteCache.clear();
      spriteCache.set(key, s);
      return s;
    }

    // Background stars, fixed.
    const field = [];
    {
      let a = 1234567;
      const rnd = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
      for (let i = 0; i < 260; i++) field.push([rnd(), rnd(), Math.pow(rnd(), 3)]);
    }

    // ---- Display particles for the disk ------------------------------------------------------
    function makeSet(n, seed) {
      let a = seed;
      const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
      const s = { n, q: new Float32Array(n), phi: new Float32Array(n), zeta: new Float32Array(n), r: new Float32Array(n), from: null };
      for (let i = 0; i < n; i++) {
        s.q[i] = (i + rnd()) / n;
        s.phi[i] = rnd() * TAU;
        const u = Math.max(1e-9, rnd()), v = rnd();
        s.zeta[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v) * 0.8;
      }
      return s;
    }
    const gasSet = makeSet(N_GAS, 11), dustSet = makeSet(N_DUST, 23), pltSet = makeSet(N_PLTS, 37);
    let morph = null;          // { t, dur } while the cloud turns into the disk
    const refMass = { gas: 0, dust: 0, plts: 0 };
    const bodyPhase = new Map();

    // Radii for quantiles q of the mass in sigma (per ring) between edges re.
    function placeByMass(set, sigma, re) {
      const n = sigma.length;
      const cum = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + Math.max(0, sigma[i]) * Math.PI * (re[i + 1] * re[i + 1] - re[i] * re[i]);
      const tot = cum[n];
      if (!(tot > 0)) return 0;
      for (let k = 0; k < set.n; k++) {
        const target = set.q[k] * tot;
        let lo = 0, hi = n;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= target) lo = mid; else hi = mid; }
        const f = (target - cum[lo]) / Math.max(1e-300, cum[lo + 1] - cum[lo]);
        set.r[k] = re[lo] * Math.pow(re[lo + 1] / re[lo], clamp(f, 0, 1));
      }
      return tot;
    }

    function ringIndex(re, r) {
      let lo = 0, hi = re.length - 1;
      if (r <= re[0]) return 0;
      if (r >= re[hi]) return hi - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (re[mid] <= r) lo = mid; else hi = mid; }
      return lo;
    }

    // ---- Camera ------------------------------------------------------------------------------
    // Basis: R (screen right), U (screen up), D (into the screen), from yaw
    // about the disk's axis and tilt away from looking straight down it.
    function basis() {
      const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), ct = Math.cos(cam.tilt), st = Math.sin(cam.tilt);
      const R = [cy, sy, 0];
      const U = [-sy * ct, cy * ct, st];
      const D = [-(R[1] * U[2] - R[2] * U[1]), -(R[2] * U[0] - R[0] * U[2]), -(R[0] * U[1] - R[1] * U[0])];
      return { R, U, D };
    }
    let B = basis();

    function resize() {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
      if (w !== W || h !== H) { W = canvas.width = w; H = canvas.height = h; }
      cam.cx = W / 2; cam.cy = H / 2;
    }

    // The radius (AU) the view should frame right now.
    function fitRadius() {
      if (!frame) return 1500;
      const r = frame.readings;
      if (frame.stage === 'cloud') return clamp(r.radius * 1.15, 60, 2200);
      let R0 = Math.max(3, (r.diskRadius || 0) * 1.1, (r.snowLine || 0) * 2.5);
      if (r.gone) R0 = 4;
      for (const b of frame.bodies || []) if (b.earths > 0.05 && b.a < 400) R0 = Math.max(R0, b.a * (1 + b.e) * 1.2);
      if (frame.star && frame.star.rAU > 0.05) R0 = Math.max(R0, frame.star.rAU * 4);
      return clamp(R0, 1, 1200);
    }

    function setFrame(f) {
      const first = frame && frame.stage === 'cloud' && f.stage === 'disk';
      frame = f;
      if (f.stage === 'disk') {
        const d = f.disk;
        const mg = placeByMass(gasSet, d.sigG, d.re);
        const md = placeByMass(dustSet, d.sigD, d.re);
        const mp = placeByMass(pltSet, d.sigP, d.re);
        refMass.gas = Math.max(refMass.gas, mg); refMass.dust = Math.max(refMass.dust, md); refMass.plts = Math.max(refMass.plts, mp);
        gasSet.mass = mg; dustSet.mass = md; pltSet.mass = mp;
        if ((first || f.lastCloud) && f.lastCloud) startMorph(f.lastCloud);
      } else {
        refMass.gas = refMass.dust = refMass.plts = 0;
      }
    }

    // Start each gas display particle where a cloud particle was, matched by
    // distance from the star, and slide it into the disk.
    function startMorph(c) {
      const n = c.pos.length / 3;
      if (!n) return;
      const idx = Array.from({ length: n }, (_, i) => i);
      const rc = (i) => Math.hypot(c.pos[i * 3], c.pos[i * 3 + 1]);
      idx.sort((a, b) => rc(a) - rc(b));
      const order = Array.from({ length: gasSet.n }, (_, i) => i).sort((a, b) => gasSet.q[a] - gasSet.q[b]);
      const from = new Float32Array(gasSet.n * 3);
      for (let k = 0; k < gasSet.n; k++) {
        const j = idx[Math.floor(k / gasSet.n * n)];
        const i = order[k];
        from[i * 3] = c.pos[j * 3]; from[i * 3 + 1] = c.pos[j * 3 + 1]; from[i * 3 + 2] = c.pos[j * 3 + 2];
      }
      gasSet.from = from;
      morph = { t: 0, dur: 2.8 };
    }

    function project(x, y, z, out) {
      const s = cam.scale;
      out[0] = cam.cx + (x * B.R[0] + y * B.R[1] + z * B.R[2]) * s;
      out[1] = cam.cy - (x * B.U[0] + y * B.U[1] + z * B.U[2]) * s;
      out[2] = x * B.D[0] + y * B.D[1] + z * B.D[2];
      return out;
    }

    // ---- Drawing --------------------------------------------------------------------------------
    const P = [0, 0, 0];
    function draw(dt) {
      resize();
      if (!paused) vt += dt;
      // Camera follows the system unless you've zoomed by hand.
      const want = Math.min(W, H) * 0.47 / fitRadius();
      if (cam.auto) cam.scale = cam.scale * Math.exp(clamp(dt * 1.6, 0, 1) * Math.log(want / cam.scale));
      refR = refR * Math.exp(clamp(dt, 0, 1) * Math.log(fitRadius() / refR));
      B = basis();

      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#04050b';
      ctx.fillRect(0, 0, W, H);
      for (const s of field) {
        ctx.fillStyle = `rgba(200,210,255,${0.12 + 0.5 * s[2]})`;
        const z = (s[2] > 0.8 ? 1.6 : 1) * dpr;
        ctx.fillRect(s[0] * W, s[1] * H, z, z);
      }
      if (!frame) return;
      ctx.globalCompositeOperation = 'lighter';
      if (frame.stage === 'cloud') drawCloud();
      else drawDisk(dt);
      ctx.globalCompositeOperation = 'source-over';
      drawMarks(dt);
    }

    function drawCloud() {
      const c = frame.cloud;
      if (!c) return;
      const n = c.rho.length;
      const mean = 3 / (4 * Math.PI);
      const size = Math.max(3, Math.round(4.5 * dpr));
      for (let i = 0; i < n; i++) {
        project(c.pos[i * 3], c.pos[i * 3 + 1], c.pos[i * 3 + 2], P);
        if (P[0] < -20 || P[1] < -20 || P[0] > W + 20 || P[1] > H + 20) continue;
        const dens = c.rho[i] / mean;
        let rgb, a;
        if (layer === 'heat') { rgb = ramp(HEAT, tempT(c.temp[i])); a = 0.55; }
        else if (layer === 'motion') {
          const x = c.pos[i * 3], y = c.pos[i * 3 + 1], z = c.pos[i * 3 + 2];
          const r = Math.hypot(x, y, z) || 1;
          const vr = (c.vel[i * 3] * x + c.vel[i * 3 + 1] * y + c.vel[i * 3 + 2] * z) / r;
          const vphi = (x * c.vel[i * 3 + 1] - y * c.vel[i * 3]) / Math.max(1e-9, Math.hypot(x, y));
          const sp = Math.hypot(vr, vphi);
          rgb = vr < -0.15 * sp ? [80, 170, 255] : vr > 0.15 * sp ? [255, 150, 70] : [180, 120, 255];
          a = clamp(0.15 + sp / 3, 0.15, 0.9);
        } else {
          rgb = ramp(LIGHT, 0.75 * tempT(c.temp[i]) + 0.25 * clamp(Math.log10(dens + 1) / 3.5, 0, 1));
          a = clamp(0.16 + 0.22 * Math.log10(dens + 1), 0.12, 0.85);
        }
        ctx.globalAlpha = a;
        const s = sprite(rgb, size);
        ctx.drawImage(s, P[0] - size, P[1] - size);
      }
      ctx.globalAlpha = 1;
      for (const st of c.stars) drawStarAt(st.x, st.y, st.z, { L: Math.max(0.05, st.lum), T: 4000, primary: st.primary });
    }

    function drawStarAt(x, y, z, s) {
      project(x, y, z, P);
      const glow = clamp(6 * Math.pow(Math.max(s.L, 1e-6), 0.18), 2.5, 40) * dpr;
      const rgb = Star.colour(s.T);
      ctx.globalAlpha = 1;
      ctx.drawImage(sprite(rgb, Math.round(glow)), P[0] - glow, P[1] - glow);
      ctx.drawImage(sprite([255, 255, 255], Math.max(2, Math.round(glow * 0.35))), P[0] - glow * 0.35, P[1] - glow * 0.35);
      // A swollen star big enough to see on this scale is drawn at its size.
      if (s.rAU) {
        const rp = s.rAU * cam.scale;
        if (rp > glow * 0.4) {
          ctx.globalCompositeOperation = 'source-over';
          const g = ctx.createRadialGradient(P[0], P[1], 0, P[0], P[1], rp);
          g.addColorStop(0, `rgba(${rgb.join(',')},1)`);
          g.addColorStop(0.85, `rgba(${rgb.map((v) => Math.round(v * 0.75)).join(',')},0.95)`);
          g.addColorStop(1, `rgba(${rgb.join(',')},0)`);
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(P[0], P[1], rp, 0, TAU); ctx.fill();
          ctx.globalCompositeOperation = 'lighter';
        }
      }
    }

    // Slowed orbits: the outer part of the view turns once every ~5 s.
    function omega(r) {
      const P = clamp(5 * Math.pow(Math.max(r, 1e-3) / Math.max(refR, 1e-3), 1.5), 0.9, 120);
      return TAU / P;
    }

    function drawDisk(dt) {
      const f = frame, d = f.disk;
      const re = d.re;
      const step = paused ? 0 : dt;
      if (morph) { morph.t += dt; if (morph.t >= morph.dur) { morph = null; gasSet.from = null; } }
      const ease = morph ? (1 - Math.cos(Math.PI * clamp(morph.t / morph.dur, 0, 1))) / 2 : 1;

      // Faint bands first: habitable zone and snow line.
      const showOrbits = layer === 'orbits' || layer === 'dust';
      if (f.readings.hz && (layer === 'orbits' || f.readings.gone)) ring(f.readings.hz.inner, f.readings.hz.outer, 'rgba(127,224,168,0.07)', 'rgba(127,224,168,0.35)');
      if (!f.readings.gone || layer === 'heat') circle(f.readings.snowLine, layer === 'light' ? 'rgba(143,208,255,0.25)' : 'rgba(143,208,255,0.7)', [5, 6]);

      // Gas.
      const gasFade = refMass.gas > 0 ? clamp(Math.pow(gasSet.mass / refMass.gas, 0.3), 0, 1) : 0;
      if (gasSet.mass > 0 && gasFade > 0.02) {
        const base = layer === 'dust' || layer === 'orbits' ? 0.1 : 0.42;
        const size = Math.max(3, Math.round(4 * dpr));
        for (let i = 0; i < gasSet.n; i++) {
          const r = gasSet.r[i];
          gasSet.phi[i] += omega(r) * step;
          const k = ringIndex(re, r);
          const h = d.H[k] * gasSet.zeta[i];
          let x = r * Math.cos(gasSet.phi[i]), y = r * Math.sin(gasSet.phi[i]), z = h;
          if (gasSet.from) {
            x = lerp(gasSet.from[i * 3], x, ease); y = lerp(gasSet.from[i * 3 + 1], y, ease); z = lerp(gasSet.from[i * 3 + 2], z, ease);
          }
          project(x, y, z, P);
          if (P[0] < -10 || P[1] < -10 || P[0] > W + 10 || P[1] > H + 10) continue;
          const T = d.T[k];
          const rgb = layer === 'heat' ? ramp(HEAT, tempT(T)) : ramp(LIGHT, 0.2 + 0.8 * tempT(T));
          ctx.globalAlpha = base * gasFade * (morph ? 0.6 + 0.4 * ease : 1);
          ctx.drawImage(sprite(rgb, size), P[0] - size, P[1] - size);
        }
      }
      ctx.globalAlpha = 1;

      // Dust and pebbles: small sparks, icy blue beyond the snow line.
      const dustFade = refMass.dust > 0 ? clamp(Math.pow(dustSet.mass / refMass.dust, 0.25), 0, 1) : 0;
      if (dustSet.mass > 0 && dustFade > 0.03 && layer !== 'heat') {
        const sz = Math.max(1, Math.round((layer === 'dust' ? 2 : 1.3) * dpr));
        for (let i = 0; i < dustSet.n; i++) {
          const r = dustSet.r[i];
          dustSet.phi[i] += omega(r) * step;
          const k = ringIndex(re, r);
          project(r * Math.cos(dustSet.phi[i]), r * Math.sin(dustSet.phi[i]), d.H[k] * 0.25 * dustSet.zeta[i], P);
          const ice = d.ice[k];
          ctx.fillStyle = ice > 0.3 ? 'rgb(150,205,255)' : 'rgb(255,196,120)';
          ctx.globalAlpha = (layer === 'dust' ? 0.9 : 0.55) * dustFade * (morph ? ease : 1);
          ctx.fillRect(P[0], P[1], sz, sz);
        }
      }
      // Planetesimals: grey-gold belts.
      if (pltSet.mass > 0) {
        const fade = refMass.plts > 0 ? clamp(Math.pow(pltSet.mass / refMass.plts, 0.25), 0.25, 1) : 0;
        const sz = Math.max(1, Math.round((layer === 'dust' ? 1.8 : 1.2) * dpr));
        for (let i = 0; i < pltSet.n; i++) {
          const r = pltSet.r[i];
          pltSet.phi[i] += omega(r) * step;
          project(r * Math.cos(pltSet.phi[i]), r * Math.sin(pltSet.phi[i]), r * 0.02 * pltSet.zeta[i], P);
          const k = ringIndex(re, r);
          ctx.fillStyle = d.iceP[k] > 0.3 ? 'rgb(170,185,215)' : 'rgb(200,170,135)';
          ctx.globalAlpha = (layer === 'dust' ? 0.85 : 0.5) * fade;
          ctx.fillRect(P[0], P[1], sz, sz);
        }
      }
      ctx.globalAlpha = 1;

      // The star.
      const s = f.star;
      if (s) drawStarAt(0, 0, 0, { L: s.lTotal, T: s.T || 5000, rAU: s.rAU });

      // Planets and their orbits.
      ctx.globalCompositeOperation = 'source-over';
      const seen = new Set();
      for (const b of f.bodies) {
        seen.add(b.id);
        let ph = bodyPhase.get(b.id);
        if (ph === undefined) ph = b.phase;
        ph += omega(b.a) * step;
        bodyPhase.set(b.id, ph);
        const big = b.earths >= 0.05 || b.star;
        if (big && (showOrbits || b.id === selected || b.e > 0.1)) ellipse(b, b.id === selected ? 'rgba(255,93,115,0.8)' : layer === 'orbits' ? 'rgba(200,205,235,0.35)' : 'rgba(200,205,235,0.14)');
        const pos = orbitPos(b, ph);
        project(pos[0], pos[1], 0, P);
        if (b.star) { ctx.globalCompositeOperation = 'lighter'; drawStarAt(pos[0], pos[1], 0, { L: Math.pow(b.mass, 3.5), T: 3200 + 2600 * Math.min(1, b.mass) }); ctx.globalCompositeOperation = 'source-over'; continue; }
        const px = clamp(2 + 2.4 * Math.pow(Math.max(b.radius, 0.05), 0.6), 1.5, 14) * dpr * (big ? 1 : 0.6);
        ctx.fillStyle = KIND_COLOURS[b.kind] || '#ccc';
        ctx.globalAlpha = big ? 1 : 0.55;
        ctx.beginPath(); ctx.arc(P[0], P[1], px, 0, TAU); ctx.fill();
        if (b.kind === 'gas giant' || b.kind === 'hot Jupiter') {
          ctx.globalAlpha = 0.35; ctx.fillStyle = '#8a6a48';
          ctx.fillRect(P[0] - px * 0.9, P[1] - px * 0.18, px * 1.8, px * 0.36);
        }
        ctx.globalAlpha = 1;
        if (b.id === selected) { ctx.strokeStyle = '#ff5d73'; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.arc(P[0], P[1], px + 5 * dpr, 0, TAU); ctx.stroke(); }
        if ((layer === 'orbits' && b.earths >= 0.3) || b.id === selected) label(P[0] + px + 4 * dpr, P[1] - px - 2 * dpr, b.label || '');
      }
      for (const id of bodyPhase.keys()) if (!seen.has(id)) bodyPhase.delete(id);
      ctx.globalCompositeOperation = 'lighter';
    }

    function orbitPos(b, M) {
      // Kepler's equation for the position along an eccentric orbit.
      let E = M;
      for (let k = 0; k < 5; k++) E -= (E - b.e * Math.sin(E) - M) / (1 - b.e * Math.cos(E));
      const x = b.a * (Math.cos(E) - b.e), y = b.a * Math.sqrt(1 - b.e * b.e) * Math.sin(E);
      const c = Math.cos(b.peri), s = Math.sin(b.peri);
      return [x * c - y * s, x * s + y * c];
    }

    function ellipse(b, style) {
      ctx.strokeStyle = style; ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      for (let k = 0; k <= 72; k++) {
        const p = orbitPos(b, (k / 72) * TAU);
        project(p[0], p[1], 0, P);
        if (k === 0) ctx.moveTo(P[0], P[1]); else ctx.lineTo(P[0], P[1]);
      }
      ctx.stroke();
    }

    function circle(r, style, dash) {
      if (!(r > 0)) return;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = style; ctx.lineWidth = 1.2 * dpr;
      if (dash) ctx.setLineDash(dash.map((v) => v * dpr));
      ctx.beginPath();
      for (let k = 0; k <= 96; k++) {
        const a = (k / 96) * TAU;
        project(r * Math.cos(a), r * Math.sin(a), 0, P);
        if (k === 0) ctx.moveTo(P[0], P[1]); else ctx.lineTo(P[0], P[1]);
      }
      ctx.stroke();
      ctx.restore();
    }

    function ring(r0, r1, fill, edge) {
      if (!(r1 > r0)) return;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = fill;
      ctx.beginPath();
      for (let k = 0; k <= 96; k++) { const a = (k / 96) * TAU; project(r1 * Math.cos(a), r1 * Math.sin(a), 0, P); if (k === 0) ctx.moveTo(P[0], P[1]); else ctx.lineTo(P[0], P[1]); }
      for (let k = 96; k >= 0; k--) { const a = (k / 96) * TAU; project(r0 * Math.cos(a), r0 * Math.sin(a), 0, P); ctx.lineTo(P[0], P[1]); }
      ctx.closePath(); ctx.fill('evenodd');
      ctx.restore();
      circle(r0, edge); circle(r1, edge);
    }

    function label(x, y, text) {
      if (!text) return;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.font = `${Math.round(11 * dpr)}px "IBM Plex Mono", ui-monospace, monospace`;
      ctx.fillStyle = 'rgba(231,233,243,0.9)';
      ctx.fillText(text, x, y);
      ctx.restore();
    }

    // ---- Effects --------------------------------------------------------------------------------
    function drawMarks(dt) {
      for (let i = marks.length - 1; i >= 0; i--) {
        const m = marks[i];
        m.t += dt;
        if (m.t > m.dur) { marks.splice(i, 1); continue; }
        const k = m.t / m.dur;
        if (m.kind === 'flyby') {
          // A star sweeping past on a hyperbola, closest at q.
          const s = lerp(-2.2, 2.2, k);
          const x = m.q * Math.cosh(s) * Math.cos(m.ang) - m.q * 1.6 * Math.sinh(s) * Math.sin(m.ang);
          const y = m.q * Math.cosh(s) * Math.sin(m.ang) + m.q * 1.6 * Math.sinh(s) * Math.cos(m.ang);
          ctx.globalCompositeOperation = 'lighter';
          drawStarAt(x, y, 0, { L: 0.5, T: 4200 });
          ctx.globalCompositeOperation = 'source-over';
        } else if (m.kind === 'ring') {
          project(m.p[0], m.p[1], m.p[2] || 0, P);
          ctx.strokeStyle = `rgba(255,93,115,${1 - k})`; ctx.lineWidth = 2 * dpr;
          ctx.beginPath(); ctx.arc(P[0], P[1], (6 + 30 * k) * dpr, 0, TAU); ctx.stroke();
        } else if (m.kind === 'band') {
          ctx.globalAlpha = 1 - k;
          ring(m.r0, m.r1, 'rgba(255,93,115,0.12)', 'rgba(255,93,115,0.5)');
          ctx.globalAlpha = 1;
        } else if (m.kind === 'wave') {
          // A blast front sweeping across from one side.
          ctx.strokeStyle = `rgba(255,190,120,${0.8 * (1 - k)})`; ctx.lineWidth = 3 * dpr;
          const R = Math.min(W, H) * (1.2 - k);
          const cx = W / 2 + m.sx * Math.min(W, H) * 0.9, cy = H / 2 + m.sy * Math.min(W, H) * 0.9;
          ctx.beginPath(); ctx.arc(cx, cy, Math.max(1, R), 0, TAU); ctx.stroke();
        }
      }
      if (pointerMark) {
        ctx.strokeStyle = 'rgba(255,93,115,0.85)'; ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath(); ctx.arc(pointerMark.x * dpr, pointerMark.y * dpr, pointerMark.r * dpr, 0, TAU); ctx.stroke();
        if (pointerMark.text) label(pointerMark.x * dpr + pointerMark.r * dpr + 6 * dpr, pointerMark.y * dpr + 4 * dpr, pointerMark.text);
      }
    }

    // ---- Screen to world ----------------------------------------------------------------------------
    // A CSS-pixel point to the disk plane (z = 0); null if looking edge-on.
    function toPlane(x, y) {
      const X = (x * dpr - cam.cx) / cam.scale, Y = -(y * dpr - cam.cy) / cam.scale;
      // p = a R + b U with p.z = 0, projecting to (X, Y): solve along the view direction.
      // Point on the screen plane through the origin, then slide along D to z = 0.
      const p = [X * B.R[0] + Y * B.U[0], X * B.R[1] + Y * B.U[1], X * B.R[2] + Y * B.U[2]];
      if (Math.abs(B.D[2]) < 0.08) return null;
      const t = -p[2] / B.D[2];
      return [p[0] + t * B.D[0], p[1] + t * B.D[1], 0];
    }
    // A CSS-pixel point to the plane through the centre facing the viewer,
    // with the view direction (for the cloud tools).
    function toView(x, y) {
      const X = (x * dpr - cam.cx) / cam.scale, Y = -(y * dpr - cam.cy) / cam.scale;
      return { p: [X * B.R[0] + Y * B.U[0], X * B.R[1] + Y * B.U[1], X * B.R[2] + Y * B.U[2]], d: B.D.slice() };
    }
    // A drag (CSS pixels) as a direction in the world.
    function dragVector(dx, dy) {
      const v = [dx * B.R[0] - dy * B.U[0], dx * B.R[1] - dy * B.U[1], dx * B.R[2] - dy * B.U[2]];
      const n = Math.hypot(v[0], v[1], v[2]) || 1;
      return v.map((c) => c / n);
    }
    function auPerPixel() { return dpr / cam.scale; }

    function pick(x, y) {
      if (!frame || frame.stage !== 'disk') return null;
      let best = null, bd = 22;
      for (const b of frame.bodies) {
        const ph = bodyPhase.get(b.id);
        if (ph === undefined) continue;
        const pos = orbitPos(b, ph);
        project(pos[0], pos[1], 0, P);
        const dd = Math.hypot(P[0] / dpr - x, P[1] / dpr - y);
        if (dd < bd) { bd = dd; best = b.id; }
      }
      return best;
    }

    // ---- Controls -----------------------------------------------------------------------------------
    return {
      setFrame, draw, pick, toPlane, toView, dragVector, auPerPixel,
      setLayer(l) { layer = l; },
      setSelected(id) { selected = id; },
      setPaused(p) { paused = p; },
      rotate(dx, dy) { cam.yaw -= dx * 0.008; cam.tilt = clamp(cam.tilt + dy * 0.008, 0, Math.PI * 0.49); },
      zoom(f) { cam.auto = false; cam.scale = clamp(cam.scale * f, 1e-4, 1e5); },
      fit() { cam.auto = true; },
      isAuto() { return cam.auto; },
      mark(m) { marks.push(Object.assign({ t: 0, dur: 0.8 }, m)); },
      pointer(m) { pointerMark = m; },
      view() { return { yaw: cam.yaw, tilt: cam.tilt }; },
      setView(v) { if (v && Number.isFinite(v.yaw)) { cam.yaw = v.yaw; cam.tilt = clamp(v.tilt, 0, Math.PI * 0.49); } },
      kindColour(k) { return KIND_COLOURS[k] || '#ccc'; },
    };
  }

  return { createView, KIND_COLOURS, ramp, LIGHT, HEAT };
});
