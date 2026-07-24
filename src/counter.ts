import type {
  CounterState,
  ExerciseConfig,
  InvalidReason,
  Phase,
  PoseFrame,
  RepCounter,
  RepEvent,
  SessionFrameLog,
  SessionLog,
  ValidatorId,
} from './types.js';
import { PoseAngleEngine, keypointName } from './angle-engine.js';
import { angleABC } from './geometry.js';

type Zone = 'down' | 'mid' | 'up';

interface Attempt {
  startT: number;
  /** true si el intento arrancó desde DOWN (no desde un rebote a medio camino). */
  fromDown: boolean;
  reachedTop: boolean;
  peak: number;         // extremo hacia arriba
  bottomReturn: number; // extremo del retorno
  degradedFrames: number;
  totalFrames: number;
  armAssist: boolean;
  ankleRef: { x: number; y: number } | null;
  maxAnkleDy: number;
  /** Dirección hacia los pies (+1/-1) y escala cadera-rodilla, fijadas al iniciar el intento. */
  footward: number | null;
  legScale: number | null;
  /** Máxima desviación observada del ángulo hombro-cadera-tobillo respecto a 180° (cadera caída o levantada). */
  hipDeviation: number;
}

const HINTS: Record<InvalidReason, string> = {
  shallow_depth: 'sube completamente',
  no_return: 'baja completamente antes de volver a subir',
  too_fast: 'más despacio, controla el movimiento',
  too_slow: 'mantén el ritmo',
  arm_assist: 'no te impulses con los brazos',
  low_confidence: 'no te veo bien',
  feet_lifted: 'mantén los pies en el piso',
  hip_sag: 'mantén el cuerpo recto, no dejes caer ni levantes la cadera',
};

const CONFIDENCE_WINDOW = 30;

export class ExerciseRepCounter implements RepCounter {
  private engine: PoseAngleEngine;
  private phase: Phase = 'IDLE';
  private validReps = 0;
  private invalidReps = 0;
  private repIndex = 0;
  private hint: string | undefined;

  private down: number;
  private up: number;

  private streakZone: Zone | null = null;
  private streak = 0;
  private confirmedZone: Zone | null = null;

  private degradedStreak = 0;
  private confWindow: boolean[] = []; // true = frame bueno
  private attempt: Attempt | null = null;
  /** Posición del tobillo en reposo (fase DOWN); referencia del validador feetAnchored. */
  private ankleBaseline: { x: number; y: number } | null = null;
  /**
   * EMA de la dirección cadera→rodilla en reposo: referencia estable de "hacia los pies"
   * para noArmAssist. Recomputar el signo cada frame es demasiado ruidoso en video real
   * (la diferencia cadera-rodilla es pequeña y su signo puede voltearse cuadro a cuadro).
   */
  private footwardEma: number | null = null;
  private legScaleEma: number | null = null;

  private callbacks: Array<(e: RepEvent) => void> = [];
  private frames: SessionFrameLog[] = [];
  private reps: RepEvent[] = [];
  private startedAt: number | null = null;

  constructor(private readonly cfg: ExerciseConfig) {
    this.engine = new PoseAngleEngine(cfg);
    this.down = cfg.thresholds.down;
    this.up = cfg.thresholds.up;
  }

  onRep(cb: (e: RepEvent) => void): void {
    this.callbacks.push(cb);
  }

  reset(): void {
    this.engine.reset();
    this.phase = 'IDLE';
    this.validReps = 0;
    this.invalidReps = 0;
    this.repIndex = 0;
    this.hint = undefined;
    this.streakZone = null;
    this.streak = 0;
    this.confirmedZone = null;
    this.degradedStreak = 0;
    this.confWindow = [];
    this.attempt = null;
    this.ankleBaseline = null;
    this.footwardEma = null;
    this.legScaleEma = null;
    this.frames = [];
    this.reps = [];
    this.startedAt = null;
  }

  export(): SessionLog {
    return {
      exerciseId: this.cfg.id,
      startedAt: this.startedAt ?? 0,
      thresholds: { down: this.down, up: this.up },
      side: this.engine.side,
      frames: this.frames,
      reps: [...this.reps],
    };
  }

  // ---- helpers de dirección: 'decreasing' = subir reduce el ángulo (situp) ----

  private inDownZone(angle: number): boolean {
    return this.cfg.direction === 'decreasing' ? angle >= this.down : angle <= this.down;
  }

