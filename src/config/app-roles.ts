/** Papéis que uma instância pode exercer (ADR-001). */
export const APP_ROLE_VALUES = [
  'api',
  'consumer',
  'relay',
  'scheduler',
] as const;
export type AppRole = (typeof APP_ROLE_VALUES)[number];

export const APP_ROLES = Symbol('AppRoles');

/** Lê APP_ROLES ("api,consumer,..."). Valor inválido falha no boot, em vez de subir uma instância que não faz nada. */
export function parseAppRoles(raw: string | undefined): ReadonlySet<AppRole> {
  const values = (raw ?? APP_ROLE_VALUES.join(','))
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');

  const invalid = values.filter(
    (value) => !(APP_ROLE_VALUES as readonly string[]).includes(value),
  );
  if (invalid.length > 0) {
    throw new Error(
      `invalid APP_ROLES: ${invalid.join(', ')} (valid: ${APP_ROLE_VALUES.join(', ')})`,
    );
  }
  return new Set(values as AppRole[]);
}
