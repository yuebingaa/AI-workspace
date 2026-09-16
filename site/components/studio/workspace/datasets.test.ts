import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionState, type ChangeSetExecutionState } from "@/core/changesets";
import { confirmDatasetAiAccess, DatasetAiAccessConflictError, deleteUploadedDataset } from "@/core/datasets/client";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { analyzeEdsWorkbook, EDS_WORKSPACE_PAGE_ID, type EdsAnalysisResponse } from "@/core/eds";
import { createBlankWorkspaceInAppSpec, ensureInitialBlankWorkspaceInProduct, INITIAL_WORKSPACE_PAGE_ID } from "@/core/workspaces";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { createSyntheticEdsFixture } from "@/fixtures/eds-synthetic";
import { createStudioDatasetActions, useStudioDatasetsState, type StudioDatasetActionsContext, type StudioDatasetsState } from "./datasets";

vi.mock("@/core/datasets/client", async (original) => ({ ...await original<object>(),
  confirmDatasetAiAccess: vi.fn(), deleteUploadedDataset: vi.fn(),
}));

function context() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  const dataProduct = ensureInitialBlankWorkspaceInProduct(structuredClone(demoFixtureResult.data.dataProduct));
  dataProduct.appSpec = createBlankWorkspaceInAppSpec(dataProduct.appSpec, "第二界面", () => "second-workspace").appSpec;
  const execution = createExecutionState(dataProduct.appSpec);
  let datasets!: StudioDatasetsState;
  function Probe() { datasets = useStudioDatasetsState(dataProduct, execution.present, INITIAL_WORKSPACE_PAGE_ID); return null; }
  renderToStaticMarkup(createElement(Probe));
  const values: Record<string, unknown> = { ...datasets };
  const bindings = datasets as unknown as Record<string, unknown>;
  for (const key of Object.keys(bindings).filter((key) => key.startsWith("set"))) {
    const valueKey = key[3].toLowerCase() + key.slice(4);
    bindings[key] = vi.fn((next: unknown) => { values[valueKey] = typeof next === "function" ? next(values[valueKey]) : next; });
  }
  datasets.handleCloseEdsAnalysis = vi.fn();
  const state: StudioDatasetActionsContext = {
    datasets, role: "editor", renderedSpec: execution.present, activePageId: INITIAL_WORKSPACE_PAGE_ID,
    pendingChangeSource: null,
    latestDatasetWorkspaceRef: { current: { execution, dataProduct, dataRuntime: { rowsByDataSourceId: {} },
      activeDataSourceId: "", auditRecords: [], queryRecords: [], harnessTasks: [], assistantConversation: [], edsWorkspace: null } },
    assistant: { aiChangeSet: demoFixtureResult.data.repurchaseChangeSet, setAiMessage: vi.fn(), setAiMetadata: vi.fn(),
      setAiInstruction: vi.fn(), setAiRequestStatus: vi.fn(), setAiRequestError: vi.fn(), setHasValidAiPlan: vi.fn(),
      setHarnessTasks: vi.fn(), aiRequestAbortRef: { current: null }, harnessRequestActiveRef: { current: false } },
    setExecution: vi.fn(), setDataProduct: vi.fn(), setDataRuntime: vi.fn(), setAuditRecords: vi.fn(), setActivePageId: vi.fn(),
    setPendingPuckChangeSet: vi.fn(), setPendingChangeSource: vi.fn(), setCanvasMode: vi.fn(), clearPuckDraft: vi.fn(),
    setPuckSessionKey: vi.fn(), setValidationError: vi.fn(), setSaveLabel: vi.fn(), setPersistenceNotice: vi.fn(),
    persistExplicitly: vi.fn(() => ({ persisted: true, notice: null })), handleGenerateAiPlan: vi.fn(async () => {}),
  };
  return { state, values };
}

async function upload(name: string) {
  return parseCsvUpload({ originalFileName: `${name}.csv`, mimeType: "text/csv",
    stream: new Blob(["item,amount\nA,10\nB,20"]).stream(), now: () => new Date("2026-09-10T00:00:00.000Z") });
}

beforeEach(() => { vi.clearAllMocks(); vi.mocked(deleteUploadedDataset).mockResolvedValue(); });

