import { METRICS, type Metrics } from '@/src/platform/observability/metrics';
import { formatPrometheusText } from '@/src/platform/observability/prometheus-format';
import { Controller, Get, Header, Inject } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

/** Exposição Prometheus das métricas em memória. Sem autenticação, como /health. */
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: Metrics) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  get(): string {
    return formatPrometheusText(this.metrics.snapshot());
  }
}
