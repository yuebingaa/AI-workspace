import { redactOperationalText } from "@/core/observability/redaction";

const MAX_PUBLIC_ERROR_CHARACTERS = 500;
const FALLBACK_ERROR = "EDS 工作簿分析失败。";

export function sanitizeEdsPublicError(value: string): string {
  const normalized = redactOperationalText(value, 2_000)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const bounded = Array.from(normalized).slice(0, MAX_PUBLIC_ERROR_CHARACTERS).join("");
  return bounded || FALLBACK_ERROR;
}
