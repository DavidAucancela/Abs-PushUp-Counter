import type {
  CounterState,
  ExerciseConfig,
  Keypoint,
  PoseFrame,
  RepEvent,
} from '../src/index.js';
import { createRepCounter } from '../src/index.js';

export interface FrameOpts {
  /** La muñeca cruza más allá de la rodilla (trampa de impulso con brazos). */
  wristBeyondKnee?: boolean;
  /** Desplazamiento vertical del tobillo (fracción del alto de imagen). */
  ankleDy?: number;
  /** Todos los scores bajos: simula pérdida de tracking. */
  badScores?: boolean;
  /** Amplitud de ruido determinístico sobre el ángulo, en grados. */
  noiseDeg?: number;
}

const FPS = 30;
export const DT = 1000 / FPS;

/**
 * Persona acostada de perfil, pies a la derecha del encuadre.
 * theta = ángulo hombro–cadera–rodilla exacto (por construcción geométrica).
 * El lado izquierdo es el visible (scores altos); el derecho queda ocluido.
 */
export function makeFrame(thetaDeg: number, t: number, opts: FrameOpts = {}): PoseFrame {
  const good = opts.badScores ? 0.2 : 0.95;
  const far = opts.badScores ? 0.1 : 0.35;

  const hip = { x: 0.5, y: 0.75 };
  const knee = { x: 0.65, y: 0.75 };
  const th = (thetaDeg * Math.PI) / 180;
  const shoulder = { x: hip.x + 0.3 * Math.cos(th), y: hip.y - 0.3 * Math.sin(th) };
  const elbow = { x: (shoulder.x + hip.x) / 2, y: (shoulder.y + hip.y) / 2 - 0.02 };
  const wrist = opts.wristBeyondKnee
    ? { x: knee.x + 0.05, y: knee.y - 0.05 }
    : { x: shoulder.x, y: shoulder.y + 0.03 };
  const ankle = { x: 0.73, y: 0.78 + (opts.ankleDy ?? 0) };
  const nose = { x: shoulder.x + 0.03, y: shoulder.y - 0.05 };

  const kp = (p: { x: number; y: number }, score: number): Keypoint => ({
    x: p.x,
    y: p.y,
    score,
  });
  const occluded = (p: { x: number; y: number }): Keypoint => kp({ x: p.x, y: p.y + 0.02 }, far);

  return {
    timestamp: t,
    keypoints: {
      nose: kp(nose, good),
      leftShoulder: kp(shoulder, good),
      leftElbow: kp(elbow, good),
      leftWrist: kp(wrist, good),
      leftHip: kp(hip, good),
      leftKnee: kp(knee, good),
      leftAnkle: kp(ankle, good),
      rightShoulder: occluded(shoulder),
      rightElbow: occluded(elbow),
      rightWrist: occluded(wrist),
      rightHip: occluded(hip),
      rightKnee: occluded(knee),
      rightAnkle: occluded(ankle),
    },
  };
}

/** Constructor de secuencias sintéticas a 30 fps. */
export class Seq {
  frames: PoseFrame[] = [];
  private t = 0;

  private add(theta: number, opts: FrameOpts): void {
    const noisy = opts.noiseDeg ? theta + opts.noiseDeg * Math.sin(this.t * 0.7 + 1) : theta;
    this.frames.push(makeFrame(noisy, this.t, opts));
    this.t += DT;
  }

  rest(theta: number, ms: number, opts: FrameOpts = {}): this {
    const n = Math.round(ms / DT);
    for (let i = 0; i < n; i++) this.add(theta, opts);
    return this;
  }

  /** Interpolación de medio coseno entre dos ángulos. */
  ramp(from: number, to: number, ms: number, opts: FrameOpts = {}): this {
    const n = Math.round(ms / DT);
    for (let i = 0; i < n; i++) {
      const f = 0.5 * (1 - Math.cos((Math.PI * i) / n));
      this.add(from + (to - from) * f, opts);
    }
    return this;
  }

  /** Ciclos completos rest→top→rest (coseno). optsFor recibe la fracción de subida 0..1. */
  reps(
    rest: number,
    top: number,
    periodMs: number,
    count: number,
    optsFor?: (riseFrac: number) => FrameOpts
  ): this {
    const total = Math.round((periodMs * count) / DT);
    for (let i = 0; i < total; i++) {
      const phase = ((i * DT) % periodMs) / periodMs;
      const f = 0.5 * (1 - Math.cos(2 * Math.PI * phase));
      this.add(rest + (top - rest) * f, optsFor?.(f) ?? {});
    }
    return this;
  }
}

export interface RunResult {
  events: RepEvent[];
  states: CounterState[];
  last: CounterState;
}

export function run(cfg: ExerciseConfig, frames: PoseFrame[]): RunResult {
  const counter = createRepCounter(cfg);
  const events: RepEvent[] = [];
  counter.onRep((e) => events.push(e));
  const states: CounterState[] = [];
  for (const f of frames) states.push(counter.push(f));
  return { events, states, last: states[states.length - 1]! };
}
