import { describe, expect, it } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import type { NotebookDocument } from "./contracts";
import { runNotebook } from "./server/runtime";
import { createHarnessNotebookArtifact } from "@/core/harness/notebook";
import { executeHarnessTool } from "@/core/harness/tool-registry";
import type { HarnessRequest } from "@/core/harness/contracts";
import { adoptNotebookDraft } from "./client-state";
import { DeepSeekHarness } from "@/core/harness/deepseek-harness";

function fixture() {
  const { source, rows, product } = semanticFixture();
  const document: NotebookDocument = { name: "SQL 配方分析", revision: 2, cells: [
    { id: "data", kind: "data", title: "数据", sourceDataSourceId: source.id, outputName: "sales" },
    { id: "sql", kind: "sql", title: "SQL", inputCellIds: ["data"], outputName: "raw", sql: "SELECT region, amount FROM sales" },
    { id: "recipe", kind: "transform", title: "销售配方", inputCellId: "sql", outputName: "totals", steps: [
      { id: "double", type: "deriveField", field: "doubled", label: "双倍", operator: "multiply", left: { kind: "field", field: "amount" }, right: { kind: "literal", value: 2 } },
      { id: "aggregate", type: "groupAggregate", groupBy: ["region"], aggregations: [{ field: "doubled", aggregation: "sum", as: "revenue", label: "销售额" }] },
    ] },
    { id: "chart", kind: "chart", title: "图表", inputCellId: "recipe", chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
    { id: "downstream", kind: "sql", title: "继续查询配方", inputCellIds: ["recipe"], outputName: "summary", sql: "SELECT SUM(revenue) AS revenue FROM totals" },
  ] };
  const request: HarnessRequest = { idempotencyKey: "notebook_transform_test", instruction: "Notebook SQL 配方图表分析", pageId: "page_home", role: "editor", appSpec: product.appSpec, recipes: [], notebookContext: { document, sourceIds: [source.id] } };
  return { document, request, sources: [{ source, rows }], source, rows };
}
describe("shared Notebook / Agent transformation runtime", () => {
  it("runs a complete Agent connection → plan → recipe / chart draft under the existing model input budget", async () => {
    const { request, source, rows } = fixture();
    request.instruction = "请从 PostgreSQL 数据库分析地区销售并生成 Notebook 配方和图表";
    request.notebookContext = { document: { name: "外部数据库", revision: 0, cells: [] }, sourceIds: [], connections: [{ id: "warehouse", name: "Sales", kind: "postgresql", allowAi: true }] };
    const cells = [
      { id: "remote", kind: "warehouseSql" as const, title: "销售", connectionId: "warehouse", outputName: "raw", sql: "SELECT region, amount FROM public.sales" },
      { id: "recipe", kind: "transform" as const, title: "汇总", inputCellId: "remote", outputName: "totals", steps: [{ id: "sum", type: "groupAggregate" as const, groupBy: ["region"], aggregations: [{ field: "amount", aggregation: "sum" as const, as: "revenue", label: "销售额" }] }] },
      { id: "chart", kind: "chart" as const, title: "销售额", inputCellId: "recipe", chartType: "bar" as const, categoryField: "region", valueFields: ["revenue"] },
    ];
    const task = await new DeepSeekHarness().run(request, { dataRuntime: { rowsByDataSourceId: {} },
      connectionInspector: async () => ({ columns: [{ table_schema: "public", table_name: "sales", column_name: "region", data_type: "text" }, { table_schema: "public", table_name: "sales", column_name: "amount", data_type: "integer" }], truncated: false }),
      notebookRunner: (artifact) => runNotebook({ document: { name: artifact.name, revision: 0, cells: artifact.cells }, sources: [], forAi: true,
        connectionQuery: async () => ({ fields: source.fields.map(({ name, label, type }) => ({ name, label, type })), rows, truncated: false }),
      }),
      modelClient: { next: async ({ iteration, context }) => ({ model: "scripted-remote-protocol-test", usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40 },
        turn: iteration === 1 ? { type: "callTool", name: "inspectConnectionSchema", toolCallId: "schema", message: "查看字段", arguments: { connectionId: "warehouse", offset: 0 } }
          : iteration === 2 ? { type: "callTool", name: "createAnalysisPlan", toolCallId: "plan", message: "规划分析", arguments: { name: "销售分析", objective: "汇总地区销售", questions: ["各地区销售额是多少"], deliverables: ["chart"], steps: [
            { id: "remote", kind: "warehouseSql", title: "销售", objective: "读数据库", dependsOn: [], connectionId: "warehouse", transformation: "读取 region 和 amount" },
            { id: "recipe", kind: "transform", title: "汇总", objective: "地区汇总", dependsOn: ["remote"], transformation: "按 region 汇总 amount 为 revenue" },
            { id: "chart", kind: "chart", title: "销售额", objective: "展示地区销售", dependsOn: ["recipe"], chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
          ] } }
          : { type: "callTool", name: "createNotebookDraft", toolCallId: "draft", message: "执行并生成草稿", arguments: { name: "销售分析", cells, analysisPlanId: (context.latestObservation as { result: { analysisPlanArtifactId: string } }).result.analysisPlanArtifactId } },
      }) },
    });
    expect(task.state, task.error).toBe("awaitingConfirmation");
    expect(task.notebookArtifact?.executionEvidence?.status).toBe("success");
    expect(task.notebookArtifact?.cells).toEqual(cells);
    expect(task.notebookArtifact?.connectionIds).toEqual(["warehouse"]);
  });
  it("runs real SQL → recipe → chart and SQL without saving a Dataset", async () => {
    const { document, sources } = fixture();
    const run = await runNotebook({ document, sources, log: () => {} });
    expect(run.status).toBe("success");
    expect(run.cells[2].table?.rows).toContainEqual({ region: "华东", revenue: 300 });
    expect(run.cells[3].table).toEqual(run.cells[2].table);
    expect(run.cells[3].resultRef?.inputResultIds).toEqual([run.cells[2].resultRef?.resultId]);
    expect(run.cells[2].resultRef).toMatchObject({ runId: run.runId, revision: 2, accessMode: "user", complete: true });
    const second = await runNotebook({ document, sources, log: () => {} });
    expect(second.cells[2].resultRef?.resultId).not.toBe(run.cells[2].resultRef?.resultId);
    expect(second.cells[2].resultRef?.dataSignature).toBe(run.cells[2].resultRef?.dataSignature);
  }, 20_000);
  it("requires real recipe execution evidence and lets Agent emit the same editable cells", async () => {
    const { document, request, source, rows, sources } = fixture();
    const draft = { name: document.name, cells: document.cells };
    const context = { request, dataRuntime: { rowsByDataSourceId: { [source.id]: rows } }, now: Date.now, id: () => "transform" };
    await expect(executeHarnessTool("createNotebookDraft", draft, context)).rejects.toThrow("运行时未配置");
    const result = await executeHarnessTool("createNotebookDraft", draft, { ...context,
      notebookRunner: (artifact) => runNotebook({ document: { ...document, cells: artifact.cells }, sources, forAi: true, log: () => {} }),
    });
    expect(result.notebookArtifact?.cells).toEqual(document.cells);
    expect(result.notebookArtifact?.executionEvidence?.status).toBe("success");
    expect(adoptNotebookDraft(document, result.notebookArtifact!).revision).toBe(3);
    expect(JSON.stringify(result.data)).toContain('"accessMode":"ai"');
  }, 20_000);
  it("rejects partial input and blocks descendants instead of aggregating previews", async () => {
    const { document, sources } = fixture();
    const run = await runNotebook({ document, sources, query: async () => ({ fields: [{ name: "amount", label: "amount", type: "number" }], rows: [{ amount: 1 }], truncated: true }), log: () => {} });
    expect(run.cells[2].status).toBe("failure");
    expect(run.cells[2].error).toContain("截断");
    expect(run.cells[2].resultRef).toBeUndefined();
    expect(run.cells[3].status).toBe("blocked");
  });
  it("applies recipes to full source rows while returning only a source preview", async () => {
    const { document, source } = fixture();
    const recipe = document.cells[2];
    if (recipe.kind !== "transform") throw new Error("fixture");
    const run = await runNotebook({ document: { ...document, cells: [document.cells[0], { ...recipe, inputCellId: "data" }] }, sources: [{ source, rows: Array.from({ length: 1200 }, () => ({ region: "East", amount: 1 })) }] });
    expect(run.cells[0].table?.rows).toHaveLength(100);
    expect(run.cells[0].resultRef).toMatchObject({ rowCount: 1200, complete: true });
    expect(run.cells[1].table?.rows).toEqual([{ region: "East", revenue: 2400 }]);
  });
  it("allows remote-only authorized drafts and denies undeclared connections", async () => {
    const { document, request } = fixture();
    const draft = { name: "数据库分析", cells: [{ id: "remote", title: "远端查询", kind: "warehouseSql" as const, connectionId: "warehouse", outputName: "remote", sql: "SELECT 1 AS amount" }] };
    const options = { request, allowedDataSourceIds: [], now: Date.now, id: () => "remote" };
    expect(() => createHarnessNotebookArtifact(draft, options)).toThrow("未授权");
    request.notebookContext!.connections = [{ id: "warehouse", name: "Test", kind: "postgresql", allowAi: true }];
    expect(createHarnessNotebookArtifact(draft, options)).toMatchObject({ sourceDataSourceIds: [], connectionIds: ["warehouse"] });
    const run = await runNotebook({ document: { ...document, cells: draft.cells }, sources: [] });
    expect(run.cells[0]).toMatchObject({ status: "failure", error: "数据库连接运行时未配置" });
  });
  it("discards late remote completion after cancellation", async () => {
    const controller = new AbortController();
    const run = await runNotebook({ document: { name: "cancel", revision: 0, cells: [{ id: "remote", title: "查询", kind: "warehouseSql", connectionId: "warehouse", outputName: "remote", sql: "SELECT 1 AS amount" }] }, sources: [], signal: controller.signal,
      connectionQuery: async () => { controller.abort(); return { fields: [{ name: "amount", label: "amount", type: "number" }], rows: [{ amount: 1 }], truncated: false }; },
    });
    expect(run.cells[0].status).toBe("failure"); expect(run.cells[0].table).toBeUndefined(); expect(run.cells[0].resultRef).toBeUndefined();
  });
});
