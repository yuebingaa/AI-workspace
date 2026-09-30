// @vitest-environment happy-dom
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "@/test-support/render-themed";
import { markupRoot } from "@/test-support/markup";
import { NotebookPanel } from "./NotebookPanel";

const props: ComponentProps<typeof NotebookPanel> = {
  document: { name: "合成入口验收", revision: 0, cells: [
    { id: "data", kind: "data", title: "输入", sourceDataSourceId: "synthetic", outputName: "sales" },
    { id: "chart", kind: "chart", title: "地区销售", inputCellId: "data", chartType: "bar", categoryField: "region", valueFields: ["amount"] },
    { id: "table", kind: "table", title: "销售明细", inputCellId: "data", columns: ["region", "amount"] },
  ] }, pageId: "page", sources: [], models: [], canEdit: true, externalBusy: false, hidden: false, instruction: "",
  onInstructionChange() {}, onBrowseData() {}, onChange() {}, onImport() {}, onAskAi() {}, onSnapshot() {}, onInteractionChange() {},
};

describe("Notebook chart editor entry", () => {
  it.each([{ canEdit: true, externalBusy: false, disabled: false }, { canEdit: false, externalBusy: false, disabled: true },
    { canEdit: true, externalBusy: true, disabled: true }])("names the entry clearly and preserves edit locks: %j", ({ disabled, ...flags }) => {
    const root = markupRoot(renderToStaticMarkup(<NotebookPanel {...props} {...flags} />));
    const button = root.querySelector<HTMLButtonElement>('[data-cell-id="chart"] .notebook-chart-edit');
    expect(button?.textContent).toBe("定位配置");
    expect(button?.disabled).toBe(disabled);
    expect(button?.title).toContain("本单元内");
    expect(root.querySelector('[data-cell-id="table"] .notebook-chart-edit')).toBeNull();
    expect(props.document.cells[1]).not.toHaveProperty("graphicWalker");
    const workspace = root.querySelector('[data-cell-id="chart"] .notebook-inline-chart-workspace');
    expect(workspace?.getAttribute("data-layout")).toBe("data-style");
    expect(workspace?.textContent).toContain("Data / Style 布局");
    expect(workspace?.textContent).toContain("官方原生布局");
    expect(workspace?.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(disabled);
    expect(workspace?.textContent).toContain("等待上游数据");
    expect(root.querySelector('[data-cell-id="table"] .notebook-inline-chart-workspace')).toBeNull();
  });
});
