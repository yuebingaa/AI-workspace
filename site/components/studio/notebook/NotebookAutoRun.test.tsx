import { renderToStaticMarkup } from "react-dom/server";
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
  it("renders a keyboard-accessible unchecked opt-in and explicitly promises no execution on enabling", () => {
    const html = renderToStaticMarkup(<NotebookPanel {...props} />);
    expect(html).toContain('type="checkbox" aria-label="参数自动重算"');
    expect(html).not.toContain('checked=""');
    expect(html).toContain("开启本身不会执行分析");
    expect(html).toContain('aria-label="参数重算设置"');
  });
  it.each([{ canEdit: false }, { externalBusy: true }, { hidden: true }])("does not allow opt-in when unavailable: %j", (changes) => {
    const html = renderToStaticMarkup(<NotebookPanel {...props} {...changes} />);
    expect(html).toMatch(/type="checkbox" aria-label="参数自动重算" disabled=""/u);
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
