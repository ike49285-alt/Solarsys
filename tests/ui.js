// Drives the page in headless Chromium on a phone-sized screen: lets the
// cloud collapse, uses every tool, skips into the disk and planet stages,
// opens every tab and view, and fails on any page error. Saves screenshots.
//
//   node tests/ui.js [page] [screenshot-dir]
//
// Needs Playwright (playwright-core) and a Chromium; set CHROMIUM to the
// browser binary and PLAYWRIGHT to the playwright-core module if they aren't
// found in the usual places.
'use strict';
const path = require('path');
const fs = require('fs');

function load(name, guesses) {
  for (const g of guesses) { try { return require(g); } catch (e) { /* try the next */ } }
  return null;
}
const pw = load('playwright-core', [process.env.PLAYWRIGHT, 'playwright-core', '/opt/node-tools/node_modules/playwright-core'].filter(Boolean));
if (!pw) { console.log('playwright-core not found; skipping the page test'); process.exit(0); }
const chromium = process.env.CHROMIUM || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find((p) => fs.existsSync(p));

const page = path.resolve(process.argv[2] || path.join(__dirname, '..', 'index.html'));
const shots = process.argv[3] || path.join(__dirname, '..', 'dist', 'shots');
fs.mkdirSync(shots, { recursive: true });

(async () => {
  const browser = await pw.chromium.launch({ executablePath: chromium, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await p.goto('file://' + page);
  const state = () => p.evaluate(() => { const f = window.__nebula.latest; return f && { stage: f.stage, phase: f.phase, age: f.age, bodies: (f.bodies || []).length, rate: f.rate }; });
  const shot = (name) => p.screenshot({ path: path.join(shots, `${name}.png`) });
  const sky = await p.locator('#sky-canvas').boundingBox();
  const at = (fx, fy) => [sky.x + sky.width * fx, sky.y + sky.height * fy];
  const tap = async (fx, fy) => { const [x, y] = at(fx, fy); await p.mouse.click(x, y); };
  const drag = async (fx0, fy0, fx1, fy1, steps) => {
    const [x0, y0] = at(fx0, fy0), [x1, y1] = at(fx1, fy1);
    await p.mouse.move(x0, y0); await p.mouse.down();
    for (let k = 1; k <= (steps || 12); k++) { await p.mouse.move(x0 + (x1 - x0) * k / (steps || 12), y0 + (y1 - y0) * k / (steps || 12)); await p.waitForTimeout(30); }
    await p.mouse.up();
  };
  const useTool = (name) => p.click(`#tools button[data-tool="${name}"]`);

  // Clear any save from an earlier run, so it starts from a new cloud.
  await p.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('solar-nebula'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await p.reload();
  await p.waitForTimeout(3000);
  console.log('cloud:', JSON.stringify(await state()));
  await shot('1-cloud');

  // The cloud tools.
  await useTool('stir'); await drag(0.3, 0.5, 0.7, 0.45);
  await useTool('pull'); { const [x, y] = at(0.6, 0.4); await p.mouse.move(x, y); await p.mouse.down(); await p.waitForTimeout(700); await p.mouse.move(x + 20, y + 10); await p.waitForTimeout(400); await p.mouse.up(); }
  await useTool('gas'); await tap(0.35, 0.6);
  await useTool('blast'); await tap(0.95, 0.5);
  await p.waitForTimeout(1500);
  for (const v of ['heat', 'motion', 'light']) { await p.click(`#views button[data-view="${v}"]`); await p.waitForTimeout(300); if (v !== 'light') await shot(`2-cloud-${v}`); }
  await p.waitForTimeout(6000);
  console.log('after tools:', JSON.stringify(await state()));
  await shot('3-protostar');

  // Skip to the disk.
  await p.click('#skip');
  for (let k = 0; k < 60 && (await state()).stage !== 'disk'; k++) await p.waitForTimeout(500);
  await p.waitForTimeout(1500);
  console.log('disk:', JSON.stringify(await state()));
  await shot('4-disk');
  await p.waitForTimeout(6000);
  await shot('5-disk-later');

  // The disk tools.
  await useTool('planet'); await tap(0.62, 0.5);
  await useTool('dust'); await tap(0.4, 0.42);
  await useTool('sweep'); await drag(0.55, 0.5, 0.7, 0.5);
  await p.waitForTimeout(1000);
  await useTool('flyby'); await tap(0.9, 0.15);
  await p.waitForTimeout(2500);
  for (const v of ['heat', 'dust', 'orbits']) { await p.click(`#views button[data-view="${v}"]`); await p.waitForTimeout(400); await shot(`6-disk-${v}`); }
  await p.click('#views button[data-view="light"]');

  // On through the stages.
  for (let k = 0; k < 4; k++) {
    await p.click('#skip');
    await p.waitForTimeout(2500);
    console.log('skip:', JSON.stringify(await state()));
  }
  await shot('7-later');
  await useTool('move');
  { const id = await p.evaluate(() => { const f = window.__nebula.latest; const b = (f.bodies || []).find((x) => x.earths > 0.5); return b ? b.id : null; }); console.log('move target', id); }
  await p.click('#views button[data-view="orbits"]');
  await p.waitForTimeout(800);
  await shot('8-orbits');

  // Tabs.
  await p.click('#tab-profile'); await p.waitForTimeout(1200); await shot('9-profile');
  await p.click('#tab-settings'); await p.waitForTimeout(500); await shot('10-settings');
  await p.click('#tab-system'); await p.waitForTimeout(500);
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await p.waitForTimeout(500); await shot('11-system');

  // Start from a disk, then save and reload: it should pick up again.
  await p.click('#tab-settings'); await p.click('#new-disk');
  await p.waitForTimeout(4000);
  await p.evaluate(() => window.__nebula.send({ type: 'save', reason: 'test' }));
  await p.waitForTimeout(1500);
  const before = await state();
  await p.reload();
  await p.waitForTimeout(3000);
  const after = await state();
  console.log('reload:', JSON.stringify(before), '->', JSON.stringify(after));
  if (!after || after.stage !== 'disk' || after.age < before.age * 0.5) errors.push(`didn't pick up after reload: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) errors.push(`page scrolls sideways by ${overflow}px`);
  await browser.close();
  console.log(errors.length ? `PAGE TEST FAILED\n  ${errors.join('\n  ')}` : 'page test passed');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