  private inUpZone(angle: number): boolean {
    return this.cfg.direction === 'decreasing' ? angle <= this.up : angle >= this.up;
  }

  private towardUp(a: number, b: number): number {
    return this.cfg.direction === 'decreasing' ? Math.min(a, b) : Math.max(a, b);
  }

  private towardDown(a: number, b: number): number {
    return this.cfg.direction === 'decreasing' ? Math.max(a, b) : Math.min(a, b);
  }

  private deepEnoughForShallowReport(peak: number): boolean {
    const limit =
      this.cfg.direction === 'decreasing'
        ? this.down - this.cfg.shallowExcursionDeg
        : this.down + this.cfg.shallowExcursionDeg;
    return this.cfg.direction === 'decreasing' ? peak <= limit : peak >= limit;
  }

  private zoneOf(angle: number): Zone {
    if (this.inUpZone(angle)) return 'up';
    if (this.inDownZone(angle)) return 'down';
    return 'mid';
  }

  // ---- ciclo principal ----

  push(frame: PoseFrame): CounterState {
    if (this.startedAt === null) this.startedAt = frame.timestamp;
    const ef = this.engine.push(frame);
    const t = frame.timestamp;

    this.confWindow.push(!ef.degraded);
    if (this.confWindow.length > CONFIDENCE_WINDOW) this.confWindow.shift();

    if (ef.degraded) this.degradedStreak++;
    else this.degradedStreak = 0;

    if (this.attempt) {
      this.attempt.totalFrames++;
      if (ef.degraded) this.attempt.degradedFrames++;
    }

    if (!ef.locked || ef.angle === null) {
      this.logFrame(t, ef.angle, true, frame);
      return this.snapshot(ef.angle);
    }

    // Pérdida de tracking sostenida (~0.5 s): a IDLE, se descarta el intento en curso.
    if (this.degradedStreak > this.cfg.maxDegradedStreak) {
      if (this.phase !== 'IDLE') {
        this.phase = 'IDLE';
        this.attempt = null;
        this.hint = HINTS.low_confidence;
        this.streakZone = null;
        this.streak = 0;
        this.confirmedZone = null;
      }
      this.logFrame(t, ef.angle, true, frame);
      return this.snapshot(ef.angle);
    }

    const angle = ef.angle;
    const zone = this.zoneOf(angle);
    if (zone === this.streakZone) this.streak++;
    else {
      this.streakZone = zone;
      this.streak = 1;
    }
    // Confirmación de N frames: mata falsos cruces por un keypoint que salta un frame.
    if (this.streak >= this.cfg.confirmFrames && zone !== this.confirmedZone) {
      this.confirmedZone = zone;
      this.onZoneConfirmed(zone, angle, t, frame);
    }

    if ((this.phase === 'DOWN' || this.phase === 'IDLE') && !ef.degraded) {
      const ankle = this.ankleOf(frame);
      if (ankle) this.ankleBaseline = ankle;
      this.updateFootwardRef(frame);
    }

    if (this.attempt && !ef.degraded) {
      this.attempt.peak = this.towardUp(this.attempt.peak, angle);
      if (this.phase === 'LOWERING') {
        this.attempt.bottomReturn = this.towardDown(this.attempt.bottomReturn, angle);
      }
      if (this.phase === 'RISING' || this.phase === 'UP') this.checkArmAssist(frame);
      this.checkFeet(frame);
      this.checkHipAlignment(frame);
    }

    this.logFrame(t, angle, ef.degraded, frame);
    return this.snapshot(angle);
  }

  private onZoneConfirmed(zone: Zone, angle: number, t: number, frame: PoseFrame): void {
    switch (this.phase) {
      case 'IDLE':
        if (zone === 'down') {
          this.phase = 'DOWN';
          this.hint = undefined;
        }
        break;

      case 'DOWN':
        if (zone === 'mid' || zone === 'up') {
          this.startAttempt(t, angle, frame, true);
          this.phase = zone === 'up' ? 'UP' : 'RISING';
          if (zone === 'up') this.attempt!.reachedTop = true;
        }
        break;

      case 'RISING':
        if (zone === 'up') {
          this.phase = 'UP';
          this.attempt!.reachedTop = true;
        } else if (zone === 'down') {
          this.finishShallow(t, angle);
          this.phase = 'DOWN';
        }
        break;

      case 'UP':
        if (zone === 'mid') {
          this.phase = 'LOWERING';
        } else if (zone === 'down') {
          this.completeRep(t, angle);
          this.phase = 'DOWN';
        }
        break;

      case 'LOWERING':
        if (zone === 'down') {
          // La rep se cuenta al COMPLETAR el retorno, no al llegar arriba.
          this.completeRep(t, angle);
          this.phase = 'DOWN';
        } else if (zone === 'up') {
          // Rebote a medio camino: la trampa más común. Se marca y se abre un segmento nuevo.
          this.emitBounce(t, angle, frame);
          this.phase = 'UP';
        }
        break;
    }
  }

