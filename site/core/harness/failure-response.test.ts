import { describe, expect, it } from "vitest";
import { failureResponse, acceptableFailureExplanation } from "./failure-response";
import { createHarnessTask } from "./task-state";

describe("failure explanations", () => {
  const task = createHarnessTask("failure_test", "分析销售", "page_home", "editor", { now: () => new Date(), id: () => "event" });
  it("does not disclose raw errors or classify a timeout as missing capability", () => {
    const text = failureResponse({ ...task, state: "failed", error: "网络超时 C:\\private\\secret.txt Bearer private-token" });
    expect(text).toContain("不代表你的分析目标无法完成");
    expect(text).not.toContain("private");
  });
  it("offers actionable local explanations for unavailable credentials and missing fields", () => {
    expect(failureResponse({ ...task, state: "failed", error: "AI 服务尚未配置" })).toContain("API 设置");
    expect(failureResponse({ ...task, state: "blocked", terminationCode: "missingDataFields" })).toContain("字段");
    expect(failureResponse({ ...task, state: "failed", error: "DeepSeek API Key 无效。" })).toContain("重新验证密钥");
    expect(failureResponse({ ...task, state: "failed", error: "Failed to fetch" })).toContain("检查网络后重试");
    expect(failureResponse({ ...task, state: "failed", error: "无法连接 Harness 服务。" })).toContain("检查网络后重试");
  });
  it("does not turn format errors into missing data or exhausted quota", () => {
    expect(failureResponse({ ...task, state: "failed", error: "字段类型不合法" })).not.toContain("缺少这项分析需要的字段");
    expect(failureResponse({ ...task, state: "failed", error: "DeepSeek 未返回可信的 token 用量" })).not.toContain("已经达到处理限额");
  });
  it("rejects tool-success claims and secret-bearing model narration", () => {
    expect(acceptableFailureExplanation("暂时无法完成统计，你可以缩小分析范围后再试。")).toBe(true);
    expect(acceptableFailureExplanation("暂时不能展示，但是分析已完成且已经保存结果。")).toBe(false);
    expect(acceptableFailureExplanation("暂时无法完成，请使用 Bearer secret-token 再试。")).toBe(false);
  });
});
