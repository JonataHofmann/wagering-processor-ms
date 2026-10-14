import { METRICS, type Metrics } from '@/src/platform/observability/metrics';
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs';

interface HttpRequest {
  method: string;
  route?: { path?: string };
}

interface HttpResponse {
  statusCode: number;
}

/** Histograma de latência de toda a API HTTP, por método/rota/status. */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(@Inject(METRICS) private readonly metrics: Metrics) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const startedAt = performance.now();
    const record = (): void => this.record(context, startedAt);
    return next.handle().pipe(tap({ next: record, error: record }));
  }

  private record(context: ExecutionContext, startedAt: number): void {
    const http = context.switchToHttp();
    const req = http.getRequest<HttpRequest>();
    const res = http.getResponse<HttpResponse>();
    const seconds = (performance.now() - startedAt) / 1000;

    this.metrics.observe('http_request_duration_seconds', seconds, {
      method: req.method,
      route: req.route?.path ?? 'unknown',
      status: String(res.statusCode),
    });
  }
}
