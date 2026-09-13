import { describe, expect, it } from "vitest";
import {
  isDataIndependentUiStyleMutation,
  isLightweightConversation,
  isUiMutationCapabilityQuestion,
  lightweightConversationReply,
  uiMutationCapabilityReply,
} from "./conversation";

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

  it.each(["可以增加组件吗", "能不能修改图表？", "你能控制这个网页的组件了吗？", "这个网站支持添加指标卡吗", "能改字体吗", "能改什么字体", "支持哪些字体"])(
    "recognizes %s as a UI capability question",
    (instruction) => {
      expect(isUiMutationCapabilityQuestion(instruction)).toBe(true);
    },
  );

  it.each(["增加一个组件", "请增加一个组件", "可以帮我增加一个组件吗", "分析一下数据"])(
    "keeps %s out of the local capability reply path",
    (instruction) => {
      expect(isUiMutationCapabilityQuestion(instruction)).toBe(false);
    },
  );

  it.each([
    "把本月收入标题字体改成微软雅黑，字号 24，颜色改成蓝色并加粗",
    "将表格标题设为宋体并加下划线",
  ])("recognizes %s as a data-independent typography change", (instruction) => {
    expect(isDataIndependentUiStyleMutation(instruction)).toBe(true);
  });

  it.each([
    "能改什么字体",
    "根据销售额高低改变文字颜色",
    "分析一下数据",
  ])("does not treat %s as a data-independent typography change", (instruction) => {
    expect(isDataIndependentUiStyleMutation(instruction)).toBe(false);
  });

  it("answers capability questions with the actual preview boundary", () => {
    const reply = uiMutationCapabilityReply(true);

    expect(reply).toContain("可以");
    expect(reply).toContain("待确认预览");
    expect(reply).toContain("字体");
    expect(reply).toContain("微软雅黑");
    expect(reply).toContain("8–72 px");
    expect(reply).toContain("不会直接修改正式页面");
  });
});
