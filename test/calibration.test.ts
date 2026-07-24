import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABDOMINALES, Calibrator, calibratedThresholds } from '../src/index.js';
import { DT, Seq, makeFrame } from './helpers.js';

test('calibración mide el ángulo de reposo y ajusta umbrales', () => {
  const seq = new Seq().rest(120, 5000, { noiseDeg: 1.5 });
  const cal = new Calibrator(ABDOMINALES);
  let state = cal.push(seq.frames[0]!);
  for (const f of seq.frames) state = cal.push(f);
  assert.equal(state.done, true);
  assert.ok(Math.abs(state.restAngle! - 120) < 3, `rest ${state.restAngle}`);

  const th = calibratedThresholds(state.restAngle!, ABDOMINALES);
  assert.ok(Math.abs(th.down - 105) < 3, `down ${th.down}`);
  assert.equal(th.down - th.up, 50);
});

test('umbral calibrado nunca supera el tope de 130°', () => {
  const th = calibratedThresholds(155, ABDOMINALES);
  assert.equal(th.down, 130);
  assert.equal(th.up, 80);
});

test('la calibración no termina mientras no haya tracking', () => {
  const seq = new Seq().rest(120, 5000, { badScores: true });
  const cal = new Calibrator(ABDOMINALES);
  let state = cal.push(seq.frames[0]!);
  for (const f of seq.frames) state = cal.push(f);
  assert.equal(state.done, false);
  assert.equal(state.tracking, false);
});

test('calibración robusta a ráfagas de tracking "alucinado" (saltos imposibles)', () => {
  // Reposo real a 150°, pero la mitad de los frames "alucinan" un salto imposible a 10°
  // (keypoint con score alto pero mal ubicado) — el filtro de velocidad del engine debe
  // descartarlos antes de que lleguen a contaminar la mediana de reposo.
  const frames = [];
  const n = Math.round(15000 / DT);
  for (let i = 0; i < n; i++) {
    frames.push(makeFrame(i % 2 === 0 ? 150 : 10, i * DT));
  }
  const cal = new Calibrator(ABDOMINALES);
  let state = cal.push(frames[0]!);
  for (const f of frames) state = cal.push(f);
  assert.equal(state.done, true);
  assert.ok(Math.abs(state.restAngle! - 150) < 5, `rest ${state.restAngle}`);
});
