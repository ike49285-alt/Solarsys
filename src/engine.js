// Runs a world against a clock, off the page's thread.
//
// The page starts the engine; it runs in a Web Worker built from the
// modules' factory functions (their source text), so it works from a file,
// a web server or an artifact alike, and falls back to running on the page
// if workers aren't available. The page and the engine talk only by
// messages.
//
// Stability first: each slice of work has a time budget and the clock never
// chases a backlog, so heavy stretches run slower rather than freezing. Any
// error pauses the clock and reports itself, and the world is left intact.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.EngineFactory = factory;
})(this, function EngineFactory() {
  'use strict';

  const BUDGET_MS = 14;          // longest a slice of simulation may run before yielding
  const LOOP_MS = 16;
  const FRAME_MS = 33;           // frames go out no more often than this
  const MAX_IN_FLIGHT = 2;
  // How fast time runs at speed 1. In the collapse, years a second. After
  // it, a fraction of the age each second (a log clock), set by the stage:
  // slow while the disk lives and planets form, which is the part you can
  // play with, and quicker through the quiet billions of years. In old age
  // the star's brief phases hold it back too, so a red giant gets minutes on
  // screen, not a blink. At speed 1 a whole system takes about half an hour.
  //
  // After the star dies time goes on, quicker, with nothing to stop it: the
  // remnant cools, and gas poured in grows a new disk, which gets the pace
  // of a young one by its own age. Past a black dwarf's age, about 1e15
  // years, time stops speeding up.
  const CLOUD_RATE = 120;
  const LOG_RATE = { disk: 0.007, planets: 0.007, clearing: 0.007, impacts: 0.01, mature: 0.015, late: 0.01, remnant: 0.05 };
  const STAR_STEPS = 5;          // at most this many of the star's step limits a second
  const LATE_CAP = 1e13;         // years a second, at most
  const MAX_AGE = 1e100;         // numbers stay sane, however long it's left running

  // Years a second at speed 1 for a world past its collapse.
  function pace(System, w) {
    if (w.age >= MAX_AGE) return 0;
    const ph = System.phase(w), star = w.disk.star;
    const key = ph === 'late' && star && star.remnant ? 'remnant' : ph;
    let rate = Math.min(Math.max(1, w.age) * (LOG_RATE[key] || 0.01), STAR_STEPS * System.starStep(w), LATE_CAP);
    const young = System.newDiskAge(w);
    if (young !== null) rate = Math.min(rate, Math.max(1e4, young) * LOG_RATE.disk);
    return rate;
  }

  function compose(F) {
    const Rng = F.RngFactory();
    const Cloud = F.CloudFactory(Rng);
    const Star = F.StarFactory();
    const Disk = F.DiskFactory(Rng, Star);
    const Planets = F.PlanetsFactory(Rng, Disk, Star);
    const System = F.SystemFactory(Rng, Cloud, Star, Disk, Planets);
    return { Rng, Cloud, Star, Disk, Planets, System };
  }

  // ---- The engine itself (in the worker) ----------------------------------------------
  function createHost(post, F) {
    const M = compose(F);
    const System = M.System;
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let w = null, paused = false, speed = 1, held = false;
    let timer = null, last = 0, lastFrame = 0, inFlight = 0, dirty = true, broken = false;
    let stepMs = 1, debt = 0, achieved = 0;
    let ff = null;                 // fast-forwarding to the next stage: { phase, goal }
    const recent = [];

    function targetRate() {
      if (!w) return 0;
      // While a finger stirs or pulls the cloud, time runs no faster than x1.
      if (w.stage === 'cloud') return CLOUD_RATE * (held ? Math.min(1, speed) : speed);
      return pace(System, w) * speed;
    }

    function fail(e) {
      broken = true; paused = true;
      post({ type: 'error', message: (e && e.message) || String(e), stack: e && e.stack ? String(e.stack).slice(0, 2000) : '' });
    }

    // Run the world forward by up to `years`, within the budget.
    function runFor(years, budget) {
      const start = now();
      let done = 0, n = 0;
      if (w.stage === 'cloud') {
        // A collapse step can't be split, so take one only once the clock
        // has run up enough time for it (not one every slice regardless,
        // which let the start of the collapse race ahead).
        while (w.stage === 'cloud' && done + 0.5 * System.nextStep(w) <= years && now() - start < budget) {
          done += System.stepCloud(w);
          n++;
        }
        if (n) stepMs = stepMs * 0.8 + ((now() - start) / n) * 0.2;
      } else {
        while (n === 0 || (done < years && now() - start < budget)) {
          const chunk = Math.min(years - done, Math.max(1, System.nextStep(w)) * 4);
          if (chunk <= 0) break;
          done += System.advance(w, chunk, 8);
          n++;
        }
      }
      return done;
    }

    // A fast-forward runs whole slices back to back, still yielding between
    // them, until the stage changes or the age has grown tenfold. Late on,
    // a slice could cover billions of years, so it looks again every few
    // percent of the age rather than sailing past the next stage.
    function fastForward() {
      const start = now();
      do {
        const left = ff.goal - w.age;
        runFor(w.stage === 'cloud' ? Infinity : Math.min(left, 0.04 * Math.max(1, w.age)), Math.max(1, BUDGET_MS - (now() - start)));
        if (w.stage !== ff.stage || System.phase(w) !== ff.phase || w.age >= ff.goal || starPhase() !== ff.star || (System.newDiskAge(w) !== null) !== ff.newDisk) {
          ff = null; debt = 0; recent.length = 0;
          return;
        }
      } while (now() - start < BUDGET_MS);
    }

    // In old age the star itself is the story, so a skip stops at each of
    // its changes (giant, helium burning, white dwarf, ...).
    function starPhase() {
      return w.stage === 'disk' && System.phase(w) === 'late' && w.disk.star ? w.disk.star.phase : null;
    }

    function sendFrame() {
      const f = System.frame(w);
      f.paused = paused; f.speed = speed; f.rate = achieved; f.target = targetRate(); f.stepMs = stepMs;
      f.skipping = !!ff;
      f.stepYears = w.stage === 'cloud' ? System.nextStep(w) : 0;   // lets the view glide between collapse steps
      const transfer = [];
      if (f.cloud) for (const k of ['pos', 'vel', 'rho', 'temp']) transfer.push(f.cloud[k].buffer);
      if (f.disk) for (const k of Object.keys(f.disk)) if (f.disk[k] && f.disk[k].buffer) transfer.push(f.disk[k].buffer);
      if (f.lastCloud) for (const k of ['pos', 'vel', 'rho', 'temp']) transfer.push(f.lastCloud[k].buffer);
      post({ type: 'frame', frame: f }, transfer);
      lastFrame = now();
      inFlight++;
      dirty = false;
    }

    function loop() {
      timer = null;
      if (!w) return;
      const t = now();
      const dt = Math.min(250, t - last);
      last = t;
      if (ff && !broken) {
        try { fastForward(); dirty = true; } catch (e) { ff = null; fail(e); }
      } else if (!paused && !broken) {
        try {
          const rate = targetRate();
          // Owed time is capped, so a stall never turns into a rush, but
          // always covers at least one collapse step, so slow speeds still move.
          debt = Math.min(debt + rate * dt / 1000, Math.max(rate * 0.25, w.stage === 'cloud' ? 2 * System.nextStep(w) : 0));
          let budget = BUDGET_MS;
          if (inFlight < MAX_IN_FLIGHT) budget = Math.max(4, Math.min(budget, lastFrame + FRAME_MS - t));
          const done = runFor(debt, budget);
          debt -= done;   // a collapse step's overshoot is carried, not forgiven
          dirty = true;
        } catch (e) { fail(e); }
      }
      recent.push([t, w.age]);
      while (recent.length > 2 && t - recent[0][0] > 1500) recent.shift();
      if (recent.length > 1) {
        const a = recent[0], b = recent[recent.length - 1];
        achieved = b[0] > a[0] ? (b[1] - a[1]) * 1000 / (b[0] - a[0]) : 0;
      }
      if (inFlight < MAX_IN_FLIGHT && (dirty || paused) && now() - lastFrame >= FRAME_MS - 1) {
        try { sendFrame(); } catch (e) { fail(e); }
      }
      timer = setTimeout(loop, paused && !ff ? 50 : Math.max(1, LOOP_MS - (now() - t)));
    }

    function start() {
      last = now();
      if (!timer) timer = setTimeout(loop, 0);
    }

    function reset() { debt = 0; recent.length = 0; inFlight = 0; broken = false; dirty = true; ff = null; }

    return function onMessage(msg) {
      try {
        switch (msg.type) {
          case 'init':
            w = System.create(msg.seed, msg.settings, { start: msg.start, n: msg.n });
            paused = !!msg.paused;
            reset(); start();
            post({ type: 'world', seed: w.seed, settings: w.settings });
            break;
          case 'restore':
            w = System.restore(msg.state);
            paused = !!msg.paused;
            reset(); start();
            post({ type: 'world', seed: w.seed, settings: w.settings, restored: true });
            break;
          case 'ack': inFlight = Math.max(0, inFlight - 1); break;
          case 'speed': speed = Math.max(0.05, Math.min(64, +msg.speed || 1)); debt = 0; recent.length = 0; break;
          case 'pause': paused = true; ff = null; dirty = true; break;
          case 'play': if (!broken) { paused = false; debt = 0; last = now(); } break;
          case 'hold': held = !!msg.on; break;
          case 'tool': if (w) { System.tool(w, msg); dirty = true; } break;
          case 'set': if (w) { System.set(w, msg.key, msg.value); dirty = true; } break;
          case 'inspect': if (w) post({ type: 'inspected', info: System.inspect(w, msg.id) }); break;
          case 'save': if (w) post({ type: 'state', state: System.save(w), reason: msg.reason }); break;
          case 'skip':
            // Hurry on to the next stage (or a tenfold age), showing it on the
            // way; skipping again while it runs stops it.
            if (w && !broken && w.age < MAX_AGE) {
              if (ff) { ff = null; debt = 0; recent.length = 0; }
              else {
                ff = {
                  stage: w.stage, phase: System.phase(w), star: starPhase(), newDisk: System.newDiskAge(w) !== null,
                  goal: w.stage === 'cloud' ? Infinity : Math.min(MAX_AGE, Math.max(1, w.age) * 10),
                };
              }
              dirty = true;
            }
            break;
          case 'runTo':  // tests: advance synchronously to an age
            if (w) { System.runTo(w, msg.age); dirty = true; post({ type: 'ranTo', age: w.age }); }
            break;
          default: break;
        }
      } catch (e) { fail(e); }
      if (w && (msg.type === 'tool' || msg.type === 'set' || msg.type === 'pause' || msg.type === 'skip') && inFlight < MAX_IN_FLIGHT) {
        try { sendFrame(); } catch (e) { fail(e); }
      }
    };
  }

  // ---- Inside the worker -----------------------------------------------------------------
  function workerMain(scope, F) {
    const handle = createHost((msg, transfer) => scope.postMessage(msg, transfer || []), F);
    scope.onmessage = (e) => handle(e.data);
    scope.postMessage({ type: 'ready' });
  }

  // ---- On the page ------------------------------------------------------------------------
  // Start the engine; `onMessage` gets everything it sends. Returns
  // { send(msg), kind } where kind is 'worker' or 'page'.
  function start(F, onMessage) {
    const names = ['RngFactory', 'CloudFactory', 'StarFactory', 'DiskFactory', 'PlanetsFactory', 'SystemFactory', 'EngineFactory'];
    try {
      if (typeof Worker === 'undefined' || typeof Blob === 'undefined') throw new Error('no workers');
      const src = names.map((n) => `var ${n} = ${F[n].toString()};`).join('\n')
        + `\nEngineFactory().workerMain(self, { ${names.join(', ')} });\n`;
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const worker = new Worker(url);
      worker.onmessage = (e) => onMessage(e.data);
      worker.onerror = (e) => onMessage({ type: 'error', message: e.message || 'The simulation thread stopped.' });
      return { kind: 'worker', send: (msg, transfer) => worker.postMessage(msg, transfer || []), worker };
    } catch (err) {
      // No workers: run on the page, deferring messages so callers behave the same.
      const handle = createHost((msg) => setTimeout(() => onMessage(msg), 0), F);
      setTimeout(() => onMessage({ type: 'ready' }), 0);
      return { kind: 'page', send: (msg) => setTimeout(() => handle(msg), 0) };
    }
  }

  return { compose, createHost, workerMain, start, pace, BUDGET_MS, CLOUD_RATE, LOG_RATE, STAR_STEPS, LATE_CAP, MAX_AGE };
});