  private startAttempt(t: number, angle: number, frame: PoseFrame, fromDown: boolean): void {
    this.attempt = {
      startT: t,
      fromDown,
      reachedTop: false,
      peak: angle,
      bottomReturn: angle,
      degradedFrames: 0,
      totalFrames: 1,
      armAssist: false,
      ankleRef: this.ankleBaseline ?? this.ankleOf(frame),
      maxAnkleDy: 0,
      footward: this.footwardEma !== null ? Math.sign(this.footwardEma) || 1 : null,
      legScale: this.legScaleEma,
      hipDeviation: 0,
    };
  }

  private ankleOf(frame: PoseFrame): { x: number; y: number } | null {
    const side = this.engine.side;
    if (!side) return null;
    const kp = frame.keypoints[keypointName(side, 'ankle')];
    if (!kp || kp.score < this.cfg.minKeypointScore) return null;
    return { x: kp.x, y: kp.y };
  }

  private updateFootwardRef(frame: PoseFrame): void {
    const side = this.engine.side;
    if (!side) return;
    const min = this.cfg.minKeypointScore;
    const hip = frame.keypoints[keypointName(side, 'hip')];
    const knee = frame.keypoints[keypointName(side, 'knee')];
    if (!hip || !knee || hip.score < min || knee.score < min) return;
    const dx = knee.x - hip.x;
    const dist = Math.hypot(knee.x - hip.x, knee.y - hip.y);
    const alpha = 0.1;
    this.footwardEma = this.footwardEma === null ? dx : this.footwardEma * (1 - alpha) + dx * alpha;
    this.legScaleEma = this.legScaleEma === null ? dist : this.legScaleEma * (1 - alpha) + dist * alpha;
  }

  private checkArmAssist(frame: PoseFrame): void {
    if (!this.cfg.validators.includes('noArmAssist') || !this.attempt) return;
    const side = this.engine.side;
    if (!side || this.attempt.footward === null) return;
    const min = this.cfg.minKeypointScore;
    const wrist = frame.keypoints[keypointName(side, 'wrist')];
    const knee = frame.keypoints[keypointName(side, 'knee')];
    if (!wrist || !knee || wrist.score < min || knee.score < min) return;
    // Dirección "hacia los pies" y escala de pierna fijadas al iniciar el intento (reposo):
    // recomputarlas cuadro a cuadro es demasiado ruidoso en video real.
    const marginFrac = this.cfg.armAssist?.margin ?? 0.15;
    const margin = marginFrac * (this.attempt.legScale ?? 0.15);
    if ((wrist.x - knee.x) * this.attempt.footward > margin) this.attempt.armAssist = true;
  }

  private checkFeet(frame: PoseFrame): void {
    if (!this.cfg.validators.includes('feetAnchored') || !this.attempt) return;
    const ankle = this.ankleOf(frame);
    if (!ankle) return;
    if (!this.attempt.ankleRef) {
      this.attempt.ankleRef = ankle;
      return;
    }
    const dy = Math.abs(ankle.y - this.attempt.ankleRef.y);
    if (dy > this.attempt.maxAnkleDy) this.attempt.maxAnkleDy = dy;
  }

  private checkHipAlignment(frame: PoseFrame): void {
    if (!this.cfg.validators.includes('hipAligned') || !this.attempt) return;
    const side = this.engine.side;
    if (!side) return;
    const min = this.cfg.minKeypointScore;
    const shoulder = frame.keypoints[keypointName(side, 'shoulder')];
    const hip = frame.keypoints[keypointName(side, 'hip')];
    const ankle = frame.keypoints[keypointName(side, 'ankle')];
    if (!shoulder || !hip || !ankle) return;
    if (shoulder.score < min || hip.score < min || ankle.score < min) return;
    // Cuerpo recto ⇒ ángulo hombro-cadera-tobillo ≈ 180°. Cadera caída o levantada lo desvían.
    const deviation = Math.abs(180 - angleABC(shoulder, hip, ankle));
    if (deviation > this.attempt.hipDeviation) this.attempt.hipDeviation = deviation;
  }

