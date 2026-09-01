import { describe, expect, it } from "vitest";
import { normalizeHarnessModelTurn } from "./action-normalizer";
import {
  redactedCompleteActionFailureDescription,
  redactedCompleteActionFailureFixture,
} from "./fixtures/redacted-complete-action";

const readonlyComplete = { readonlyTask: true, readonlyResultComplete: true } as const;

describe("Harness 动作协议标准化", () => {
  it("可安全标准化真实失败类别的脱敏回归 fixture", () => {
    const result = normalizeHarnessModelTurn(redactedCompleteActionFailureFixture, readonlyComplete);

    expect(result.turn).toEqual({
      type: "complete",
      message: "数据集检查完成，已返回行列数和字段摘要。",
    });
    expect(result.normalizedFrom).toBe("completedAlias");
    expect(redactedCompleteActionFailureDescription.fieldNames).toEqual(["message", "action", "action.type"]);
    expect(redactedCompleteActionFailureDescription.schemaIssues).toEqual(expect.arrayContaining([
      expect.stringContaining("type"),
    ]));
  });

  it("接受规范 complete，completed 别名仅在只读结果已满足时标准化", () => {
    expect(normalizeHarnessModelTurn({ type: "complete", message: "检查完成。" }, readonlyComplete))
      .toEqual({ turn: { type: "complete", message: "检查完成。" }, normalized: false });
    expect(normalizeHarnessModelTurn({ type: "completed", message: "检查完成。" }, readonlyComplete).turn)
      .toEqual({ type: "complete", message: "检查完成。" });
    expect(() => normalizeHarnessModelTurn(
      { type: "completed", message: "检查完成。" },
      { readonlyTask: true, readonlyResultComplete: false },
    )).toThrow("Schema 校验");
  });

  it("拒绝缺少 message 的 complete", () => {
    expect(() => normalizeHarnessModelTurn({ type: "complete" }, readonlyComplete))
      .toThrow("Schema 校验");
  });

  it("不猜测或补全非法 callTool", () => {
    const illegal = {
      message: "调用某工具",
      action: { type: "tool", name: "inspectDataset" },
    };
    expect(() => normalizeHarnessModelTurn(illegal, readonlyComplete)).toThrow("Schema 校验");
  });

  it("写操作不能通过纯文本总结绕过 ChangeSet", () => {
    expect(() => normalizeHarnessModelTurn(
      { message: "已修改页面。" },
      { readonlyTask: false, readonlyResultComplete: true },
    )).toThrow("Schema 校验");
  });

  it("错误只包含动作形状和 Schema 路径，不包含字段值", () => {
    const secretValue = "sensitive-model-value";
    expect(() => normalizeHarnessModelTurn(
      { type: "complete", message: "", extra: secretValue },
      readonlyComplete,
    )).toThrowError(expect.objectContaining({
      message: expect.not.stringContaining(secretValue),
    }));
  });
});