describe("数据导入与选择控制器", () => {
  it("语义模型引用的数据源不能被提前删除", async () => {
    const { state } = context(), uploaded = await upload("semantic");
    createStudioDatasetActions(state).handleCsvUploaded(uploaded, undefined, state.activePageId);
    state.datasets.activeDataSource = uploaded.dataset.source;
    state.latestDatasetWorkspaceRef.current.dataProduct.semanticLayer = { models: [{ ...semanticFixture().model, sourceDatasetId: uploaded.dataset.datasetId }], selectedByWorkspace: {} };
    await expect(createStudioDatasetActions(state).handleDeleteDataset()).rejects.toThrow("语义模型引用");
    expect(deleteUploadedDataset).not.toHaveBeenCalled();
  });
  it("连续导入保留两份数据及各自界面归属，文件只挂载于会话", async () => {
    const { state, values } = context();
    const first = await upload("first"), second = await upload("second");
    const actions = createStudioDatasetActions(state);
    const secondPage = state.renderedSpec.pages.at(-1)!.id;
    const workbook = { file: new File(["fixture"], "second.xlsx"), sheetNames: ["Sheet1"] };
    actions.handleCsvUploaded(first, undefined, state.activePageId);
    actions.handleCsvUploaded(second, workbook, secondPage);
    const current = state.latestDatasetWorkspaceRef.current;
    expect(current.dataProduct.datasets.find((dataset) => dataset.id === first.dataset.datasetId)?.workspaceId).toBe(state.activePageId);
    expect(current.dataProduct.datasets.find((dataset) => dataset.id === second.dataset.datasetId)?.workspaceId).toBe(secondPage);
    expect(current.dataRuntime.rowsByDataSourceId[first.dataset.datasetId]).toEqual(first.rows);
    expect(current.dataRuntime.rowsByDataSourceId[second.dataset.datasetId]).toEqual(second.rows);
    expect(values.originalWorkbooks).toEqual([expect.objectContaining({ file: workbook.file, workspaceId: secondPage })]);
    expect(current.dataProduct).not.toHaveProperty("originalWorkbooks");
    expect(state.setActivePageId).toHaveBeenLastCalledWith(secondPage);
    expect(state.persistExplicitly).toHaveBeenCalledTimes(2);
  });

  it("导入目标已不存在时继续使用当前界面，持久化失败仍保留提示", async () => {
    const { state, values } = context();
    vi.mocked(state.persistExplicitly).mockReturnValue({ persisted: false, notice: "存储不可用" });
    const uploaded = await upload("fallback");
    createStudioDatasetActions(state).handleCsvUploaded(uploaded, undefined, "missing");
    expect(state.setActivePageId).toHaveBeenCalledWith(state.activePageId);
    expect(values.activeDataSourceId).toBe(uploaded.dataset.datasetId);
    expect(state.setPersistenceNotice).toHaveBeenCalledWith(expect.stringContaining("存储不可用"));
  });

  it("敏感字段授权冲突先同步服务端描述，再保留错误反馈", async () => {
    const { state } = context(), uploaded = await upload("consent");
    state.datasets.activeDataSource = uploaded.dataset.source;
    const error = new DatasetAiAccessConflictError("策略已更新", uploaded.dataset);
    vi.mocked(confirmDatasetAiAccess).mockRejectedValueOnce(error);
    await expect(createStudioDatasetActions(state).handleConfirmDatasetAiAccess("masked")).rejects.toBe(error);
    expect(state.latestDatasetWorkspaceRef.current.execution.present.dataSources).toContainEqual(uploaded.dataset.source);
    expect(state.setSaveLabel).toHaveBeenCalledWith("已保存 · 已同步服务端敏感字段策略");
  });

  it("正式组件或撤销历史仍引用的数据源不能删除", async () => {
    const { state } = context();
    const fixture = semanticFixture();
    // The default workspace is now blank: use an explicit bound chart fixture.
    fixture.product.appSpec.pages[0].root.children = [{ id: "bound_metric", type: "MetricCard", props: { label: "销售", trend: "", binding: {
      dataSourceId: fixture.source.id, field: "amount", aggregation: "sum", groupBy: null, filters: [], sort: [], limit: 100, format: { style: "auto" },
    } } }];
    state.latestDatasetWorkspaceRef.current.execution = createExecutionState(fixture.product.appSpec);
    state.datasets.activeDataSource = { ...fixture.source, ephemeral: true };
    await expect(createStudioDatasetActions(state).handleDeleteDataset()).rejects.toThrow("仍被页面组件或变更历史引用");
    expect(deleteUploadedDataset).not.toHaveBeenCalled();
  });

  it("删除完成时读取最新快照，不丢弃等待期间导入的另一份数据", async () => {
    const { state } = context(), first = await upload("delete"), second = await upload("keep");
    createStudioDatasetActions(state).handleCsvUploaded(first, undefined, state.activePageId);
    state.datasets.activeDataSource = first.dataset.source;
    let finish!: () => void;
    vi.mocked(deleteUploadedDataset).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const actions = createStudioDatasetActions(state), deletion = actions.handleDeleteDataset();
    actions.handleCsvUploaded(second, undefined, state.activePageId);
    finish(); await deletion;
    const next = vi.mocked(state.setDataProduct).mock.calls.at(-1)![0];
    if (typeof next === "function") throw new Error("expected document state");
    expect(next.datasets.some((dataset) => dataset.id === first.dataset.datasetId)).toBe(false);
    expect(next.datasets.some((dataset) => dataset.id === second.dataset.datasetId)).toBe(true);
    expect(state.datasets.setIsDataSourceOpen).toHaveBeenCalledTimes(2);
  });

  it("项目删除等待未完成的保存，归档后使用回收站文案", async () => {
    const { state } = context(), uploaded = await upload("archive");
    createStudioDatasetActions(state).handleCsvUploaded(uploaded, undefined, state.activePageId);
    state.datasets.activeDataSource = { ...uploaded.dataset.source, ephemeral: false };
    let finish!: () => void;
    state.flushProject = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const deletion = createStudioDatasetActions(state).handleDeleteDataset();
    expect(state.flushProject).toHaveBeenCalledOnce();
    expect(deleteUploadedDataset).not.toHaveBeenCalled();
    finish(); await deletion;
    expect(deleteUploadedDataset).toHaveBeenCalledWith(uploaded.dataset.datasetId);
    expect(state.setSaveLabel).toHaveBeenCalledWith("已保存 · 数据表已移入回收站");
  });

  it("项目保存失败时不删除数据，也不移除本地文档或原件", async () => {
    const { state } = context(), uploaded = await upload("keep-after-conflict");
    createStudioDatasetActions(state).handleCsvUploaded(uploaded, undefined, state.activePageId);
    state.datasets.activeDataSource = { ...uploaded.dataset.source, ephemeral: false };
    vi.clearAllMocks();
    state.flushProject = vi.fn().mockRejectedValue(new Error("项目保存冲突"));
    await expect(createStudioDatasetActions(state).handleDeleteDataset()).rejects.toThrow("项目保存冲突");
    expect(deleteUploadedDataset).not.toHaveBeenCalled();
    expect(state.setDataProduct).not.toHaveBeenCalled();
    expect(state.datasets.setOriginalWorkbooks).not.toHaveBeenCalled();
    expect(state.persistExplicitly).not.toHaveBeenCalled();
  });

  it("Notebook 的数据单元引用不能由详情页删除破坏", async () => {
    const { state } = context(), uploaded = await upload("notebook-dependency");
    createStudioDatasetActions(state).handleCsvUploaded(uploaded, undefined, state.activePageId);
    state.datasets.activeDataSource = uploaded.dataset.source;
    state.latestDatasetWorkspaceRef.current.dataProduct.notebooks = { page: { name: "分析", revision: 1, cells: [{ id: "source", kind: "data", title: "输入", sourceDataSourceId: uploaded.dataset.datasetId, outputName: "input" }] } };
    await expect(createStudioDatasetActions(state).handleDeleteDataset()).rejects.toThrow("Notebook 引用");
    expect(deleteUploadedDataset).not.toHaveBeenCalled();
  });

  it("待确认预览中的绑定仍保护数据源", async () => {
    const { state } = context(), uploaded = await upload("preview-dependency");
    createStudioDatasetActions(state).handleCsvUploaded(uploaded, undefined, state.activePageId);
    state.datasets.activeDataSource = uploaded.dataset.source;
    const preview = structuredClone(state.latestDatasetWorkspaceRef.current.execution.present);
    preview.pages[0].root.children = [{ id: "pending_metric", type: "MetricCard", props: { label: "合计", trend: "", binding: {
      dataSourceId: uploaded.dataset.datasetId, field: "amount", aggregation: "sum", groupBy: null, filters: [], sort: [], limit: 1, format: { style: "number" },
    } } }];
    state.latestDatasetWorkspaceRef.current.execution.preview = { appSpec: preview, changeSetId: "pending", operationIds: [] };
    await expect(createStudioDatasetActions(state).handleDeleteDataset()).rejects.toThrow("待确认预览引用");
    expect(deleteUploadedDataset).not.toHaveBeenCalled();
  });

  it("服务端拒绝删除时保留本地数据及原件，不报告已保存", async () => {
    const { state } = context(), uploaded = await upload("server-conflict");
    createStudioDatasetActions(state).handleCsvUploaded(uploaded, undefined, state.activePageId);
    state.datasets.activeDataSource = uploaded.dataset.source;
    vi.clearAllMocks();
    vi.mocked(deleteUploadedDataset).mockRejectedValueOnce(new Error("数据仍被引用，未删除：配方：合成处理"));
    await expect(createStudioDatasetActions(state).handleDeleteDataset()).rejects.toThrow("合成处理");
    expect(state.setDataProduct).not.toHaveBeenCalled();
    expect(state.datasets.setOriginalWorkbooks).not.toHaveBeenCalled();
    expect(state.setSaveLabel).not.toHaveBeenCalled();
  });

  it("分析指定数据源时默认附带其原工作簿，原件不可用时仍分析数据集", async () => {
    const { state } = context(), uploaded = await upload("analysis");
    state.renderedSpec = { ...state.renderedSpec, dataSources: [...state.renderedSpec.dataSources, uploaded.dataset.source] };
    const workbook = { id: "workbook", datasetId: uploaded.dataset.datasetId, workspaceId: state.activePageId,
      file: new File(["fixture"], "analysis.xlsx"), sheetNames: ["Sheet1"] };
    state.datasets.originalWorkbooks = [workbook];
    createStudioDatasetActions(state).handleAnalyzeDataSource(uploaded.dataset.datasetId);
    expect(vi.mocked(state.handleGenerateAiPlan).mock.calls[0][2]).toEqual({ dataSourceId: uploaded.dataset.datasetId, rawWorkbook: workbook.file });
    state.datasets.originalWorkbooks = [];
    createStudioDatasetActions(state).handleAnalyzeDataSource(uploaded.dataset.datasetId);
    expect(vi.mocked(state.handleGenerateAiPlan).mock.calls[1][2]).toEqual({ dataSourceId: uploaded.dataset.datasetId });
  });

  it("保留 EDS 导入行为和查看者边界，原文件仍只挂载于会话", () => {
    const { state, values } = context();
    const source = new File(["synthetic"], "eds.xlsx");
    const result: EdsAnalysisResponse = {
      ...analyzeEdsWorkbook(createSyntheticEdsFixture().sourceSheets),
      exportArtifact: {
        id: "workspace-refactor-fixture", status: "ready", fileName: "synthetic-eds.xlsx",
        downloadUrl: "/api/exports/workspace-refactor-fixture", rowCount: 30, fieldCount: 20, sizeBytes: 1,
        createdAt: "2026-09-10T00:00:00.000Z", expiresAt: "2026-09-10T00:10:00.000Z",
      },
    };
    state.role = "viewer";
    expect(() => createStudioDatasetActions(state).handleCreateEdsWorkspace([result], 0, source)).toThrow("查看者无权");
    expect(state.setExecution).not.toHaveBeenCalled();
    state.role = "editor";
    createStudioDatasetActions(state).handleCreateEdsWorkspace([result], 0, source);
    const execution = vi.mocked(state.setExecution).mock.calls[0][0] as ChangeSetExecutionState;
    expect(execution.present.pages.some((page) => page.id === EDS_WORKSPACE_PAGE_ID)).toBe(true);
    expect(state.setActivePageId).toHaveBeenCalledWith(EDS_WORKSPACE_PAGE_ID);
    expect(values.originalWorkbooks).toEqual([expect.objectContaining({ file: source })]);
    expect(state.persistExplicitly).toHaveBeenCalledTimes(1);
    expect(state.datasets.handleCloseEdsAnalysis).toHaveBeenCalled();
  });
});
