import { describe, expect, it } from "vitest";
import { DEFAULT_HARNESS_LIMITS } from "@/core/harness/contracts";
import { configuredDshExecutionPolicy, DEFAULT_DSH_EXECUTION_POLICY, resolveDshExecutionPolicy } from "./execution-policy";

describe("DSH server-owned execution protection", () => {
  it("has no website budget by default without changing the original Harness", () => {
    expect(resolveDshExecutionPolicy()).toEqual({ maxToolCalls: null, totalExecutionTimeoutMs: null, toolCallTimeoutMs: null });
    expect(DEFAULT_HARNESS_LIMITS.maxToolCalls).toBe(6);
    expect(DEFAULT_HARNESS_LIMITS.totalExecutionTimeoutMs).toBe(90_000);
    expect(Object.isFrozen(DEFAULT_DSH_EXECUTION_POLICY)).toBe(true);
  });

  it("allows explicit deployment budgets and ignores legacy Harness deployment knobs", () => {
    expect(resolveDshExecutionPolicy({ maxToolCalls: 8, totalExecutionTimeoutMs: 60_000, toolCallTimeoutMs: 10_000 }))
      .toEqual({ maxToolCalls: 8, totalExecutionTimeoutMs: 60_000, toolCallTimeoutMs: 10_000 });
    expect(configuredDshExecutionPolicy({ HARNESS_MAX_TOOL_CALLS: "1", HARNESS_TOTAL_EXECUTION_TIMEOUT_MS: "2000" }))
      .toEqual(DEFAULT_DSH_EXECUTION_POLICY);
    expect(configuredDshExecutionPolicy({ DSH_MAX_TOOL_CALLS: "12", DSH_TOTAL_EXECUTION_TIMEOUT_MS: "120000", DSH_TOOL_CALL_TIMEOUT_MS: "15000" }))
      .toEqual({ maxToolCalls: 12, totalExecutionTimeoutMs: 120_000, toolCallTimeoutMs: 15_000 });
  });

  it("accepts budgets above the old ceilings, or explicit disabling", () => {
    expect(configuredDshExecutionPolicy({ DSH_MAX_TOOL_CALLS: "100", DSH_TOTAL_EXECUTION_TIMEOUT_MS: "600000", DSH_TOOL_CALL_TIMEOUT_MS: "120000" }))
      .toEqual({ maxToolCalls: 100, totalExecutionTimeoutMs: 600_000, toolCallTimeoutMs: 120_000 });
    expect(configuredDshExecutionPolicy({ DSH_MAX_TOOL_CALLS: "0", DSH_TOTAL_EXECUTION_TIMEOUT_MS: "0", DSH_TOOL_CALL_TIMEOUT_MS: "0" }))
      .toEqual(DEFAULT_DSH_EXECUTION_POLICY);
    expect(resolveDshExecutionPolicy({ maxToolCalls: null, totalExecutionTimeoutMs: null, toolCallTimeoutMs: null }))
      .toEqual(DEFAULT_DSH_EXECUTION_POLICY);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid trusted tool count %s", maxToolCalls => {
    expect(() => resolveDshExecutionPolicy({ maxToolCalls })).toThrow("DSH 执行保护配置无效");
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_647])("rejects invalid or overflowing total timeout %s", totalExecutionTimeoutMs => {
    expect(() => resolveDshExecutionPolicy({ totalExecutionTimeoutMs })).toThrow("DSH 执行保护配置无效");
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_647])("rejects invalid or overflowing tool timeout %s", toolCallTimeoutMs => {
    expect(() => resolveDshExecutionPolicy({ toolCallTimeoutMs })).toThrow("DSH 执行保护配置无效");
  });

  it.each(["", "-1", "1.5", "Infinity", "null", " 12", "12x", "1e1"])("rejects malformed deployment configuration %s", value => {
    expect(() => configuredDshExecutionPolicy({ DSH_MAX_TOOL_CALLS: value })).toThrow("DSH 执行保护配置无效");
  });
});
