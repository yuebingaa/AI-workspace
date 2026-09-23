import { describe, expect, it, vi } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { harnessRequestSchema } from "../contracts";
import type { NotebookCell } from "@/core/notebook/definition";
import { createNotebookToolBridge, type NotebookToolBridgeOptions } from "./notebook-tool-bridge";

const query: Extract<NotebookCell, { kind: "semanticQuery" }> = {
  id: "semantic", kind: "semanticQuery", title: "地区收入", inputCellId: "data", modelId: "sales_model", modelVersion: 1,
  dimensions: ["area"], measures: ["revenue"], limit: 10, outputName: "semantic_sales",
};
function fixture(existing = false) {
  const { product, source, rows, model } = semanticFixture();
  const request = harnessRequestSchema.parse({ idempotencyKey: "semantic_bridge_test", role: "editor", pageId: "page_home",
    instruction: "使用当前语义模型新增地区收入表", appSpec: product.appSpec, recipes: [], dataSourceId: source.id, semanticModel: model,
    notebookContext: { sourceIds: [source.id], document: { name: "单表语义分析", revision: 3, cells: [
      { id: "data", kind: "data", title: "销售数据", sourceDataSourceId: source.id, outputName: "sales_data" },
      ...(existing ? [query] : []),
    ] } } });
  const runner = vi.fn<NotebookToolBridgeOptions["notebookRunner"]>(async () => { throw new Error("No execution in bridge validation tests"); });
  const options: NotebookToolBridgeOptions = { profile: "notebook", request, dataRuntime: { rowsByDataSourceId: { [source.id]: rows } },
    notebookRunner: runner, authorizeCurrentAccess: vi.fn() };
  return { options, runner };
}

