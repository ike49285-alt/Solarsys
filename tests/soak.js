// Long unattended runs of whole systems, from the cloud to old age, through
// the real code (headless, the same modules the page's worker runs). Fails on
// errors, broken numbers, slow steps, a mass budget that doesn't add up, or a
// save that doesn't restore exactly.
//
//   node tests/soak.js                       3 systems, cloud to 10 Gyr
//   node tests/soak.js --quick               2 smaller clouds, to 1 Gyr
//   node tests/soak.js --seeds Orion-1,Lupus-7 --until 5e9 --n 2000
//
// Exits with code 1 if anything goes wrong.
'use strict';
const path = require('path');
const v8 = require('v8');

const src = path.join(__dirname, '..', 'src');
const F = {};
for (const [name, file] of [['RngFactory', 'rng'], ['CloudFactory', 'cloud'], ['StarFactory', 'star'], ['DiskFactory', 'disk'],
  ['PlanetsFactory', 'planets'], ['SystemFactory', 'system'], ['EngineFactory', 'engine']]) F[name] = require(path.join(src, `${file}.js`));
const Engine = F.EngineFactory();
const { System, Cloud, Disk, Planets } = Engine.compose(F);
const ME = Disk.MEARTH;

const args = process.argv.slice(2);
const opt = (name, fallback) => { const k = args.indexOf(`--${name}`); return k >= 0 ? args[k + 1] : fallback; };
const quick = args.includes('--quick');
const seeds = opt('seeds', quick ? 'Taurus-101,Orion-202' : 'Taurus-101,Orion-202,Lupus-303').split(',');
const until = +opt('until', quick ? 1e9 : 1e10);
const n = +opt('n', quick ? 1200 : 2000);
const SLOW_STEP_MS = 1500;      // the page's engine yields every 14 ms; one step this slow would stall it
const BUDGET_TOLERANCE = 0.02;  // the parts must add up to the start within 2%

const fmt = (y) => (y >= 1e9 ? `${(y / 1e9).toFixed(2)} Gyr` : y >= 1e6 ? `${(y / 1e6).toFixed(2)} Myr` : `${(y / 1e3).toFixed(1)} kyr`);
const now = () => Number(process.hrtime.bigint()) / 1e6;

function finiteArrays(obj, keys, problems, where) {
  for (const k of keys) {
    const a = obj[k];
    if (!a) continue;
    for (let i = 0; i < a.length; i++) {
      if (!Number.isFinite(a[i])) { problems.push(`${where}: ${k}[${i}] = ${a[i]}`); return; }
      if (a[i] < 0 && !['vx', 'vy', 'vz', 'x', 'y', 'z', 'ax', 'ay', 'az', 'divv'].includes(k)) { problems.push(`${where}: ${k}[${i}] = ${a[i]} is negative`); return; }
    }
  }
}

function checkCloud(w, problems) {
  const c = w.cloud;
  finiteArrays(c, ['x', 'y', 'z', 'vx', 'vy', 'vz', 'h', 'rho'], problems, `cloud at ${fmt(w.age)}`);
  for (const s of c.sinks) if (!Number.isFinite(s.x + s.y + s.z + s.m) || s.m < 0) problems.push(`protostar ${s.id} broken: ${JSON.stringify(s)}`);
}

function checkDisk(w, problems) {
  const d = w.disk;
  finiteArrays(d, ['sigG', 'sigDR', 'sigDI', 'sigV', 'sigPR', 'sigPI', 'T', 'alpha'], problems, `disk at ${fmt(w.age)}`);
  if (!(d.mStar > 0.01 && d.mStar < 20)) problems.push(`star mass ${d.mStar} at ${fmt(w.age)}`);
  for (const b of d.bodies) {
    const m = Planets.mass(b);
    if (!(b.a > 0 && Number.isFinite(b.a)) || !(b.e >= 0 && b.e < 1) || !(m >= 0 && Number.isFinite(m))) {
      problems.push(`body ${b.id} broken at ${fmt(w.age)}: a=${b.a} e=${b.e} m=${m}`);
      break;
    }
  }
  const B = System.budget(w);
  if (B && Math.abs(B.sum - B.start) > BUDGET_TOLERANCE * B.start) {
    problems.push(`mass budget off at ${fmt(w.age)}: started ${B.start.toFixed(4)} Msun, parts add to ${B.sum.toFixed(4)} (${JSON.stringify(B.parts, (k, v) => typeof v === 'number' ? +v.toPrecision(3) : v)})`);
  }
}

// Advance a disk-stage world by `years` the way the engine does.
function advance(w, years) {
  let done = 0;
  while (done < years) {
    const chunk = Math.min(years - done, Math.max(1, System.nextStep(w)) * 4);
    done += System.advance(w, chunk, 8);
  }
}

// Save, clone the way IndexedDB does, restore, then run both copies the same
// way and require them to agree.
function checkSaveRestore(w, problems) {
  const copy = System.restore(v8.deserialize(v8.serialize(System.save(w))));
  advance(w, 2e5);
  advance(copy, 2e5);
  const a = w.disk, b = copy.disk;
  const same = (x, y) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  if (!same(a.age, b.age) || !same(a.mStar, b.mStar) || a.bodies.length !== b.bodies.length) {
    problems.push(`restored world drifted: age ${a.age} vs ${b.age}, star ${a.mStar} vs ${b.mStar}, bodies ${a.bodies.length} vs ${b.bodies.length}`);
    return;
  }
  for (let i = 0; i < a.bodies.length; i++) {
    const p = a.bodies[i], q = b.bodies[i];
    if (!same(p.a, q.a) || !same(Planets.mass(p), Planets.mass(q))) { problems.push(`restored world drifted: body ${p.id} a ${p.a} vs ${q.a}`); return; }
  }
  for (const k of ['sigG', 'sigDR', 'sigPR']) for (let i = 0; i < a[k].length; i++) {
    if (!same(a[k][i], b[k][i])) { problems.push(`restored world drifted: ${k}[${i}] ${a[k][i]} vs ${b[k][i]}`); return; }
  }
}

