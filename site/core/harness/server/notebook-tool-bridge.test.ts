import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { runNotebook } from "@/core/notebook/server/runtime";
import { adoptNotebookDraft } from "@/core/notebook/client-state";
import type { NotebookCell } from "@/core/notebook/definition";
import type { NotebookRun } from "@/core/notebook/contracts";
import type { NotebookLiveProgress, NotebookProgressObserver } from "@/core/notebook/live-progress";
import { harnessRequestSchema } from "../contracts";
import { HarnessToolArgumentsError, harnessToolCatalog } from "../tool-registry";
import { createNotebookToolBridge, type NotebookToolBridgeOptions } from "./notebook-tool-bridge";
import { NotebookBridgePreflightError } from "./bridge-preflight";

afterEach(() => { vi.unstubAllGlobals(); });

const cells: NotebookCell[] = [
  { id: "totals", kind: "sql", title: "地区汇总", inputCellIds: ["data"], outputName: "region_totals",
    sql: "SELECT region, SUM(amount)::DOUBLE AS revenue FROM sales_data GROUP BY region ORDER BY region" },
  { id: "table", kind: "table", title: "地区表", inputCellId: "totals", columns: ["region", "revenue"] },
  { id: "chart", kind: "chart", title: "地区图", inputCellId: "totals", chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
];

async function fixture() {
  if (!demoFixtureResult.success) throw new Error("Synthetic app fixture unavailable");
  const parsed = await parseCsvUpload({ originalFileName: "bridge-sales.csv", mimeType: "text/csv",
    stream: new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("region,amount\nEast,100\nEast,50\nSouth,80\n")); controller.close();
    } }),
  });
  const source = parsed.dataset.source;
  const appSpec = structuredClone(demoFixtureResult.data.dataProduct.appSpec);
  appSpec.dataSources.push(source);
  const request = harnessRequestSchema.parse({ idempotencyKey: "bridge_synthetic_task", instruction: "添加 SQL 地区汇总、表格和图表单元。",
    role: "editor", pageId: "page_home", dataSourceId: source.id, appSpec, recipes: [],
    notebookContext: { sourceIds: [source.id], document: { name: "本地 CSV 工具桥", revision: 7,
      cells: [{ id: "data", kind: "data", title: "CSV 数据", sourceDataSourceId: source.id, outputName: "sales_data" }] } },
  });
  const authorizeCurrentAccess = vi.fn(() => {});
  const runs: NotebookRun[] = [];
  const options: NotebookToolBridgeOptions = {
    request, dataRuntime: { rowsByDataSourceId: { [source.id]: parsed.rows } }, authorizeCurrentAccess,
    notebookRunner: async (artifact, context) => {
      const run = await runNotebook({ document: { name: artifact.name, revision: artifact.baseRevision ?? 0, cells: artifact.cells },
        sources: context.sources, forAi: true, signal: context.signal, log: () => {} });
      runs.push(run);
      return run;
    },
  };
  return { options, source, runs };
}

async function notebookFixture() {
  const value = await fixture();
  value.options.profile = "notebook";
  value.options.notebookCapabilities = { python: { enabled: true } };
  return value;
}

function attachWorkbook(options: NotebookToolBridgeOptions) {
  options.rawWorkbook = { fileName: "bridge-synthetic.xlsx", contentHash: "a".repeat(64),
    sheets: [{ sheet: "Sales", data: [["region", "amount"], ["East", 150], ["South", 80]] }] };
  options.request.rawWorkbookManifest = { fileName: options.rawWorkbook.fileName, contentHash: options.rawWorkbook.contentHash,
    sheets: [{ name: "Sales", rowCount: 3, columnCount: 2 }] };
}

function removeSources(options: NotebookToolBridgeOptions) {
  delete options.request.dataSourceId;
  options.request.notebookContext!.sourceIds = [];
  options.request.notebookContext!.document.cells = [];
  options.dataRuntime.rowsByDataSourceId = {};
}

const pythonCell: NotebookCell = { id: "python", kind: "python", title: "Python 计算", inputCellIds: ["data"],
  fileNames: [], code: "result = sales_data.copy()", outputName: "python_result" };
const warehouseCell: NotebookCell = { id: "warehouse", kind: "warehouseSql", title: "授权数据库",
  connectionId: "db_allowed", sql: "SELECT 1 AS amount", outputName: "db_result" };
const transformCell: Extract<NotebookCell, { kind: "transform" }> = { id: "clean", kind: "transform", title: "已有整理步骤",
  inputCellId: "data", outputName: "clean_data", steps: [{ id: "select", type: "selectFields", fields: ["region", "amount"] }] };

