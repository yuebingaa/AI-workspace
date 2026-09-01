const secretPatterns = [
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /sk-[A-Za-z0-9_-]{8,}/gi,
  /DEEPSEEK_API_KEY\s*[=:]\s*\S+/gi,
  /Authorization\s*[=:]\s*\S+/gi,
  /reasoning_content\s*[=:]\s*[^,}\n]+/gi,
];

export function sanitizeHarnessText(value: unknown, fallback = "Harness 执行失败，请稍后重试。"): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : fallback;
  return secretPatterns.reduce((text, pattern) => text.replace(pattern, "[已脱敏]"), raw).slice(0, 1_000) || fallback;
}

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