  private finishShallow(t: number, angle: number): void {
    const a = this.attempt;
    this.attempt = null;
    if (!a) return;
    // Solo se reporta si hubo excursión real; los micro-movimientos se descartan en silencio.
    if (!this.deepEnoughForShallowReport(a.peak)) return;
    this.emit(t, a, angle, 'shallow_depth');
  }

  private emitBounce(t: number, angle: number, frame: PoseFrame): void {
    const a = this.attempt;
    if (a) this.emit(t, a, this.towardDown(a.bottomReturn, angle), 'no_return');
    // Segmento nuevo desde el rebote: si al final baja completo, esa vuelta sí puede contar.
    this.startAttempt(t, angle, frame, false);
    this.attempt!.reachedTop = true;
  }

  private completeRep(t: number, angle: number): void {
    const a = this.attempt;
    this.attempt = null;
    if (!a) return;
    const bottom = this.towardDown(a.bottomReturn, angle);
    this.emit(t, a, bottom, this.firstFailure(a, t - a.startT));
  }

  /** Devuelve la primera razón de rechazo en el orden configurado de validadores, o undefined. */
  private firstFailure(a: Attempt, durationMs: number): InvalidReason | undefined {
    for (const v of this.cfg.validators) {
      const reason = this.runValidator(v, a, durationMs);
      if (reason) return reason;
    }
    return undefined;
  }

  private runValidator(v: ValidatorId, a: Attempt, durationMs: number): InvalidReason | undefined {
    switch (v) {
      case 'depth':
        // Una rep completada pasó por la zona UP por construcción; se mantiene por semántica.
        return this.inUpZone(a.peak) ? undefined : 'shallow_depth';
      case 'fullReturn':
        // El retorno completo es condición de conteo; los rebotes se emiten aparte como no_return.
        return undefined;
      case 'duration':
        if (a.fromDown && durationMs < this.cfg.repDurationMs.min) return 'too_fast';
        if (durationMs > this.cfg.repDurationMs.max) return 'too_slow';
        return undefined;
      case 'confidence':
        return a.totalFrames > 0 && a.degradedFrames / a.totalFrames > this.cfg.maxDegradedRatio
          ? 'low_confidence'
          : undefined;
      case 'noArmAssist':
        return a.armAssist ? 'arm_assist' : undefined;
      case 'feetAnchored':
        return a.maxAnkleDy > (this.cfg.feetAnchor?.maxDy ?? 0.08) ? 'feet_lifted' : undefined;
      case 'hipAligned':
        return a.hipDeviation > (this.cfg.hipAlignment?.maxDeviationDeg ?? 30) ? 'hip_sag' : undefined;
    }
  }

  private emit(t: number, a: Attempt, bottomAngle: number, reason: InvalidReason | undefined): void {
    const event: RepEvent = {
      index: ++this.repIndex,
      valid: reason === undefined,
      ...(reason ? { reason } : {}),
      durationMs: t - a.startT,
      peakAngle: a.peak,
      bottomAngle,
    };
    if (event.valid) {
      this.validReps++;
      this.hint = undefined;
    } else {
      this.invalidReps++;
      this.hint = this.cfg.hints?.[reason!] ?? HINTS[reason!];
    }
    this.reps.push(event);
    for (const cb of this.callbacks) cb(event);
  }

  private logFrame(t: number, angle: number | null, degraded: boolean, frame: PoseFrame): void {
    this.frames.push({ t, angle, degraded, phase: this.phase, keypoints: frame.keypoints });
  }

  private snapshot(angle: number | null): CounterState {
    const good = this.confWindow.filter(Boolean).length;
    return {
      phase: this.phase,
      validReps: this.validReps,
      invalidReps: this.invalidReps,
      currentAngle: angle ?? 0,
      confidence: this.confWindow.length ? good / this.confWindow.length : 0,
      ...(this.hint ? { formHint: this.hint } : {}),
    };
  }
}

export function createRepCounter(cfg: ExerciseConfig): RepCounter {
  return new ExerciseRepCounter(cfg);
}
