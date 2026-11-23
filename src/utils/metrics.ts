/**
 * Technical metrics registry.
 *
 * Counters, gauges and duration observations about the SERVICE (latency,
 * errors, wire bytes parsed, lock waits, quarantined files, …). It never
 * records content: no memory bodies, no queries, no tokens. The snapshot is
 * exposed to authenticated callers only (`/api/metrics`, `/api/health`).
 */

interface HistogramState {
  count: number;
  totalMs: number;
  maxMs: number;
  /** Observations, kept bounded. */
  samples: number[];
}

const SAMPLE_LIMIT = 256;

class MetricsRegistry {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, HistogramState>();
  private startedAt = Date.now();

  /** Increment a monotonic counter by `delta` (default 1). */
  increment(name: string, delta = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
  }

  /** Set a gauge to an absolute value. */
  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  /** Record one duration observation in milliseconds. */
  observe(name: string, ms: number): void {
    let state = this.histograms.get(name);
    if (!state) {
      state = { count: 0, totalMs: 0, maxMs: 0, samples: [] };
      this.histograms.set(name, state);
    }
    state.count++;
    state.totalMs += ms;
    state.maxMs = Math.max(state.maxMs, ms);
    state.samples.push(ms);
    if (state.samples.length > SAMPLE_LIMIT) {
      state.samples.shift();
    }
  }

  /** Run `fn`, observe its wall time under `name`, and count errors. */
  async timed<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      this.observe(name, Date.now() - start);
    }
  }

  percentile(name: string, p: number): number | null {
    const state = this.histograms.get(name);
    if (!state || state.samples.length === 0) return null;
    const sorted = [...state.samples].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[index];
  }

  uptimeMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Content-free snapshot for metrics endpoints. */
  snapshot(): {
    uptimeMs: number;
    counters: Record<string, number>;
    gauges: Record<string, number>;
    timings: Record<string, { count: number; avgMs: number; maxMs: number; p50Ms: number | null; p95Ms: number | null }>;
  } {
    const timings: Record<
      string,
      { count: number; avgMs: number; maxMs: number; p50Ms: number | null; p95Ms: number | null }
    > = {};
    for (const [name, state] of this.histograms) {
      timings[name] = {
        count: state.count,
        avgMs: state.count > 0 ? Math.round(state.totalMs / state.count) : 0,
        maxMs: state.maxMs,
        p50Ms: this.percentile(name, 50),
        p95Ms: this.percentile(name, 95),
      };
    }
    return {
      uptimeMs: this.uptimeMs(),
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      timings,
    };
  }
}

/** Process-wide registry (one MCP process / one dashboard per workspace). */
export const metrics = new MetricsRegistry();

export interface HealthReport {
  /** `ok` when every subsystem reports healthy; `degraded`/`corrupt` otherwise. */
  status: 'ok' | 'degraded' | 'rebuilding' | 'corrupt';
  reasons: string[];
}

/** Derive a health verdict from gauges/counters set by the subsystems. */
export function healthFromMetrics(): HealthReport {
  const reasons: string[] = [];
  const quarantined = (metrics.snapshot().counters['corrupt_files_quarantined'] ?? 0) > 0;
  if (quarantined) reasons.push('corrupt files were quarantined');

  const gauge = metrics.snapshot().gauges;
  const state = gauge['health_state'];
  if (state === 2) return { status: 'corrupt', reasons };
  if (state === 3) return { status: 'rebuilding', reasons };
  if (state === 1) {
    reasons.push('one or more subsystems reported degradation');
    return { status: 'degraded', reasons };
  }
  return { status: reasons.length > 0 ? 'degraded' : 'ok', reasons };
}
