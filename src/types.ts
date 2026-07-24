// Contrato congelado del módulo. Independiente de MediaPipe/MoveNet/TFLite.
// La Capa 2 (adaptador) convierte la salida del modelo de pose a PoseFrame.

export type KeypointName =
  | 'nose'
  | 'leftEye' | 'rightEye'
  | 'leftEar' | 'rightEar'
  | 'leftShoulder' | 'rightShoulder'
  | 'leftElbow' | 'rightElbow'
  | 'leftWrist' | 'rightWrist'
  | 'leftHip' | 'rightHip'
  | 'leftKnee' | 'rightKnee'
  | 'leftAnkle' | 'rightAnkle';

export interface Keypoint {
  x: number;      // normalizado 0..1
  y: number;      // normalizado 0..1
  score: number;  // 0..1
}

export interface PoseFrame {
  timestamp: number; // ms, monotónico
  keypoints: Partial<Record<KeypointName, Keypoint>>;
}

export type Side = 'left' | 'right';
export type Joint = 'shoulder' | 'elbow' | 'wrist' | 'hip' | 'knee' | 'ankle';

export type Phase = 'IDLE' | 'DOWN' | 'RISING' | 'UP' | 'LOWERING';

export type InvalidReason =
  | 'shallow_depth'
  | 'no_return'
  | 'too_fast'
  | 'too_slow'
  | 'arm_assist'
  | 'low_confidence'
  | 'feet_lifted'
  | 'hip_sag';

export type ValidatorId =
  | 'depth'
  | 'fullReturn'
  | 'duration'
  | 'confidence'
  | 'noArmAssist'
  | 'feetAnchored'
  | 'hipAligned';

export interface RepEvent {
  index: number;        // 1, 2, 3... sobre el total de eventos (válidos + inválidos)
  valid: boolean;
  reason?: InvalidReason;
  durationMs: number;
  peakAngle: number;    // ángulo extremo alcanzado hacia "arriba" (mínimo en situp)
  bottomAngle: number;  // ángulo extremo del retorno (máximo en situp)
}

export interface CounterState {
  phase: Phase;
  validReps: number;
  invalidReps: number;
  currentAngle: number;
  confidence: number;   // 0..1, fracción de frames no degradados en ventana reciente
  formHint?: string;
}

export interface ExerciseConfig {
  id: string;
  /** Articulaciones del ángulo principal, sin lado: el contador elige el lado visible. */
  angle: { a: Joint; vertex: Joint; b: Joint };
  /** Histéresis: zona DOWN y zona UP en grados. */
  thresholds: { down: number; up: number };
  /** 'decreasing': subir reduce el ángulo (situp). 'increasing': subir lo aumenta. */
  direction: 'decreasing' | 'increasing';
  repDurationMs: { min: number; max: number };
  validators: ValidatorId[];
  smoothing: { window: number; method: 'median' };

  /** Score mínimo por keypoint para considerar el frame confiable. */
  minKeypointScore: number;
  /** Frames consecutivos requeridos para confirmar cruce de umbral. */
  confirmFrames: number;
  /** Frames degradados consecutivos antes de pasar a IDLE. */
  maxDegradedStreak: number;
  /** Frames para fijar el lado visible al inicio. */
  sideLockFrames: number;
  /** Fracción máxima de frames degradados dentro de una rep. */
  maxDegradedRatio: number;
  /** Excursión mínima (grados más allá de DOWN) para que un intento parcial se reporte como shallow_depth. */
  shallowExcursionDeg: number;

  /**
   * Parámetros del validador noArmAssist (muñeca cruza más allá de la rodilla en la subida).
   * `margin` es una fracción de la distancia cadera-rodilla (escala del cuerpo en pantalla),
   * no una fracción absoluta del cuadro: así no depende de qué tan cerca está la cámara.
   */
  armAssist?: { margin: number };
  /** Parámetros del validador feetAnchored (desplazamiento vertical máximo del tobillo, fracción del alto). */
  feetAnchor?: { maxDy: number };
  /**
   * Parámetros del validador hipAligned (hombro-cadera-tobillo debe mantenerse casi recto:
   * cadera caída o levantada = trampa clásica de flexiones). `maxDeviationDeg` es la
   * desviación máxima tolerada respecto a 180°.
   */
  hipAlignment?: { maxDeviationDeg: number };

  /**
   * Textos de aviso por razón de rechazo, específicos del ejercicio. Necesarios porque
   * "sube completamente" (situp, el esfuerzo es subir) sería literalmente al revés en
   * flexiones (el esfuerzo es bajar). Si falta una razón aquí, se usa el default genérico.
   */
  hints?: Partial<Record<InvalidReason, string>>;

  /** Calibración de reposo (§3.4 del plan). */
  calibration: {
    durationMs: number;
    /** Tope del umbral DOWN calibrado (p.ej. 130 en situp). */
    maxDown: number;
    /** Offset respecto al ángulo de reposo. */
    restOffsetDeg: number;
    /** Separación entre DOWN y UP. */
    hysteresisDeg: number;
  };
}

export interface SessionFrameLog {
  t: number;
  angle: number | null;   // ángulo suavizado usado por la máquina de estados
  degraded: boolean;
  phase: Phase;
  keypoints: PoseFrame['keypoints'];
}

export interface SessionLog {
  exerciseId: string;
  startedAt: number;
  thresholds: { down: number; up: number };
  side: Side | null;
  frames: SessionFrameLog[];
  reps: RepEvent[];
}

export interface RepCounter {
  push(frame: PoseFrame): CounterState;
  onRep(cb: (e: RepEvent) => void): void;
  reset(): void;
  export(): SessionLog;
}
