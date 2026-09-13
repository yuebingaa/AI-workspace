import { afterEach, describe, expect, it, vi } from "vitest";
import { createChangeSetAuditRecord } from "@/core/audit";
import { createExecutionState } from "@/core/changesets";
import { ensureInitialBlankWorkspaceInProduct, INITIAL_WORKSPACE_PAGE_ID, workspaceInterfaceSummaries } from "@/core/workspaces";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { createStudioPageActions, selectablePageId, type StudioPageActionsContext } from "./pages";

function context(): StudioPageActionsContext {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  const dataProduct = ensureInitialBlankWorkspaceInProduct(structuredClone(demoFixtureResult.data.dataProduct));
  const execution = createExecutionState(dataProduct.appSpec);
  return {
    role: "editor", dataProduct, execution, renderedSpec: execution.present,
    activePageId: INITIAL_WORKSPACE_PAGE_ID,
    interfaces: workspaceInterfaceSummaries(execution.present, dataProduct.datasets), canvasMode: "preview",
    latestDatasetWorkspaceRef: { current: { execution, dataProduct, dataRuntime: { rowsByDataSourceId: {} },
      activeDataSourceId: "", auditRecords: [], queryRecords: [], harnessTasks: [], assistantConversation: [], edsWorkspace: null } },
    setExecution: vi.fn(), setDataProduct: vi.fn(), setActivePageId: vi.fn(), setActiveDataSourceId: vi.fn(),
    setIsDataSourceOpen: vi.fn(), setPendingPuckChangeSet: vi.fn(), setPendingChangeSource: vi.fn(),
    setCanvasMode: vi.fn(), clearPuckDraft: vi.fn(), setPuckSessionKey: vi.fn(),
    setValidationError: vi.fn(), setSaveLabel: vi.fn(), ensurePuckDraft: vi.fn(), auditCurrentPreviewCancellation: vi.fn(),
    addAudit: vi.fn((changeSet, source, status, error) => createChangeSetAuditRecord(changeSet, "editor", source, status, error)),
    persistExplicitly: vi.fn(() => ({ persisted: true, notice: null })),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("工作界面控制器保持原有操作边界", () => {
  it("查看者不能新建、重命名或删除", () => {
    const state = context(); state.role = "viewer";
    const prompt = vi.fn(), confirm = vi.fn();
    vi.stubGlobal("window", { prompt, confirm });
    const actions = createStudioPageActions(state);
    actions.handleCreateInterface("新界面");
    actions.handleRenamePage(state.activePageId, "空白工作界面");
    actions.handleDeletePage(state.activePageId, "空白工作界面");
    expect(state.setExecution).not.toHaveBeenCalled();
    expect(state.persistExplicitly).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  });

  it("连续新建读取最新共享快照，两个空白界面都保留", () => {
    const state = context(), original = structuredClone(state.execution.present);
    const actions = createStudioPageActions(state);
    actions.handleCreateInterface("质量分析");
    actions.handleCreateInterface("库存分析");
    const result = state.latestDatasetWorkspaceRef.current.execution.present;
    expect(result.pages).toHaveLength(original.pages.length + 2);
    expect(result.pages.slice(-2).map((page) => page.title)).toEqual(["质量分析", "库存分析"]);
    expect(result.pages.slice(-2).every((page) => !page.root.children?.length)).toBe(true);
    expect(state.execution.present).toEqual(original);
    expect(state.persistExplicitly).toHaveBeenCalledTimes(2);
    expect(state.setActiveDataSourceId).toHaveBeenLastCalledWith("");
  });

  it("重命名仅生成手动 ChangeSet 预览，不写入正式页面", () => {
    const state = context(), original = structuredClone(state.execution.present);
    vi.stubGlobal("window", { prompt: vi.fn(() => "新的标题") });
    createStudioPageActions(state).handleRenamePage(state.activePageId, "空白工作界面");
    const next = vi.mocked(state.setExecution).mock.calls[0][0];
    expect(typeof next).not.toBe("function");
    if (typeof next === "function") throw new Error("expected preview state");
    expect(next.present).toEqual(original);
    expect(next.preview?.appSpec.pages.find((page) => page.id === state.activePageId)?.title).toBe("新的标题");
    expect(state.setPendingChangeSource).toHaveBeenCalledWith("manual");
    expect(state.persistExplicitly).not.toHaveBeenCalled();
  });

  it("最后一个工作界面不能删除", () => {
    const state = context();
    const confirm = vi.fn(() => true); vi.stubGlobal("window", { confirm });
    createStudioPageActions(state).handleDeletePage(state.activePageId, "空白工作界面");
    expect(state.setValidationError).toHaveBeenCalledWith("至少需要保留一个工作界面。");
    expect(confirm).not.toHaveBeenCalled();
    expect(state.setExecution).not.toHaveBeenCalled();
  });

  it("删除先确认再预览，保留正式页面与数据，取消确认不操作", () => {
    const state = context();
    createStudioPageActions(state).handleCreateInterface("待删除界面");
    state.execution = state.latestDatasetWorkspaceRef.current.execution;
    state.dataProduct = state.latestDatasetWorkspaceRef.current.dataProduct;
    state.renderedSpec = state.execution.present;
    state.interfaces = workspaceInterfaceSummaries(state.renderedSpec, state.dataProduct.datasets);
    state.activePageId = state.renderedSpec.pages.at(-1)!.id;
    const original = structuredClone(state.execution.present);
    const confirm = vi.fn(() => false); vi.stubGlobal("window", { confirm });
    vi.mocked(state.setExecution).mockClear(); vi.mocked(state.persistExplicitly).mockClear();
    const actions = createStudioPageActions(state);
    actions.handleDeletePage(state.activePageId, "待删除界面");
    expect(state.setExecution).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    actions.handleDeletePage(state.activePageId, "待删除界面");
    const next = vi.mocked(state.setExecution).mock.calls[0][0];
    if (typeof next === "function") throw new Error("expected preview state");
    expect(next.present).toEqual(original);
    expect(next.preview?.appSpec.pages.some((page) => page.id === state.activePageId)).toBe(false);
    expect(next.preview?.appSpec.dataSources).toEqual(original.dataSources);
    expect(state.persistExplicitly).not.toHaveBeenCalled();
    expect(state.setActivePageId).toHaveBeenCalledWith(INITIAL_WORKSPACE_PAGE_ID);
  });

  it("无效界面选择不切换；编辑模式下合法切换继续初始化编辑草稿", () => {
    const state = context(); state.canvasMode = "edit";
    const actions = createStudioPageActions(state);
    actions.handleInterfaceChange("missing");
    expect(state.setExecution).not.toHaveBeenCalled();
    actions.handleInterfaceChange(state.activePageId);
    expect(state.ensurePuckDraft).toHaveBeenCalledWith(state.activePageId, state.execution.present);
    expect(selectablePageId(state.renderedSpec, "missing")).toBe(INITIAL_WORKSPACE_PAGE_ID);
  });
});
