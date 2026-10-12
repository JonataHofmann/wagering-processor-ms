export const undef = <T>(value: T | null): T | undefined =>
  value === null ? undefined : value;
