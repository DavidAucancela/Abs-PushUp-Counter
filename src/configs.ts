import type { ExerciseConfig } from './types.js';

/**
 * Abdominal (sit-up) medido de perfil: ángulo del torso hombro–cadera–rodilla.
 * Flexiones y sentadillas serán este mismo objeto con otros números.
 */
export const ABDOMINALES: ExerciseConfig = {
  id: 'situp',
  angle: { a: 'shoulder', vertex: 'hip', b: 'knee' },
  thresholds: { down: 130, up: 80 }, // histéresis de 50°
  direction: 'decreasing',           // subir = el ángulo baja
  repDurationMs: { min: 600, max: 8000 },
  validators: ['duration', 'confidence', 'depth', 'fullReturn', 'noArmAssist', 'feetAnchored'],
  smoothing: { window: 5, method: 'median' },

  minKeypointScore: 0.5,
  confirmFrames: 2,
  maxDegradedStreak: 15,   // ~0.5 s a 30 fps
  sideLockFrames: 30,      // ~1 s a 30 fps
  maxDegradedRatio: 0.2,
  shallowExcursionDeg: 20,

  armAssist: { margin: 0.15 }, // 15% de la distancia cadera-rodilla en pantalla
  feetAnchor: { maxDy: 0.08 },

  calibration: {
    durationMs: 3000,
    maxDown: 130,
    restOffsetDeg: 15,
    hysteresisDeg: 50,
  },
};

/**
 * Flexión de pecho medida de perfil: ángulo del codo hombro–codo–muñeca.
 * Mismo núcleo que ABDOMINALES, solo cambian el ángulo, los umbrales y los validadores
 * de forma: aquí no aplica noArmAssist (los brazos SON el ejercicio); en su lugar se
 * vigila que la cadera no se caiga ni se levante (hipAligned), la trampa clásica del push-up.
 * "down"/"up" son zonas del ÁNGULO del codo, no la posición del cuerpo: down = codo casi
 * recto (arriba, posición de reposo), up = codo doblado (abajo, pico del esfuerzo).
 */
export const FLEXIONES: ExerciseConfig = {
  id: 'pushup',
  angle: { a: 'shoulder', vertex: 'elbow', b: 'wrist' },
  thresholds: { down: 160, up: 90 }, // histéresis de 70°
  direction: 'decreasing',           // bajar = el ángulo del codo baja
  repDurationMs: { min: 400, max: 8000 },
  validators: ['duration', 'confidence', 'depth', 'fullReturn', 'hipAligned', 'feetAnchored'],
  smoothing: { window: 5, method: 'median' },

  minKeypointScore: 0.5,
  confirmFrames: 2,
  maxDegradedStreak: 15,
  sideLockFrames: 30,
  maxDegradedRatio: 0.2,
  shallowExcursionDeg: 15,

  feetAnchor: { maxDy: 0.08 },
  hipAlignment: { maxDeviationDeg: 30 }, // tolerancia amplia de partida; afinar con dataset real

  hints: {
    shallow_depth: 'baja hasta doblar bien el codo',
    no_return: 'sube completamente antes de volver a bajar',
  },

  calibration: {
    durationMs: 3000,
    maxDown: 160,
    restOffsetDeg: 10,
    hysteresisDeg: 70,
  },
};
