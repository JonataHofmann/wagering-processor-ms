# Autenticação (Port/Adapter, hoje no-op)

A integração real com Keycloak **não está implementada** (decisão de escopo do enunciado — ver
ADR-008 no `ARCHITECTURE.md`). O que existe é a estrutura completa, pronta pra trocar o adapter
sem tocar em Guard, decorator ou controller: `src/platform/auth/`.

## Fluxo (hoje, com o adapter no-op)

```mermaid
sequenceDiagram
    autonumber
    participant C as Cliente
    participant Guard as ProviderAuthGuard
    participant Port as ProviderIdentityPort
    participant Adapter as NoOpProviderIdentityAdapter
    participant Ctrl as Controller

    C->>Guard: requisição (Authorization: Bearer <token>, opcional)
    Guard->>Guard: extrai o token do header (ou undefined)
    Guard->>Port: authenticate(token)
    Port->>Adapter: (implementação ligada por AUTH_MODE)
    Adapter-->>Port: sempre a mesma identidade fictícia<br/>(nunca valida nada)
    Port-->>Guard: ProviderIdentity
    Guard->>Guard: request.providerIdentity = identity
    Guard-->>Ctrl: permite a execução
    Ctrl->>Ctrl: @CurrentProvider() lê request.providerIdentity
    Note over Ctrl: NUNCA lê providerId do corpo —<br/>sempre da identidade autenticada
```

## Fluxo futuro (Keycloak — desenhado, não implementado)

```mermaid
sequenceDiagram
    participant C as Cliente
    participant Guard as ProviderAuthGuard
    participant Port as ProviderIdentityPort
    participant KC as KeycloakProviderIdentityAdapter
    participant JWKS as Cache de chaves JWKS

    C->>Guard: Authorization: Bearer <JWT>
    Guard->>Port: authenticate(token)
    Port->>KC: (mesma troca de adapter, nada mais muda)
    KC->>JWKS: chave pública do kid do JWT (cache, sem HTTP por requisição)
    KC->>KC: valida assinatura, iss, aud, exp
    alt token inválido/expirado
        KC-->>Port: lança
        Port-->>Guard: lança
        Guard-->>C: 401 Unauthorized
    else token válido
        KC->>KC: sub → subject, claim/mapeamento → providerId,<br/>realm/client roles → roles
        KC-->>Port: ProviderIdentity
        Port-->>Guard: ProviderIdentity
    end
```

## Por que isso é seguro como está

```mermaid
flowchart TD
    Boot(["bootstrap da aplicação"]) --> Read["authConfigFromEnv():<br/>lê AUTH_MODE e NODE_ENV"]
    Read --> Missing{"AUTH_MODE ausente?"}
    Missing -- sim --> Fail1["❌ falha o boot<br/>(sem fallback implícito)"]
    Missing -- não --> IsKeycloak{"AUTH_MODE=keycloak?"}
    IsKeycloak -- sim --> Fail2["❌ falha o boot<br/>('adapter ainda não existe')"]
    IsKeycloak -- não --> IsNoop{"AUTH_MODE=noop?"}
    IsNoop -- não --> Fail3["❌ falha o boot<br/>('unsupported AUTH_MODE')"]
    IsNoop -- sim --> IsProd{"NODE_ENV=production?"}
    IsProd -- sim --> Fail4["❌ falha o boot<br/>('no-op nunca pode rodar em produção')"]
    IsProd -- não --> OK["✅ sobe com o adapter no-op"]
```

## O que NÃO foi feito (de propósito)

- Nenhum controller existente (`wagering`, `wallet`) usa `@UseGuards(ProviderAuthGuard)` — ligar
  o Guard numa rota é decisão de produto (quais rotas exigem identidade) e muda o contrato
  público (o `providerId` do corpo deixaria de valer), fora do escopo desta etapa.
- `/health/*` e `/metrics` continuam sempre abertos, como o enunciado exige.
- Nenhuma biblioteca de Keycloak foi instalada; nenhuma chamada de rede acontece.

## Arquivos

- `src/platform/auth/provider-identity.port.ts` — contrato, zero dependência de framework.
- `src/platform/auth/no-op-provider-identity.adapter.ts`
- `src/platform/auth/auth.config.ts` — validação fail-fast de `AUTH_MODE`/`NODE_ENV`.
- `src/platform/auth/provider-auth.guard.ts`, `current-provider.decorator.ts`, `auth.module.ts`.
- `ARCHITECTURE.md` (ADR-008) — desenho completo da integração futura.
- `test/unit/platform/auth/` — cobertura de cada peça.
