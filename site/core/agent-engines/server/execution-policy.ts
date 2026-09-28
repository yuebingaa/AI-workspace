/** Optional deployment budgets, not provider limits or business authorization. */
export interface DshExecutionPolicy {
  maxToolCalls: number | null;
  totalExecutionTimeoutMs: number | null;
  toolCallTimeoutMs: number | null;
}

// null means no website-imposed budget. Only trusted server composition may
// opt in; browser payloads and model output never select these values.
export const DEFAULT_DSH_EXECUTION_POLICY: Readonly<DshExecutionPolicy> = Object.freeze({
  maxToolCalls: null,
  totalExecutionTimeoutMs: null,
  toolCallTimeoutMs: null,
});

export function resolveDshExecutionPolicy(overrides: Partial<DshExecutionPolicy> = {}): DshExecutionPolicy {
  const result = { ...DEFAULT_DSH_EXECUTION_POLICY };
  for (const key of Object.keys(result) as Array<keyof DshExecutionPolicy>) {
    const value = overrides[key];
    if (value === undefined) continue;
    // JS timers overflow beyond signed int32; reserve the browser's 5s grace.
    const maximum = key === "maxToolCalls" ? Number.MAX_SAFE_INTEGER : 2_147_483_647 - 5_000;
    if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > maximum)) {
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
    overrides[key] = Number(value) === 0 ? null : Number(value);
  }
  return resolveDshExecutionPolicy(overrides);
}
