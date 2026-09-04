import { describe, expect, it } from "vitest";
import { isLightweightConversation, lightweightConversationReply } from "./conversation";

describe("lightweight Harness conversation", () => {
  it.each(["额", "嗯……", "好的", "谢谢你！", "你好", "hi"])("handles %s without starting a task", (instruction) => {
    expect(isLightweightConversation(instruction)).toBe(true);
  });

  it.each(["分析一下数据", "详细一点", "为什么夜班异常更多", "修改页面标题"])("keeps %s on the Harness path", (instruction) => {
    expect(isLightweightConversation(instruction)).toBe(false);
  });

  it("offers relevant next questions when EDS context is available", () => {
    const reply = lightweightConversationReply("额", true);

    expect(reply).toContain("EDS 汇总已经就绪");
    expect(reply).toContain("为什么夜班异常更多");
    expect(reply).not.toContain("goalSummary");
  });

  it("responds naturally to greetings and thanks", () => {
    expect(lightweightConversationReply("你好", false)).toMatch(/^你好，我在。/u);
    expect(lightweightConversationReply("谢谢", false)).toMatch(/^不客气。/u);
  });
});
