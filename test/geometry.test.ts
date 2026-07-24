import { test } from 'node:test';
import assert from 'node:assert/strict';
import { angleABC, MedianSmoother } from '../src/index.js';

test('angleABC: ángulo recto y colineal', () => {
  assert.ok(Math.abs(angleABC({ x: 0, y: -1 }, { x: 0, y: 0 }, { x: 1, y: 0 }) - 90) < 1e-9);
  assert.ok(Math.abs(angleABC({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }) - 180) < 1e-9);
  assert.ok(Math.abs(angleABC({ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }) - 45) < 1e-9);
});

test('angleABC: keypoints degenerados no revientan', () => {
  assert.equal(angleABC({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0 }), 0);
});

test('MedianSmoother elimina outliers puntuales', () => {
  const s = new MedianSmoother(5);
  [100, 101, 99, 100].forEach((v) => s.push(v));
  // Un salto de pose de un frame no mueve la mediana:
  assert.equal(s.push(170), 100);
});
