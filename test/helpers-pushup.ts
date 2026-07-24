import type { Keypoint, PoseFrame } from '../src/index.js';
import { DT } from './helpers.js';

export interface PushupFrameOpts {
  /** Desviación de la cadera respecto a la línea recta hombro-tobillo (0 = cuerpo perfectamente recto). */
  hipSagFrac?: number;
  /** Desplazamiento vertical del tobillo (fracción del alto de imagen). */
  ankleDy?: number;
  /** Todos los scores bajos: simula pérdida de tracking. */
  badScores?: boolean;
  /** Amplitud de ruido determinístico sobre el ángulo, en grados. */
  noiseDeg?: number;
}

/**
 * Persona en posición de flexión, de perfil, pies a la derecha del encuadre.
 * thetaDeg = ángulo hombro–codo–muñeca exacto (por construcción geométrica), igual que
 * el helper de abdominales pero con el codo como vértice.
 */
export function makePushupFrame(thetaDeg: number, t: number, opts: PushupFrameOpts = {}): PoseFrame {
  const good = opts.badScores ? 0.2 : 0.95;
  const far = opts.badScores ? 0.1 : 0.35;

  const elbow = { x: 0.55, y: 0.45 };
  const wristDir = (-150 * Math.PI) / 180; // eje de referencia (ángulo 0) del vértice codo
  const forearm = 0.1;
  const wrist = {
    x: elbow.x + forearm * Math.cos(wristDir),
    y: elbow.y + forearm * Math.sin(wristDir),
  };
  const upperArm = 0.18;
  const shoulderDir = wristDir + (thetaDeg * Math.PI) / 180;
  const shoulder = {
    x: elbow.x + upperArm * Math.cos(shoulderDir),
    y: elbow.y + upperArm * Math.sin(shoulderDir),
  };

  const ankle = { x: 0.85, y: 0.55 + (opts.ankleDy ?? 0) };
  // Cadera sobre la recta hombro-tobillo (ángulo 180 exacto) + desviación perpendicular controlada.
  const sx = ankle.x - shoulder.x;
  const sy = ankle.y - shoulder.y;
  const segLen = Math.hypot(sx, sy) || 1;
  const perpX = -sy / segLen;
  const perpY = sx / segLen;
  const t0 = 0.45;
  const sagMag = (opts.hipSagFrac ?? 0) * segLen;
  const hip = {
    x: shoulder.x + sx * t0 + perpX * sagMag,
    y: shoulder.y + sy * t0 + perpY * sagMag,
  };
  const knee = { x: shoulder.x + sx * 0.75, y: shoulder.y + sy * 0.75 };
  const nose = { x: shoulder.x - 0.03, y: shoulder.y - 0.05 };

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

/** Constructor de secuencias sintéticas a 30 fps para flexiones (misma lógica que Seq de situps). */
export class SeqPushup {
  frames: PoseFrame[] = [];
  private t = 0;

  private add(theta: number, opts: PushupFrameOpts): void {
    const noisy = opts.noiseDeg ? theta + opts.noiseDeg * Math.sin(this.t * 0.7 + 1) : theta;
    this.frames.push(makePushupFrame(noisy, this.t, opts));
    this.t += DT;
  }

  rest(theta: number, ms: number, opts: PushupFrameOpts = {}): this {
    const n = Math.round(ms / DT);
    for (let i = 0; i < n; i++) this.add(theta, opts);
    return this;
  }

  ramp(from: number, to: number, ms: number, opts: PushupFrameOpts = {}): this {
    const n = Math.round(ms / DT);
    for (let i = 0; i < n; i++) {
      const f = 0.5 * (1 - Math.cos((Math.PI * i) / n));
      this.add(from + (to - from) * f, opts);
    }
    return this;
  }

  reps(
    rest: number,
    top: number,
    periodMs: number,
    count: number,
    optsFor?: (riseFrac: number) => PushupFrameOpts
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
