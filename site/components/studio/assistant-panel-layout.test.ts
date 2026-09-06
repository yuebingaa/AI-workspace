import { describe, expect, it } from "vitest";
import {
  clampAssistantPanelWidth,
  getAssistantPanelWidthBounds,
} from "./assistant-panel-layout";

describe("assistant panel layout", () => {
  it("为宽屏画布保留可用空间，并在展开页面侧栏后收紧最大宽度", () => {
    expect(getAssistantPanelWidthBounds(1440, false)).toEqual({ minimum: 300, maximum: 720 });
    expect(getAssistantPanelWidthBounds(1440, true)).toEqual({ minimum: 300, maximum: 630 });
    expect(getAssistantPanelWidthBounds(1000, false)).toEqual({ minimum: 300, maximum: 588 });
    expect(getAssistantPanelWidthBounds(1000, true)).toEqual({ minimum: 300, maximum: 430 });
  });

  it("窄屏抽屉最多只占视口减去安全露出区域", () => {
    expect(getAssistantPanelWidthBounds(815, false)).toEqual({ minimum: 300, maximum: 771 });
    expect(getAssistantPanelWidthBounds(320, false)).toEqual({ minimum: 276, maximum: 276 });
  });

  it("把拖拽结果限制在当前布局允许的范围内", () => {
    expect(clampAssistantPanelWidth(200, 1440, false)).toBe(300);
    expect(clampAssistantPanelWidth(900, 1440, true)).toBe(630);
    expect(clampAssistantPanelWidth(437.6, 1000, false)).toBe(438);
  });
});
