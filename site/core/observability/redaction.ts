const SECRET_ASSIGNMENT = /\b(api[_-]?key|authorization|token|password|secret)\b\s*[:=]\s*([^\s,;]+)/giu;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu;
const WINDOWS_PATH = /\b[A-Za-z]:\\[^\r\n"']+/gu;
const UNIX_HOME_PATH = /\/(?:home|Users)\/[^\s"']+/gu;

export function redactOperationalText(value: unknown, maxLength = 500): string {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return text
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=[REDACTED]`)
    .replace(WINDOWS_PATH, "[LOCAL_PATH]")
    .replace(UNIX_HOME_PATH, "[LOCAL_PATH]")
    .slice(0, Math.max(1, maxLength));
}
