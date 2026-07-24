/**
 * Mediana móvil sobre el ángulo (no sobre los keypoints): los saltos de pose
 * son outliers puntuales, no ruido gaussiano, y la mediana los elimina sin lag notable.
 */
export class MedianSmoother {
  private buf: number[] = [];

  constructor(private readonly window: number) {
    if (window < 1) throw new Error('window must be >= 1');
  }

  push(value: number): number {
    this.buf.push(value);
    if (this.buf.length > this.window) this.buf.shift();
    const sorted = [...this.buf].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1
      ? sorted[mid]!
      : (sorted[mid - 1]! + sorted[mid]!) / 2;
  }

  reset(): void {
    this.buf.length = 0;
  }
}
