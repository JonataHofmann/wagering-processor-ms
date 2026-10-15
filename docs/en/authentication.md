# Authentication (Port/Adapter, currently no-op)

The real Keycloak integration **is not implemented** (scope decision from the spec — see
ADR-008 in `ARCHITECTURE.en.md`). What exists is the complete structure, ready to swap the adapter
without touching the Guard, decorator, or controller: `src/platform/auth/`.

## Flow (today, with the no-op adapter)

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant Guard as ProviderAuthGuard
    participant Port as ProviderIdentityPort
    participant Adapter as NoOpProviderIdentityAdapter
    participant Ctrl as Controller

    C->>Guard: request (Authorization: Bearer <token>, optional)
    Guard->>Guard: extracts the token from the header (or undefined)
    Guard->>Port: authenticate(token)
    Port->>Adapter: (implementation wired by AUTH_MODE)
    Adapter-->>Port: always the same fictitious identity<br/>(never validates anything)
    Port-->>Guard: ProviderIdentity
    Guard->>Guard: request.providerIdentity = identity
    Guard-->>Ctrl: allows execution
    Ctrl->>Ctrl: @CurrentProvider() reads request.providerIdentity
    Note over Ctrl: NEVER reads providerId from the body —<br/>always from the authenticated identity
```

## Future flow (Keycloak — designed, not implemented)

```mermaid
sequenceDiagram
    participant C as Client
    participant Guard as ProviderAuthGuard
    participant Port as ProviderIdentityPort
    participant KC as KeycloakProviderIdentityAdapter
    participant JWKS as JWKS key cache

    C->>Guard: Authorization: Bearer <JWT>
    Guard->>Port: authenticate(token)
    Port->>KC: (same adapter swap, nothing else changes)
    KC->>JWKS: public key for the JWT's kid (cache, no HTTP per request)
    KC->>KC: validates signature, iss, aud, exp
    alt invalid/expired token
        KC-->>Port: throws
        Port-->>Guard: throws
        Guard-->>C: 401 Unauthorized
    else valid token
        KC->>KC: sub → subject, claim/mapping → providerId,<br/>realm/client roles → roles
        KC-->>Port: ProviderIdentity
        Port-->>Guard: ProviderIdentity
    end
```

## Why this is safe as it stands

```mermaid
flowchart TD
    Boot(["application bootstrap"]) --> Read["authConfigFromEnv():<br/>reads AUTH_MODE and NODE_ENV"]
    Read --> Missing{"AUTH_MODE missing?"}
    Missing -- yes --> Fail1["❌ boot fails<br/>(no implicit fallback)"]
    Missing -- no --> IsKeycloak{"AUTH_MODE=keycloak?"}
    IsKeycloak -- yes --> Fail2["❌ boot fails<br/>('adapter does not exist yet')"]
    IsKeycloak -- no --> IsNoop{"AUTH_MODE=noop?"}
    IsNoop -- no --> Fail3["❌ boot fails<br/>('unsupported AUTH_MODE')"]
    IsNoop -- yes --> IsProd{"NODE_ENV=production?"}
    IsProd -- yes --> Fail4["❌ boot fails<br/>('no-op can never run in production')"]
    IsProd -- no --> OK["✅ boots with the no-op adapter"]
```

## What was NOT done (on purpose)

- No existing controller (`wagering`, `wallet`) uses `@UseGuards(ProviderAuthGuard)` — wiring
  the Guard into a route is a product decision (which routes require identity) and changes the
  public contract (the `providerId` from the body would stop being valid), out of scope for this
  stage.
- `/health/*` and `/metrics` remain always open, as the spec requires.
- No Keycloak library was installed; no network call happens.

## Files

- `src/platform/auth/provider-identity.port.ts` — contract, zero framework dependency.
- `src/platform/auth/no-op-provider-identity.adapter.ts`
- `src/platform/auth/auth.config.ts` — fail-fast validation of `AUTH_MODE`/`NODE_ENV`.
- `src/platform/auth/provider-auth.guard.ts`, `current-provider.decorator.ts`, `auth.module.ts`.
- `ARCHITECTURE.en.md` (ADR-008) — complete design of the future integration.
- `test/unit/platform/auth/` — coverage of each piece.