describe("独立 Notebook 工具桥", () => {
  it("DSH charts writes the shared official-editor config and publishes exact draft IDs", async () => {
    const { options, runs } = await notebookFixture(); const events: NotebookLiveProgress[] = [];
    options.onProgress = event => events.push(event);
    const bridge = createNotebookToolBridge(options);
    const schema = JSON.stringify(bridge.catalog().find(tool => tool.name === "editNotebookCells")?.parameters);
    expect(schema).toContain('"charts"');
    const args = { id: "native_chart", title: "原生图", inputCellId: "data", mark: "bar",
      channels: { x: { field: "region" }, y: { field: "amount", aggregate: "sum" } } };
    await bridge.execute("editNotebookCells", { editVersion: 0, charts: [args] });
    expect(JSON.stringify(events)).toContain('"native_chart"');
    await bridge.execute("runNotebookCells", { editVersion: 1 });
    const submitted = await bridge.execute("submitNotebookDraft", { editVersion: 1 });
    expect(submitted.notebookArtifact?.cells.find(cell => cell.id === "native_chart")).toMatchObject({ graphicWalker: { datasetId: "notebook:native_chart:data", channels: { y: { aggregate: "sum" } } } });
    const result = runs[0].cells.find(cell => cell.cellId === "native_chart");
    expect(result?.visualization?.table.rows.map(row => row.viz_y)).toEqual([150, 80]);
    const before = structuredClone(bridge.getVerifiedDraft());
    await expect(bridge.execute("editNotebookCells", { editVersion: 1, charts: [{ ...args, id: "data" }] })).rejects.toThrow(/其他类型/);
    expect(options.request.notebookContext!.document.cells).toHaveLength(1);
    expect(before?.cells[0].kind).toBe("data"); bridge.close();
  }, 15000);
  it("streams actual failed/blocked cells, then repaired results; does not accept late runner callbacks", async () => {
    const { options } = await fixture(), events: NotebookLiveProgress[] = [];
    let late: NotebookProgressObserver | undefined;
    const bridge = createNotebookToolBridge({ ...options, onProgress: event => events.push(event), notebookRunner: (artifact, context) => {
      late = context.onProgress;
      return runNotebook({ document: { name: artifact.name, revision: artifact.baseRevision ?? 0, cells: artifact.cells },
        sources: context.sources, forAi: true, signal: context.signal, onProgress: context.onProgress, log: () => {} });
    } });
    try {
      await bridge.execute("editNotebookCells", { editVersion: 0, cells: [{ ...cells[0], sql: "SELECT missing_column FROM sales_data" }, ...cells.slice(1)] });
      await bridge.execute("runNotebookCells", { editVersion: 1 });
      expect(events.some(event => event.update.kind === "cell_finished" && event.update.result.cellId === "totals" && event.update.result.status === "failure")).toBe(true);
      expect(events.some(event => event.update.kind === "cell_finished" && event.update.result.cellId === "chart" && event.update.result.status === "blocked")).toBe(true);
      expect(bridge.getVerifiedDraft()).toBeUndefined();
      const count = events.length;
      late?.({ kind: "cell_started", runId: "late", revision: 7, cellId: "totals" }); expect(events).toHaveLength(count);
      await bridge.execute("editNotebookCells", { editVersion: 1, cells });
      await bridge.execute("runNotebookCells", { editVersion: 2 });
      expect(events.at(-1)).toMatchObject({ editVersion: 2, update: { kind: "run_finished", status: "success" } });
      await bridge.execute("submitNotebookDraft", { editVersion: 2 }); expect(bridge.getVerifiedDraft()).toBeDefined();
    } finally { bridge.close(); }
  }, 20_000);

  it.each(["cancel", "revoke"])("does not publish live results after %s", async mode => {
    const { options } = await fixture(), events: NotebookLiveProgress[] = [];
    let permitted = true;
    const abort = new AbortController();
    const bridge = createNotebookToolBridge({ ...options, signal: abort.signal,
      authorizeCurrentAccess: () => { if (!permitted) throw new Error("revoked"); }, onProgress: event => {
        events.push(event);
        if (event.update.kind === "cell_started") { if (mode === "cancel") abort.abort(); else permitted = false; }
      }, notebookRunner: (artifact, context) => runNotebook({ document: { name: artifact.name, revision: artifact.baseRevision ?? 0, cells: artifact.cells },
        sources: context.sources, forAi: true, signal: context.signal, onProgress: context.onProgress, log: () => {} }) });
    try {
      await expect(bridge.execute("runNotebookCells", { editVersion: 0 })).rejects.toThrow();
      expect(events.some(event => event.update.kind === "cell_finished")).toBe(false);
      expect(() => bridge.getVerifiedDraft()).toThrow();
    } finally { bridge.close(); }
  });

  it.each(["csv", "notebook-python", "notebook-no-python"] as const)("%s 目录说明仅承诺本 profile 能力，公共 Harness 目录不变", async (profile) => {
    const { options } = await fixture();
    if (profile !== "csv") {
      options.profile = "notebook";
      options.notebookCapabilities = { python: { enabled: profile === "notebook-python" } };
    }
    const publicOptions = { request: options.request, names: ["cellSearch", "editNotebookCells"] as const,
      notebookCapabilities: options.notebookCapabilities };
    const before = harnessToolCatalog({ ...publicOptions, names: [...publicOptions.names] });
    const bridge = createNotebookToolBridge(options);
    try {
      const tools = bridge.catalog();
      const edit = tools.find((tool) => tool.name === "editNotebookCells")!;
      const search = tools.find((tool) => tool.name === "cellSearch")!;
      expect(edit.description).not.toMatch(/createPythonCell|Python 用专用工具|text 可选/u);
      expect(edit.description).toContain("cellSearch 返回的 editVersion");
      expect(edit.description).toContain("同 ID 单元须完整替换");
      expect(edit.description).toContain("既有 Data 单元及其 ID、来源必须保留");
      expect(edit.description).toContain("afterCellId");
      expect(edit.description).toContain("valueFields 必须引用 number 字段");
      expect(edit.description).toContain("先确认聚合结果的范围与精度允许");
      expect(edit.description).toContain("removeCellIds 仅响应明确删除要求");
      expect(edit.description).toContain("outputRenames.codeChecks");
      expect(edit.description).toContain("runNotebookCells");
      expect(edit.description).toContain("submitNotebookDraft");
      expect(edit.description.includes("Python 直接通过本工具")).toBe(profile === "notebook-python");
      expect(edit.description.includes("warehouseSql 仅使用")).toBe(profile !== "csv");
      expect(JSON.stringify(edit.parameters).includes('"const":"python"')).toBe(profile === "notebook-python");
      expect(JSON.stringify(edit.parameters).includes('"const":"warehouseSql"')).toBe(profile !== "csv");
      expect(JSON.stringify(edit.parameters).includes('"const":"transform"')).toBe(profile !== "csv");
      expect(edit.description.includes("steps 沿用原数据配方 Schema 校验与执行")).toBe(profile !== "csv");
      expect(JSON.stringify(edit.parameters).includes('"const":"text"')).toBe(profile !== "csv");
      expect(edit.description.includes("text 说明单元")).toBe(profile !== "csv");
      expect(JSON.stringify(edit.parameters).includes('"const":"parameter"')).toBe(profile !== "csv");
      expect(edit.description.includes("parameter.type")).toBe(profile !== "csv");
      expect(search.description).toContain("可直接传 {}");
      expect(search.description).toContain("不是 document.revision / baseRevision");
      expect(search.description).toContain("不要填 null 或空 ID");
      expect(search.parameters).toEqual(before.find((tool) => tool.name === "cellSearch")!.parameters);
      expect(harnessToolCatalog({ ...publicOptions, names: [...publicOptions.names] })).toEqual(before);
      expect(before.find((tool) => tool.name === "editNotebookCells")!.description).toContain("Python 用专用工具");
    } finally { bridge.close(); }
  });

  it("直接执行真实 CSV → SQL 150/80 → 表图 → 提交；正式文档不变且仅人工采用", async () => {
    const network = vi.fn(async () => { throw new Error("No network or model calls allowed"); });
    vi.stubGlobal("fetch", network);
    const { options, runs } = await fixture();
    const original = structuredClone({ request: options.request, data: options.dataRuntime });
    const bridge = createNotebookToolBridge(options);
    try {
      expect(bridge.getVerifiedDraft()).toBeUndefined();
      const catalog = bridge.catalog();
      expect(catalog.map((tool) => tool.name)).toEqual(["cellSearch", "editNotebookCells", "runNotebookCells", "submitNotebookDraft"]);
      const editSchema = JSON.stringify(catalog.find((tool) => tool.name === "editNotebookCells")!.parameters);
      for (const forbidden of ["python", "warehouseSql", "semanticQuery", "transform", "text", "parameter"]) {
        expect(editSchema).not.toContain(`"const":"${forbidden}"`);
      }
      for (const kind of ["data", "sql", "table", "chart"]) expect(editSchema).toContain(`"const":"${kind}"`);
      catalog[0].name = "callMcpTool";
      expect(bridge.catalog()[0].name).toBe("cellSearch");
      expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 0, totalCells: 1 });
      await bridge.execute("editNotebookCells", { editVersion: 0, cells });
      await expect(bridge.execute("submitNotebookDraft", { editVersion: 1 })).rejects.toThrow("尚未完整试运行通过");
      const result = await bridge.execute("runNotebookCells", { editVersion: 1 });
      expect(result.data).toMatchObject({ status: "success", results: expect.arrayContaining([
        expect.objectContaining({ cellId: "totals", rows: [{ region: "East", revenue: 150 }, { region: "South", revenue: 80 }] }),
      ]) });
      expect(bridge.getVerifiedDraft()).toBeUndefined();
      const submitted = await bridge.execute("submitNotebookDraft", { editVersion: 1 });
      const draft = bridge.getVerifiedDraft()!;
      expect(draft).toEqual(submitted.notebookArtifact);
      expect(draft.executionEvidence).toMatchObject({ status: "success", runId: runs[0].runId });
      expect(draft.baseRevision).toBe(7);
      draft.cells[0].title = "mutated external result";
      submitted.notebookArtifact!.cells[0].title = "mutated returned result";
      expect(bridge.getVerifiedDraft()!.cells[0].title).toBe("CSV 数据");
      const adopted = adoptNotebookDraft(options.request.notebookContext!.document, bridge.getVerifiedDraft()!);
      expect(adopted.revision).toBe(8);
      expect(adopted.cells).toHaveLength(4);
      expect({ request: options.request, data: options.dataRuntime }).toEqual(original);
      expect(network).not.toHaveBeenCalled();
      await bridge.execute("editNotebookCells", { editVersion: 1, cells: [{ ...cells[2], title: "新标题" }] });
      expect(bridge.getVerifiedDraft()).toBeUndefined();
      await expect(bridge.execute("submitNotebookDraft", { editVersion: 2 })).rejects.toThrow("尚未完整试运行通过");
    } finally { bridge.close(); }
  }, 20_000);

  it("任务状态隔离，调用后修改请求、行和参数均不能篡改内部草稿", async () => {
    const { options, source } = await fixture();
    const first = createNotebookToolBridge(options), second = createNotebookToolBridge(options);
    try {
      options.request.notebookContext!.document.cells[0].title = "caller changed";
      options.dataRuntime.rowsByDataSourceId[source.id][0].amount = 999;
      const args = { editVersion: 0, cells: structuredClone(cells) };
      const pending = first.execute("editNotebookCells", args);
      args.cells[0].title = "caller changed later";
      await pending;
      expect((await first.execute("cellSearch", { cellId: "totals" })).data).toMatchObject({
        cells: [expect.objectContaining({ id: "totals", title: "地区汇总" })],
      });
      expect((await second.execute("cellSearch", {})).data).toMatchObject({ editVersion: 0, totalCells: 1 });
      expect((await first.execute("cellSearch", {})).data).toMatchObject({ editVersion: 1, totalCells: 4 });
      expect(second.getVerifiedDraft()).toBeUndefined();
      const result = await first.execute("runNotebookCells", { editVersion: 1 });
      expect(result.data).toMatchObject({ status: "success", results: expect.arrayContaining([
        expect.objectContaining({ cellId: "totals", rows: [{ region: "East", revenue: 150 }, { region: "South", revenue: 80 }] }),
      ]) });
    } finally { first.close(); second.close(); }
  });

  it.each(["callMcpTool", "inspectDataset", "bash", "__proto__", "complete"])("拒绝非白名单工具 %s，不接受模型自报完成", async (name) => {
    const { options } = await fixture();
    const bridge = createNotebookToolBridge(options);
    try {
      await expect(bridge.execute(name, { notebookArtifact: { executionEvidence: { status: "success" } } })).rejects.toThrow("不允许调用");
      expect(bridge.getVerifiedDraft()).toBeUndefined();
    } finally { bridge.close(); }
  });

  it("保持既有参数错误格式、版本检查和提交防伪", async () => {
    const { options } = await fixture();
    const bridge = createNotebookToolBridge(options);
    try {
      await expect(bridge.execute("editNotebookCells", { editVersion: "0", cells })).rejects.toBeInstanceOf(HarnessToolArgumentsError);
      await expect(bridge.execute("submitNotebookDraft", { editVersion: 0, notebookArtifact: { status: "success" } })).rejects.toBeInstanceOf(HarnessToolArgumentsError);
      await expect(bridge.execute("editNotebookCells", { editVersion: 99, cells })).rejects.toThrow("版本已变化");
      expect(bridge.getVerifiedDraft()).toBeUndefined();
    } finally { bridge.close(); }
  });

  it.each(["python", "warehouseSql", "parameter", "data-source", "remove-data"])("实验能力拒绝 %s", async (kind) => {
    const { options } = await fixture();
    const bridge = createNotebookToolBridge(options);
    const additions = kind === "python" ? [{ id: "py", kind, title: "不允许", inputCellIds: ["data"], outputName: "py_data", code: "py_data = sales_data" }]
      : kind === "warehouseSql" ? [{ id: "remote", kind, title: "不允许", connectionId: "remote", outputName: "remote_data", sql: "SELECT 1" }]
      : kind === "parameter" ? [{ id: "param", kind, title: "不允许", outputName: "param_data", parameter: { type: "number", value: 1 } }]
      : kind === "data-source" ? [{ id: "data", kind: "data", title: "不允许", outputName: "sales_data", sourceDataSourceId: "outside" }] : [];
    try {
      await expect(bridge.execute("editNotebookCells", { editVersion: 0, cells: additions,
        ...(kind === "remove-data" ? { removeCellIds: ["data"] } : {}),
      })).rejects.toThrow("本实验不能");
      expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 0, totalCells: 1 });
    } finally { bridge.close(); }
  });

  it.each(["close", "abort", "call-signal"])("%s 丢弃迟到运行结果并拒绝并发或后续调用", async (mode) => {
    const { options } = await fixture();
    const controller = new AbortController();
    const callController = new AbortController();
    let release: (run: NotebookRun) => void = () => { throw new Error("Runner not reached"); };
    const waiting = new Promise<NotebookRun>((resolve) => { release = resolve; });
    const runner = vi.fn<NotebookToolBridgeOptions["notebookRunner"]>(() => waiting);
    const bridge = createNotebookToolBridge({ ...options, signal: controller.signal, notebookRunner: runner });
    await bridge.execute("editNotebookCells", { editVersion: 0, cells });
    const pending = bridge.execute("runNotebookCells", { editVersion: 1 }, callController.signal);
    const rejected = expect(pending).rejects.toThrow();
    await expect(bridge.execute("cellSearch", {})).rejects.toThrow("不能并行");
    const rejectedController = new AbortController(); rejectedController.abort();
    await expect(bridge.execute("cellSearch", {}, rejectedController.signal)).rejects.toThrow("不能并行");
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0][1]?.signal?.aborted).toBe(false);
    if (mode === "close") bridge.close();
    else if (mode === "call-signal") callController.abort();
    else controller.abort();
    expect(runner.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await rejected; // Cancellation settles even when a trusted runner ignores its signal.
    release({ runId: "late", revision: 7, status: "success", cells: [], startedAt: new Date().toISOString(),
      dataSignature: "synthetic", notice: "untrusted late receipt" });
    expect(() => bridge.getVerifiedDraft()).toThrow("已关闭或取消");
    await expect(bridge.execute("cellSearch", {})).rejects.toThrow("已关闭或取消");
    bridge.close();
  });

  it("每次调用释放取消订阅；下一次已取消调用关闭任务且不启动工具", async () => {
    const { options } = await fixture();
    const runner = vi.fn(options.notebookRunner);
    const bridge = createNotebookToolBridge({ ...options, notebookRunner: runner });
    const finished = new AbortController();
    await bridge.execute("cellSearch", {}, finished.signal);
    finished.abort();
    expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 0 });
    await bridge.execute("editNotebookCells", { editVersion: 0, cells });
    const cancelled = new AbortController(); cancelled.abort();
    await expect(bridge.execute("runNotebookCells", { editVersion: 1 }, cancelled.signal)).rejects.toThrow("已关闭或取消");
    expect(runner).not.toHaveBeenCalled();
    expect(() => bridge.getVerifiedDraft()).toThrow("已关闭或取消");
    bridge.close();
  });

  it("授权撤回在执行后仍拒绝结果且关闭整个工具会话", async () => {
    const { options } = await fixture();
    let allowed = true;
    const bridge = createNotebookToolBridge({ ...options, authorizeCurrentAccess: () => {
      if (!allowed) throw new Error("synthetic authorization revoked");
    } });
    const pending = bridge.execute("cellSearch", {});
    allowed = false;
    await expect(pending).rejects.toThrow("authorization revoked");
    expect(() => bridge.catalog()).toThrow("已关闭或取消");
    expect(() => bridge.getVerifiedDraft()).toThrow("已关闭或取消");
    bridge.close();
  });

  it("实际 SQL 失败不产生可采用草稿，后续提交继续拒绝", async () => {
    const { options } = await fixture();
    const bridge = createNotebookToolBridge(options);
    try {
      await bridge.execute("editNotebookCells", { editVersion: 0, cells: [{ ...cells[0],
        sql: "SELECT missing_column FROM sales_data" }, ...cells.slice(1)] });
      expect((await bridge.execute("runNotebookCells", { editVersion: 1 })).data).toMatchObject({ status: "failure" });
      await expect(bridge.execute("submitNotebookDraft", { editVersion: 1 })).rejects.toThrow("尚未完整试运行通过");
      expect(bridge.getVerifiedDraft()).toBeUndefined();
    } finally { bridge.close(); }
  }, 15_000);

  it("复用正式回执校验拒绝 runner 返回另一文档的伪成功", async () => {
    const { options } = await fixture();
    const bridge = createNotebookToolBridge({ ...options, notebookRunner: async () => ({
      runId: "forged_run", revision: 999, status: "success", cells: [],
      startedAt: new Date().toISOString(), dataSignature: "synthetic", notice: "forged successful document",
    }) });
    try {
      await bridge.execute("editNotebookCells", { editVersion: 0, cells });
      await expect(bridge.execute("runNotebookCells", { editVersion: 1 })).rejects.toThrow("回执与本次草稿不一致");
      await expect(bridge.execute("submitNotebookDraft", { editVersion: 1 })).rejects.toThrow("尚未完整试运行通过");
      expect(bridge.getVerifiedDraft()).toBeUndefined();
    } finally { bridge.close(); }
  });

  it("创建前拒绝已取消、范围外来源和远端连接", async () => {
    const { options } = await fixture();
    const controller = new AbortController(); controller.abort();
    expect(() => createNotebookToolBridge({ ...options, signal: controller.signal })).toThrow();
    const secondSource = structuredClone(options.request);
    secondSource.notebookContext!.sourceIds.push("outside");
    expect(() => createNotebookToolBridge({ ...options, request: secondSource })).toThrow("单个本地 CSV");
    const remote = structuredClone(options.request);
    remote.notebookContext!.connections = [{ id: "remote", name: "remote", kind: "postgresql", allowAi: true }];
    expect(() => createNotebookToolBridge({ ...options, request: remote })).toThrow("单个本地 CSV");
  });

  it.each(["sql-connection", "warehouseSql", "other-source"])("即使没有连接目录，现有 %s 也不能进入执行器", async (variant) => {
    const { options } = await fixture();
    const runner = vi.fn(options.notebookRunner);
    const request = structuredClone(options.request);
    expect(request.notebookContext!.connections).toBeUndefined();
    if (variant === "sql-connection") {
      // A caller can forge extra properties despite the TypeScript contract.
      // Canonical strict SQL schema must reject, not strip or dispatch them.
      request.notebookContext!.document.cells.push({ ...cells[0], ...{ connectionId: "remote" } });
    } else if (variant === "warehouseSql") {
      request.notebookContext!.document.cells.push({ id: "remote", kind: "warehouseSql", title: "远端 SQL",
        connectionId: "remote", sql: "SELECT 1", outputName: "remote_data" });
    } else {
      request.notebookContext!.document.cells.push({ id: "other", kind: "data", title: "其他来源",
        sourceDataSourceId: "outside", outputName: "outside_data" });
    }
    expect(() => createNotebookToolBridge({ ...options, request, notebookRunner: runner }))
      .toThrow(variant === "sql-connection" ? ZodError : expect.objectContaining({ code: "notebook_cell_unsupported" }));
    expect(runner).not.toHaveBeenCalled();
  });

  it.each(["new", "existing"])("拒绝编辑 %s SQL 的 connectionId，保持版本且不调用执行器", async (mode) => {
    const { options } = await fixture();
    const runner = vi.fn(options.notebookRunner);
    if (mode === "existing") options.request.notebookContext!.document.cells.push(structuredClone(cells[0]));
    const bridge = createNotebookToolBridge({ ...options, notebookRunner: runner });
    try {
      const before = await bridge.execute("cellSearch", {});
      await expect(bridge.execute("editNotebookCells", { editVersion: 0, cells: [{ ...cells[0], connectionId: "remote" }] }))
        .rejects.toBeInstanceOf(HarnessToolArgumentsError);
      expect((await bridge.execute("cellSearch", {})).data).toEqual(before.data);
      expect(bridge.getVerifiedDraft()).toBeUndefined();
      expect(runner).not.toHaveBeenCalled();
    } finally { bridge.close(); }
  });

  it("拒绝编辑 warehouseSql，即使外部执行器存在也不会收到调用", async () => {
    const { options } = await fixture();
    const runner = vi.fn(options.notebookRunner);
    const bridge = createNotebookToolBridge({ ...options, notebookRunner: runner });
    try {
      await expect(bridge.execute("editNotebookCells", { editVersion: 0, cells: [{ id: "remote", kind: "warehouseSql",
        title: "远端 SQL", connectionId: "remote", sql: "SELECT 1", outputName: "remote_data" }] }))
        .rejects.toThrow("本实验不能");
      expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 0, totalCells: 1 });
      expect(runner).not.toHaveBeenCalled();
    } finally { bridge.close(); }
  });

  it("请求中的伪造 connectionSQL 配方由已有严格 Schema 拒绝，不进入执行器", async () => {
    const { options, source } = await fixture();
    const runner = vi.fn(options.notebookRunner);
    const request = structuredClone(options.request);
    Object.assign(request, { recipes: [{ id: "remote_recipe", name: "无效远端配方", sourceDatasetId: source.id,
      outputDatasetId: "outside", status: "ready", steps: [{ id: "step_remote", type: "connectionSQL",
        connectionId: "remote", sql: "SELECT 1" }] }] });
    expect(() => createNotebookToolBridge({ ...options, request, notebookRunner: runner })).toThrow(ZodError);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("网站 Notebook 参数单元", () => {
  const parameter: NotebookCell = { id: "region", kind: "parameter", title: "地区选择", outputName: "region_pick",
    parameter: { type: "select", value: "East", options: ["East", "South"] } };
  const query: NotebookCell = { id: "filtered", kind: "sql", title: "参数汇总", inputCellIds: ["data", "region"], outputName: "filtered_sales",
    sql: "SELECT region, SUM(amount)::DOUBLE AS revenue FROM sales_data WHERE region = (SELECT value FROM region_pick) GROUP BY region" };

  it("保留已有参数，修改后旧回执失效；重跑150→80后才能提交，正式定义不变", async () => {
    const { options, runs } = await notebookFixture();
    options.request.notebookContext!.document.cells.push(parameter, query);
    const before = structuredClone(options.request), bridge = createNotebookToolBridge(options);
    try {
      await bridge.execute("runNotebookCells", { editVersion: 0 });
      expect(runs[0].cells.find(cell => cell.cellId === "filtered")?.table?.rows).toEqual([{ region: "East", revenue: 150 }]);
      await bridge.execute("editNotebookCells", { editVersion: 0, cells: [{ ...parameter,
        parameter: { type: "select", value: "South", options: ["East", "South"] } }] });
      await expect(bridge.execute("submitNotebookDraft", { editVersion: 1 })).rejects.toThrow();
      await bridge.execute("runNotebookCells", { editVersion: 1 });
      expect(runs[1].cells.find(cell => cell.cellId === "filtered")?.table?.rows).toEqual([{ region: "South", revenue: 80 }]);
      await bridge.execute("submitNotebookDraft", { editVersion: 1 });
      expect(bridge.getVerifiedDraft()?.lineage.find(item => item.cellId === "filtered")?.dependsOn).toEqual(["data", "region"]);
      expect(options.request).toEqual(before);
    } finally { bridge.close(); }
  });

  it.each([
    { type: "text", value: "East'); DROP TABLE sales_data; -- {{ignore}}" },
    { type: "number", value: 0.5 },
    { type: "date", value: "2026-09-22" },
    { type: "select", value: "South", options: ["East", "South"] },
  ] as const)("$type 参数以结构化value表进入真实SQL，不当代码/模板执行", async value => {
    const { options, runs } = await notebookFixture(), bridge = createNotebookToolBridge(options);
    try {
      await bridge.execute("editNotebookCells", { editVersion: 0, cells: [
        { ...parameter, parameter: value }, { ...query, inputCellIds: ["region"], sql: "SELECT value FROM region_pick" },
      ] });
      await bridge.execute("runNotebookCells", { editVersion: 1 });
      expect(runs[0].status).toBe("success");
      const output = runs[0].cells.find(cell => cell.cellId === "filtered")?.table;
      // SQL date representation is adapter-owned; compare its explicit calendar date.
      if (value.type === "date") expect(String(output?.rows[0].value).slice(0, 10)).toBe(value.value);
      else expect(output?.rows).toEqual([{ value: value.value }]);
      await bridge.execute("submitNotebookDraft", { editVersion: 1 });
      expect(bridge.getVerifiedDraft()?.cells.find(cell => cell.id === "region")).toEqual({ ...parameter, parameter: value });
    } finally { bridge.close(); }
  });

  it.each([
    { type: "select", value: "Outside", options: ["East"] },
    { type: "select", value: "East", options: ["East", "East"] },
    { type: "date", value: "2026-02-30" },
    { type: "number", value: Number.MAX_SAFE_INTEGER + 1 },
    { type: "number", value: Number.POSITIVE_INFINITY },
    { type: "text", value: "literal", code: "execute" },
  ])("非法参数不推进版本或调用执行器：%j", async value => {
    const { options } = await notebookFixture(), runner = vi.fn(options.notebookRunner);
    const bridge = createNotebookToolBridge({ ...options, notebookRunner: runner });
    try {
      await expect(bridge.execute("editNotebookCells", { editVersion: 0, cells: [{ ...parameter, parameter: value }] }))
        .rejects.toBeInstanceOf(HarnessToolArgumentsError);
      expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 0, totalCells: 1 });
      expect(runner).not.toHaveBeenCalled(); expect(bridge.getVerifiedDraft()).toBeUndefined();
    } finally { bridge.close(); }
  });

  it("参数不增加来源授权；无数据上下文与旧CSV初始参数仍拒绝", async () => {
    const { options } = await notebookFixture();
    removeSources(options); options.request.notebookContext!.document.cells = [parameter];
    expect(() => createNotebookToolBridge(options)).toThrow(expect.objectContaining({ code: "missing_data_context" }));
    const { options: csv } = await fixture(); csv.request.notebookContext!.document.cells.push(parameter);
    expect(() => createNotebookToolBridge(csv)).toThrow(expect.objectContaining({ code: "notebook_cell_unsupported" }));
  });
});

