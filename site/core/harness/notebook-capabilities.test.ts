import { describe, expect, it, vi } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import type { NotebookCapabilities } from "@/core/notebook/capabilities";
import type { HarnessRequest } from "./contracts";
import { buildHarnessContextSelection } from "./context-selector";
import { executeHarnessTool, harnessToolCatalog, type HarnessToolContext } from "./tool-registry";

const disabled: NotebookCapabilities = { python: { enabled: false, reason: "测试部署已关闭 Python" } };

function fixture() {
  const { product, source, rows } = semanticFixture();
  const python = { id: "python", kind: "python" as const, title: "保留的 Python", inputCellIds: ["data"], fileNames: [],
    outputName: "python_result", code: "python_result = sales_data.copy()" };
  const request: HarnessRequest = {
    idempotencyKey: "disabled_python_test", instruction: "查看并修改 Python 单元", role: "editor", pageId: "page_home",
    appSpec: product.appSpec, recipes: [], dataSourceId: source.id,
    notebookContext: { sourceIds: [source.id], selectedCellIds: [python.id], document: { name: "能力关闭", revision: 3, cells: [
      { id: "data", kind: "data", title: "销售数据", sourceDataSourceId: source.id, outputName: "sales_data" }, python,
    ] } },
  };
  const context: HarnessToolContext = {
    request, dataRuntime: { rowsByDataSourceId: { [source.id]: rows } }, now: Date.now, id: () => "capability_test",
    notebookCapabilities: disabled,
    notebookCellSession: { document: structuredClone(request.notebookContext!.document), editVersion: 0 },
    pythonRuntimeInfo: vi.fn(async () => ({ available: true })),
  };
  return { request, context, python };
}

describe("Harness Notebook 能力关闭", () => {
  it("从模型目录移除 Python 专属工具和 Python 计划分支", () => {
    const { request } = fixture();
    const tools = harnessToolCatalog({
      names: ["createAnalysisPlan", "createNotebookDraft", "editNotebookCells", "createPythonCell", "getKernelPackagesInfo", "cellSearch"],
      request, notebookCapabilities: disabled,
    });
    expect(tools.map((tool) => tool.name)).not.toContain("createPythonCell");
    expect(tools.map((tool) => tool.name)).not.toContain("getKernelPackagesInfo");
    expect(tools.map((tool) => tool.name)).not.toContain("createNotebookDraft");
    const plan = tools.find((tool) => tool.name === "createAnalysisPlan");
    expect(JSON.stringify(plan?.parameters)).not.toContain('"const":"python"');
    expect(plan?.description).toContain("已关闭 Python 能力");
    expect(tools.map((tool) => tool.name)).toContain("cellSearch");
  });

  it("服务端拒绝伪造的 Python 工具调用，但仍可只读检查旧定义", async () => {
    const { context, python } = fixture();
    await expect(executeHarnessTool("createPythonCell", { editVersion: 0, cell: python }, context))
      .rejects.toThrow("Notebook 能力已关闭");
    await expect(executeHarnessTool("getKernelPackagesInfo", {}, context)).rejects.toThrow("Notebook 能力已关闭");
    expect(context.pythonRuntimeInfo).not.toHaveBeenCalled();

    const inspected = await executeHarnessTool("cellSearch", { cellId: python.id, view: "source" }, context);
    expect(inspected.data).toMatchObject({
      sourceCellId: python.id,
      cells: [expect.objectContaining({ id: python.id, kind: "python" })],
    });
    expect(context.notebookCellSession?.document.cells.find((cell) => cell.id === python.id)).toEqual(python);
  });

  it("保护整稿、增量会话和试运行中的旧 Python 定义", async () => {
    const { context, request, python } = fixture();
    const data = request.notebookContext!.document.cells[0];
    await expect(executeHarnessTool("createNotebookDraft", {
      name: "遗漏 Python 的整稿",
      cells: [data],
    }, context)).rejects.toThrow("原定义必须保留");
    await expect(executeHarnessTool("editNotebookCells", {
      editVersion: 0,
      cells: [],
      removeCellIds: [python.id],
    }, context)).rejects.toThrow("不能通过 Agent 修改或移除");
    context.notebookRunner = vi.fn();
    await expect(executeHarnessTool("runNotebookCells", { editVersion: 0 }, context))
      .rejects.toThrow("不能由 Agent 试运行或提交整稿");
    await expect(executeHarnessTool("submitNotebookDraft", { editVersion: 0 }, context))
      .rejects.toThrow("不能由 Agent 试运行或提交整稿");
    expect(context.notebookRunner).not.toHaveBeenCalled();
  });

  it("上下文选择不再要求不存在的 Python 工具，并明确阻断混合整稿修改", () => {
    const { request } = fixture();
    const blocked = buildHarnessContextSelection(
      { ...request, instruction: "修改独立 SQL 单元" }, [], 1, false,
      undefined, undefined, [], [], undefined, false, disabled,
    );
    expect(blocked.blockingReason).toContain("可手动编辑独立 SQL");
    expect(blocked.toolNames).not.toContain("createPythonCell");
    expect(blocked.toolNames).not.toContain("getKernelPackagesInfo");
    expect(JSON.stringify(blocked.context)).not.toContain("createPythonCell 创建/更新");

    const inspection = buildHarnessContextSelection(
      { ...request, instruction: "查看 Python 单元的定义" }, [], 1, false,
      undefined, undefined, [], [], undefined, false, disabled,
    );
    expect(inspection.blockingReason).toBeUndefined();
    expect(inspection.toolNames).toEqual(["cellSearch"]);
    expect(JSON.stringify(inspection.context)).toContain("已有定义只读保留");
  });
});
