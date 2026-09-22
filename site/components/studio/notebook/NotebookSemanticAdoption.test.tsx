import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import type { NotebookArtifact } from "@/core/notebook/definition";
import type { SemanticModel } from "@/core/semantic/contracts";
import { NotebookPanel } from "./NotebookPanel";

const { model, source } = semanticFixture();
const draft: NotebookArtifact = { id: "draft_semantic", version: 1, status: "draft", name: "旧语义草稿", baseRevision: 0,
  cells: [
    { id: "data", kind: "data", title: "原始数据", sourceDataSourceId: source.id, outputName: "raw" },
    { id: "query", kind: "semanticQuery", title: "销售汇总", inputCellId: "data", modelId: model.id, modelVersion: 1,
      dimensions: ["area"], measures: ["revenue"], limit: 10, outputName: "totals" },
  ], executionOrder: ["data", "query"], lineage: [{ cellId: "data", dependsOn: [] }, { cellId: "query", dependsOn: ["data"] }],
  sourceDataSourceIds: [source.id], createdAt: "2026-09-21T00:00:00.000Z",
  executionEvidence: { runId: "synthetic_trial", status: "success", completedCellIds: ["data", "query"], summary: "合成历史试运行回执" },
};
function review(models: SemanticModel[]) {
  return renderToStaticMarkup(<NotebookPanel document={{ name: "空文档", revision: 0, cells: [] }} pageId="page_home"
    sources={[source]} models={models} draft={draft} canEdit externalBusy={false} hidden={false} instruction=""
    onInstructionChange={() => {}} onBrowseData={() => {}} onChange={() => {}} onImport={() => {}}
    onAskAi={() => {}} onSnapshot={() => {}} onInteractionChange={() => {}} />);
}
describe("Notebook deleted-model draft display", () => {
  it("shows a missing-model reason and disables adoption despite an old successful receipt", () => {
    const html = review([]);
    expect(html).toContain("已通过数据试运行");
    expect(html).toContain("草稿引用的语义模型已删除或不在当前工作界面");
    expect(html).toContain("现有 Notebook 未改动");
    expect(html).toMatch(/class="notebook-primary" disabled="">采用草稿/);
    expect(html).toContain("暂不采用");
  });
  it("allows adoption when the same model is present and distinguishes same-name replacements", () => {
    const valid = review([model]);
    expect(valid).not.toContain("草稿引用的语义模型已删除");
    expect(valid).toContain('class="notebook-primary">采用草稿');
    expect(review([{ ...model, id: "replacement_id" }])).toMatch(/class="notebook-primary" disabled="">采用草稿/);
  });
});
