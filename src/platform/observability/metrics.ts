/**
 * Registro de métricas mínimo, em memória. A etapa 19 expõe estes valores no
 * formato Prometheus (GET /metrics); até lá, eles já são contados e testáveis.
 */
export type MetricLabels = Readonly<Record<string, string>>;

export interface Metrics {
  /** contador: só cresce */
  increment(name: string, labels?: MetricLabels, by?: number): void;
  /** gauge: valor atual */
  set(name: string, value: number, labels?: MetricLabels): void;
  /** valor atual de uma série (0 se nunca registrada) */
  value(name: string, labels?: MetricLabels): number;
  /** todas as séries, para exposição */
  snapshot(): ReadonlyArray<{ name: string; labels: MetricLabels; value: number }>;
}

export const METRICS = Symbol('Metrics');

function seriesKey(name: string, labels: MetricLabels): string {
  const sorted = Object.keys(labels).sort().map((key) => `${key}=${labels[key]}`);
  return `${name}{${sorted.join(',')}}`;
}

export class InMemoryMetrics implements Metrics {
  private readonly series = new Map<string, { name: string; labels: MetricLabels; value: number }>();

  increment(name: string, labels: MetricLabels = {}, by = 1): void {
    const current = this.series.get(seriesKey(name, labels));
    this.series.set(seriesKey(name, labels), { name, labels, value: (current?.value ?? 0) + by });
  }

  set(name: string, value: number, labels: MetricLabels = {}): void {
    this.series.set(seriesKey(name, labels), { name, labels, value });
  }

  value(name: string, labels: MetricLabels = {}): number {
    return this.series.get(seriesKey(name, labels))?.value ?? 0;
  }

  snapshot() {
    return [...this.series.values()];
  }
}
