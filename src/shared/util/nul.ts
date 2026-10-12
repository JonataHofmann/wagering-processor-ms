export const nul = <T>(value: T | undefined): T | null =>
  value === undefined ? null : value;