describe("网站 Notebook 说明单元", () => {
  const total: NotebookCell = { id: "total", kind: "sql", title: "销售总收入", inputCellIds: ["data"],
    outputName: "sales_total", sql: "SELECT SUM(amount)::DOUBLE AS revenue FROM sales_data" };
  const note: Extract<NotebookCell, { kind: "text" }> = { id: "note", kind: "text", title: "结论",
    markdown: "销售总收入：{{total}}", references: [{ key: "total", cellId: "total", field: "revenue" }] };

  it("已有静态说明可检索与编辑，旧花括号和HTML字样保留为文本；CSV仍拒绝", async () => {
    const { options, runs } = await notebookFixture();
    const legacy: NotebookCell = { id: "legacy", kind: "text", title: "说明", markdown: "旧 {{unbound}} <b>文字</b>" };
    options.request.notebookContext!.document.cells.push(legacy);
    const before = structuredClone(options.request), bridge = createNotebookToolBridge(options);
    try {
      expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 0, totalCells: 2 });
      await bridge.execute("editNotebookCells", { editVersion: 0, cells: [{ ...legacy, markdown: legacy.markdown + "。" }] });
      await bridge.execute("runNotebookCells", { editVersion: 1 });
      expect(runs[0].cells.find(cell => cell.cellId === "legacy")).toMatchObject({ status: "success" });
      await bridge.execute("submitNotebookDraft", { editVersion: 1 });
      expect(bridge.getVerifiedDraft()?.cells[1]).toEqual({ ...legacy, markdown: legacy.markdown + "。" });
      expect(options.request).toEqual(before);
    } finally { bridge.close(); }
    options.profile = "csv";
    expect(() => createNotebookToolBridge(options)).toThrow(expect.objectContaining({ code: "notebook_cell_unsupported" }));
  });

  it("真实SQL单行230通过绑定进入说明预览及草稿，正式定义与数据不变", async () => {
    const { options, runs } = await notebookFixture(), before = structuredClone({ request: options.request, data: options.dataRuntime });
    const bridge = createNotebookToolBridge(options);
    try {
      await bridge.execute("editNotebookCells", { editVersion: 0, cells: [note, total] });
      await expect(bridge.execute("submitNotebookDraft", { editVersion: 1 })).rejects.toThrow("尚未完整试运行通过");
      const result = await bridge.execute("runNotebookCells", { editVersion: 1 });
      expect(result.data).toMatchObject({ status: "success", textResults: [{ cellId: "note", text: "销售总收入：230", truncated: false }] });
      expect(runs[0].cells.find(cell => cell.cellId === "note")).toMatchObject({ status: "success", text: "销售总收入：230" });
      await bridge.execute("submitNotebookDraft", { editVersion: 1 });
      const draft = bridge.getVerifiedDraft();
      expect(draft?.lineage.find(item => item.cellId === "note")).toEqual({ cellId: "note", dependsOn: ["total"] });
      expect(draft?.cells.find(cell => cell.id === "note")).toEqual(note);
      expect({ request: options.request, data: options.dataRuntime }).toEqual(before);
    } finally { bridge.close(); }
  });

  it.each(["expression", "undeclared", "outside", "self", "extra-access"])("非法说明 %s 不推进草稿且不调用执行器", async variant => {
    const { options } = await notebookFixture(), runner = vi.fn(options.notebookRunner);
    const invalid = structuredClone(note);
    if (variant === "expression") invalid.markdown = "{{total + 1}}";
    if (variant === "undeclared") invalid.markdown = "{{other}}";
    if (variant === "outside") invalid.references![0].cellId = "outside";
    if (variant === "self") invalid.references![0].cellId = "note";
    if (variant === "extra-access") Object.assign(invalid, { fileNames: ["outside.csv"], connectionId: "outside" });
    const bridge = createNotebookToolBridge({ ...options, notebookRunner: runner });
    try {
      await expect(bridge.execute("editNotebookCells", { editVersion: 0, cells: [total, invalid] })).rejects.toThrow();
      expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 0, totalCells: 1 });
      expect(bridge.getVerifiedDraft()).toBeUndefined(); expect(runner).not.toHaveBeenCalled();
    } finally { bridge.close(); }
  });

  it("多行引用不能提交，修为真实单行汇总并重新运行后才可提交", async () => {
    const { options, runs } = await notebookFixture(), before = structuredClone(options.request);
    const bridge = createNotebookToolBridge(options);
    try {
      await bridge.execute("editNotebookCells", { editVersion: 0, cells: [{ ...note,
        references: [{ key: "total", cellId: "data", field: "amount" }] }] });
      await bridge.execute("runNotebookCells", { editVersion: 1 });
      expect(runs[0].status).toBe("failure");
      expect(runs[0].cells.find(cell => cell.cellId === "note")).toMatchObject({ status: "failure" });
      await expect(bridge.execute("submitNotebookDraft", { editVersion: 1 })).rejects.toThrow();
      expect(bridge.getVerifiedDraft()).toBeUndefined();
      await bridge.execute("editNotebookCells", { editVersion: 1, cells: [total, note] });
      await bridge.execute("runNotebookCells", { editVersion: 2 });
      expect(runs[1].cells.find(cell => cell.cellId === "note")?.text).toBe("销售总收入：230");
      await bridge.execute("submitNotebookDraft", { editVersion: 2 });
      expect(bridge.getVerifiedDraft()?.executionEvidence?.status).toBe("success");
      expect(options.request).toEqual(before);
    } finally { bridge.close(); }
  });
});

