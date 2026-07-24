import type { ExerciseConfig, PoseFrame } from './types.js';
import { PoseAngleEngine } from './angle-engine.js';

export interface CalibrationState {
  /** 0..1 respecto a la duración configurada (calibration.durationMs). */
  progress: number;
  done: boolean;
  /** Mediana del ángulo de reposo; presente solo al terminar. */
  restAngle?: number;
  /** Dispersión de las muestras (p90 - p10); útil para avisar "quédate quieto". */
  spreadDeg?: number;
  /** false mientras no hay lado fijado o el frame venía degradado. */
  tracking: boolean;
}

/**
 * spreadDeg (p90-p10) máximo para aceptar la calibración como estable. Por encima de esto
 * el tracking probablemente sigue "alucinando" pese al filtro de velocidad del engine
 * (ver MAX_VELOCITY_DEG_PER_S en angle-engine.ts) — mejor seguir midiendo que congelar
 * umbrales calculados sobre un reposo corrupto.
 */
const MAX_STABLE_SPREAD_DEG = 15;

/**
 * Calibración de reposo (§3.4): el usuario se acuesta y durante ~3 s se mide su
 * ángulo natural. Los umbrales se ajustan a su cuerpo, no al revés.
 */
export class Calibrator {
  private engine: PoseAngleEngine;
  private samples: number[] = [];
  private t0: number | null = null;
  private result: { restAngle: number; spreadDeg: number } | null = null;

  constructor(private readonly cfg: ExerciseConfig) {
    this.engine = new PoseAngleEngine(cfg);
  }

  push(frame: PoseFrame): CalibrationState {
    if (this.result) return this.state(1, true);
    const ef = this.engine.push(frame);
    if (!ef.locked || ef.degraded || ef.angle === null) {
      return this.state(this.progressAt(frame.timestamp), false);
    }
    if (this.t0 === null) this.t0 = frame.timestamp;
    this.samples.push(ef.angle);
    const progress = this.progressAt(frame.timestamp);
    const elapsed = frame.timestamp - this.t0;
    if (elapsed >= this.cfg.calibration.durationMs && this.samples.length >= this.cfg.smoothing.window) {
      const sorted = [...this.samples].sort((a, b) => a - b);
      const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
      const spreadDeg = q(0.9) - q(0.1);
      // Si la muestra vino muy dispersa (posible tracking inestable) seguimos juntando datos
      // en vez de aceptar un reposo corrupto — hasta 3x la duración nominal, después se
      // acepta igual (mejor una medición ruidosa que bloquear la calibración para siempre).
      if (spreadDeg <= MAX_STABLE_SPREAD_DEG || elapsed >= this.cfg.calibration.durationMs * 3) {
        this.result = { restAngle: q(0.5), spreadDeg };
      }
    }
    return this.state(progress, true);
  }

  private progressAt(t: number): number {
    if (this.t0 === null) return 0;
    return Math.min(1, (t - this.t0) / this.cfg.calibration.durationMs);
  }

  private state(progress: number, tracking: boolean): CalibrationState {
    return {
      progress,
      done: this.result !== null,
      tracking,
      ...(this.result ?? {}),
    };
  }

  reset(): void {
    this.engine.reset();
    this.samples = [];
    this.t0 = null;
    this.result = null;
  }
}

/**
 * down = min(maxDown, reposo - offset); up = down - histéresis (invertido si direction = 'increasing').
 */
export function calibratedThresholds(
  restAngle: number,
  cfg: ExerciseConfig
): { down: number; up: number } {
  const { maxDown, restOffsetDeg, hysteresisDeg } = cfg.calibration;
  if (cfg.direction === 'decreasing') {
    const down = Math.min(maxDown, restAngle - restOffsetDeg);
    return { down, up: down - hysteresisDeg };
  }
  const down = Math.max(maxDown, restAngle + restOffsetDeg);
  return { down, up: down + hysteresisDeg };
}