// Every tool, used the way the page sends it, on a small cloud and then its
// disk; the world must stay sound and the mass budget must still add up.
function toolsCheck() {
  const problems = [];
  const t0 = now();
  try {
    const w = System.create('Tools-1', {}, { n: 600 });
    const tool = (msg) => System.tool(w, Object.assign({ type: 'tool' }, msg));
    for (let k = 0; w.stage === 'cloud' && k < 40000; k++) {
      if (k === 20) tool({ tool: 'stir', p: [300, 0, 0], d: [0, 0, -1], v: [0, 1.5, 0], radius: 400 });
      if (k === 40) tool({ tool: 'pull', p: [-200, 300, 0], mass: 0.3 });
      if (k === 80) tool({ tool: 'pull', p: null });
      if (k === 100) tool({ tool: 'gas', p: [0, -500, 0], count: 150, radius: 300 });
      if (k === 140) tool({ tool: 'blast', d: [1, 0, 0], speed: 0.8 });
      System.stepCloud(w);
      if (k % 500 === 0 && w.cloud) checkCloud(w, problems);
    }
    if (w.stage !== 'disk') problems.push('the collapse never finished');
    else {
      advance(w, 2e4);
      tool({ tool: 'planet', a: 5, earths: 318 });
      tool({ tool: 'planet', a: 0.8, earths: 1 });
      tool({ tool: 'dust', r0: 9, r1: 11, earths: 10 });
      tool({ tool: 'clear', r0: 20, r1: 40 });
      advance(w, 5e4);
      const b = w.disk.bodies.find((x) => x.kind !== 'star');
      if (b) tool({ tool: 'move', id: b.id, a: b.a * 1.5 });
      tool({ tool: 'flyby', q: 150, mass: 1 });
      advance(w, 2e5);
      checkDisk(w, problems);
      const B = System.budget(w);
      console.log(`tools: ${((now() - t0) / 1000).toFixed(1)} s; mass budget ${B.start.toFixed(4)} -> ${B.sum.toFixed(4)} Msun`);
    }
  } catch (e) {
    problems.push(`threw: ${e.stack || e}`);
  }
  if (problems.length) console.log(`  tools FAILED:\n    ${problems.slice(0, 12).join('\n    ')}`);
  return problems.length === 0;
}

let failed = !toolsCheck();
for (const seed of seeds) {
  const problems = [];
  const t0 = now();
  const w = System.create(seed, {}, { n });
  let worst = 0, steps = 0;
  try {
    // The collapse, a step at a time.
    while (w.stage === 'cloud') {
      const s = now();
      System.stepCloud(w);
      const ms = now() - s;
      worst = Math.max(worst, ms);
      if (ms > SLOW_STEP_MS) problems.push(`a collapse step took ${ms.toFixed(0)} ms at ${fmt(w.age)}`);
      if (++steps % 500 === 0 && w.cloud) checkCloud(w, problems);
      if (steps > 40000) { problems.push('the collapse never finished'); break; }
    }
    const cloudSecs = (now() - t0) / 1000;
    const hand = System.readings(w);
    console.log(`${seed}: collapse ${steps} steps in ${cloudSecs.toFixed(1)} s (worst ${worst.toFixed(0)} ms); protostar ${hand.starMass.toFixed(3)} Msun at ${fmt(w.age)}`);
    checkDisk(w, problems);

    // The disk and the planets, checking as we go.
    let next = w.age * 3, saved = false, worstChunk = 0;
    while (w.age < until && !problems.length) {
      const s = now();
      advance(w, Math.min(until - w.age, w.age * 0.25));
      worstChunk = Math.max(worstChunk, now() - s);
      if (w.age >= next) { checkDisk(w, problems); next = w.age * 3; }
      if (!saved && w.age > 1e6) { saved = true; checkSaveRestore(w, problems); }
    }
    checkDisk(w, problems);
    const r = System.readings(w);
    const bodies = w.disk.bodies.filter((b) => Planets.mass(b) > 0.1 * ME).sort((a, b) => a.a - b.a)
      .map((b) => Planets.describe(w.disk, b)).map((x) => `${x.kind} ${x.earths >= 95 ? (x.earths / 317.8).toFixed(1) + ' MJ' : x.earths.toFixed(1) + ' ME'} @ ${x.a.toPrecision(3)} AU`);
    console.log(`  to ${fmt(w.age)} in ${((now() - t0) / 1000 - cloudSecs).toFixed(1)} s more (slowest chunk ${worstChunk.toFixed(0)} ms): star ${r.starMass.toFixed(2)} Msun, ${r.star.phase}; gas gone at ${r.goneAt ? fmt(r.goneAt) : 'never'}`);
    console.log(`  planets: ${bodies.length ? bodies.join('; ') : 'none above 0.1 Earth masses'}`);
    const B = System.budget(w);
    console.log(`  mass budget: started ${B.start.toFixed(3)} Msun, accounted for ${B.sum.toFixed(3)}`);
  } catch (e) {
    problems.push(`threw: ${e.stack || e}`);
  }
  if (problems.length) {
    failed = true;
    console.log(`  FAILED:\n    ${problems.slice(0, 12).join('\n    ')}`);
  }
}
console.log(failed ? 'SOAK TEST FAILED' : 'soak test passed');
process.exit(failed ? 1 : 0);
