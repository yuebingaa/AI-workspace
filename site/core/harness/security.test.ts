import { expect, it } from "vitest";
import { redactHarnessSecrets, sanitizeHarnessText } from "./security";

it("preserves the old display sanitizer contract while allowing lossless redacted context", () => {
  const value = "普通上下文".repeat(250) + " sk-synthetic-123456789 结尾约定";
  expect(sanitizeHarnessText(value)).toHaveLength(1000);
  expect(redactHarnessSecrets(value)).toContain("结尾约定");
  expect(redactHarnessSecrets(value)).not.toContain("sk-synthetic-123456789");
  expect(sanitizeHarnessText(undefined, "fallback")).toBe("fallback");
  expect(sanitizeHarnessText(new Error("Bearer synthetic_token_123"))).toBe("[已脱敏]");
});
