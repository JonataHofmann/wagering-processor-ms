import type { MetricLabels, MetricSeries } from '@/src/platform/observability/metrics';

function formatLabels(labels: MetricLabels, extra?: MetricLabels): string {
  const all = { ...labels, ...extra };
  const keys = Object.keys(all);
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${all[k]}"`).join(',')}}`;
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toString();
}

/** Serializa as séries no formato de exposição de texto do Prometheus. */
export function formatPrometheusText(series: readonly MetricSeries[]): string {
  const lines: string[] = [];

  // Prometheus exige que todas as amostras de um mesmo nome fiquem juntas,
  // logo depois do "# TYPE" — então agrupamos antes de emitir.
  const byName = new Map<string, MetricSeries[]>();
  for (const s of series) {
    byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  }

  for (const [name, group] of byName) {
    lines.push(`# TYPE ${name} ${group[0]!.kind}`);
    for (const s of group) pushSeries(lines, s);
  }

  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function pushSeries(lines: string[], s: MetricSeries): void {
  if (s.kind === 'histogram') {
    for (const bucket of s.buckets) {
      lines.push(
        `${s.name}_bucket${formatLabels(s.labels, { le: String(bucket.le) })} ${formatValue(bucket.count)}`,
      );
    }
    lines.push(`${s.name}_bucket${formatLabels(s.labels, { le: '+Inf' })} ${formatValue(s.count)}`);
    lines.push(`${s.name}_sum${formatLabels(s.labels)} ${formatValue(s.sum)}`);
    lines.push(`${s.name}_count${formatLabels(s.labels)} ${formatValue(s.count)}`);
  } else {
    lines.push(`${s.name}${formatLabels(s.labels)} ${formatValue(s.value)}`);
  }
}
