import type { ProviderIdentity } from '@/src/platform/auth/provider-identity.port';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

interface RequestWithProviderIdentity {
  providerIdentity?: ProviderIdentity;
}

/**
 * Lógica pura por trás do decorator — separada para ser testável sem a reflexão do
 * Nest em volta de createParamDecorator.
 */
export function extractCurrentProvider(
  context: ExecutionContext,
): ProviderIdentity {
  const request = context
    .switchToHttp()
    .getRequest<RequestWithProviderIdentity>();
  if (request.providerIdentity === undefined) {
    throw new Error(
      'CurrentProvider() used without ProviderAuthGuard — request has no authenticated identity',
    );
  }
  return request.providerIdentity;
}

/** Identidade autenticada, nunca o providerId informado pelo cliente no corpo da requisição. */
export const CurrentProvider = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ProviderIdentity =>
    extractCurrentProvider(context),
);
