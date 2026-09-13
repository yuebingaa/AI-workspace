import { afterEach, describe, it, expect, vi } from "vitest";
import { createExecutionState } from "@/core/changesets";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { createStudioSemanticActions, type SemanticActionsContext } from "./semantics";

function context() {
  const { product, model, source, rows } = semanticFixture();
  const state: SemanticActionsContext = { pageId: "page_home", role: "editor", busy: false,
    latestDatasetWorkspaceRef: { current: { dataProduct: product, execution: createExecutionState(product.appSpec),
      dataRuntime: { rowsByDataSourceId: { [source.id]: rows } }, activeDataSourceId: "", auditRecords: [], queryRecords: [],
      harnessTasks: [], assistantConversation: [], edsWorkspace: null } },
    setDataProduct: vi.fn(), setActiveDataSourceId: vi.fn(), setSaveLabel: vi.fn(), setPersistenceNotice: vi.fn(),
    persistExplicitly: vi.fn(() => ({ persisted: true, notice: null })),
  };
  return { state, model, source };
}
afterEach(() => vi.unstubAllGlobals());
describe("语义模型界面控制器", () => {
  it("连续编辑读取最新快照，选择同步数据源，并使用原有完整保存边界", () => {
    const { state, model, source } = context();
    const actions = createStudioSemanticActions(state);
    actions.save(model); actions.save({ ...model, name: "修订销售" });
    const current = state.latestDatasetWorkspaceRef.current;
    expect(current.dataProduct.semanticLayer?.models[0]).toMatchObject({ name: "修订销售", version: 2 });
    expect(current.activeDataSourceId).toBe(source.id);
    expect(state.persistExplicitly).toHaveBeenLastCalledWith(current.execution, current.auditRecords, current.queryRecords,
      current.dataProduct, current.harnessTasks, current.edsWorkspace, current.assistantConversation);
    actions.select(null); expect(state.latestDatasetWorkspaceRef.current.dataProduct.semanticLayer?.selectedByWorkspace).toEqual({});
    actions.select(model.id); expect(state.setActiveDataSourceId).toHaveBeenLastCalledWith(source.id);
  });
  it("存储失败明确提示仅当前会话，不误报持久保存", () => {
    const { state, model } = context();
    vi.mocked(state.persistExplicitly).mockReturnValue({ persisted: false, notice: "存储空间不足" });
    createStudioSemanticActions(state).save(model);
    expect(state.setSaveLabel).toHaveBeenCalledWith(expect.stringContaining("仅当前会话"));
    expect(state.setPersistenceNotice).toHaveBeenCalledWith("存储空间不足");
  });
  it("删除须确认，取消不修改；确认后保留表格、页面及历史", () => {
    const { state, model } = context(); const actions = createStudioSemanticActions(state); actions.save(model);
    const before = structuredClone(state.latestDatasetWorkspaceRef.current);
    const confirm = vi.fn(() => false); vi.stubGlobal("window", { confirm });
    expect(actions.remove(model.id)).toBe(false);
    expect(state.latestDatasetWorkspaceRef.current).toEqual(before);
    confirm.mockReturnValue(true); expect(actions.remove(model.id)).toBe(true);
    const after = state.latestDatasetWorkspaceRef.current;
    expect(after.dataProduct.semanticLayer?.models).toEqual([]);
    expect(after.dataRuntime).toEqual(before.dataRuntime); expect(after.execution).toEqual(before.execution);
    expect(after.harnessTasks).toEqual(before.harnessTasks); expect(after.dataProduct.datasets).toEqual(before.dataProduct.datasets);
  });
  it("查看者不能修改定义，任务执行期间不能切换或删除", () => {
    const { state, model } = context(); const actions = createStudioSemanticActions(state); actions.save(model);
    state.role = "viewer";
    expect(() => actions.save(model)).toThrow("无权"); expect(() => actions.remove(model.id)).toThrow("无权");
    actions.select(null); actions.select(model.id);
    state.role = "editor"; state.busy = true;
    expect(() => actions.save(model)).toThrow("等待"); expect(() => actions.select(null)).toThrow("等待"); expect(() => actions.remove(model.id)).toThrow("等待");
  });
});
