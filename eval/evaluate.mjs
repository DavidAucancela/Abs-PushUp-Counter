#!/usr/bin/env node
// Suite de evaluación (§5 del plan): corre logs de keypoints contra el algoritmo
// y compara con el conteo humano. Permite cambiar umbrales sin volver a grabar.
//
// Uso:
//   npm run eval -- sessions/*.json
//   npm run eval -- sessions/ --down 125 --up 75
//   npm run eval -- sessions/ --calibrate            # usa los primeros 3 s como reposo
//   npm run eval -- sessions/ --holdout s10,s11,s12  # sesiones reservadas, se reportan aparte
//
// Formato de sesión (lo produce el botón Exportar de abs-counter.html):
//   { name, human: { validReps, cheatReps? }, log: { frames: [{t|timestamp, keypoints}], ... } }

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';

const { createRepCounter, Calibrator, calibratedThresholds, ABDOMINALES, FLEXIONES } = await import(
  '../dist/src/index.js'
).catch(() => {
  console.error('Falta dist/. Corre `npm run build` primero.');
  process.exit(1);
});

const BASE_CONFIGS = { situp: ABDOMINALES, pushup: FLEXIONES };

// ---- CLI ----
const args = process.argv.slice(2);
const opts = { paths: [], down: null, up: null, calibrate: false, holdout: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--down') opts.down = Number(args[++i]);
  else if (a === '--up') opts.up = Number(args[++i]);
  else if (a === '--calibrate') opts.calibrate = true;
  else if (a === '--holdout') opts.holdout = args[++i].split(',');
  else opts.paths.push(a);
}
if (opts.paths.length === 0) {
  console.error('Uso: node eval/evaluate.mjs <archivos.json|carpeta> [--down N --up N | --calibrate] [--holdout a,b]');
  process.exit(1);
}

const files = opts.paths.flatMap((p) => {
  const full = resolve(p);
  if (statSync(full).isDirectory()) {
    return readdirSync(full).filter((f) => f.endsWith('.json')).map((f) => join(full, f));
  }
  return [full];
});

function normalizeFrames(raw) {
  const frames = raw.log?.frames ?? raw.frames;
  if (!Array.isArray(frames)) throw new Error('sin frames');
  return frames.map((f) => ({
    timestamp: f.timestamp ?? f.t,
    keypoints: f.keypoints,
  }));
}

function evaluateSession(frames, exerciseId) {
  const base = BASE_CONFIGS[exerciseId] ?? ABDOMINALES;
  let config = base;
  if (opts.down !== null && opts.up !== null) {
    config = { ...base, thresholds: { down: opts.down, up: opts.up } };
  } else if (opts.calibrate) {
    const cal = new Calibrator(base);
    let st = null;
    for (const f of frames) {
      st = cal.push(f);
      if (st.done) break;
    }
    if (st?.done) config = { ...base, thresholds: calibratedThresholds(st.restAngle, base) };
  }
  const counter = createRepCounter(config);
  const reasons = {};
  counter.onRep((e) => {
    if (!e.valid) reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
  });
  let last = null;
  for (const f of frames) last = counter.push(f);
  return { valid: last?.validReps ?? 0, invalid: last?.invalidReps ?? 0, reasons, thresholds: config.thresholds };
}

// ---- corrida ----
const rows = [];
for (const file of files) {
  const name = basename(file, '.json');
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`✗ ${name}: JSON inválido (${e.message})`);
    continue;
  }
  let frames;
  try {
    frames = normalizeFrames(raw);
  } catch (e) {
    console.error(`✗ ${name}: ${e.message}`);
    continue;
  }
  const human = raw.human ?? {};
  const exerciseId = raw.log?.exerciseId ?? 'situp';
  const r = evaluateSession(frames, exerciseId);
  rows.push({
    name,
    exerciseId,
    holdout: opts.holdout.includes(name),
    auto: r.valid,
    autoInvalid: r.invalid,
    human: human.validReps ?? null,
    cheatReps: human.cheatReps ?? null,
    reasons: r.reasons,
    thresholds: r.thresholds,
  });
}

if (rows.length === 0) {
  console.error('Sin sesiones evaluables.');
  process.exit(1);
}

// ---- reporte ----
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
console.log('');
console.log(
  pad('sesión', 34) + pad('ejercicio', 10) + rpad('auto', 6) + rpad('inv', 5) + rpad('humano', 8) + rpad('|err|', 7) +
  '  umbrales      razones de rechazo'
);
console.log('-'.repeat(120));

for (const r of rows) {
  const err = r.human === null ? null : Math.abs(r.auto - r.human);
  const reasons = Object.entries(r.reasons).map(([k, v]) => `${k}×${v}`).join(' ') || '—';
  console.log(
    pad(r.name + (r.holdout ? ' [holdout]' : ''), 34) +
    pad(r.exerciseId, 10) +
    rpad(r.auto, 6) + rpad(r.autoInvalid, 5) +
    rpad(r.human ?? '?', 8) + rpad(err ?? '?', 7) +
    `  ${rpad(r.thresholds.down.toFixed(0), 3)}/${r.thresholds.up.toFixed(0).padEnd(3)}      ${reasons}`
  );
}

console.log('-'.repeat(120));

// El gate se calcula por ejercicio: mezclar precisión de abdominales y flexiones en un
// solo número no dice nada útil si difieren mucho.
const byExercise = new Map();
for (const r of rows) {
  if (!byExercise.has(r.exerciseId)) byExercise.set(r.exerciseId, []);
  byExercise.get(r.exerciseId).push(r);
}

let anyLabeled = false;
for (const [exerciseId, group] of byExercise) {
  let sumErr = 0, sumHuman = 0, catastrophic = 0, labeled = 0;
  let cheatTotal = 0, cheatDetected = 0;
  for (const r of group) {
    const err = r.human === null ? null : Math.abs(r.auto - r.human);
    if (err !== null && !r.holdout) {
      sumErr += err;
      sumHuman += r.human;
      labeled++;
      if (err > 2) catastrophic++;
    }
    if (r.cheatReps !== null && !r.holdout) {
      cheatTotal += r.cheatReps;
      cheatDetected += Math.min(r.autoInvalid, r.cheatReps);
    }
  }
  if (labeled === 0) continue;
  anyLabeled = true;
  const precision = sumHuman > 0 ? 1 - sumErr / sumHuman : 1;
  console.log(`\n${exerciseId} — sesiones etiquetadas: ${labeled}   Σ|err|: ${sumErr}   Σ humano: ${sumHuman}`);
  const gate = (label, ok, detail) => console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} ${detail}`);
  gate('precisión ≥ 95%', precision >= 0.95, `→ ${(precision * 100).toFixed(1)}%`);
  gate('sesiones con error > 2 reps = 0', catastrophic === 0, `→ ${catastrophic}`);
  if (cheatTotal > 0) {
    gate('detección de trampa ≥ 80%', cheatDetected / cheatTotal >= 0.8,
      `→ ${((cheatDetected / cheatTotal) * 100).toFixed(0)}% (${cheatDetected}/${cheatTotal})`);
  } else {
    console.log('  ····  detección de trampa: sin sesiones con cheatReps etiquetadas');
  }
}
if (anyLabeled) {
  console.log('\n  (fps y falsos positivos en reposo se miden en vivo con abs-counter.html)');
} else {
  console.log('Ninguna sesión tiene human.validReps etiquetado — edita los JSON con el conteo humano.');
}
console.log('');