describe("网站 Notebook 工具桥的授权能力配置", () => {
  it("已有 transform 不阻止初始化，编辑后真实 SQL 150/80 并提交，正式定义与数据保持不变", async () => {
    const { options, runs } = await notebookFixture();
    options.request.notebookContext!.document.cells.push(structuredClone(transformCell));
    const original = structuredClone({ request: options.request, data: options.dataRuntime });
    const network = vi.fn(async () => { throw new Error("No external side effects allowed"); });
    vi.stubGlobal("fetch", network);
    const bridge = createNotebookToolBridge(options);
    try {
      expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 0, totalCells: 2 });
      expect(bridge.catalog().find(tool => tool.name === "editNotebookCells")!.description).toContain("transform");
      const grouped: NotebookCell = { ...transformCell, steps: [{ id: "group", type: "groupAggregate", groupBy: ["region"],
        aggregations: [{ field: "amount", aggregation: "sum", as: "revenue", label: "收入" }] }] };
      const sql: NotebookCell = { id: "totals", kind: "sql", title: "地区汇总排序", inputCellIds: ["clean"], outputName: "region_totals",
        sql: "SELECT region, revenue::DOUBLE AS revenue FROM clean_data ORDER BY region" };
      await bridge.execute("editNotebookCells", { editVersion: 0, cells: [grouped, sql, cells[1], cells[2]] });
      expect((await bridge.execute("runNotebookCells", { editVersion: 1 })).data).toMatchObject({ status: "success",
        results: expect.arrayContaining([expect.objectContaining({ cellId: "totals",
          rows: [{ region: "East", revenue: 150 }, { region: "South", revenue: 80 }] })]) });
      await bridge.execute("submitNotebookDraft", { editVersion: 1 });
      const draft = bridge.getVerifiedDraft()!;
      expect(draft.cells.find(cell => cell.id === "clean")).toEqual(grouped);
      expect(draft.executionEvidence).toMatchObject({ status: "success", runId: runs[0].runId });
      expect(draft.baseRevision).toBe(7);
      expect({ request: options.request, data: options.dataRuntime }).toEqual(original);
      expect(network).not.toHaveBeenCalled();
    } finally { bridge.close(); }
  }, 15_000);

  it("transform 仍不属于旧 CSV 试点，既有定义和新增编辑都不能绕过该范围", async () => {
    const { options } = await fixture();
    const runner = vi.fn(options.notebookRunner);
    const bridge = createNotebookToolBridge({ ...options, notebookRunner: runner });
    try {
      await expect(bridge.execute("editNotebookCells", { editVersion: 0, cells: [transformCell] })).rejects.toThrow("本实验不能");
      expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 0, totalCells: 1 });
      expect(bridge.getVerifiedDraft()).toBeUndefined();
    } finally { bridge.close(); }
    options.request.notebookContext!.document.cells.push(structuredClone(transformCell));
    expect(() => createNotebookToolBridge({ ...options, notebookRunner: runner }))
      .toThrow(expect.objectContaining({ name: "NotebookBridgePreflightError", code: "notebook_cell_unsupported" }));
    expect(runner).not.toHaveBeenCalled();
  });

  it("transform 只消费已声明上游，不能新增未授权来源或把步骤变成文件/SQL/脚本入口", async () => {
    const { options } = await notebookFixture();
    const runner = vi.fn(options.notebookRunner);
    const bridge = createNotebookToolBridge({ ...options, notebookRunner: runner });
    try {
      const before = await bridge.execute("cellSearch", {});
      await expect(bridge.execute("editNotebookCells", { editVersion: 0, cells: [{ ...transformCell, inputCellId: "outside" }] })).rejects.toThrow();
      for (const type of ["connectionSQL", "readFile", "python", "shell"]) {
        await expect(bridge.execute("editNotebookCells", { editVersion: 0,
          cells: [{ ...transformCell, steps: [{ id: "escape", type, connectionId: "outside", path: "outside.xlsx", code: "synthetic" }] }],
        })).rejects.toBeInstanceOf(HarnessToolArgumentsError);
      }
      await expect(bridge.execute("editNotebookCells", { editVersion: 0, cells: [transformCell,
        { id: "outside", kind: "data", title: "未授权来源", sourceDataSourceId: "unselected", outputName: "outside_data" }],
      })).rejects.toThrow("未授权");
      await expect(bridge.execute("editNotebookCells", { editVersion: 0,
        cells: [{ ...transformCell, sourceDataSourceId: "unselected" }],
      })).rejects.toBeInstanceOf(HarnessToolArgumentsError);
      expect((await bridge.execute("cellSearch", {})).data).toEqual(before.data);
      expect(bridge.getVerifiedDraft()).toBeUndefined();
      expect(runner).not.toHaveBeenCalled();
    } finally { bridge.close(); }
    options.request.notebookContext!.document.cells.push(structuredClone(transformCell),
      { id: "outside", kind: "data", title: "未授权来源", sourceDataSourceId: "unselected", outputName: "outside_data" });
    expect(() => createNotebookToolBridge({ ...options, notebookRunner: runner }))
      .toThrow(expect.objectContaining({ code: "notebook_reference_unavailable" }));
    expect(runner).not.toHaveBeenCalled();
  });

  it.each(["missing-notebook", "missing-page", "disabled-python", "semanticQuery"])("初始化 %s 返回有限诊断，仍不调用模型或运行器", async kind => {
    const { options } = await notebookFixture();
    const runner = vi.fn(options.notebookRunner);
    if (kind === "missing-notebook") delete options.request.notebookContext;
    else if (kind === "missing-page") options.request.pageId = "missing_page";
    else if (kind === "disabled-python") {
      options.notebookCapabilities = { python: { enabled: false, reason: "测试关闭" } };
      options.request.notebookContext!.document.cells.push(pythonCell);
    }
    else options.request.notebookContext!.document.cells.push({ id: "semantic", kind: "semanticQuery", title: "语义查询",
      inputCellId: "data", modelId: "model", modelVersion: 1, dimensions: [], measures: ["amount"], limit: 10, outputName: "semantic_data" });
    const code = kind === "missing-notebook" ? "missing_notebook_context" : kind === "missing-page" ? "workspace_unavailable"
      : kind === "semanticQuery" ? "semantic_model_unavailable" : "python_unavailable";
    expect(() => createNotebookToolBridge({ ...options, notebookRunner: runner })).toThrow(new NotebookBridgePreflightError(code));
    expect(runner).not.toHaveBeenCalled();
  });

  it("多来源只复制选中数据，新增 Data 后真实运行 SQL 150/80，正式文档不变", async () => {
    const { options, source } = await notebookFixture();
    const second = { ...structuredClone(source), id: "dataset_second", name: "Second source" };
    options.request.appSpec.dataSources.push(second);
    options.request.notebookContext!.sourceIds.push(second.id);
    options.dataRuntime.rowsByDataSourceId[second.id] = [{ region: "West", amount: 9 }];
    options.dataRuntime.rowsByDataSourceId.outside = [{ private: "must not reach runner" }];
    const original = structuredClone(options.request);
    const runner = vi.fn<NotebookToolBridgeOptions["notebookRunner"]>(async (artifact, context) => {
      expect(context.sources.map(item => item.source.id).sort()).toEqual([source.id, second.id].sort());
      expect(Object.keys(context).sort()).toEqual(["revision", "semanticModels", "signal", "sources", "taskId"]);
      return runNotebook({ document: { name: artifact.name, revision: artifact.baseRevision ?? 0, cells: artifact.cells },
        sources: context.sources, forAi: true, signal: context.signal, log: () => {} });
    });
    const bridge = createNotebookToolBridge({ ...options, notebookRunner: runner });
    try {
      const edited = [{ id: "second", kind: "data", title: "第二来源", sourceDataSourceId: second.id, outputName: "second_data" }, ...cells];
      await bridge.execute("editNotebookCells", { editVersion: 0, cells: edited });
      const result = await bridge.execute("runNotebookCells", { editVersion: 1 });
      expect(result.data).toMatchObject({ status: "success", results: expect.arrayContaining([
        expect.objectContaining({ cellId: "totals", rows: [{ region: "East", revenue: 150 }, { region: "South", revenue: 80 }] }),
      ]) });
      await bridge.execute("submitNotebookDraft", { editVersion: 1 });
      expect(bridge.getVerifiedDraft()!.sourceDataSourceIds).toEqual([source.id, second.id]);
      expect(options.request).toEqual(original);
    } finally { bridge.close(); }
  }, 15_000);

  it.each(["missing-runtime", "unknown-source", "pending", "duplicate", "outside-selection"])("拒绝 %s 来源", async (variant) => {
    const { options, source } = await notebookFixture();
    const runner = vi.fn(options.notebookRunner);
    if (variant === "missing-runtime") delete options.dataRuntime.rowsByDataSourceId[source.id];
    if (variant === "unknown-source") options.request.appSpec.dataSources = options.request.appSpec.dataSources.filter((item) => item.id !== source.id);
    if (variant === "pending") options.request.appSpec.dataSources.find((item) => item.id === source.id)!.aiAccessPolicy = "pending";
    if (variant === "duplicate") options.request.notebookContext!.sourceIds.push(source.id);
    if (variant === "outside-selection") options.request.dataSourceId = "outside";
    expect(() => createNotebookToolBridge({ ...options, notebookRunner: runner })).toThrow(expect.objectContaining({ code: "source_unavailable" }));
    expect(runner).not.toHaveBeenCalled();
  });

  it("保护所有原始 Data 单元，不能移除、改来源或替换为另一种单元", async () => {
    const { options, source } = await notebookFixture();
    options.request.notebookContext!.document.cells.push({ id: "data_two", kind: "data", title: "原始第二单元",
      sourceDataSourceId: source.id, outputName: "data_two_output" });
    const bridge = createNotebookToolBridge(options);
    try {
      for (const id of ["data", "data_two"]) {
        await expect(bridge.execute("editNotebookCells", { editVersion: 0, cells: [], removeCellIds: [id] })).rejects.toThrow("不能变更原始 Data");
        await expect(bridge.execute("editNotebookCells", { editVersion: 0, cells: [{ id, kind: "data", title: "越权来源",
          sourceDataSourceId: "outside", outputName: "outside_data" }] })).rejects.toThrow("不能变更原始 Data");
        await expect(bridge.execute("editNotebookCells", { editVersion: 0, cells: [{ ...pythonCell, id }] })).rejects.toThrow("不能变更原始 Data");
      }
      expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 0, totalCells: 2 });
    } finally { bridge.close(); }
  });

  it("零来源必须有本次原件或已授权连接，不能借未授权目录启动空环境", async () => {
    const { options } = await notebookFixture();
    removeSources(options);
    expect(() => createNotebookToolBridge(options)).toThrow(expect.objectContaining({ code: "missing_data_context" }));
    options.request.notebookContext!.connections = [{ id: "db_allowed", name: "Not authorized", kind: "postgresql", allowAi: false }];
    expect(() => createNotebookToolBridge(options)).toThrow(expect.objectContaining({ code: "missing_data_context" }));
    options.request.notebookContext!.connections[0].allowAi = true;
    const bridge = createNotebookToolBridge(options);
    expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 0, totalCells: 0 });
    expect(bridge.getVerifiedDraft()).toBeUndefined();
    bridge.close();
  });

  it("原件端口只暴露清单匹配的本次文件；零 Dataset 可读取真实工作表并创建 Python 草稿", async () => {
    const { options } = await notebookFixture();
    removeSources(options);
    attachWorkbook(options);
    options.pythonRuntimeInfo = vi.fn(async () => ({ available: true, packages: ["pandas", "openpyxl"] }));
    const original = structuredClone(options.request);
    const bridge = createNotebookToolBridge(options);
    // Caller-owned parsed rows and metadata cannot rewrite the bound workbook.
    options.rawWorkbook!.sheets[0].data[1][1] = 999;
    options.rawWorkbook!.fileName = "outside.xlsx";
    try {
      const names = bridge.catalog().map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["inspectEdsRawWorkbook", "readEdsRawRows", "getKernelPackagesInfo"]));
      expect(names).not.toContain("inspectConnectionSchema");
      expect(names).not.toContain("createPythonCell");
      expect((await bridge.execute("inspectEdsRawWorkbook", {})).data).toMatchObject({ fileName: "bridge-synthetic.xlsx",
        sheets: [{ name: "Sales", rowCount: 3, columnCount: 2 }] });
      expect(JSON.stringify((await bridge.execute("readEdsRawRows", { sheetName: "Sales", startRow: 2, rowCount: 1 })).data)).toContain("150");
      expect((await bridge.execute("getKernelPackagesInfo", {})).data).toMatchObject({ available: true });
      await bridge.execute("editNotebookCells", { editVersion: 0, cells: [{ ...pythonCell, inputCellIds: [],
        fileNames: ["bridge-synthetic.xlsx"], code: "result = pd.read_excel(files['bridge-synthetic.xlsx'])" }] });
      expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 1, totalCells: 1 });
      expect(bridge.getVerifiedDraft()).toBeUndefined();
      expect(options.request).toEqual(original);
      await expect(bridge.execute("readEdsRawRows", { sheetName: "Sales", rowCount: 21 })).rejects.toBeInstanceOf(HarnessToolArgumentsError);
    } finally { bridge.close(); }
  });

  it.each(["missing-workbook-port", "missing-manifest", "name", "hash", "sheet-name", "rows", "columns"])("本次原件 %s 不匹配即拒绝", async (variant) => {
    const { options } = await notebookFixture();
    attachWorkbook(options);
    if (variant === "missing-workbook-port") delete options.rawWorkbook;
    if (variant === "missing-manifest") delete options.request.rawWorkbookManifest;
    if (variant === "name") options.rawWorkbook!.fileName = "another.xlsx";
    if (variant === "hash") options.rawWorkbook!.contentHash = "b".repeat(64);
    if (variant === "sheet-name") options.rawWorkbook!.sheets[0].sheet = "Another";
    if (variant === "rows") options.rawWorkbook!.sheets[0].data.push(["West", 9]);
    if (variant === "columns") options.rawWorkbook!.sheets[0].data[0].push("extra");
    expect(() => createNotebookToolBridge(options)).toThrow(expect.objectContaining({ code: "workbook_context_mismatch" }));
  });

  it.each(["missing", "another", "traversal"])("Python 文件 %s 不能借现有或新建单元访问项目任意原件", async (variant) => {
    const { options } = await notebookFixture();
    if (variant !== "missing") attachWorkbook(options);
    const target = variant === "traversal" ? "../bridge-synthetic.xlsx" : "another.xlsx";
    const runner = vi.fn(options.notebookRunner);
    const bridge = createNotebookToolBridge({ ...options, notebookRunner: runner });
    try {
      await expect(bridge.execute("editNotebookCells", { editVersion: 0, cells: [{ ...pythonCell, fileNames: [target] }] })).rejects.toThrow();
      expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 0 });
      expect(runner).not.toHaveBeenCalled();
    } finally { bridge.close(); }
    options.request.notebookContext!.document.cells.push({ ...pythonCell, fileNames: [target] });
    expect(() => createNotebookToolBridge({ ...options, notebookRunner: runner })).toThrow();
    expect(runner).not.toHaveBeenCalled();
  });

  it.each(["missing", "disabled"])("Python 能力 %s 时目录与运行一致拒绝，不因提供 info 端口而开放", async (variant) => {
    const { options } = await notebookFixture();
    const info = vi.fn(async () => ({ available: true }));
    options.pythonRuntimeInfo = info;
    if (variant === "missing") delete options.notebookCapabilities;
    else options.notebookCapabilities = { python: { enabled: false, reason: "synthetic deployment policy" } };
    const runner = vi.fn(options.notebookRunner);
    const bridge = createNotebookToolBridge({ ...options, notebookRunner: runner });
    try {
      const catalog = bridge.catalog();
      expect(catalog.map((tool) => tool.name)).not.toContain("getKernelPackagesInfo");
      expect(JSON.stringify(catalog.find((tool) => tool.name === "editNotebookCells")!.parameters)).not.toContain('"const":"python"');
      await expect(bridge.execute("getKernelPackagesInfo", {})).rejects.toThrow("不允许调用该工具");
      await expect(bridge.execute("editNotebookCells", { editVersion: 0, cells: [pythonCell] })).rejects.toThrow("单元能力");
    } finally { bridge.close(); }
    options.request.notebookContext!.document.cells.push(pythonCell);
    expect(() => createNotebookToolBridge({ ...options, notebookRunner: runner })).toThrow(expect.objectContaining({ code: "python_unavailable" }));
    expect(info).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("能力与端口双重控制可选工具；schema 只开放八类，额外工具仍拒绝", async () => {
    const { options } = await notebookFixture();
    const bridge = createNotebookToolBridge(options);
    try {
      expect(bridge.catalog()).toHaveLength(4);
      const schema = JSON.stringify(bridge.catalog().find((tool) => tool.name === "editNotebookCells")!.parameters);
      for (const kind of ["data", "sql", "table", "chart", "python", "warehouseSql", "transform", "text", "parameter"]) expect(schema).toContain(`"const":"${kind}"`);
      expect(schema).not.toContain('"const":"semanticQuery"');
      for (const tool of ["getKernelPackagesInfo", "inspectEdsRawWorkbook", "readEdsRawRows", "inspectConnectionSchema", "callMcpTool", "createPythonCell"]) {
        await expect(bridge.execute(tool, {})).rejects.toThrow("不允许调用该工具");
      }
    } finally { bridge.close(); }
  });

  it("仅授权服务器目录的连接可被检查或新建 warehouseSql，端口不能被任意 ID 调用", async () => {
    const { options } = await notebookFixture();
    removeSources(options);
    options.request.notebookContext!.connections = [
      { id: "db_allowed", name: "Allowed", kind: "postgresql", allowAi: true },
      { id: "db_denied", name: "Denied", kind: "postgresql", allowAi: false },
    ];
    const inspector = vi.fn<NonNullable<NotebookToolBridgeOptions["connectionInspector"]>>(async () => ({ columns: [
      { table_schema: "public", table_name: "sales", column_name: "amount", data_type: "numeric" },
    ], truncated: false }));
    const runner = vi.fn(options.notebookRunner);
    const bridge = createNotebookToolBridge({ ...options, connectionInspector: inspector, notebookRunner: runner });
    try {
      expect(bridge.catalog().map((tool) => tool.name)).toContain("inspectConnectionSchema");
      await bridge.execute("inspectConnectionSchema", { connectionId: "db_allowed" });
      expect(inspector).toHaveBeenCalledOnce();
      expect(inspector.mock.calls[0][0]).toBe("db_allowed");
      expect(inspector.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
      for (const id of ["db_denied", "outside"]) {
        await expect(bridge.execute("inspectConnectionSchema", { connectionId: id })).rejects.toThrow("未授权");
        await expect(bridge.execute("editNotebookCells", { editVersion: 0, cells: [{ ...warehouseCell, connectionId: id }] })).rejects.toThrow("未授权");
      }
      expect(inspector).toHaveBeenCalledOnce();
      await bridge.execute("editNotebookCells", { editVersion: 0, cells: [warehouseCell] });
      expect((await bridge.execute("cellSearch", {})).data).toMatchObject({ editVersion: 1, totalCells: 1 });
      expect(bridge.getVerifiedDraft()).toBeUndefined();
      expect(runner).not.toHaveBeenCalled();
    } finally { bridge.close(); }
    options.request.notebookContext!.document.cells.push({ ...warehouseCell, connectionId: "db_denied" });
    expect(() => createNotebookToolBridge({ ...options, notebookRunner: runner })).toThrow(expect.objectContaining({ code: "notebook_reference_unavailable" }));
    expect(runner).not.toHaveBeenCalled();
  });

  it.each(["revoke", "cancel"])("连接检查 %s 后拒绝迟到结果、关闭会话且不返回草稿", async (variant) => {
    const { options } = await notebookFixture();
    options.request.notebookContext!.connections = [{ id: "db_allowed", name: "Allowed", kind: "postgresql", allowAi: true }];
    let allowed = true;
    let complete!: (value: { columns: []; truncated: boolean }) => void;
    const pendingSchema = new Promise<{ columns: []; truncated: boolean }>((resolve) => { complete = resolve; });
    let receivedSignal: AbortSignal | undefined;
    const bridge = createNotebookToolBridge({ ...options, authorizeCurrentAccess: () => { if (!allowed) throw new Error("revoked"); },
      connectionInspector: async (_id, signal) => { receivedSignal = signal; return pendingSchema; } });
    const controller = new AbortController();
    const pending = bridge.execute("inspectConnectionSchema", { connectionId: "db_allowed" }, controller.signal);
    if (variant === "revoke") allowed = false;
    else controller.abort();
    if (variant === "revoke") complete({ columns: [], truncated: false });
    await expect(pending).rejects.toThrow(variant === "revoke" ? "revoked" : "已关闭或取消");
    expect(receivedSignal!.aborted).toBe(true);
    complete({ columns: [], truncated: false });
    await Promise.resolve();
    expect(() => bridge.getVerifiedDraft()).toThrow("已关闭或取消");
    expect(() => bridge.catalog()).toThrow("已关闭或取消");
    bridge.close();
  });
});
