/**
 * Registro de métricas mínimo, em memória, exposto em /metrics no formato Prometheus
 * (ver prometheus-format.ts e metrics.controller.ts).
 */
export type MetricLabels = Readonly<Record<string, string>>;

/** Buckets default do cliente Prometheus, em segundos. */
export const DEFAULT_HISTOGRAM_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export interface HistogramBucket {
  /** limite superior (inclusive) do bucket, em segundos */
  le: number;
  /** contagem cumulativa: observações com valor <= le */
  count: number;
}

export type MetricSeries =
  | { kind: 'counter' | 'gauge'; name: string; labels: MetricLabels; value: number }
  | {
      kind: 'histogram';
      name: string;
      labels: MetricLabels;
      buckets: readonly HistogramBucket[];
      sum: number;
      count: number;
    };

export interface Metrics {
  /** contador: só cresce */
  increment(name: string, labels?: MetricLabels, by?: number): void;
  /** gauge: valor atual */
  set(name: string, value: number, labels?: MetricLabels): void;
  /** histograma: registra uma observação (ex.: duração em segundos) */
  observe(name: string, value: number, labels?: MetricLabels): void;
  /** valor atual de uma série counter/gauge (0 se nunca registrada) */
  value(name: string, labels?: MetricLabels): number;
  /** todas as séries, para exposição */
  snapshot(): ReadonlyArray<MetricSeries>;
}

export const METRICS = Symbol('Metrics');

function seriesKey(name: string, labels: MetricLabels): string {
  const sorted = Object.keys(labels).sort().map((key) => `${key}=${labels[key]}`);
  return `${name}{${sorted.join(',')}}`;
}

interface CounterOrGaugeSeries {
  kind: 'counter' | 'gauge';
  name: string;
  labels: MetricLabels;
  value: number;
}

interface HistogramSeries {
  name: string;
  labels: MetricLabels;
  buckets: number[]; // contagem cumulativa, mesmo índice que DEFAULT_HISTOGRAM_BUCKETS
  sum: number;
  count: number;
}

export class InMemoryMetrics implements Metrics {
  private readonly series = new Map<string, CounterOrGaugeSeries>();
  private readonly histograms = new Map<string, HistogramSeries>();

  increment(name: string, labels: MetricLabels = {}, by = 1): void {
    const key = seriesKey(name, labels);
    const current = this.series.get(key);
    this.series.set(key, {
      kind: 'counter',
      name,
      labels,
      value: (current?.value ?? 0) + by,
    });
  }

  set(name: string, value: number, labels: MetricLabels = {}): void {
    this.series.set(seriesKey(name, labels), { kind: 'gauge', name, labels, value });
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    const key = seriesKey(name, labels);
    const current = this.histograms.get(key) ?? {
      name,
      labels,
      buckets: DEFAULT_HISTOGRAM_BUCKETS.map(() => 0),
      sum: 0,
      count: 0,
    };
    const buckets = current.buckets.map((count, i) =>
      value <= DEFAULT_HISTOGRAM_BUCKETS[i]! ? count + 1 : count,
    );
    this.histograms.set(key, {
      name,
      labels,
      buckets,
      sum: current.sum + value,
      count: current.count + 1,
    });
  }

  value(name: string, labels: MetricLabels = {}): number {
    return this.series.get(seriesKey(name, labels))?.value ?? 0;
  }

  snapshot(): MetricSeries[] {
    const counters: MetricSeries[] = [...this.series.values()];
    const histograms: MetricSeries[] = [...this.histograms.values()].map((h) => ({
      kind: 'histogram' as const,
      name: h.name,
      labels: h.labels,
      buckets: DEFAULT_HISTOGRAM_BUCKETS.map((le, i) => ({ le, count: h.buckets[i]! })),
      sum: h.sum,
      count: h.count,
    }));
    return [...counters, ...histograms];
  }
}
