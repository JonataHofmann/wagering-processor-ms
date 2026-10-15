import {
  SQS_CLIENT,
  SQS_CONFIG,
  type SqsConfig,
} from '@/src/modules/messaging/infrastructure/sqs/sqs.config';
import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Inject, Optional, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

interface StatusSettable {
  status(code: number): unknown;
}

interface CheckResult {
  ok: boolean;
  detail: string;
}

interface ReadinessBody {
  status: 'ok' | 'error';
  checks: { postgres: string; sqs: string };
}

/** Node agrupa falhas de conexão (ex.: ECONNREFUSED em IPv4 e IPv6) num AggregateError sem .message. */
function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map(describeError).join('; ');
  }
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    @Optional() @Inject(SQS_CLIENT) private readonly sqsClient?: SQSClient,
    @Optional() @Inject(SQS_CONFIG) private readonly sqsConfig?: SqsConfig,
  ) {}

  @Get('live')
  @ApiOperation({
    summary: 'Liveness probe: process is alive, does not query dependencies',
  })
  @ApiResponse({ status: 200, schema: { example: { status: 'ok' } } })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe: PostgreSQL and SQS reachable',
  })
  @ApiResponse({
    status: 200,
    schema: {
      example: { status: 'ok', checks: { postgres: 'ok', sqs: 'ok' } },
    },
  })
  @ApiResponse({
    status: 503,
    description: 'PostgreSQL or SQS unreachable',
    schema: {
      example: {
        status: 'error',
        checks: { postgres: 'ok', sqs: 'error: ...' },
      },
    },
  })
  async ready(
    @Res({ passthrough: true }) response: StatusSettable,
  ): Promise<ReadinessBody> {
    const [postgres, sqs] = await Promise.all([
      this.checkPostgres(),
      this.checkSqs(),
    ]);
    const ready = postgres.ok && sqs.ok;
    response.status(ready ? 200 : 503);
    return {
      status: ready ? 'ok' : 'error',
      checks: { postgres: postgres.detail, sqs: sqs.detail },
    };
  }

  private async checkPostgres(): Promise<CheckResult> {
    try {
      const connected = await this.orm.isConnected();
      return connected
        ? { ok: true, detail: 'ok' }
        : { ok: false, detail: 'not connected' };
    } catch (error) {
      return { ok: false, detail: describeError(error) };
    }
  }

  private async checkSqs(): Promise<CheckResult> {
    if (this.sqsClient === undefined || this.sqsConfig === undefined) {
      // instância sem SQS configurado
      return { ok: true, detail: 'skipped (SQS not configured)' };
    }
    try {
      await this.sqsClient.send(
        new GetQueueUrlCommand({
          QueueName: this.sqsConfig.queues.walletEvents,
        }),
      );
      return { ok: true, detail: 'ok' };
    } catch (error) {
      return { ok: false, detail: describeError(error) };
    }
  }
}
