// How long each stage of one system takes on screen at speed 1, using the
// engine's own pacing, assuming the device keeps up (a slow phone stretches
// the heavy parts: the collapse and the planets forming).
//
//   node tools/pace.js [seed]
'use strict';
const path = require('path');

const src = path.join(__dirname, '..', 'src');
const F = {};
for (const [name, file] of [['RngFactory', 'rng'], ['CloudFactory', 'cloud'], ['StarFactory', 'star'], ['DiskFactory', 'disk'],
  ['PlanetsFactory', 'planets'], ['SystemFactory', 'system'], ['EngineFactory', 'engine']]) F[name] = require(path.join(src, `${file}.js`));
const Engine = F.EngineFactory();
const { System } = Engine.compose(F);

const seed = process.argv[2] || 'Taurus-101';
const w = System.create(seed, {});
const secs = new Map();
const add = (stage, s) => secs.set(stage, (secs.get(stage) || 0) + s);

while (w.stage === 'cloud') add(System.phase(w), System.stepCloud(w) / Engine.CLOUD_RATE);
// On to a black dwarf, a thousand billion years on; time goes on after that.
while (w.age < 2e12) {
  const phase = System.phase(w), star = w.disk.star.phase;
  const a0 = w.age, rate = Engine.pace(System, w);
  System.advance(w, Math.max(1, System.nextStep(w)) * 2, 4);
  add(phase === 'late' ? `old age: ${star}` : phase, (w.age - a0) / rate);
}

const fmt = (s) => (s >= 90 ? `${(s / 60).toFixed(1)} min` : `${s.toFixed(0)} s`);
let total = 0;
for (const [stage, s] of secs) { total += s; console.log(`${stage.padEnd(30)} ${fmt(s)}`); }
console.log(`${'to a black dwarf'.padEnd(30)} ${fmt(total)}`);
