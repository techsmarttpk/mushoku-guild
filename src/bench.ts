// Phase 2 measurement helpers (latency statistics). Not product code.
export interface LatencySummary {
  count: number;
  minMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  gaps: number;
}

export class LatencyStats {
  private readonly values: number[] = [];
  private lastSeq = -1;
  private gaps = 0;

  add(latencyMs: number, seq: number): void {
    this.values.push(latencyMs);
    if (seq !== this.lastSeq + 1) {
      this.gaps += 1; // out-of-order or dropped
    }
    this.lastSeq = seq;
  }

  get count(): number {
    return this.values.length;
  }

  summary(): LatencySummary {
    const v = [...this.values].sort((a, b) => a - b);
    const at = (q: number): number => v[Math.min(v.length - 1, Math.floor(q * v.length))] ?? NaN;
    const sum = v.reduce((a, b) => a + b, 0);
    return {
      count: v.length,
      minMs: v[0] ?? NaN,
      meanMs: v.length ? sum / v.length : NaN,
      p50Ms: at(0.5),
      p95Ms: at(0.95),
      p99Ms: at(0.99),
      maxMs: v[v.length - 1] ?? NaN,
      gaps: this.gaps,
    };
  }
}

/** Sub-millisecond wall-clock time comparable with the Rust side's Unix-millisecond timestamps. */
export const nowUnixMs = (): number => performance.timeOrigin + performance.now();
