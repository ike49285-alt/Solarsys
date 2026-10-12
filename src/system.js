// One world: a cloud that collapses into a star and a disk, the disk's gas
// and dust, and the planets that form in it, followed from the first
// thousand years to billions. It owns the stages, the clock (in years), the
// tools, the event log and saving. The page never touches the physics
// modules directly; it talks to this through the engine.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.SystemFactory = factory;
})(this, function SystemFactory(Rng, Cloud, Star, Disk, Planets) {
  'use strict';

  const ME = Disk.MEARTH, MJ = Disk.MJUP;

  // Every setting, with [default, least, most], and which part uses it.
  const SETTINGS = {};
  for (const [k, v] of Object.entries(Cloud.SETTINGS)) SETTINGS[k] = { part: 'cloud', range: v };
  for (const [k, v] of Object.entries(Disk.SETTINGS)) SETTINGS[k] = { part: 'disk', range: v };

  function defaults() {
    const o = {};
    for (const k in SETTINGS) o[k] = SETTINGS[k].range[0];
    return o;
  }
  function split(settings) {
    const c = {}, d = {};
    for (const k in SETTINGS) {
      const v = settings && settings[k] !== undefined ? settings[k] : SETTINGS[k].range[0];
      (SETTINGS[k].part === 'cloud' ? c : d)[k] = v;
    }
    return { cloud: Cloud.clampSettings(c), disk: Disk.clampSettings(d) };
  }

  // ---- A new world --------------------------------------------------------------
  // start: 'cloud' (the whole story) or 'disk' (skip the collapse: a young
  // star with a typical disk).
  function create(seed, settings, opts) {
    opts = opts || {};
    const s = split(settings);
    const w = {
      version: 1, seed: String(seed), settings: Object.assign({}, s.cloud, s.disk),
      stage: 'cloud', cloud: null, disk: null, age: 0, cloudAge: 0, log: [], logId: 1,
      history: [], nextSample: 0, n: opts.n || 2000, ended: false,
    };
    if (opts.start === 'disk') {
      w.stage = 'disk';
      w.disk = Disk.synthetic(w.seed, s.disk, { mStar: opts.mStar });
      w.age = clock(w.disk);
      w.handLost = 0;
      w.initialMass = w.disk.mStar + Disk.totals(w.disk).gas + Disk.totals(w.disk).dust + Disk.totals(w.disk).planetesimals
        + w.disk.sigV.reduce((a, v, i) => a + v * w.disk.area[i], 0);
      note(w, 'start', 'A young star about a hundred thousand years old, wrapped in its disk of gas and dust.');
    } else {
      w.cloud = Cloud.create(w.seed, s.cloud, { n: w.n });
      w.initialMass = w.settings.mass;
      note(w, 'start', `A dense core of gas ${Math.round(Cloud.CLOUD_AU * 2).toLocaleString('en')} AU across, ${fmtMass(w.settings.mass)} in all, starts to fall in on itself.`);
    }
    return w;
  }

  // ---- The log ----------------------------------------------------------------------
  function note(w, kind, text, extra) {
    w.log.push(Object.assign({ id: w.logId++, t: w.age, kind, text }, extra || {}));
    if (w.log.length > 400) w.log.splice(0, w.log.length - 400);
  }

  function fmtMass(mSun) {
    if (mSun >= 0.08) return `${mSun.toFixed(2)} solar masses`;
    if (mSun >= 0.3 * MJ) return `${(mSun / MJ).toFixed(1)} Jupiter masses`;
    return `${(mSun / ME).toPrecision(2)} Earth masses`;
  }
  function fmtEarths(m) {
    const e = m / ME;
    if (e >= 0.3 * 317.8) return `${(e / 317.8).toPrecision(2)} Jupiter masses`;
    if (e >= 1) return `${e.toPrecision(2)} Earth masses`;
    return `${e.toPrecision(1)} Earth masses`;
  }
  function fmtAU(a) { return a >= 10 ? `${Math.round(a)} AU` : `${a.toPrecision(2)} AU`; }

  function cloudEvents(w) {
    for (const e of w.cloud.events.splice(0)) {
      if (e.kind === 'protostar') {
        if (e.count === 1) note(w, 'protostar', 'The centre has grown dense enough to hold itself up: a protostar is born, and gas that falls in with too much spin starts to circle it.');
        else note(w, 'protostar', `A second clump has collapsed on its own: ${e.count === 2 ? 'a sibling star is forming. This may become a binary.' : 'another star is forming.'}`);
      } else if (e.kind === 'merge') note(w, 'merge', 'Two young protostars spiralled together and merged.');
      else if (e.kind === 'escape') note(w, 'escape', 'A young protostar was flung out of the cloud entirely.');
    }
  }

  function diskEvents(w) {
    const d = w.disk;
    for (const e of d.events.splice(0)) {
      const where = e.a !== undefined ? ` at ${fmtAU(e.a)}` : '';
      switch (e.kind) {
        case 'outburst': note(w, e.kind, `Gas piled up in the inner disk heated past ~1000 K, turned magnetically turbulent and crashed onto the star: an outburst, the star flaring brighter for a while.`); break;
        case 'embryos': note(w, e.kind, `Pebbles have gathered into planetesimals and the first planetary embryos, about the mass of the Moon, are forming${where}.`); break;
        case 'earth': note(w, e.kind, `An embryo${where} has grown to an Earth mass.`, { id: e.id }); break;
        case 'core10': note(w, e.kind, `A core${where} has reached ten Earth masses.`, { id: e.id }); break;
        case 'isolation': note(w, e.kind, `A core${where} (${fmtEarths(e.mass)}) is heavy enough to bend the gas into a pressure bump. Pebbles pile up outside its orbit instead of reaching it.`, { id: e.id }); break;
        case 'runaway': note(w, e.kind, `The core${where} can no longer hold its atmosphere up: gas is pouring in. A gas giant is being born.`, { id: e.id }); break;
        case 'giant': note(w, e.kind, `A gas giant${where} has passed a third of a Jupiter mass.`, { id: e.id }); break;
        case 'resonance': note(w, e.kind, `Two planets migrating inward have locked into a ${e.ratio} orbital resonance and now move together.`, { id: e.id }); break;
        case 'impact': note(w, e.kind, `Giant impact${where}: two bodies collided and merged into ${fmtEarths(e.mass)}.`, { id: e.id }); break;
        case 'ejected': note(w, e.kind, `A ${fmtEarths(e.mass)} body${where} was flung out of the system by a close pass.`); break;
        case 'scattered': if (e.mass > 1 * ME) note(w, e.kind, `A ${fmtEarths(e.mass)} planet was thrown onto a stretched orbit${where} (eccentricity ${e.e.toFixed(2)}).`, { id: e.id }); break;
        case 'hole': note(w, e.kind, `The star's X-rays have opened a hole in the disk${where}. The inner disk drains away and the rest is eaten from the inside out.`); break;
        case 'gas-gone': note(w, e.kind, 'The gas disk is gone. Planets stop migrating and stop gaining gas; from here on it is gravity and collisions.'); break;
        case 'binary': note(w, e.kind, `The sibling protostar stays bound: a binary, ${fmtMass(e.mass)} orbiting ${fmtAU(e.a)} away. It will strip the disk beyond about a third of that.`); break;
        case 'close-binary': note(w, e.kind, `The sibling protostar is in a tight orbit, ${fmtAU(e.a)}: the disk will circle both stars.`); break;
        case 'sibling-escapes': note(w, e.kind, 'The sibling protostar was not bound and drifts away.'); break;
        case 'binary-ejects': note(w, e.kind, `The companion star destabilised a ${fmtEarths(e.mass)} planet${where}.`); break;
        case 'stars-merge': note(w, e.kind, 'The two stars merged.'); break;
        case 'engulfed': note(w, e.kind, `A ${fmtEarths(e.mass)} planet${where} was swallowed by the ${e.phase === 'red giant' || e.phase === 'asymptotic giant' || e.phase === 'supergiant' ? 'swelling giant star' : 'star'}.`); break;
        case 'unbound': note(w, e.kind, 'The supernova blew away most of the star\'s mass; its planets are no longer bound.'); break;
        case 'dropped': note(w, e.kind, `You placed a ${fmtEarths(e.mass)} body at ${fmtAU(e.a)}.`, { id: e.id }); break;
        case 'flyby': note(w, e.kind, `A ${fmtMass(e.mass)} star swept past ${fmtAU(e.q)} away, stripping the disk beyond ~${fmtAU(e.rT)}${e.lost ? ` and taking ${e.lost} bod${e.lost === 1 ? 'y' : 'ies'} with it` : ''}.`); break;
        case 'stolen': note(w, e.kind, `A ${fmtEarths(e.mass)} body${where} was captured by the passing star.`); break;
        case 'flung': note(w, e.kind, `A ${fmtEarths(e.mass)} body${where} was flung loose by the passing star.`); break;
        default: break;
      }
    }
  }

  // Star milestones, noted once each.
  function starMilestones(w) {
    const s = w.disk.star;
    const seen = w.seenPhases || (w.seenPhases = {});
    if (seen[s.phase]) return;
    seen[s.phase] = true;
    const text = {
      'young star': 'The star has cleared its cocoon of falling gas: a young T Tauri star, still shrinking.',
      'main sequence': 'Hydrogen fusion has taken over in the core. The star has settled onto the main sequence.',
      subgiant: 'The core has run out of hydrogen. The star is swelling into a subgiant.',
      'red giant': 'A red giant: the star swells to hundreds of times its size, and close planets are in danger.',
      'helium-burning giant': 'Helium has ignited in the core; the star shrinks back for a while.',
      'asymptotic giant': 'The star swells again, bigger than ever, and sheds its outer layers.',
      'planetary nebula': 'The star has puffed off its outer layers as a planetary nebula, laying bare its hot core.',
      'white dwarf': 'Only the core is left: a white dwarf the size of the Earth, slowly cooling. Surviving planets drift outward as the star loses mass.',
      supergiant: 'A massive star\'s end is near: it has swollen into a supergiant.',
      'neutron star': 'The core collapsed in a supernova, leaving a neutron star.',
      'black hole': 'The core collapsed in a supernova, leaving a black hole.',
      'brown dwarf': 'The central object never got heavy enough to fuse hydrogen: a brown dwarf.',
    }[s.phase];
    if (text && s.phase !== 'protostar') note(w, 'star-' + s.phase.replace(/ /g, '-'), text);
  }

  // ---- Stages -----------------------------------------------------------------------------
  // Where in the story we are, as a key and a label for the page's timeline.
  const PHASES = [
    { key: 'cloud', label: 'Cloud' },
    { key: 'protostar', label: 'Protostar' },
    { key: 'disk', label: 'Disk' },
    { key: 'planets', label: 'Planets form' },
    { key: 'clearing', label: 'Clearing' },
    { key: 'impacts', label: 'Giant impacts' },
    { key: 'mature', label: 'Mature' },
    { key: 'late', label: 'Old age' },
  ];
  function phase(w) {
    if (w.stage === 'cloud') return Cloud.primary(w.cloud) ? 'protostar' : 'cloud';
    const d = w.disk;
    const s = d.star;
    if (s && !['protostar', 'young star', 'main sequence', 'brown dwarf'].includes(s.phase)) return 'late';
    if (!d.gone) {
      if (d.hole) return 'clearing';
      return d.bodies.some((b) => b.kind !== 'star') ? 'planets' : 'disk';
    }
    if (d.age < 1e8) return 'impacts';
    return 'mature';
  }

  // ---- Running -----------------------------------------------------------------------------
  // The cloud stage advances one SPH step at a time; returns years advanced.
  function stepCloud(w) {
    const c = w.cloud;
    const t0 = c.t;
    Cloud.step(c);
    cloudEvents(w);
    const dy = (c.t - t0) * c.units.years;
    w.age += dy;
    w.cloudAge = c.t * c.units.years;
    if (Cloud.finished(c)) handoff(w);
    return dy;
  }

  function handoff(w) {
    const c = w.cloud;
    const hand = Cloud.handoff(c);
    w.initialMass = w.settings.mass * (1 + c.added);
    w.handLost = hand.lostMass;
    const s = split(w.settings);
    w.disk = Disk.fromCollapse(w.seed, s.disk, hand);
    Planets.addCompanions(w.disk, hand.stars);
    w.lastCloud = Cloud.snapshot(c);
    w.cloud = null;
    w.stage = 'disk';
    w.age = clock(w.disk);
    const jets = w.disk.totals.jets || 0;
    note(w, 'disk', `The star has gathered ${fmtMass(w.disk.mStar)}. Around it the gas settles into a spinning disk; more is still raining in${jets > 0.01 ? `, and jets along the star's poles throw ${fmtMass(jets)} back out` : ''}.`);
    diskEvents(w);
  }

  // Advance the disk and planets by up to `years`, in steps no longer than
  // the physics allows; returns years advanced. Stops early after maxSteps.
  function advance(w, years, maxSteps) {
    if (w.stage === 'cloud') return 0;
    const d = w.disk;
    let done = 0, n = 0;
    while (done < years && n < (maxSteps || 1e9)) {
      const dt = Math.min(Disk.maxDt(d), Planets.maxDt(d), years - done);
      Planets.evolve(d, dt);
      Disk.step(d, dt);
      done += dt; n++;
      w.age = clock(d);
      diskEvents(w);
      starMilestones(w);
    }
    sample(w);
    return done;
  }

  // The page's clock runs from the start of the collapse; the disk keeps the
  // star's own age (from its birth), which is what the physics needs.
  function clock(d) { return d.age + (d.bornAt || 0); }

  // The longest single step the disk would take right now (for the clock).
  function nextStep(w) {
    if (w.stage === 'cloud') return w.cloud.dt * w.cloud.units.years;
    return Math.min(Disk.maxDt(w.disk), Planets.maxDt(w.disk));
  }

  // A few numbers kept over time, sampled evenly in log(age), for charts.
  function sample(w) {
    if (w.age < w.nextSample) return;
    w.nextSample = w.age * 1.05 + 100;
    const r = readings(w);
    w.history.push([w.age, r.starMass, r.gas, r.dust + r.planetesimals, r.planetMass, r.luminosity]);
    if (w.history.length > 600) w.history.splice(0, w.history.length - 600);
  }

  // ---- What the page shows -----------------------------------------------------------------
  function readings(w) {
    if (w.stage === 'cloud') {
      const c = w.cloud;
      const cen = Cloud.census(c);
      const p = Cloud.primary(c);
      return {
        stage: 'cloud', phase: phase(w), age: w.age, progress: Cloud.progress(c),
        starMass: cen.stars * c.units.msun, stars: cen.count, gas: cen.gas * c.units.msun,
        disk: cen.disk * c.units.msun, envelope: cen.envelope * c.units.msun, radius: cen.r90 * c.units.au,
        temperature: c.set.temp, luminosity: Cloud.luminosity(c), protostar: !!p,
        dust: 0, planetesimals: 0, planetMass: 0, lost: c.lost * c.units.msun,
      };
    }
    const d = w.disk;
    const T = Disk.totals(d);
    let planetMass = 0, count = 0;
    for (const b of d.bodies) if (b.kind !== 'star') { planetMass += Planets.mass(b); if (Planets.mass(b) > 0.05 * ME) count++; }
    const hz = Star.habitableZone(Math.max(d.star.L, 1e-6));
    return {
      stage: 'disk', phase: phase(w), age: w.age, starMass: d.mStar, star: d.star,
      luminosity: d.star.lTotal, mdot: d.mdotStar, gas: T.gas, dust: T.dust, planetesimals: T.planetesimals,
      ice: T.ice, infall: T.infall, snowLine: T.snowLine, planetMass, planets: count, hz,
      diskRadius: Disk.radiusHolding(d, 0.9), gone: d.gone, goneAt: d.gone ? d.goneAt + (d.bornAt || 0) : d.goneAt, hole: d.hole,
      totals: d.totals,
    };
  }

  // Everything the page needs to draw a frame.
  function frame(w) {
    const out = { stage: w.stage, age: w.age, phase: phase(w), readings: readings(w), log: w.log.slice(-60) };
    if (w.stage === 'cloud') {
      out.cloud = Cloud.snapshot(w.cloud);
      out.density = Cloud.densityScale(w.cloud);
      return out;
    }
    const d = w.disk;
    out.disk = {
      r: Array.from(d.r), re: Array.from(d.re),
      sigG: Float32Array.from(d.sigG, (v, i) => v * d.gap[i]), sigD: Float32Array.from(d.sigDR, (v, i) => v + d.sigDI[i]),
      sigP: Float32Array.from(d.sigPR, (v, i) => v + d.sigPI[i]), ice: Float32Array.from(d.sigDI, (v, i) => v / Math.max(1e-30, v + d.sigDR[i])),
      iceP: Float32Array.from(d.sigPI, (v, i) => v / Math.max(1e-30, v + d.sigPR[i])),
      T: Float32Array.from(d.T), H: Float32Array.from(d.H), St: Float32Array.from(d.St1),
      sigG0: Float32Array.from(d.sig0),
    };
    out.bodies = d.bodies.map((b) => Planets.describe(d, b));
    out.star = d.star;
    out.mStar = d.mStar;
    if (w.lastCloud) { out.lastCloud = w.lastCloud; w.lastCloud = null; }
    return out;
  }

  // ---- Fiddling ----------------------------------------------------------------------------------
  function tool(w, msg) {
    const r = Rng.makeRng(null, (w.toolSeed = ((w.toolSeed || 1) * 1103515245 + 12345) | 0));
    if (w.stage === 'cloud') {
      const c = w.cloud, au = c.units.au;
      const p = c && Cloud.primary(c);
      const off = p ? [p.x, p.y, p.z] : [0, 0, 0];
      const toCode = (v) => [v[0] / au + off[0], v[1] / au + off[1], v[2] / au + off[2]];
      switch (msg.tool) {
        case 'stir': Cloud.stir(c, toCode(msg.p), msg.d, msg.v.map((x) => x / c.units.kms), msg.radius / au); break;
        case 'pull': Cloud.setPull(c, msg.p ? toCode(msg.p) : null, (msg.mass || 0.25)); break;
        case 'gas': {
          const added = Cloud.addGas(c, toCode(msg.p), msg.count || 60, (msg.radius || 120) / au, r);
          if (added && !w.gasNoted) { w.gasNoted = true; note(w, 'gas', 'You added a puff of gas. It joins whatever is moving there.'); }
          break;
        }
        case 'blast': Cloud.blast(c, msg.d, msg.speed || 0.6); note(w, 'blast', 'A supernova blast wave slams into the cloud from one side, squeezing it.'); break;
        default: break;
      }
      return;
    }
    const d = w.disk;
    switch (msg.tool) {
      case 'planet': w.initialMass += Planets.mass(Planets.addPlanet(d, msg.a, msg.earths)); break;
      case 'move': Planets.moveBody(d, msg.id, msg.a, msg.e); break;
      case 'remove': Planets.removeBody(d, msg.id); note(w, 'removed', 'You took a body out of the system.'); break;
      case 'clear': { const m = Disk.clear(d, msg.r0, msg.r1, msg.f || 0.9); if (m > 0) note(w, 'clear', `You swept ${fmtMass(m)} of gas out of the disk between ${fmtAU(msg.r0)} and ${fmtAU(msg.r1)}.`); break; }
      case 'dust': w.initialMass += Disk.addDust(d, msg.r0, msg.r1, msg.earths || 5); note(w, 'dust', `You scattered ${fmtEarths((msg.earths || 5) * ME)} of dust between ${fmtAU(msg.r0)} and ${fmtAU(msg.r1)}.`); break;
      case 'flyby': Planets.flyby(d, msg.q, msg.mass || 0.5); break;
      default: break;
    }
    diskEvents(w);
  }

  // Change a setting. Cloud settings other than temperature only matter for
  // a new cloud; disk settings apply at once.
  function set(w, key, value) {
    if (!(key in SETTINGS)) return;
    const [, lo, hi] = SETTINGS[key].range;
    const v = Math.min(hi, Math.max(lo, +value));
    if (!Number.isFinite(v)) return;
    w.settings[key] = v;
    if (key === 'temp' && w.stage === 'cloud') Cloud.setTemperature(w.cloud, v);
    if (SETTINGS[key].part === 'disk' && w.disk) { w.disk.settings[key] = v; Disk.fields(w.disk); }
  }

  // Details of one body, for tapping on it.
  function inspect(w, id) {
    if (!w.disk) return null;
    const b = w.disk.bodies.find((x) => x.id === id);
    return b ? Planets.describe(w.disk, b) : null;
  }

  // ---- Saving -----------------------------------------------------------------------------------
  function save(w) {
    const o = {};
    for (const k of Object.keys(w)) {
      if (k === 'cloud') o.cloud = w.cloud ? Cloud.save(w.cloud) : null;
      else if (k === 'disk') o.disk = w.disk ? Disk.save(w.disk) : null;
      else if (k === 'lastCloud') continue;
      else o[k] = JSON.parse(JSON.stringify(w[k]));
    }
    return o;
  }
  function restore(o) {
    const w = {};
    for (const k of Object.keys(o)) {
      if (k === 'cloud') w.cloud = o.cloud ? Cloud.restore(o.cloud) : null;
      else if (k === 'disk') w.disk = o.disk ? Disk.restore(o.disk) : null;
      else w[k] = JSON.parse(JSON.stringify(o[k]));
    }
    return w;
  }

  // ---- Headless: run to an age (tests) ------------------------------------------------------------
  function runTo(w, age, onStep) {
    while (w.stage === 'cloud') { stepCloud(w); if (onStep) onStep(w); }
    while (w.age < age) { advance(w, Math.min(age - w.age, Math.max(1, nextStep(w))), 50); if (onStep) onStep(w); }
  }

  // Where the mass that started in the cloud is now, in solar masses; the
  // parts should add up to `start`.
  function budget(w) {
    if (w.stage === 'cloud') return null;
    const d = w.disk, T = Disk.totals(d), t = d.totals;
    let vapour = 0, planets = 0, companions = 0, infall = 0;
    for (let i = 0; i < d.sigV.length; i++) vapour += d.sigV[i] * d.area[i];
    for (const b of d.bodies) if (b.kind !== 'star') planets += Planets.mass(b);
    for (const c of d.companions) companions += c.mass;
    for (const p of d.infall) infall += p.m;
    const parts = {
      star: d.mStar, companions, gas: T.gas, dust: T.dust, vapour, planetesimals: T.planetesimals, planets, infall,
      escapedCloud: w.handLost || 0, jets: t.jets || 0, wind: t.wind || 0, photo: t.photo || 0, external: t.external || 0,
      dustLost: t.dustLost || 0, scattered: t.scattered || 0, ejected: t.ejected || 0, engulfed: t.engulfed || 0,
      stolen: t.stolen || 0, removed: t.removed || 0,
    };
    let sum = 0;
    for (const k in parts) sum += parts[k];
    return { start: w.initialMass, sum, parts };
  }

  return {
    SETTINGS, PHASES, defaults, create, budget, stepCloud, advance, nextStep, readings, frame, phase,
    tool, set, inspect, save, restore, runTo, fmtMass, fmtEarths, fmtAU,
  };
});
