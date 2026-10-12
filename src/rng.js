// Seeded random numbers. Every world is reproducible from its seed, and the
// generator's state is a single integer so it saves and restores exactly.
//
// Each module in src/ is a factory function that takes the modules it needs
// as arguments and refers to nothing outside itself, so the same code runs
// as a classic <script>, inside the Web Worker (rebuilt from the factory's
// source text), and in Node (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.RngFactory = factory;
})(this, function RngFactory() {
  'use strict';

  // cyrb53: a string to a 53-bit hash, used to turn typed seeds into numbers.
  function hashString(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  function seedNumber(seed) {
    if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0 || 1;
    return (hashString(String(seed)) >>> 0) || 1;
  }

  // mulberry32, with its state exposed.
  function makeRng(seed, state) {
    let a = state !== undefined ? state | 0 : seedNumber(seed) | 0;
    let spare = null;
    const rng = {
      next() {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      range(lo, hi) { return lo + (hi - lo) * rng.next(); },
      // Standard normal deviate (Box-Muller, keeping the second value).
      gauss() {
        if (spare !== null) { const s = spare; spare = null; return s; }
        let u = 0;
        while (u <= 1e-12) u = rng.next();
        const v = rng.next();
        const r = Math.sqrt(-2 * Math.log(u));
        spare = r * Math.sin(2 * Math.PI * v);
        return r * Math.cos(2 * Math.PI * v);
      },
      // Log-uniform between lo and hi.
      logRange(lo, hi) { return lo * Math.pow(hi / lo, rng.next()); },
      pick(list) { return list[Math.floor(rng.next() * list.length) % list.length]; },
      get state() { return a; },
      set state(v) { a = v | 0; spare = null; },
    };
    return rng;
  }

  // A child generator for one part of the world, so adding draws in one part
  // doesn't shift the random numbers every other part sees.
  function fork(rng, label) {
    return makeRng(null, (rng.state ^ (hashString(label) >>> 0)) | 0);
  }

  return { makeRng, fork, hashString, seedNumber };
});
