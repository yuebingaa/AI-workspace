// @vitest-environment happy-dom
import { markupRoot } from "@/test-support/markup";
import { renderToStaticMarkup } from "@/test-support/render-themed";
import { describe, expect, it } from "vitest";
import type { ComponentProps } from "react";
import { NotebookPanel } from "./NotebookPanel";
import { NotebookParameterSummary } from "./NotebookParameterEditor";

const props: ComponentProps<typeof NotebookPanel> = {
  document: { name: "Synthetic notebook", revision: 0, cells: [] }, pageId: "page", sources: [], models: [],
  canEdit: true, externalBusy: false, hidden: false, instruction: "",
  onInstructionChange: () => {}, onBrowseData: () => {}, onChange: () => {}, onImport: () => {}, onAskAi: () => {},
  onSnapshot: () => {}, onInteractionChange: () => {},
};
describe("Notebook parameter auto-run controls", () => {
  it("keeps AI preview execution separate from parameter auto-run and preserves confirmation", () => {
    const html = renderToStaticMarkup(<NotebookPanel {...props} aiAutoRunEnabled onAiAutoRunChange={() => { throw Error("must not change during render"); }} />);
    expect(markupRoot(html).querySelector('[aria-label="AI 分析后自动运行 Notebook"]')?.getAttribute("aria-checked")).toBe("true");
    expect(html).toContain("确认后才保存步骤");
    expect(html).toContain("历史记录不会自动运行");
    expect(markupRoot(html).querySelector('[aria-label="参数自动重算"]')?.getAttribute("aria-checked")).toBe("false");
  });
  it.each([{ canEdit: false }, { externalBusy: true }, { hidden: true }])("protects AI preview controls when unavailable: %j", (changes) => {
    const html = renderToStaticMarkup(<NotebookPanel {...props} {...changes} aiAutoRunEnabled onAiAutoRunChange={() => {}} />);
    const checkbox = markupRoot(html).querySelector('[aria-label="AI 分析后自动运行 Notebook"]');
    expect(checkbox?.hasAttribute("disabled")).toBe(true);
    expect(checkbox?.getAttribute("aria-checked")).toBe("true");
  });
  it("explains the disabled manual fallback without enabling execution in render", () => {
    const html = renderToStaticMarkup(<NotebookPanel {...props} aiAutoRunEnabled={false} onAiAutoRunChange={() => {}} />);
    expect(html).toContain("已关闭；新草稿由你手动采用和运行");
    expect(markupRoot(html).querySelectorAll('[role="checkbox"][aria-checked="true"]')).toHaveLength(0);
  });
  it("renders a keyboard-accessible unchecked opt-in and explicitly promises no execution on enabling", () => {
    const html = renderToStaticMarkup(<NotebookPanel {...props} />);
    expect(markupRoot(html).querySelector('[aria-label="参数自动重算"]')?.getAttribute("role")).toBe("checkbox");
    expect(markupRoot(html).querySelectorAll('[role="checkbox"][aria-checked="true"]')).toHaveLength(0);
    expect(html).toContain("开启本身不会执行分析");
    expect(html).toContain('aria-label="参数重算设置"');
  });
  it.each([{ canEdit: false }, { externalBusy: true }, { hidden: true }])("does not allow opt-in when unavailable: %j", (changes) => {
    const html = renderToStaticMarkup(<NotebookPanel {...props} {...changes} />);
    expect(markupRoot(html).querySelector('[aria-label="参数自动重算"]')?.hasAttribute("disabled")).toBe(true);
  });
  it("keeps manual mode explicit for the ordinary parameter summary", () => {
    const html = renderToStaticMarkup(<NotebookParameterSummary parameter={{ type: "number", value: 0 }} />);
    expect(html).toContain("保存后需手动运行");
    expect(html).not.toContain("保存值变更后自动");
  });
  it("uses the actual window setting for the enabled parameter summary", () => {
    const html = renderToStaticMarkup(<NotebookParameterSummary parameter={{ type: "number", value: 0 }} automatic />);
    expect(html).toContain("仅保存值变更后自动重算相关步骤");
    expect(html).not.toContain("保存后需手动运行");
  });
});
