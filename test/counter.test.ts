import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABDOMINALES, createRepCounter } from '../src/index.js';
import { Seq, run } from './helpers.js';

test('cuenta 10 reps limpias con ruido leve', () => {
  const seq = new Seq()
    .rest(145, 1500, { noiseDeg: 2 })
    .reps(145, 60, 2000, 10, () => ({ noiseDeg: 2 }))
    .rest(145, 1000, { noiseDeg: 2 });
  const { events, last } = run(ABDOMINALES, seq.frames);
  assert.equal(last.validReps, 10);
  assert.equal(last.invalidReps, 0);
  assert.equal(events.length, 10);
  for (const e of events) {
    assert.equal(e.valid, true);
    assert.ok(e.peakAngle <= 80, `peak ${e.peakAngle}`);
    assert.ok(e.durationMs >= 600 && e.durationMs <= 8000, `dur ${e.durationMs}`);
  }
});

test('60 s en reposo sin moverse = 0 reps (falsos positivos)', () => {
  const seq = new Seq().rest(145, 60_000, { noiseDeg: 3 });
  const { events, last } = run(ABDOMINALES, seq.frames);
  assert.equal(events.length, 0);
  assert.equal(last.validReps, 0);
  assert.equal(last.invalidReps, 0);
  assert.equal(last.phase, 'DOWN');
});

test('medio recorrido se marca shallow_depth, no cuenta como válida', () => {
  const seq = new Seq()
    .rest(145, 1500)
    .reps(145, 100, 2000, 5) // nunca baja de 80°
    .rest(145, 1000);
  const { events, last } = run(ABDOMINALES, seq.frames);
  assert.equal(last.validReps, 0);
  assert.equal(last.invalidReps, 5);
  for (const e of events) assert.equal(e.reason, 'shallow_depth');
});

test('oscilación dentro de la banda muerta no genera eventos', () => {
  // Micro-movimiento en zona DOWN y dips leves que no superan la excursión mínima.
  const seq = new Seq()
    .rest(145, 1500)
    .reps(141, 132, 1000, 3)
    .reps(145, 115, 2000, 3) // llega a 115 > 110 (130-20): descarte silencioso
    .rest(145, 500);
  const { events, last } = run(ABDOMINALES, seq.frames);
  assert.equal(events.length, 0);
  assert.equal(last.validReps, 0);
  assert.equal(last.invalidReps, 0);
});

test('rebote a medio camino: 1 no_return + 1 válida al completar el retorno', () => {
  const seq = new Seq()
    .rest(145, 1500)
    .ramp(145, 60, 1000)  // sube completo
    .ramp(60, 110, 500)   // baja a medias...
    .ramp(110, 60, 500)   // ...y rebota arriba
    .ramp(60, 145, 1000)  // ahora sí baja completo
    .rest(145, 1000);
  const { events, last } = run(ABDOMINALES, seq.frames);
  assert.equal(last.invalidReps, 1);
  assert.equal(last.validReps, 1);
  assert.equal(events[0]!.reason, 'no_return');
  assert.equal(events[1]!.valid, true);
});

test('rep en 500 ms se rechaza como too_fast', () => {
  const seq = new Seq().rest(145, 1500).reps(145, 60, 500, 1).rest(145, 1000);
  const { events, last } = run(ABDOMINALES, seq.frames);
  assert.equal(last.validReps, 0);
  assert.equal(last.invalidReps, 1);
  assert.equal(events[0]!.reason, 'too_fast');
});

test('rep de 10 s se rechaza como too_slow', () => {
  const seq = new Seq().rest(145, 1500).reps(145, 60, 12_000, 1).rest(145, 1000);
  const { events } = run(ABDOMINALES, seq.frames);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.reason, 'too_slow');
});

test('impulso con brazos (muñeca cruza la rodilla) se rechaza como arm_assist', () => {
  const seq = new Seq()
    .rest(145, 1500)
    .reps(145, 60, 2000, 1, () => ({ wristBeyondKnee: true }))
    .rest(145, 1000);
  const { events } = run(ABDOMINALES, seq.frames);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.reason, 'arm_assist');
});

test('tobillo que se levanta >8% del alto se rechaza como feet_lifted', () => {
  const seq = new Seq()
    .rest(145, 1500)
    .reps(145, 60, 2000, 1, (f) => ({ ankleDy: 0.12 * f }))
    .rest(145, 1000);
  const { events } = run(ABDOMINALES, seq.frames);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.reason, 'feet_lifted');
});

test('pérdida de tracking sostenida pasa a IDLE y se recupera sin reps fantasma', () => {
  const seq = new Seq()
    .rest(145, 1500)
    .reps(145, 60, 2000, 1)
    .rest(145, 700, { badScores: true }) // ~21 frames degradados > 15
    .rest(145, 1000)
    .reps(145, 60, 2000, 1)
    .rest(145, 500);
  const { events, states, last } = run(ABDOMINALES, seq.frames);
  assert.equal(last.validReps, 2);
  assert.equal(last.invalidReps, 0);
  assert.equal(events.length, 2);
  assert.ok(
    states.some((s) => s.phase === 'IDLE' && s.formHint === 'no te veo bien'),
    'debe pasar por IDLE con aviso durante la pérdida de tracking'
  );
});

test('frames degradados aislados no rompen la rep en curso', () => {
  // 3 frames malos en plena subida (< 15 seguidos y < 20% de la rep): la rep cuenta.
  const seq = new Seq().rest(145, 1500);
  const clean = new Seq().reps(145, 60, 2000, 1);
  clean.frames.forEach((f, i) => {
    if (i >= 15 && i < 18) {
      for (const kp of Object.values(f.keypoints)) kp.score = 0.2;
    }
  });
  const all = [...seq.frames, ...clean.frames.map((f, i) => ({ ...f, timestamp: 1500 + i * (1000 / 30) }))];
  const tail = new Seq().rest(145, 1000);
  const t0 = all[all.length - 1]!.timestamp;
  const { events, last } = run(ABDOMINALES, [
    ...all,
    ...tail.frames.map((f, i) => ({ ...f, timestamp: t0 + (i + 1) * (1000 / 30) })),
  ]);
  assert.equal(last.validReps, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.valid, true);
});

test('export() entrega frames, umbrales, lado y reps para el dataset', () => {
  const seq = new Seq().rest(145, 1500).reps(145, 60, 2000, 2).rest(145, 500);
  const c = createRepCounter(ABDOMINALES);
  for (const f of seq.frames) c.push(f);
  const log = c.export();
  assert.equal(log.exerciseId, 'situp');
  assert.equal(log.side, 'left');
  assert.equal(log.frames.length, seq.frames.length);
  assert.equal(log.reps.length, 2);
  assert.deepEqual(log.thresholds, { down: 130, up: 80 });
});
