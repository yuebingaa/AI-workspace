/** Server-owned execution protection; unrelated to provider token/context limits. */
export interface DshExecutionPolicy {
  maxToolCalls: number;
  totalExecutionTimeoutMs: number;
  toolCallTimeoutMs: number;
}

// Defaults are also hard ceilings. Trusted per-task or deployment settings may
// tighten them; browser payloads and model output never select these values.
export const DEFAULT_DSH_EXECUTION_POLICY: Readonly<DshExecutionPolicy> = Object.freeze({
  maxToolCalls: 24,
  totalExecutionTimeoutMs: 180_000,
  toolCallTimeoutMs: 35_000,
});

export function resolveDshExecutionPolicy(overrides: Partial<DshExecutionPolicy> = {}): DshExecutionPolicy {
  const result = { ...DEFAULT_DSH_EXECUTION_POLICY };
  for (const key of Object.keys(result) as Array<keyof DshExecutionPolicy>) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_DSH_EXECUTION_POLICY[key]) {
      throw new Error(`DSH 执行保护配置无效：${key}。`);
    }
    result[key] = value;
  }
  return result;
}

/** Read once at the trusted HTTP composition boundary, never from request JSON. */
export function configuredDshExecutionPolicy(environment: Readonly<Record<string, string | undefined>> = process.env): DshExecutionPolicy {
  const keys = { maxToolCalls: "DSH_MAX_TOOL_CALLS", totalExecutionTimeoutMs: "DSH_TOTAL_EXECUTION_TIMEOUT_MS",
    toolCallTimeoutMs: "DSH_TOOL_CALL_TIMEOUT_MS" } as const;
  const overrides: Partial<DshExecutionPolicy> = {};
  for (const key of Object.keys(keys) as Array<keyof DshExecutionPolicy>) {
    const value = environment[keys[key]];
    if (value === undefined) continue;
    if (!/^\d+$/u.test(value)) throw new Error(`DSH 执行保护配置无效：${key}。`);
    overrides[key] = Number(value);
  }
  return resolveDshExecutionPolicy(overrides);
}
