import type { ExerciseConfig, Joint, Keypoint, KeypointName, PoseFrame, Side } from './types.js';
import { angleABC } from './geometry.js';
import { MedianSmoother } from './smoothing.js';

export interface EngineFrame {
  /** Ángulo suavizado; en frames degradados se mantiene el último válido. Null hasta el primer frame válido. */
  angle: number | null;
  rawAngle: number | null;
  degraded: boolean;
  locked: boolean;
  side: Side | null;
}

export function keypointName(side: Side, joint: Joint): KeypointName {
  return (side + joint[0]!.toUpperCase() + joint.slice(1)) as KeypointName;
}

/**
 * Techo de velocidad angular (°/s) por encima del cual un salto se trata como tracking
 * "alucinado" (keypoint con score alto pero mal ubicado), no movimiento real. Muy por
 * encima del pico de la rep sintética más rápida de la suite (~850°/s, flexión en 350ms)
 * para no rechazar movimiento humano genuino, pero bajo cualquier teletransporte de un
 * frame a otro típico de una pérdida de tracking momentánea.
 */
const MAX_VELOCITY_DEG_PER_S = 1500;

/**
 * Convierte PoseFrames en una serie de ángulos estable:
 * fija el lado visible en los primeros N frames, filtra por score y suaviza con mediana.
 * Compartido por el contador y el calibrador.
 */
export class PoseAngleEngine {
  private smoother: MedianSmoother;
  private framesSeen = 0;
  private sideScore: Record<Side, number> = { left: 0, right: 0 };
  private _side: Side | null = null;
  private lastAngle: number | null = null;
  /** Último ángulo CRUDO aceptado (no el suavizado) — el filtro de velocidad compara crudo
   * contra crudo; comparar contra el suavizado da falsos positivos en rampas rápidas
   * legítimas porque la mediana de 5 frames queda rezagada respecto al movimiento real. */
  private lastRaw: number | null = null;
  private lastRawT: number | null = null;

  constructor(private readonly cfg: ExerciseConfig) {
    this.smoother = new MedianSmoother(cfg.smoothing.window);
  }

  get side(): Side | null {
    return this._side;
  }

  get locked(): boolean {
    return this._side !== null;
  }

  private jointKp(frame: PoseFrame, side: Side, joint: Joint): Keypoint | undefined {
    return frame.keypoints[keypointName(side, joint)];
  }

  private angleJointsScore(frame: PoseFrame, side: Side): number {
    const { a, vertex, b } = this.cfg.angle;
    let sum = 0;
    for (const joint of [a, vertex, b]) {
      sum += this.jointKp(frame, side, joint)?.score ?? 0;
    }
    return sum / 3;
  }

  push(frame: PoseFrame): EngineFrame {
    if (this._side === null) {
      this.sideScore.left += this.angleJointsScore(frame, 'left');
      this.sideScore.right += this.angleJointsScore(frame, 'right');
      this.framesSeen++;
      if (this.framesSeen >= this.cfg.sideLockFrames) {
        this._side = this.sideScore.left >= this.sideScore.right ? 'left' : 'right';
      } else {
        return { angle: null, rawAngle: null, degraded: true, locked: false, side: null };
      }
    }

    const side = this._side!;
    const { a, vertex, b } = this.cfg.angle;
    const kpA = this.jointKp(frame, side, a);
    const kpV = this.jointKp(frame, side, vertex);
    const kpB = this.jointKp(frame, side, b);
    const min = this.cfg.minKeypointScore;
    const degraded =
      !kpA || !kpV || !kpB || kpA.score < min || kpV.score < min || kpB.score < min;

    if (degraded) {
      return { angle: this.lastAngle, rawAngle: null, degraded: true, locked: true, side };
    }

    const raw = angleABC(kpA!, kpV!, kpB!);

    // Rechazo de saltos imposibles: si el ángulo CRUDO cambia más rápido que
    // MAX_VELOCITY_DEG_PER_S respecto al último crudo aceptado, es casi siempre un keypoint
    // mal ubicado (tracking "alucinado"), no movimiento real — se descarta como degradado en
    // vez de contaminar la mediana (y, vía Calibrator, el ángulo de reposo calibrado).
    if (this.lastRaw !== null && this.lastRawT !== null) {
      const dtSec = (frame.timestamp - this.lastRawT) / 1000;
      if (dtSec > 0 && Math.abs(raw - this.lastRaw) / dtSec > MAX_VELOCITY_DEG_PER_S) {
        return { angle: this.lastAngle, rawAngle: raw, degraded: true, locked: true, side };
      }
    }

    this.lastAngle = this.smoother.push(raw);
    this.lastRaw = raw;
    this.lastRawT = frame.timestamp;
    return { angle: this.lastAngle, rawAngle: raw, degraded: false, locked: true, side };
  }

  reset(): void {
    this.smoother.reset();
    this.framesSeen = 0;
    this.sideScore = { left: 0, right: 0 };
    this._side = null;
    this.lastAngle = null;
    this.lastRaw = null;
    this.lastRawT = null;
  }
}
