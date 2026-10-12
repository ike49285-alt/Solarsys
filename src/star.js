// A star's life from protostar to remnant, as fits to stellar evolution
// tracks: luminosity, radius, surface temperature and mass for a star of a
// given starting mass at a given age. Good to tens of percent, which is
// about what the rest of the world needs from it.
//
// Units: solar masses, solar luminosities, solar radii, kelvin, years.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.StarFactory = factory;
})(this, function StarFactory() {
  'use strict';

  const T_SUN = 5772;
  const RSUN_AU = 0.004650;

  // Hydrogen-burning lifetime, years.
  function mainSequenceLife(m) {
    if (m < 0.5) return 1e10 * Math.pow(0.5, -2.5) * Math.pow(m / 0.5, -1.5);
    return 1e10 * Math.pow(m, -2.5);
  }

  // Luminosity and radius when hydrogen burning starts.
  function zams(m) {
    let L;
    if (m < 0.43) L = 0.23 * Math.pow(m, 2.3);
    else if (m < 2) L = 0.7 * Math.pow(m, 4.5);
    else L = 1.4 * Math.pow(m, 3.5);
    const R = m < 1.2 ? 0.89 * Math.pow(m, 0.8) : 0.89 * Math.pow(1.2, 0.8) * Math.pow(m / 1.2, 0.6);
    return { L, R, T: T_SUN * Math.pow(L / (R * R), 0.25) };
  }

  // Time to contract onto the main sequence (Kelvin-Helmholtz), years.
  function contractionTime(m) {
    return 4e7 * Math.pow(Math.max(m, 0.08), -2.5);
  }

  // Mass left as a white dwarf (initial-final mass relation).
  function whiteDwarfMass(m) {
    return Math.min(1.35, 0.08 * m + 0.47);
  }

  function smooth(x) { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); }
  function lerp(a, b, f) { return a + (b - a) * f; }
  function logLerp(a, b, f) { return Math.exp(lerp(Math.log(a), Math.log(b), f)); }

  // The star at `age` years, for a star whose mass is `m` (its mass before
  // any loss late in life). `mdot` is the rate gas is landing on it (solar
  // masses a year), which adds accretion luminosity.
  function at(m, age, mdot) {
    m = Math.max(0.01, m);
    age = Math.max(0, age);
    const z = zams(m);
    const tKH = contractionTime(m);
    const tMS = mainSequenceLife(m);
    let L, R, T, mass = m, phase, remnant = null;

    if (m < 0.075) {
      // A brown dwarf: never burns hydrogen, just cools.
      R = 0.1 * (1 + 2 / Math.pow(1 + age / 1e7, 0.5));
      T = Math.max(300, 2800 * Math.pow(m / 0.075, 0.5) * Math.pow(1 + age / 1e8, -0.3));
      L = R * R * Math.pow(T / T_SUN, 4);
      return finish({ phase: 'brown dwarf' });
    }

    if (age < tKH) {
      // Contracting: cool and large on the Hayashi track, then heating up at
      // nearly steady luminosity (the Henyey track) as it nears its final size.
      R = Math.max(z.R, 2.5 * Math.pow(m, 0.6) * Math.pow(Math.max(age, 1e4) / 1e6, -0.37));
      const tHay = 4100 * Math.pow(m, 0.15);
      T = lerp(z.T, tHay, smooth((R / z.R - 1) / 0.8));
      L = R * R * Math.pow(T / T_SUN, 4);
      phase = age < 3e5 ? 'protostar' : 'young star';
      return finish({ phase });
    }

    const tMain = age - tKH;
    if (tMain < tMS) {
      const f = tMain / tMS;
      L = z.L * (1 + 0.9 * f);
      R = z.R * (1 + 0.3 * f + 0.15 * f * f);
      T = T_SUN * Math.pow(L / (R * R), 0.25);
      return finish({ phase: 'main sequence' });
    }

    const tPost = tMain - tMS;
    if (m >= 8) {
      // A massive star: a short supergiant life, then a supernova.
      const life = 0.1 * tMS;
      if (tPost < life) {
        const f = tPost / life;
        L = z.L * logLerp(2, 3, f);
        R = logLerp(z.R * 2, 600 * Math.pow(m / 15, 0.5), smooth(f * 1.2));
        T = T_SUN * Math.pow(L / (R * R), 0.25);
        mass = m * (1 - 0.3 * f);
        return finish({ phase: 'supergiant' });
      }
      const bh = m >= 25;
      remnant = bh ? 'black hole' : 'neutron star';
      mass = bh ? 0.15 * m : 1.4;
      R = bh ? 4.2e-6 * mass : 1.4e-5;
      L = bh ? 0 : 0.1 * Math.pow(1 + (tPost - life) / 1e5, -1);
      T = bh ? 0 : 1e6 * Math.pow(1 + (tPost - life) / 1e6, -0.25);
      return finish({ phase: remnant, remnant, sinceDeath: tPost - life });
    }

    // Sun-like and intermediate stars: subgiant, red giant, helium burning,
    // asymptotic giant, then a white dwarf.
    const post = 0.16 * tMS * Math.pow(m, 0.3);
    const mWD = whiteDwarfMass(m);
    const tipL = m < 2.2 ? 2500 : 400 * m;
    const tipR = m < 2.2 ? 170 * Math.pow(m, 0.3) : 60 * m;
    const agbL = 6000 * Math.pow(m, 0.6), agbR = 230 * Math.pow(m, 0.35);
    const lEnd = z.L * 1.9, rEnd = z.R * 1.45;
    // Mass lost up the red giant branch (Reimers-like): about a quarter of a
    // solar mass for the Sun.
    const mTip = m - (m < 2.2 ? 0.25 * Math.pow(m, 1.2) : 0.1 * m);
    const mHB = Math.max(mWD + 0.05, Math.min(m, mTip));
    if (tPost < post) {
      const f = tPost / post;
      if (f < 0.45) {                                     // subgiant
        const g = f / 0.45;
        L = lerp(lEnd, 3 * lEnd, g); R = lerp(rEnd, 3.2 * z.R, smooth(g));
        phase = 'subgiant';
      } else if (f < 0.82) {                              // red giant branch
        const g = (f - 0.45) / 0.37;
        const k = Math.pow(g, 3);
        L = logLerp(3 * lEnd, tipL, k); R = logLerp(3.2 * z.R, tipR, k);
        mass = lerp(m, mHB, Math.pow(g, 4));
        phase = 'red giant';
      } else if (f < 0.97) {                              // helium burning
        L = 50 * Math.pow(m, 0.8); R = 10 * Math.pow(m, 0.5);
        mass = mHB;
        phase = 'helium-burning giant';
      } else {                                            // asymptotic giant branch
        const g = (f - 0.97) / 0.03;
        L = logLerp(60 * Math.pow(m, 0.8), agbL, Math.pow(g, 2)); R = logLerp(12 * Math.pow(m, 0.5), agbR, Math.pow(g, 2));
        mass = lerp(mHB, mWD, Math.pow(g, 3));
        phase = 'asymptotic giant';
      }
      T = T_SUN * Math.pow(L / (R * R), 0.25);
      return finish({ phase });
    }
    const cool = tPost - post;
    mass = mWD;
    R = 0.0126 * Math.pow(mWD / 0.6, -1 / 3);
    L = Math.min(500, 0.1 * Math.pow(Math.max(cool, 1e4) / 1e7, -1.15));
    T = T_SUN * Math.pow(L / (R * R), 0.25);
    return finish({ phase: cool < 3e4 ? 'planetary nebula' : 'white dwarf', remnant: 'white dwarf', sinceDeath: cool });

    function finish(o) {
      // Gas landing on the star shines as it lands: G M Mdot / R.
      // G Msun (Msun/yr) / Rsun is 3.14e7 Lsun.
      const lAcc = mdot > 0 ? 3.1415e7 * mass * mdot / R : 0;
      return {
        mass, L, R, T, lAcc, lTotal: L + lAcc, phase: o.phase, remnant: o.remnant || remnant,
        sinceDeath: o.sinceDeath || 0, rAU: R * RSUN_AU, mainSequenceLife: tMS, contraction: tKH,
      };
    }
  }

  // A rough colour for a surface temperature (blackbody, as sRGB 0-255).
  function colour(T) {
    if (!(T > 0)) return [40, 40, 60];
    const t = T / 100;
    let r, g, b;
    if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04; }
    else { r = 329.7 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); b = 255; }
    const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
    return [c(r), c(g), c(b)];
  }

  // The habitable zone (Kopparapu et al. 2013, conservative limits), AU.
  function habitableZone(L) {
    return { inner: Math.sqrt(L / 1.1), outer: Math.sqrt(L / 0.36) };
  }

  // The longest step (years) that still follows the star through its late
  // phases: they are brief next to its life (a Sun-like star's last giant
  // phase is a few million years after ten billion), and a longer step would
  // jump right over the swelling that swallows close planets.
  function stepLimit(m, age) {
    if (m < 0.075) return Infinity;
    const tMain = age - contractionTime(m), tMS = mainSequenceLife(m);
    if (tMain < 0.97 * tMS) return Infinity;
    if (tMain < tMS) return 0.005 * tMS;
    const tPost = tMain - tMS;
    if (m >= 8) {
      const life = 0.1 * tMS;
      return tPost < life ? life / 200 : tPost < life + 1e6 ? 1e4 : Infinity;
    }
    const post = 0.16 * tMS * Math.pow(m, 0.3);
    if (tPost < 0.6 * post) return post / 200;
    if (tPost < post) return Math.max(3e3, Math.min(post / 2000, post - tPost + 1e4));   // land in the nebula
    if (tPost - post < 3e4) return 3e3;     // the planetary nebula
    return Infinity;
  }

  return { at, zams, mainSequenceLife, contractionTime, whiteDwarfMass, colour, habitableZone, stepLimit, RSUN_AU };
});
