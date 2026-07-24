import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLEXIONES } from '../src/index.js';
import { run } from './helpers.js';
import { SeqPushup } from './helpers-pushup.js';

test('cuenta 10 flexiones limpias con ruido leve', () => {
  const seq = new SeqPushup()
    .rest(170, 1500, { noiseDeg: 2 })
    .reps(170, 75, 2000, 10, () => ({ noiseDeg: 2 }))
    .rest(170, 1000, { noiseDeg: 2 });
  const { events, last } = run(FLEXIONES, seq.frames);
  assert.equal(last.validReps, 10);
  assert.equal(last.invalidReps, 0);
  assert.equal(events.length, 10);
  for (const e of events) {
    assert.equal(e.valid, true);
    assert.ok(e.peakAngle <= 90, `peak ${e.peakAngle}`);
  }
});

test('60 s en plancha sin moverse = 0 reps', () => {
  const seq = new SeqPushup().rest(170, 60_000, { noiseDeg: 3 });
  const { events, last } = run(FLEXIONES, seq.frames);
  assert.equal(events.length, 0);
  assert.equal(last.validReps, 0);
  assert.equal(last.phase, 'DOWN');
});

test('no doblar el codo lo suficiente se marca shallow_depth', () => {
  const seq = new SeqPushup()
    .rest(170, 1500)
    .reps(170, 110, 2000, 5) // nunca baja de 90°
    .rest(170, 1000);
  const { events, last } = run(FLEXIONES, seq.frames);
  assert.equal(last.validReps, 0);
  assert.equal(last.invalidReps, 5);
  for (const e of events) assert.equal(e.reason, 'shallow_depth');
  assert.equal(events[0]!.reason && FLEXIONES.hints?.[events[0]!.reason], 'baja hasta doblar bien el codo');
});

test('cadera caída (sag) se rechaza como hip_sag', () => {
  const seq = new SeqPushup()
    .rest(170, 1500)
    .reps(170, 75, 2000, 1, (f) => ({ hipSagFrac: 0.25 * f }))
    .rest(170, 1000);
  const { events } = run(FLEXIONES, seq.frames);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.reason, 'hip_sag');
});

test('cuerpo recto (sin sag) no dispara hip_sag', () => {
  const seq = new SeqPushup().rest(170, 1500).reps(170, 75, 2000, 3).rest(170, 1000);
  const { events, last } = run(FLEXIONES, seq.frames);
  assert.equal(last.validReps, 3);
  assert.equal(events.filter((e) => e.reason === 'hip_sag').length, 0);
});

test('tobillo que se levanta >8% del alto se rechaza como feet_lifted', () => {
  const seq = new SeqPushup()
    .rest(170, 1500)
    .reps(170, 75, 2000, 1, (f) => ({ ankleDy: 0.12 * f }))
    .rest(170, 1000);
  const { events } = run(FLEXIONES, seq.frames);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.reason, 'feet_lifted');
});

test('flexión en 350 ms se rechaza como too_fast', () => {
  const seq = new SeqPushup().rest(170, 1500).reps(170, 75, 350, 1).rest(170, 1000);
  const { events } = run(FLEXIONES, seq.frames);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.reason, 'too_fast');
});
