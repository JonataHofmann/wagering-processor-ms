/**
 * Identidade autenticada de um provedor. `subject` é o equivalente ao claim `sub`
 * de um JWT do Keycloak; `roles` virá dos claims de realm/client role quando a
 * integração real existir.
 */
export interface ProviderIdentity {
  subject: string;
  providerId: string;
  roles: string[];
}

/**
 * Contrato de autenticação, independente de infraestrutura — não importa nada do
 * NestJS nem do Keycloak. A troca do adapter (no-op hoje, Keycloak no futuro) nunca
 * exige mudar este arquivo, o Guard, o decorator ou qualquer controller.
 */
export interface ProviderIdentityPort {
  authenticate(token?: string): Promise<ProviderIdentity>;
}

export const PROVIDER_IDENTITY_PORT = Symbol('ProviderIdentityPort');
