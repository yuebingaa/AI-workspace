import { describe, expect, it } from "vitest";
import { DEFAULT_HARNESS_LIMITS } from "@/core/harness/contracts";
import { configuredDshExecutionPolicy, DEFAULT_DSH_EXECUTION_POLICY, resolveDshExecutionPolicy } from "./execution-policy";

describe("DSH server-owned execution protection", () => {
  it("has bounded independent defaults without changing the original Harness", () => {
    expect(resolveDshExecutionPolicy()).toEqual({ maxToolCalls: 24, totalExecutionTimeoutMs: 180_000, toolCallTimeoutMs: 35_000 });
    expect(DEFAULT_HARNESS_LIMITS.maxToolCalls).toBe(6);
    expect(DEFAULT_HARNESS_LIMITS.totalExecutionTimeoutMs).toBe(90_000);
    expect(Object.isFrozen(DEFAULT_DSH_EXECUTION_POLICY)).toBe(true);
  });

  it("allows trusted tightening and ignores legacy Harness deployment knobs", () => {
    expect(resolveDshExecutionPolicy({ maxToolCalls: 8, totalExecutionTimeoutMs: 60_000, toolCallTimeoutMs: 10_000 }))
      .toEqual({ maxToolCalls: 8, totalExecutionTimeoutMs: 60_000, toolCallTimeoutMs: 10_000 });
    expect(configuredDshExecutionPolicy({ HARNESS_MAX_TOOL_CALLS: "1", HARNESS_TOTAL_EXECUTION_TIMEOUT_MS: "2000" }))
      .toEqual(DEFAULT_DSH_EXECUTION_POLICY);
    expect(configuredDshExecutionPolicy({ DSH_MAX_TOOL_CALLS: "12", DSH_TOTAL_EXECUTION_TIMEOUT_MS: "120000", DSH_TOOL_CALL_TIMEOUT_MS: "15000" }))
      .toEqual({ maxToolCalls: 12, totalExecutionTimeoutMs: 120_000, toolCallTimeoutMs: 15_000 });
  });

  it.each([0, -1, 1.5, NaN, Infinity, 25, Number.MAX_SAFE_INTEGER])("rejects invalid or elevated trusted tool count %s", maxToolCalls => {
    expect(() => resolveDshExecutionPolicy({ maxToolCalls })).toThrow("DSH 执行保护配置无效");
  });

  it.each([0, -1, 1.5, NaN, Infinity, 180_001])("rejects invalid or elevated total timeout %s", totalExecutionTimeoutMs => {
    expect(() => resolveDshExecutionPolicy({ totalExecutionTimeoutMs })).toThrow("DSH 执行保护配置无效");
  });

  it.each([0, -1, 1.5, NaN, Infinity, 35_001])("rejects invalid or elevated tool timeout %s", toolCallTimeoutMs => {
    expect(() => resolveDshExecutionPolicy({ toolCallTimeoutMs })).toThrow("DSH 执行保护配置无效");
  });

  it.each(["", "0", "-1", "1.5", "Infinity", "null", "25", " 12", "12x", "1e1"])("rejects malformed deployment configuration %s", value => {
    expect(() => configuredDshExecutionPolicy({ DSH_MAX_TOOL_CALLS: value })).toThrow("DSH 执行保护配置无效");
  });
});
