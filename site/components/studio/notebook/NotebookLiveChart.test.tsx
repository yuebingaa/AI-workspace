// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "@/test-support/render-themed";
import { markupRoot } from "@/test-support/markup";
import { NotebookLivePreview } from "./NotebookLivePreview";
import type { NotebookLiveState } from "@/core/notebook/live-state";

it("AI live chart retains the expanded editor, read-only and without adopting or executing", () => {
  const document = { name: "模拟 AI 图表", revision: 0, cells: [
    { id: "data", kind: "data" as const, title: "模拟数据", sourceDataSourceId: "synthetic", outputName: "sales" },
    { id: "chart", kind: "chart" as const, title: "AI 图表", inputCellId: "data", chartType: "bar" as const, categoryField: "x", valueFields: ["y"] },
  ] };
  const live: NotebookLiveState = { scopeKey: "scope", taskId: "task", sequence: 1, baseline: document, document,
    editVersion: 1, phase: "working", statuses: { data: "queued", chart: "pending" }, results: {} };
  const before = JSON.stringify(live);
  const root = markupRoot(renderToStaticMarkup(<NotebookLivePreview live={live} onShowFormal={() => { throw Error("must not fire"); }} />));
  expect(root.querySelector('[data-cell-id="chart"] .notebook-inline-chart-workspace')?.getAttribute("data-layout")).toBe("data-style");
  expect(root.querySelector<HTMLFieldSetElement>('[data-cell-id="chart"] fieldset')?.disabled).toBe(true);
  expect(root.textContent).toContain("等待上游数据");
  expect(JSON.stringify(live)).toBe(before);
});
