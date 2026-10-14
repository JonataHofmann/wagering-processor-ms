import {
  type ProviderIdentity,
  PROVIDER_IDENTITY_PORT,
  type ProviderIdentityPort,
} from '@/src/platform/auth/provider-identity.port';
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

const BEARER_PREFIX = 'Bearer ';

interface RequestWithProviderIdentity {
  headers: Record<string, string | string[] | undefined>;
  providerIdentity?: ProviderIdentity;
}

function extractBearerToken(
  authorization: string | string[] | undefined,
): string | undefined {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) return undefined;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token === '' ? undefined : token;
}

/**
 * Extrai o token do header Authorization (se houver) e delega a autenticação ao
 * ProviderIdentityPort. Não conhece Keycloak nem valida assinatura de JWT — isso é
 * responsabilidade inteira do adapter por trás do Port.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    @Inject(PROVIDER_IDENTITY_PORT)
    private readonly identityPort: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<RequestWithProviderIdentity>();
    const token = extractBearerToken(request.headers['authorization']);

    try {
      request.providerIdentity = await this.identityPort.authenticate(token);
    } catch (error) {
      throw new UnauthorizedException(
        error instanceof Error ? error.message : 'authentication failed',
      );
    }
    return true;
  }
}
