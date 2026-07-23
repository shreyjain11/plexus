/**
 * One-Euro filter (Casiez, Roussel & Vogel, CHI 2012).
 *
 * A first-order low-pass whose cutoff frequency rises with movement speed:
 * slow motion is filtered hard (precise, low jitter) while fast motion is
 * filtered lightly (low lag). Ideal for taming noisy MediaPipe landmarks into
 * a signal steady enough to draw with.
 */
class LowPass {
  private y = 0;
  private initialized = false;

  filter(x: number, alpha: number): number {
    if (!this.initialized) {
      this.y = x;
      this.initialized = true;
    } else {
      this.y = alpha * x + (1 - alpha) * this.y;
    }
    return this.y;
  }

  get hasValue(): boolean {
    return this.initialized;
  }

  get value(): number {
    return this.y;
  }

  reset(): void {
    this.initialized = false;
    this.y = 0;
  }
}

export interface OneEuroConfig {
  /** Baseline cutoff (Hz). Lower = smoother but laggier at rest. */
  minCutoff: number;
  /** Speed coefficient. Higher = less lag when moving fast. */
  beta: number;
  /** Cutoff for the derivative estimate (Hz). */
  dCutoff: number;
}

class OneEuroScalar {
  private readonly x = new LowPass();
  private readonly dx = new LowPass();
  private lastTime: number | null = null;

  constructor(private cfg: OneEuroConfig) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value: number, timestampMs: number): number {
    let dt = this.lastTime === null ? 1 / 60 : (timestampMs - this.lastTime) / 1000;
    if (dt <= 0 || dt > 1) dt = 1 / 60;
    this.lastTime = timestampMs;

    const prev = this.x.hasValue ? this.x.value : value;
    const dxValue = (value - prev) / dt;
    const edx = this.dx.filter(dxValue, this.alpha(this.cfg.dCutoff, dt));
    const cutoff = this.cfg.minCutoff + this.cfg.beta * Math.abs(edx);
    return this.x.filter(value, this.alpha(cutoff, dt));
  }

  reset(): void {
    this.x.reset();
    this.dx.reset();
    this.lastTime = null;
  }
}

export class OneEuroPoint {
  private readonly fx: OneEuroScalar;
  private readonly fy: OneEuroScalar;

  constructor(cfg: OneEuroConfig) {
    this.fx = new OneEuroScalar(cfg);
    this.fy = new OneEuroScalar(cfg);
  }

  filter(x: number, y: number, timestampMs: number): { x: number; y: number } {
    return { x: this.fx.filter(x, timestampMs), y: this.fy.filter(y, timestampMs) };
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }
}
