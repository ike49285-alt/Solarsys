// The page: wires the view, the controls and the readings to the engine.
// It never runs physics itself; everything goes to the engine as messages.
(function () {
  'use strict';

  const F = {
    RngFactory: window.RngFactory, CloudFactory: window.CloudFactory, StarFactory: window.StarFactory,
    DiskFactory: window.DiskFactory, PlanetsFactory: window.PlanetsFactory, SystemFactory: window.SystemFactory,
    EngineFactory: window.EngineFactory,
  };
  const Engine = F.EngineFactory();
  const M = Engine.compose(F);              // for settings ranges and formatting only
  const System = M.System, Star = M.Star;
  const Render = window.RenderFactory(Star);
  const ME = M.Disk.MEARTH, MJ = M.Disk.MJUP;
  const SIG = M.Disk.SIG_CGS;

  const $ = (id) => document.getElementById(id);
  const canvas = $('sky-canvas');
  const view = Render.createView(canvas);

  // ---- Per-viewer conveniences (may be unavailable) ----------------------------------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('solar-nebula:' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('solar-nebula:' + k, JSON.stringify(v)); } catch (e) { /* storage off */ } },
  };

  // ---- Saved worlds (IndexedDB) --------------------------------------------------------
  const db = {
    open() {
      return new Promise((resolve, reject) => {
        try {
          const req = indexedDB.open('solar-nebula', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('saves');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        } catch (e) { reject(e); }
      });
    },
    async get(key) {
      const d = await db.open();
      return new Promise((resolve, reject) => {
        const tx = d.transaction('saves', 'readonly');
        const r = tx.objectStore('saves').get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    },
    async put(key, val) {
      const d = await db.open();
      return new Promise((resolve, reject) => {
        const tx = d.transaction('saves', 'readwrite');
        tx.objectStore('saves').put(val, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };

  // ---- Formatting -------------------------------------------------------------------------
  const nf = (v, d) => v.toLocaleString('en', { maximumFractionDigits: d, minimumFractionDigits: d });
  function fmtAge(y) {
    if (!(y >= 0)) return '—';
    if (y < 1e4) return `${nf(Math.round(y / 10) * 10, 0)} yr`;
    if (y < 1e6) return `${nf(y / 1e3, y < 1e5 ? 1 : 0)} kyr`;
    if (y < 1e9) return `${nf(y / 1e6, y < 1e7 ? 2 : y < 1e8 ? 1 : 0)} Myr`;
    return `${nf(y / 1e9, 2)} Gyr`;
  }
  function fmtRate(r) {
    if (!(r > 0)) return 'paused';
    if (r < 1e4) return `${nf(r, 0)} years a second`;
    if (r < 1e6) return `${nf(r / 1e3, 0)} thousand years a second`;
    if (r < 1e9) return `${nf(r / 1e6, r < 1e7 ? 1 : 0)} million years a second`;
    return `${nf(r / 1e9, 1)} billion years a second`;
  }
  function fmtSun(m) { return `${m.toFixed(m < 0.1 ? 3 : 2)} M☉`; }
  function fmtPlanetMass(m) {
    const e = m / ME;
    if (e >= 95) return `${(e / 317.8).toPrecision(2)} M♃`;
    if (e >= 10) return `${e.toFixed(0)} M⊕`;
    if (e >= 1) return `${e.toFixed(1)} M⊕`;
    return `${e.toPrecision(1)} M⊕`;
  }
  function fmtGas(m) {
    if (m >= 0.01) return fmtSun(m);
    if (m >= 3e-4 * MJ) return `${(m / MJ).toPrecision(2)} M♃`;
    return `${(m / ME).toPrecision(2)} M⊕`;
  }
  function fmtAU(a) { return a >= 100 ? `${nf(a, 0)} AU` : a >= 10 ? `${a.toFixed(1)} AU` : `${a.toFixed(2)} AU`; }
  function fmtL(L) { return L >= 100 ? `${nf(L, 0)} L☉` : L >= 0.01 ? `${L.toPrecision(2)} L☉` : `${L.toExponential(1)} L☉`; }

  // ---- Names ----------------------------------------------------------------------------------
  const REGIONS = ['Taurus', 'Orion', 'Lupus', 'Ophiuchus', 'Perseus', 'Chamaeleon', 'Serpens', 'Corona', 'Cepheus', 'Aquila', 'Musca', 'Carina'];
  function randomSeed() { return `${REGIONS[Math.floor(Math.random() * REGIONS.length)]}-${Math.floor(Math.random() * 900 + 100)}`; }
  let seed = store.get('seed', null) || randomSeed();
  let planetLetters = new Map();

  // ---- Settings ---------------------------------------------------------------------------------
  const SETTINGS_UI = {
    cloud: [
      { key: 'mass', label: 'Mass', log: true, fmt: (v) => `${v.toFixed(2)} M☉` },
      { key: 'temp', label: 'Temperature', fmt: (v) => `${v.toFixed(0)} K`, live: true },
      { key: 'spin', label: 'Spin', fmt: (v) => v.toFixed(3) },
      { key: 'turb', label: 'Turbulence', fmt: (v) => `${(v * 10).toFixed(1)}%` },
      { key: 'lumps', label: 'Lumpiness', fmt: (v) => `${(v * 100).toFixed(0)}%` },
      { key: 'field', label: 'Magnetic field', fmt: (v) => ['none', 'weak', 'moderate', 'strong', 'very strong'][Math.round(v * 4)] },
      { key: 'metals', label: 'Metals', fmt: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)} dex` },
    ],
    disk: [
      { key: 'alpha', label: 'Turbulence', log: true, fmt: (v) => `α ${v.toExponential(1)}` },
      { key: 'wind', label: 'Disk wind', fmt: (v) => v < 1e-4 ? 'off' : `${v.toExponential(1)}` },
      { key: 'grains', label: 'Grain toughness', fmt: (v) => `${v.toFixed(1)} m/s` },
      { key: 'xrays', label: 'Star\'s X-rays', fmt: (v) => `10^${v.toFixed(1)} erg/s` },
      { key: 'migration', label: 'Migration', fmt: (v) => `${Math.round(v * 100)}%` },
      { key: 'neighbours', label: 'Neighbours', seg: ['Alone', 'Cluster', 'Massive star'] },
    ],
  };
  let settings = Object.assign(System.defaults(), store.get('settings', {}));

  function buildSliders() {
    for (const group of ['cloud', 'disk']) {
      const box = $(`sliders-${group}`);
      box.textContent = '';
      for (const s of SETTINGS_UI[group]) {
        const [def, lo, hi] = System.SETTINGS[s.key].range;
        if (s.seg) {
          const row = document.createElement('div');
          row.className = 'slider';
          row.innerHTML = `<span id="lab-${s.key}">${s.label}</span><div class="seg" role="group" aria-labelledby="lab-${s.key}"></div><output></output>`;
          const seg = row.querySelector('.seg');
          s.seg.forEach((name, k) => {
            const b = document.createElement('button');
            b.type = 'button'; b.textContent = name; b.dataset.v = k;
            b.setAttribute('aria-pressed', String(Math.round(settings[s.key]) === k));
            b.addEventListener('click', () => { setSetting(s, k); seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); });
            seg.appendChild(b);
          });
          box.appendChild(row);
          continue;
        }
        const id = `set-${s.key}`;
        const row = document.createElement('label');
        row.className = 'slider'; row.htmlFor = id;
        const toPos = (v) => s.log ? Math.log(v / lo) / Math.log(hi / lo) * 1000 : (v - lo) / (hi - lo) * 1000;
        const fromPos = (p) => s.log ? lo * Math.pow(hi / lo, p / 1000) : lo + (hi - lo) * p / 1000;
        row.innerHTML = `<span>${s.label}</span><input type="range" id="${id}" min="0" max="1000" step="1"><output for="${id}"></output>`;
        const input = row.querySelector('input'), out = row.querySelector('output');
        input.value = String(Math.round(toPos(settings[s.key] ?? def)));
        out.textContent = s.fmt(settings[s.key] ?? def);
        input.addEventListener('input', () => { const v = fromPos(+input.value); out.textContent = s.fmt(v); setSetting(s, v, true); });
        input.addEventListener('change', () => setSetting(s, fromPos(+input.value)));
        box.appendChild(row);
      }
    }
  }
  let setTimer = null;
  function setSetting(s, v, live) {
    settings[s.key] = v;
    store.set('settings', settings);
    const part = System.SETTINGS[s.key].part;
    const applies = part === 'disk' ? s.key !== 'field' && s.key !== 'metals' : s.live;
    if (!applies) return;
    if (live) { clearTimeout(setTimer); setTimer = setTimeout(() => engine.send({ type: 'set', key: s.key, value: v }), 120); }
    else engine.send({ type: 'set', key: s.key, value: v });
  }
  // Disk settings the cloud group shows (they act when the disk forms).
  System.SETTINGS.field.part = 'disk';

  // ---- Views and tools ------------------------------------------------------------------------
  const VIEWS = {
    cloud: [
      { key: 'light', label: 'Light', title: 'The gas glowing by its temperature and density', sw: 'linear-gradient(90deg,#6e1234,#ff7a5c,#fff2d8)' },
      { key: 'heat', label: 'Heat', title: 'Temperature, from 8 K (blue) to 1500 K (white)', sw: 'linear-gradient(90deg,#263cbe,#28a0e6,#fae66e,#ff8c3c,#fff5eb)' },
      { key: 'motion', label: 'Motion', title: 'Falling in (blue), circling (violet) or moving out (orange)', sw: 'linear-gradient(90deg,#50aaff,#b478ff,#ff9646)' },
    ],
    disk: [
      { key: 'light', label: 'Light', title: 'The disk as it would glow', sw: 'linear-gradient(90deg,#6e1234,#ff7a5c,#fff2d8)' },
      { key: 'heat', label: 'Heat', title: 'Temperature of the gas, with the snow line', sw: 'linear-gradient(90deg,#263cbe,#28a0e6,#fae66e,#ff8c3c,#fff5eb)' },
      { key: 'dust', label: 'Dust', title: 'Dust, pebbles and planetesimals (blue: icy; tan: rocky)', sw: 'linear-gradient(90deg,#ffc478,#96cdff)' },
      { key: 'orbits', label: 'Orbits', title: 'Planets, their orbits and the habitable zone', sw: 'linear-gradient(90deg,#c8cdeb,#7fe0a8)' },
    ],
  };
  const ICON = {
    stir: '<path d="M4 10a6 6 0 1 1 6 6M10 16l-2.5-2.5M10 16l-2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    pull: '<circle cx="10" cy="10" r="2.6" fill="currentColor"/><path d="M10 2v3M10 15v3M2 10h3M15 10h3M4.3 4.3l2.1 2.1M13.6 13.6l2.1 2.1M4.3 15.7l2.1-2.1M13.6 6.4l2.1-2.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    gas: '<path d="M6 13a3 3 0 0 1 .3-6 4 4 0 0 1 7.6 1.2A2.4 2.4 0 0 1 14 13z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 15v3M8.5 16.5h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    blast: '<path d="M10 2l1.6 4.4L16 5l-2.2 4L18 11l-4.6.9L14 17l-4-2.8L6 17l.6-5.1L2 11l4.2-2L4 5l4.4 1.4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
    planet: '<circle cx="10" cy="10" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><ellipse cx="10" cy="10" rx="8.5" ry="3" fill="none" stroke="currentColor" stroke-width="1.3" transform="rotate(-20 10 10)"/>',
    move: '<path d="M10 2v16M2 10h16M10 2l-2.5 2.5M10 2l2.5 2.5M10 18l-2.5-2.5M10 18l2.5-2.5M2 10l2.5-2.5M2 10l2.5 2.5M18 10l-2.5-2.5M18 10l-2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    sweep: '<path d="M3 17l7-7M8 6l6 6M11 3l6 6-5 5-6-6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>',
    dust: '<circle cx="5" cy="6" r="1.4" fill="currentColor"/><circle cx="11" cy="4" r="1" fill="currentColor"/><circle cx="15" cy="8" r="1.6" fill="currentColor"/><circle cx="8" cy="11" r="1.1" fill="currentColor"/><circle cx="13" cy="14" r="1.3" fill="currentColor"/><circle cx="5" cy="15" r="1" fill="currentColor"/>',
    flyby: '<path d="M2 16C7 14 9 6 18 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="2 2.5"/><circle cx="16" cy="4.5" r="2.2" fill="currentColor"/>',
  };
  const TOOLS = {
    cloud: [
      { key: 'stir', label: 'Stir', hint: 'Drag across the cloud to push the gas the way you move.' },
      { key: 'pull', label: 'Pull', hint: 'Hold a finger on the cloud: it pulls on the gas like a heavy star.', choices: [['Light', 0.08], ['Heavy', 0.3]], def: 1 },
      { key: 'gas', label: 'Gas', hint: 'Tap to add a puff of fresh gas.', choices: [['Small', 40], ['Big', 150]], def: 0 },
      { key: 'blast', label: 'Blast', hint: 'Tap off to one side: a supernova blast wave hits the cloud from there.', choices: [['Weak', 0.3], ['Strong', 0.8]], def: 0 },
    ],
    disk: [
      { key: 'planet', label: 'Planet', hint: 'Tap the disk to place a body on a circular orbit there.', choices: [['Moon', 0.012], ['Earth', 1], ['Neptune', 17], ['Jupiter', 318]], def: 1 },
      { key: 'move', label: 'Move', hint: 'Drag a planet to a new orbit.' },
      { key: 'sweep', label: 'Sweep', hint: 'Drag across the disk to sweep the gas and dust out of that band.' },
      { key: 'dust', label: 'Dust', hint: 'Tap the disk to scatter dust into a ring there.', choices: [['1 M⊕', 1], ['10 M⊕', 10], ['50 M⊕', 50]], def: 1 },
      { key: 'flyby', label: 'Flyby', hint: 'Tap a distance from the star: another star passes that close.', choices: [['Red dwarf', 0.3], ['Sun-like', 1], ['Massive', 3]], def: 1 },
    ],
  };
  let stageKey = null, layer = 'light', tool = null;
  const choice = {};
  function buildRails(stage) {
    if (stage === stageKey) return;
    stageKey = stage;
    tool = null;
    const views = $('views');
    views.textContent = '';
    const label = document.createElement('div'); label.className = 'group-label'; label.textContent = 'View'; views.appendChild(label);
    if (!VIEWS[stage].some((v) => v.key === layer)) layer = 'light';
    for (const v of VIEWS[stage]) {
      const b = document.createElement('button');
      b.type = 'button'; b.title = v.title; b.setAttribute('aria-label', v.title); b.dataset.view = v.key;
      b.setAttribute('aria-pressed', String(v.key === layer));
      b.innerHTML = `<i class="sw" style="background:${v.sw}"></i>${v.label}`;
      b.addEventListener('click', () => { layer = v.key; view.setLayer(layer); views.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); });
      views.appendChild(b);
    }
    view.setLayer(layer);
    const tools = $('tools');
    tools.textContent = '';
    for (const t of TOOLS[stage]) {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.tool = t.key; b.title = t.hint; b.setAttribute('aria-label', `${t.label}: ${t.hint}`);
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${ICON[t.key]}</svg><span>${t.label}</span>`;
      b.addEventListener('click', () => pickTool(tool && tool.key === t.key ? null : t));
      tools.appendChild(b);
    }
    pickTool(null);
  }
  function pickTool(t) {
    tool = t;
    document.querySelectorAll('#tools button').forEach((b) => b.setAttribute('aria-pressed', String(!!t && b.dataset.tool === t.key)));
    const box = $('tool-options');
    if (!t) { box.hidden = true; view.pointer(null); return; }
    box.hidden = false;
    $('tool-hint').innerHTML = `<b>${t.label}</b>${t.hint}`;
    const ch = $('tool-choices');
    ch.textContent = '';
    if (t.choices) {
      if (choice[t.key] === undefined) choice[t.key] = t.def || 0;
      t.choices.forEach(([name], k) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = name; b.setAttribute('aria-pressed', String(k === choice[t.key]));
        b.addEventListener('click', () => { choice[t.key] = k; ch.querySelectorAll('button').forEach((x, j) => x.setAttribute('aria-pressed', String(j === k))); });
        ch.appendChild(b);
      });
    }
  }
  const chosen = (key) => { const t = TOOLS[stageKey].find((x) => x.key === key); return t && t.choices ? t.choices[choice[key] ?? t.def ?? 0][1] : null; };

  // ---- Stage timeline ---------------------------------------------------------------------------
  const stages = $('stages');
  for (const p of System.PHASES) { const li = document.createElement('li'); li.textContent = p.label; li.dataset.k = p.key; stages.appendChild(li); }
  function showPhase(ph) {
    const keys = System.PHASES.map((p) => p.key);
    const at = keys.indexOf(ph);
    stages.querySelectorAll('li').forEach((li, k) => { li.className = k < at ? 'done' : k === at ? 'now' : ''; if (k === at) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
    $('phase-label').textContent = System.PHASES[at] ? System.PHASES[at].label : '';
  }

  // ---- Engine -----------------------------------------------------------------------------------
  let latest = null, paused = false, speedExp = store.get('speed', 0), lastUI = 0, lastCharts = 0, booted = false;
  const engine = Engine.start(F, onMessage);
  const history = [];

  function onMessage(msg) {
    switch (msg.type) {
      case 'ready': boot(); break;
      case 'world':
        seed = msg.seed; $('seed').value = seed; $('star-name').textContent = seed;
        if (!msg.restored) { history.length = 0; planetLetters = new Map(); seenLog.clear(); $('log').textContent = ''; }
        break;
      case 'frame': {
        const f = msg.frame;
        engine.send({ type: 'ack' });
        latest = f;
        view.setFrame(f);
        if (!f.paused !== !paused) setPaused(!!f.paused, true);
        recordHistory(f);
        break;
      }
      case 'state': writeSave(msg.state); break;
      case 'inspected': if (msg.info) showInspect(msg.info); break;
      case 'error': showError(msg.message); break;
      default: break;
    }
  }

  async function boot() {
    if (booted) return;
    booted = true;
    setSpeed(speedExp, true);
    let saved = null;
    try { saved = await db.get('world'); } catch (e) { saved = null; }
    if (saved && saved.state && saved.state.version === 1) {
      engine.send({ type: 'restore', state: saved.state });
      if (saved.view) view.setView(saved.view);
      $('save-status').textContent = `Picked up where you left off (saved ${new Date(saved.at).toLocaleString()}).`;
    } else {
      newWorld('cloud');
    }
  }

  function newWorld(start) {
    seed = ($('seed').value || '').trim() || randomSeed();
    store.set('seed', seed);
    $('seed').value = seed;
    history.length = 0;
    planetLetters = new Map();
    seenLog.clear();
    $('log').textContent = '';
    stageKey = null;
    hideInspect();
    view.reset();
    view.fit();
    engine.send({ type: 'init', seed, settings, start });
    setPaused(false);
  }

  // ---- Saving -------------------------------------------------------------------------------------
  let saveBusy = false;
  function requestSave(reason) { if (!saveBusy && latest) { saveBusy = true; engine.send({ type: 'save', reason }); } }
  async function writeSave(state) {
    try {
      await db.put('world', { state, view: view.view(), at: Date.now() });
      $('save-status').textContent = `Saved ${new Date().toLocaleTimeString()}. It picks up from here next time.`;
    } catch (e) {
      $('save-status').textContent = 'This browser won\'t let the page save, so a reload starts a new cloud.';
    }
    saveBusy = false;
  }
  setInterval(() => requestSave('auto'), 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') requestSave('hide'); });
  window.addEventListener('pagehide', () => requestSave('hide'));

  // ---- Time controls -------------------------------------------------------------------------------
  function setPaused(p, fromEngine) {
    paused = p;
    const b = $('play');
    b.dataset.paused = String(p);
    b.setAttribute('aria-label', p ? 'Play' : 'Pause');
    b.title = p ? 'Play (space)' : 'Pause (space)';
    view.setPaused(p);
    if (!fromEngine) engine.send({ type: p ? 'pause' : 'play' });
  }
  function setSpeed(exp, quiet) {
    speedExp = Math.max(-3, Math.min(6, exp));
    const sp = Math.pow(2, speedExp);
    $('speed').value = String(speedExp);
    $('speed-out').textContent = sp >= 1 ? `×${sp}` : `×1/${Math.round(1 / sp)}`;
    store.set('speed', speedExp);
    engine.send({ type: 'speed', speed: sp });
    void quiet;
  }
  $('play').addEventListener('click', () => setPaused(!paused));
  $('speed').addEventListener('input', () => setSpeed(+$('speed').value));
  $('skip').addEventListener('click', () => engine.send({ type: 'skip' }));
  document.addEventListener('keydown', (e) => {
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); setPaused(!paused); }
    else if (e.key === '+' || e.key === '=') view.zoom(1.25);
    else if (e.key === '-') view.zoom(0.8);
    else if (e.key === 'f') view.fit();
  });

  // ---- The canvas: turning, zooming and the tools -----------------------------------------------
  const pointers = new Map();
  let gesture = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY, t: performance.now() });
    if (pointers.size === 2) {
      endTool(true);
      const [a, b] = [...pointers.values()];
      gesture = { kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      return;
    }
    if (pointers.size > 2) return;
    gesture = { kind: tool ? 'tool' : 'turn', x0: e.offsetX, y0: e.offsetY, x: e.offsetX, y: e.offsetY, t0: performance.now(), moved: 0 };
    if (tool) startTool(e.offsetX, e.offsetY);
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.offsetX; p.y = e.offsetY;
    if (!gesture) return;
    if (gesture.kind === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (gesture.d > 0 && d > 0) view.zoom(d / gesture.d);
      view.rotate(mx - gesture.mx, my - gesture.my);
      gesture.d = d; gesture.mx = mx; gesture.my = my;
      return;
    }
    const dx = e.offsetX - gesture.x, dy = e.offsetY - gesture.y;
    gesture.moved += Math.hypot(dx, dy);
    gesture.x = e.offsetX; gesture.y = e.offsetY;
    if (gesture.kind === 'turn') view.rotate(dx, dy);
    else moveTool(e.offsetX, e.offsetY, dx, dy);
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (!gesture) return;
    if (gesture.kind === 'pinch') { if (pointers.size === 0) gesture = null; return; }
    const tap = gesture.moved < 8 && performance.now() - gesture.t0 < 400;
    if (gesture.kind === 'tool') endTool(false, tap, e.offsetX, e.offsetY);
    else if (tap) {
      const id = view.pick(e.offsetX, e.offsetY);
      if (id) engine.send({ type: 'inspect', id }); else hideInspect();
    }
    gesture = null;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', (e) => { endTool(true); pointers.delete(e.pointerId); gesture = null; });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); view.zoom(Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  canvas.addEventListener('dblclick', () => view.fit());
  $('zoom-in').addEventListener('click', () => view.zoom(1.4));
  $('zoom-out').addEventListener('click', () => view.zoom(1 / 1.4));
  $('zoom-fit').addEventListener('click', () => view.fit());

  // Tool state while a finger is down.
  let live = null, lastSend = 0;
  function startTool(x, y) {
    const k = tool.key;
    live = { key: k, x0: x, y0: y, lastT: performance.now() };
    if (k === 'pull') {
      const v = view.toView(x, y);
      engine.send({ type: 'tool', tool: 'pull', p: v.p, mass: chosen('pull') });
      engine.send({ type: 'hold', on: true });
      view.pointer({ x, y, r: 26 });
    } else if (k === 'move') {
      live.id = view.pick(x, y);
      if (!live.id) { live = null; flash('Start the drag on a planet.'); }
    } else if (k === 'sweep') {
      const p = view.toPlane(x, y);
      live.r0 = p ? Math.hypot(p[0], p[1]) : null;
    } else if (k === 'stir') {
      engine.send({ type: 'hold', on: true });
      view.pointer({ x, y, r: 30 });
    }
  }
  function moveTool(x, y, dx, dy) {
    if (!live) return;
    const now = performance.now();
    if (live.key === 'stir') {
      view.pointer({ x, y, r: 30 });
      if (now - lastSend < 50) return;
      const dtS = Math.max(0.016, (now - live.lastT) / 1000);
      live.lastT = now; lastSend = now;
      const speed = Math.min(4, Math.max(0.3, Math.hypot(x - live.x0, y - live.y0) / dtS / 300));
      live.x0 = x; live.y0 = y;
      const v = view.toView(x, y);
      const dir = view.dragVector(dx, dy);
      engine.send({ type: 'tool', tool: 'stir', p: v.p, d: v.d, v: dir.map((c) => c * speed), radius: 30 * view.auPerPixel() });
    } else if (live.key === 'pull') {
      view.pointer({ x, y, r: 26 });
      if (now - lastSend < 60) return;
      lastSend = now;
      engine.send({ type: 'tool', tool: 'pull', p: view.toView(x, y).p, mass: chosen('pull') });
    } else if (live.key === 'move') {
      const p = view.toPlane(x, y);
      if (p) view.pointer({ x, y, r: 10, text: fmtAU(Math.hypot(p[0], p[1])) });
    } else if (live.key === 'sweep') {
      const p = view.toPlane(x, y);
      if (p && live.r0) {
        const r = Math.hypot(p[0], p[1]);
        live.r1 = r;
        view.pointer({ x, y, r: 12, text: `${fmtAU(Math.min(live.r0, r))} – ${fmtAU(Math.max(live.r0, r))}` });
      }
    }
  }
  function endTool(cancel, tap, x, y) {
    if (!live && !(tap && tool)) { view.pointer(null); return; }
    const k = live ? live.key : tool.key;
    view.pointer(null);
    if (k === 'pull' || k === 'stir') { engine.send({ type: 'hold', on: false }); if (k === 'pull') engine.send({ type: 'tool', tool: 'pull', p: null }); }
    if (cancel) { live = null; return; }
    if (k === 'gas' && tap) {
      const v = view.toView(x, y);
      engine.send({ type: 'tool', tool: 'gas', p: v.p, count: chosen('gas'), radius: 40 * view.auPerPixel() });
      view.mark({ kind: 'ring', p: v.p });
    } else if (k === 'blast' && tap) {
      const v = view.toView(x, y);
      const n = Math.hypot(...v.p) || 1;
      engine.send({ type: 'tool', tool: 'blast', d: v.p.map((c) => c / n), speed: chosen('blast') });
      const rect = canvas.getBoundingClientRect();
      view.mark({ kind: 'wave', dur: 1.4, sx: (x / rect.width - 0.5) * 2, sy: (y / rect.height - 0.5) * 2 });
    } else if (k === 'planet' && tap) {
      const p = view.toPlane(x, y);
      if (!p) flash('Tilt the view to tap the disk.');
      else { const a = Math.hypot(p[0], p[1]); engine.send({ type: 'tool', tool: 'planet', a, earths: chosen('planet') }); view.mark({ kind: 'ring', p }); }
    } else if (k === 'move' && live && live.id) {
      const p = view.toPlane(x, y);
      if (p) engine.send({ type: 'tool', tool: 'move', id: live.id, a: Math.max(0.03, Math.hypot(p[0], p[1])) });
    } else if (k === 'sweep' && live && live.r0) {
      let r0 = Math.min(live.r0, live.r1 || live.r0), r1 = Math.max(live.r0, live.r1 || live.r0);
      if (r1 / r0 < 1.15) { const m = Math.sqrt(r0 * r1); r0 = m / 1.08; r1 = m * 1.08; }
      engine.send({ type: 'tool', tool: 'clear', r0, r1 });
      view.mark({ kind: 'band', r0, r1, dur: 1.2 });
    } else if (k === 'dust' && tap) {
      const p = view.toPlane(x, y);
      if (p) { const r = Math.hypot(p[0], p[1]); engine.send({ type: 'tool', tool: 'dust', r0: r / 1.1, r1: r * 1.1, earths: chosen('dust') }); view.mark({ kind: 'band', r0: r / 1.1, r1: r * 1.1, dur: 0.9 }); }
    } else if (k === 'flyby' && tap) {
      const p = view.toPlane(x, y);
      if (p) { const q = Math.hypot(p[0], p[1]); engine.send({ type: 'tool', tool: 'flyby', q, mass: chosen('flyby') }); view.mark({ kind: 'flyby', q, ang: Math.atan2(p[1], p[0]), dur: 2.2 }); }
    }
    live = null;
  }
  let flashTimer = null;
  function flash(text) {
    const n = $('sky-note');
    n.textContent = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { n.textContent = ''; }, 2500);
  }

  // ---- Inspector -------------------------------------------------------------------------------------
  let inspected = null;
  function showInspect(b) {
    inspected = b.id;
    view.setSelected(b.id);
    $('inspect').hidden = false;
    const name = `${seed} ${planetLetters.get(b.id) || ''}`.trim();
    $('inspect-title').textContent = b.star ? `Companion star` : `${name} · ${b.kind}`;
    const rows = b.star ? [
      ['Mass', fmtSun(b.mass)], ['Orbit', fmtAU(b.a)], ['Eccentricity', b.e.toFixed(2)], ['Period', `${nf(b.period, 0)} yr`],
    ] : [
      ['Mass', fmtPlanetMass(b.mass)], ['Radius', `${b.radius.toFixed(1)} R⊕`], ['Orbit', fmtAU(b.a)], ['Eccentricity', b.e.toFixed(2)],
      ['Year', b.period < 1 ? `${nf(b.period * 365.25, 0)} days` : `${b.period.toPrecision(3)} yr`], ['Temperature', `${nf(b.teq, 0)} K`],
      ['Water', `${Math.round(b.water * 100)}% of its rock and ice`], ['Gas envelope', `${(b.gas * 100).toPrecision(2)}%`],
    ];
    $('inspect-facts').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  }
  function hideInspect() { inspected = null; view.setSelected(null); $('inspect').hidden = true; }
  $('inspect-close').addEventListener('click', hideInspect);

  // ---- Errors ------------------------------------------------------------------------------------------
  function showError(text) {
    $('alert').hidden = false;
    $('alert-title').textContent = 'The simulation paused itself';
    $('alert-text').textContent = `Something went wrong in the physics: ${text}. Everything up to here is kept. You can try to carry on, or start a new cloud.`;
    setPaused(true, true);
  }
  $('alert-close').addEventListener('click', () => { $('alert').hidden = true; });
  $('alert-resume').addEventListener('click', () => { $('alert').hidden = true; setPaused(false); });
  $('alert-new').addEventListener('click', () => { $('alert').hidden = true; $('seed').value = randomSeed(); newWorld('cloud'); });

  // ---- Tabs ------------------------------------------------------------------------------------------------
  const tabs = ['system', 'profile', 'settings'];
  function showTab(k) {
    for (const t of tabs) {
      $(`tab-${t}`).setAttribute('aria-selected', String(t === k));
      $(`pane-${t}`).hidden = t !== k;
    }
    store.set('tab', k);
    lastCharts = 0;
  }
  for (const t of tabs) $(`tab-${t}`).addEventListener('click', () => showTab(t));
  showTab(store.get('tab', 'system'));

  // ---- New worlds ------------------------------------------------------------------------------------------
  $('seed').value = seed;
  $('seed-random').addEventListener('click', () => { $('seed').value = randomSeed(); });
  $('new-cloud').addEventListener('click', () => newWorld('cloud'));
  $('new-disk').addEventListener('click', () => newWorld('disk'));
  $('reset-settings').addEventListener('click', () => { settings = System.defaults(); store.set('settings', settings); buildSliders(); for (const s of SETTINGS_UI.disk) if (!s.seg) engine.send({ type: 'set', key: s.key, value: settings[s.key] }); engine.send({ type: 'set', key: 'neighbours', value: settings.neighbours }); });
  buildSliders();

  // ---- Readings ------------------------------------------------------------------------------------------------
  const seenLog = new Set();
  function recordHistory(f) {
    const r = f.readings;
    const last = history[history.length - 1];
    if (!last || r.age > last[0] * 1.02 + 1) history.push([r.age, r.starMass, r.stage === 'cloud' ? r.gas : r.gas]);
    if (history.length > 800) history.splice(0, history.length - 800);
  }

  function updateUI(f) {
    const r = f.readings;
    buildRails(f.stage);
    showPhase(f.phase);
    $('age').textContent = fmtAge(f.age);
    $('rate').textContent = f.ended ? 'The end of this system’s story.' : f.skipping ? `Skipping ahead, ${fmtRate(f.rate)}` : paused ? `Paused at ${fmtAge(f.age)}` : `${fmtRate(f.rate)}${f.rate > 0 && f.rate < 0.5 * f.target ? ' (this device’s limit)' : ''}`;
    const skip = $('skip');
    if (skip.getAttribute('aria-pressed') !== String(!!f.skipping)) {
      skip.setAttribute('aria-pressed', String(!!f.skipping));
      skip.textContent = f.skipping ? 'Stop ■' : 'Skip ▸▸';
      skip.title = f.skipping ? 'Stop skipping' : 'Hurry on to the next stage';
    }
    skip.disabled = !!f.ended;
    $('sp-gas-label').textContent = f.stage === 'cloud' ? 'Gas left in the cloud' : 'Gas in the disk';

    // Stats.
    let rows;
    if (f.stage === 'cloud') {
      rows = [
        ['Protostar', r.protostar ? fmtSun(r.starMass) + (r.stars > 1 ? ` (${r.stars} stars)` : '') : 'not yet'],
        ['Brightness', r.protostar ? fmtL(r.luminosity) : '—'],
        ['Gas left', fmtSun(r.gas)],
        ['In a disk', r.protostar ? fmtSun(r.disk) : '—'],
        ['Cloud size', `${nf(r.radius * 2, 0)} AU across`],
        ['Gas temperature', `${r.temperature.toFixed(0)} K`],
      ];
    } else {
      const s = r.star;
      rows = [
        ['Star', `${fmtSun(r.starMass)}, ${s.phase}`],
        ['Brightness', `${fmtL(r.luminosity)}${r.mdot > 1e-9 ? '' : ''}`],
        ['Surface', `${nf(s.T, 0)} K`],
        ['Feeding on gas', r.mdot > 1e-12 && !r.gone ? `${r.mdot.toExponential(1)} M☉/yr` : 'no longer'],
        ['Gas disk', r.gone ? `gone at ${fmtAge(r.goneAt)}` : fmtGas(r.gas)],
        ['Dust and pebbles', `${nf(r.dust / ME, r.dust / ME < 10 ? 1 : 0)} M⊕`],
        ['Planetesimals', `${nf(r.planetesimals / ME, r.planetesimals / ME < 10 ? 1 : 0)} M⊕`],
        ['Planets', r.planets ? `${r.planets}, ${fmtPlanetMass(r.planetMass)} in all` : 'none yet'],
        ['Snow line', r.gone ? '—' : fmtAU(r.snowLine)],
        ['Habitable zone', `${fmtAU(r.hz.inner)} – ${fmtAU(r.hz.outer)}`],
      ];
    }
    $('stats').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

    // Bodies.
    const tbody = $('bodies').tBodies[0];
    const list = (f.bodies || []).filter((b) => b.earths >= 0.05 || b.star).sort((a, b) => a.a - b.a);
    let letter = 0;
    planetLetters = new Map();
    for (const b of list) if (!b.star) planetLetters.set(b.id, String.fromCharCode(98 + Math.min(24, letter++)));
    for (const b of f.bodies || []) b.label = planetLetters.get(b.id) || '';
    $('bodies-empty').hidden = list.length > 0;
    $('bodies-empty').textContent = f.stage === 'cloud' ? 'No planets yet. They start as dust in the disk.' : 'No planets yet. Dust is still gathering into planetesimals.';
    tbody.innerHTML = list.map((b) => `<tr data-id="${b.id}" class="${b.id === inspected ? 'sel' : ''}"><td><span class="dot" style="background:${b.star ? '#ffd48a' : view.kindColour(b.kind)}"></span>${b.star ? 'companion star' : `${planetLetters.get(b.id)} · ${b.kind}`}</td><td class="num">${b.star ? fmtSun(b.mass) : fmtPlanetMass(b.mass)}</td><td class="num">${fmtAU(b.a)}</td><td class="num">${b.e.toFixed(2)}</td><td class="num">${b.star ? '—' : Math.round(b.water * 100) + '%'}</td></tr>`).join('');
    if (inspected) {
      const b = (f.bodies || []).find((x) => x.id === inspected);
      if (b) showInspect(b); else hideInspect();
    }

    // Log: newest first.
    const ol = $('log');
    for (const e of f.log) {
      if (seenLog.has(e.id)) continue;
      seenLog.add(e.id);
      const li = document.createElement('li');
      li.className = 'new';
      li.innerHTML = `<time>${fmtAge(e.t)}</time><span></span>`;
      li.lastChild.textContent = e.text;
      ol.insertBefore(li, ol.firstChild);
      while (ol.children.length > 80) ol.removeChild(ol.lastChild);
    }
  }
  $('bodies').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) engine.send({ type: 'inspect', id: +tr.dataset.id });
  });

  // ---- Charts --------------------------------------------------------------------------------------------------------
  function sized(c, h) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(10, Math.round(c.clientWidth * dpr)), hh = Math.round(h * dpr);
    if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
    return { g: c.getContext('2d'), W: w, H: hh, dpr };
  }
  function spark(id, col, colour, fmt) {
    const c = $(id);
    const { g, W, H, dpr } = sized(c, 46);
    g.clearRect(0, 0, W, H);
    const pts = history.filter((p) => p[0] > 0 && p[col] >= 0);
    if (pts.length < 2) return;
    const x0 = Math.log10(pts[0][0]), x1 = Math.log10(pts[pts.length - 1][0]);
    const vals = pts.map((p) => p[col]);
    const v1 = Math.max(...vals) * 1.05 || 1;
    const X = (a) => (Math.log10(a) - x0) / Math.max(1e-9, x1 - x0) * (W - 6 * dpr) + 3 * dpr;
    const Y = (v) => H - 4 * dpr - (v / v1) * (H - 10 * dpr);
    g.strokeStyle = '#232944'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, H - 4 * dpr + 0.5); g.lineTo(W, H - 4 * dpr + 0.5); g.stroke();
    g.beginPath();
    pts.forEach((p, k) => { const x = X(p[0]), y = Y(p[col]); if (k) g.lineTo(x, y); else g.moveTo(x, y); });
    g.strokeStyle = colour; g.lineWidth = 1.8 * dpr; g.stroke();
    g.lineTo(X(pts[pts.length - 1][0]), H - 4 * dpr); g.lineTo(X(pts[0][0]), H - 4 * dpr); g.closePath();
    g.globalAlpha = 0.14; g.fillStyle = colour; g.fill(); g.globalAlpha = 1;
    const lx = X(pts[pts.length - 1][0]), ly = Y(pts[pts.length - 1][col]);
    g.fillStyle = colour; g.beginPath(); g.arc(lx - 1 * dpr, ly, 3 * dpr, 0, Math.PI * 2); g.fill();
    $(`${id}-v`).textContent = fmt(pts[pts.length - 1][col]);
  }

  function profileChart(f) {
    const c = $('profile');
    const { g, W, H, dpr } = sized(c, 280);
    g.clearRect(0, 0, W, H);
    const padL = 44 * dpr, padR = 40 * dpr, padT = 10 * dpr, padB = 34 * dpr;
    const r0 = 0.05, r1 = 1000, s0 = 1e-3, s1 = 1e5, T0 = 10, T1 = 3000;
    const X = (r) => padL + (Math.log10(r / r0) / Math.log10(r1 / r0)) * (W - padL - padR);
    const Y = (s) => padT + (1 - Math.log10(Math.max(s, s0) / s0) / Math.log10(s1 / s0)) * (H - padT - padB);
    const YT = (T) => padT + (1 - Math.log10(Math.max(T, T0) / T0) / Math.log10(T1 / T0)) * (H - padT - padB);
    g.font = `${11 * dpr}px "IBM Plex Mono", monospace`;
    g.strokeStyle = '#1c2140'; g.fillStyle = '#8f95b0'; g.lineWidth = 1;
    for (let e = -1; e <= 3; e++) {
      const x = X(Math.pow(10, e));
      g.beginPath(); g.moveTo(x + 0.5, padT); g.lineTo(x + 0.5, H - padB); g.stroke();
      g.textAlign = 'center'; g.fillText(e === -1 ? '0.1' : String(Math.pow(10, e)), x, H - padB + 14 * dpr);
    }
    g.fillText('AU from the star', (padL + W - padR) / 2, H - 4 * dpr);
    for (let e = -3; e <= 5; e += 2) {
      const y = Y(Math.pow(10, e));
      g.beginPath(); g.moveTo(padL, y + 0.5); g.lineTo(W - padR, y + 0.5); g.stroke();
      const sup = (e < 0 ? '⁻' : '') + String(Math.abs(e)).replace(/\d/g, (k) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[k]);
      g.textAlign = 'right'; g.fillText(`10${sup}`, padL - 6 * dpr, y + 4 * dpr);
    }
    g.save(); g.translate(11 * dpr, (padT + H - padB) / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.fillText('g/cm²', 0, 0); g.restore();
    g.textAlign = 'left';
    for (const T of [10, 100, 1000]) g.fillText(`${T}K`, W - padR + 4 * dpr, YT(T) + 4 * dpr);
    if (!f || f.stage !== 'disk') {
      g.textAlign = 'center'; g.fillStyle = '#8f95b0';
      g.fillText('The disk appears once the star has formed.', (padL + W - padR) / 2, H / 2);
      return;
    }
    const d = f.disk;
    const line = (arr, colour, scale, dash, yf) => {
      g.beginPath(); let on = false;
      for (let i = 0; i < d.r.length; i++) {
        const v = arr[i] * scale;
        if (!(v > (yf ? 0 : s0))) { on = false; continue; }
        const x = X(d.r[i]), y = (yf || Y)(v);
        if (!on) { g.moveTo(x, y); on = true; } else g.lineTo(x, y);
      }
      g.strokeStyle = colour; g.lineWidth = 2 * dpr; g.setLineDash(dash ? dash.map((v) => v * dpr) : []); g.stroke(); g.setLineDash([]);
    };
    line(d.sigG, '#ff8fa3', SIG);
    line(d.sigD, '#ffc46b', SIG);
    line(d.sigP, '#a9b2cc', SIG);
    line(d.T, '#ffd48a', 1, [4, 3], YT);
    const sl = f.readings.snowLine;
    if (!f.readings.gone && sl > r0) { g.strokeStyle = '#8fd0ff'; g.setLineDash([3 * dpr, 3 * dpr]); g.beginPath(); g.moveTo(X(sl), padT); g.lineTo(X(sl), H - padB); g.stroke(); g.setLineDash([]); }
    for (const b of f.bodies || []) {
      if (b.earths < 0.05 && !b.star) continue;
      const x = X(Math.max(r0, Math.min(r1, b.a)));
      const rad = Math.min(9, 2.5 + 1.6 * Math.log10(1 + b.earths)) * dpr;
      g.fillStyle = b.star ? '#ffd48a' : view.kindColour(b.kind);
      g.beginPath(); g.arc(x, H - padB - rad - 2 * dpr, rad, 0, Math.PI * 2); g.fill();
    }
  }

  // ---- The loop ----------------------------------------------------------------------------------------------------------
  let lastT = performance.now();
  function tick(t) {
    const dt = Math.min(0.1, (t - lastT) / 1000);
    lastT = t;
    view.draw(dt);
    const app = view.auPerPixel ? view.auPerPixel() : 1;
    // Scale bar: a round number of AU about 60 px long.
    const target = 60 * app;
    const p = Math.pow(10, Math.floor(Math.log10(target)));
    const nice = [1, 2, 5, 10].map((k) => k * p).find((v) => v >= target * 0.7) || p;
    $('scale-bar').style.width = `${Math.round(nice / app)}px`;
    $('scale-label').textContent = nice >= 1 ? `${nf(nice, 0)} AU` : `${nice} AU`;
    if (latest && t - lastUI > 200) { lastUI = t; try { updateUI(latest); } catch (e) { console.error(e); } }
    if (latest && t - lastCharts > 700) {
      lastCharts = t;
      if (!$('pane-system').hidden) {
        spark('sp-star', 1, '#ffd48a', fmtSun);
        spark('sp-gas', 2, '#ff8fa3', fmtGas);
      }
      if (!$('pane-profile').hidden) profileChart(latest);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // For tests.
  window.__nebula = { engine, view, get latest() { return latest; }, send: (m) => engine.send(m) };
})();
