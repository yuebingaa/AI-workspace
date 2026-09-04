const PROJECT_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function toProjectIsoDateTime(value: unknown): string | null {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
  const serialized = value.toISOString();
  return PROJECT_ISO_DATETIME.test(serialized) ? serialized : null;
}