describe("single selected semantic model in the website Notebook bridge", () => {
  it.each([false, true])("selected model exposes canonical query only; existing=%s", async existing => {
    const { options, runner } = fixture(existing), before = structuredClone(options.request);
    const bridge = createNotebookToolBridge(options);
    try {
      const catalog = bridge.catalog();
      expect(catalog.map(tool => tool.name)).toEqual(["cellSearch", "editNotebookCells", "runNotebookCells", "submitNotebookDraft"]);
      const edit = catalog.find(tool => tool.name === "editNotebookCells")!;
      expect(JSON.stringify(edit.parameters)).toContain('"const":"semanticQuery"');
      expect(JSON.stringify(edit.parameters)).toContain('"const":"parameter"');
      expect(JSON.stringify(edit.parameters)).toContain('"const":"text"');
      expect(edit.description).toContain("成员 key");
      expect(edit.description).toContain("不能修改模型");
      expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 0, totalCells: existing ? 2 : 1 });
      await bridge.execute("editNotebookCells", { editVersion: 0, cells: [query] });
      expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 1, totalCells: 2 });
      await expect(bridge.execute("submitNotebookDraft", { editVersion: 1 })).rejects.toThrow("尚未完整试运行通过");
      expect(bridge.getVerifiedDraft()).toBeUndefined();
      expect(options.request).toEqual(before); expect(runner).not.toHaveBeenCalled();
    } finally { bridge.close(); }
  });

  it("unselected website and historical CSV profile do not acquire semantic capability", async () => {
    const { options } = fixture(); delete options.request.semanticModel;
    const bridge = createNotebookToolBridge(options);
    try {
      expect(JSON.stringify(bridge.catalog())).not.toContain('"const":"semanticQuery"');
      await expect(bridge.execute("editNotebookCells", { editVersion: 0, cells: [query] })).rejects.toThrow();
    } finally { bridge.close(); }
    const old = fixture().options; old.profile = "csv";
    expect(() => createNotebookToolBridge(old)).toThrow(expect.objectContaining({ code: "unsupported_task_context" }));
  });

  it.each(["missing", "id", "version", "source", "field", "aggregation", "not-selected-source", "member", "non-data"])(
    "rejects invalid existing semantic scope before any tool/model: %s", variant => {
      const { options, runner } = fixture(true), request = options.request, model = request.semanticModel!;
      const cell = request.notebookContext!.document.cells[1];
      if (cell.kind !== "semanticQuery") throw new Error("Invalid test fixture");
      if (variant === "missing") delete request.semanticModel;
      if (variant === "id") cell.modelId = "another_model";
      if (variant === "version") cell.modelVersion++;
      if (variant === "source") model.sourceDatasetId = "another_source";
      if (variant === "field") model.measures[0].field = "missing_field";
      if (variant === "aggregation") model.measures[0].field = "region";
      if (variant === "not-selected-source") delete request.dataSourceId;
      if (variant === "member") cell.measures = ["not_a_metric"];
      if (variant === "non-data") {
        request.notebookContext!.document.cells.push({ id: "sql", kind: "sql", title: "SQL", inputCellIds: ["data"], outputName: "other", sql: "SELECT * FROM sales_data" });
        cell.inputCellId = "sql";
      }
      expect(() => createNotebookToolBridge(options)).toThrow(expect.objectContaining({ code: "semantic_model_unavailable" }));
      expect(runner).not.toHaveBeenCalled();
    },
  );

  it.each(["id", "version", "member", "non-data", "sql-injection", "aggregation"])("bad edit %s preserves draft/version", async variant => {
    const { options, runner } = fixture(), bridge = createNotebookToolBridge(options);
    const invalid = structuredClone(query);
    if (variant === "id") invalid.modelId = "other_model";
    if (variant === "version") invalid.modelVersion++;
    if (variant === "member") invalid.measures = ["amount"];
    if (variant === "non-data") invalid.inputCellId = "derived";
    if (variant === "sql-injection") Object.assign(invalid, { sql: "SELECT private FROM outside" });
    if (variant === "aggregation") Object.assign(invalid, { aggregation: "max" });
    try {
      await expect(bridge.execute("editNotebookCells", { editVersion: 0, cells: [invalid] })).rejects.toThrow();
      expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 0, totalCells: 1 });
      expect(runner).not.toHaveBeenCalled(); expect(bridge.getVerifiedDraft()).toBeUndefined();
    } finally { bridge.close(); }
  });

  it("takes one immutable validated model snapshot, not live caller-owned definitions", async () => {
    const { options } = fixture(), bridge = createNotebookToolBridge(options);
    try {
      options.request.semanticModel!.measures[0].key = "changed";
      options.request.semanticModel!.version++;
      await bridge.execute("editNotebookCells", { editVersion: 0, cells: [query] });
      expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 1, totalCells: 2 });
    } finally { bridge.close(); }
  });

  it("does not prevent inspecting and repairing unrelated SQL or chart definitions", async () => {
    const { options, runner } = fixture(true);
    options.request.notebookContext!.document.cells.push(
      { id: "broken_sql", kind: "sql", title: "待修SQL", inputCellIds: ["data"], outputName: "broken", sql: "DELETE FROM sales_data" },
      { id: "broken_chart", kind: "chart", title: "待修图", inputCellId: "semantic", chartType: "bar", categoryField: "not_defined", valueFields: ["revenue"] },
    );
    const before = structuredClone(options.request), bridge = createNotebookToolBridge(options);
    try {
      expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 0, totalCells: 4 });
      // Existing SQL guards still reject execution; this initialization change
      // must leave the model a chance to fix the definitions before running.
      await expect(bridge.execute("runNotebookCells", { editVersion: 0 })).rejects.toThrow();
      expect(runner).not.toHaveBeenCalled();
      await bridge.execute("editNotebookCells", { editVersion: 0, cells: [
        { id: "broken_sql", kind: "sql", title: "已修SQL", inputCellIds: ["data"], outputName: "broken", sql: "SELECT * FROM sales_data" },
        { id: "broken_chart", kind: "chart", title: "已修图", inputCellId: "semantic", chartType: "bar", categoryField: "area", valueFields: ["revenue"] },
      ] });
      expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 1, totalCells: 4 });
      expect(options.request).toEqual(before);
    } finally { bridge.close(); }
  });
});
