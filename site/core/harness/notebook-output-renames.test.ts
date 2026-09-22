import { describe, expect, it } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { runNotebook } from "@/core/notebook/server/runtime";
import { adoptNotebookDraft } from "@/core/notebook/client-state";
import type { NotebookCell } from "@/core/notebook/definition";
import type { HarnessObservation, HarnessRequest } from "./contracts";
import { buildHarnessContextSelection } from "./context-selector";
import { executeHarnessTool, harnessToolCatalog, type HarnessToolContext } from "./tool-registry";

const parameter: Extract<NotebookCell, { kind: "parameter" }> = {
  id: "threshold", kind: "parameter", title: "最低金额", outputName: "minimum",
  parameter: { type: "number", value: 120 },
};
const sql: Extract<NotebookCell, { kind: "sql" }> = { id: "calculation", kind: "sql", title: "金额计算",
  inputCellIds: [parameter.id], outputName: "calculated", sql: "SELECT value * 2 AS total FROM minimum" };
const table: NotebookCell = { id: "display", kind: "table", title: "结果", inputCellId: sql.id, columns: ["total"] };
const python: Extract<NotebookCell, { kind: "python" }> = { id: "python", kind: "python", title: "Python 复制",
  inputCellIds: [parameter.id], outputName: "copied", code: "copied = minimum.copy()", fileNames: [] };

function fixture(cells: NotebookCell[] = [parameter, sql, table]) {
  const { product } = semanticFixture();
  product.appSpec.dataSources = [];
  const request: HarnessRequest = { idempotencyKey: "output_rename_fixture", instruction: "修改参数输出变量名称，并检查单元依赖",
    role: "editor", pageId: "page_home", appSpec: product.appSpec, recipes: [],
    notebookContext: { sourceIds: [], document: { name: "改名验证", revision: 3, cells: structuredClone(cells) } } };
  const context: HarnessToolContext = { request, now: Date.now, id: () => crypto.randomUUID(),
    dataRuntime: { rowsByDataSourceId: {} },
    notebookCellSession: { document: structuredClone(request.notebookContext!.document), editVersion: 0 },
    notebookRunner: (artifact, ctx) => runNotebook({ document: { name: artifact.name, revision: 3, cells: artifact.cells },
      sources: [], forAi: true, signal: ctx.signal, log: () => {} }),
  };
  return { request, context };
}

describe("Notebook 改名工具回执与真实试运行门槛", () => {
  it("影响回执进入普通及压缩模型 Context，保持稳定 ID 且不携带代码或数据行", async () => {
    const { request, context } = fixture();
    const original = structuredClone(request);
    const edit = await executeHarnessTool("editNotebookCells", { editVersion: 0,
      cells: [{ ...parameter, outputName: "amount_floor" }] }, context);
    expect(edit.data).toMatchObject({ editVersion: 1, next: "runNotebookCells", outputRenames: [{
      cellId: parameter.id, previousName: "minimum", nextName: "amount_floor",
      preservedReferences: [{ cellId: sql.id }], codeChecks: [{ cellId: sql.id, reason: "input-name" }],
      affectedCellIds: [parameter.id, sql.id, table.id],
    }], renameNotice: expect.stringContaining("未自动改写") });
    expect(JSON.stringify(edit.data)).not.toContain(sql.sql);
    expect(context.notebookCellSession!.document.cells[1]).toEqual(sql);
    expect(context.notebookCellSession!.document.cells[2]).toEqual(table);
    const observation: HarnessObservation = { toolName: "editNotebookCells", toolCallId: "rename",
      summary: edit.summary, data: edit.data };
    for (const compacted of [false, true]) {
      const selection = buildHarnessContextSelection(request, [observation], 1, compacted);
      expect(selection.context.latestObservation).toMatchObject({ result: edit.data });
    }
    expect(request).toEqual(original);
  });

  it("旧 SQL 实际失败并阻断展示；修复后成功、提交仍待人工采用且拒绝旧版本", async () => {
    const { request, context } = fixture();
    const original = structuredClone(request);
    await executeHarnessTool("editNotebookCells", { editVersion: 0,
      cells: [{ ...parameter, outputName: "amount_floor" }] }, context);
    const failed = await executeHarnessTool("runNotebookCells", { editVersion: 1 }, context);
    expect(failed.data).toMatchObject({ status: "failure", errors: [
      { cellId: sql.id, status: "failure" }, { cellId: table.id, status: "blocked" },
    ] });
    expect(context.notebookCellSession!.run!.cells.find((cell) => cell.cellId === sql.id)?.resultRef).toBeUndefined();
    await expect(executeHarnessTool("submitNotebookDraft", { editVersion: 1 }, context)).rejects.toThrow("尚未完整试运行");
    const edit = await executeHarnessTool("editNotebookCells", { editVersion: 1,
      cells: [{ ...sql, sql: "SELECT value * 2 AS total FROM amount_floor" }] }, context);
    expect(edit.data).not.toHaveProperty("outputRenames");
    expect(context.notebookCellSession!.run).toBeUndefined();
    await expect(executeHarnessTool("submitNotebookDraft", { editVersion: 2 }, context)).rejects.toThrow("尚未完整试运行");
    const success = await executeHarnessTool("runNotebookCells", { editVersion: 2 }, context);
    expect(success.data).toMatchObject({ status: "success", results: expect.arrayContaining([
      expect.objectContaining({ cellId: table.id, rows: [{ total: 240 }] }),
    ]) });
    const submitted = await executeHarnessTool("submitNotebookDraft", { editVersion: 2 }, context);
    expect(request).toEqual(original);
    expect(adoptNotebookDraft(request.notebookContext!.document, submitted.notebookArtifact!).cells[0])
      .toMatchObject({ id: parameter.id, outputName: "amount_floor" });
    expect(() => adoptNotebookDraft({ ...request.notebookContext!.document, revision: 4 }, submitted.notebookArtifact!)).toThrow();
  }, 15000);

  it("同批更名和修复仍返回待核对项，不把影响分析当作成功证据", async () => {
    const { context } = fixture();
    const result = await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [
      { ...parameter, outputName: "amount_floor" }, { ...sql, sql: "SELECT value * 2 AS total FROM amount_floor" },
    ] }, context);
    expect(result.data).toMatchObject({ outputRenames: [{ codeChecks: [{ cellId: sql.id, reason: "input-name" }] }] });
    await expect(executeHarnessTool("submitNotebookDraft", { editVersion: 1 }, context)).rejects.toThrow("尚未完整试运行");
    expect((await executeHarnessTool("runNotebookCells", { editVersion: 1 }, context)).data).toMatchObject({ status: "success" });
  }, 15000);

  it("合法名称交换校验最终图；重名、陈旧版本与取消不改任务状态", async () => {
    const other: NotebookCell = { ...parameter, id: "other", title: "独立参数", outputName: "other", parameter: { type: "number", value: 2 } };
    const { context } = fixture([parameter, other]);
    const before = structuredClone(context.notebookCellSession);
    await expect(executeHarnessTool("editNotebookCells", { editVersion: 0,
      cells: [{ ...parameter, outputName: "other" }] }, context)).rejects.toThrow();
    expect(context.notebookCellSession).toEqual(before);
    const swapped = await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [
      { ...parameter, outputName: "other" }, { ...other, outputName: "minimum" },
    ] }, context);
    expect(swapped.data).toMatchObject({ outputRenames: [{ cellId: parameter.id }, { cellId: other.id }] });
    const changed = structuredClone(context.notebookCellSession);
    await expect(executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [parameter] }, context)).rejects.toThrow("版本");
    const controller = new AbortController(); controller.abort(); context.signal = controller.signal;
    await expect(executeHarnessTool("editNotebookCells", { editVersion: 1, cells: [parameter] }, context)).rejects.toThrow();
    expect(context.notebookCellSession).toEqual(changed);
  });

  it("Python 专用入口沿用同源自身输出与直接输入检查，不自动修改 Python 文本", async () => {
    const downstream: NotebookCell = { ...sql, inputCellIds: [python.id], sql: "SELECT value AS total FROM copied" };
    const { context } = fixture([parameter, python, downstream, table]);
    const changed = { ...python, outputName: "renamed_copy" };
    const edit = await executeHarnessTool("createPythonCell", { editVersion: 0, cell: changed }, context);
    expect(edit.data).toMatchObject({ outputRenames: [{ cellId: python.id,
      codeChecks: expect.arrayContaining([{ cellId: python.id, title: python.title, kind: "python", reason: "python-output" },
        { cellId: sql.id, title: sql.title, kind: "sql", reason: "input-name" }]) }] });
    expect(context.notebookCellSession!.document.cells[1]).toEqual(changed);
    expect(context.notebookCellSession!.document.cells[2]).toEqual(downstream);
    await expect(executeHarnessTool("submitNotebookDraft", { editVersion: 1 }, context)).rejects.toThrow("尚未完整试运行");
  });

  it("已有成功回执因改名失效；无改名普通编辑不增加回执字段", async () => {
    const { context } = fixture();
    await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [{ ...parameter, title: "更新标题" }] }, context);
    await executeHarnessTool("runNotebookCells", { editVersion: 1 }, context);
    const previousRunId = context.notebookCellSession!.run!.runId;
    const edit = await executeHarnessTool("editNotebookCells", { editVersion: 1,
      cells: [{ ...sql, outputName: "renamed_total" }] }, context);
    expect(edit.data).toMatchObject({ outputRenames: [{ codeChecks: [], preservedReferences: [{ cellId: table.id }] }] });
    expect(context.notebookCellSession).toMatchObject({ editVersion: 2, lastRunVersion: 1 });
    expect(context.notebookCellSession!.run).toBeUndefined();
    expect(context.notebookCellSession!.runVersion).toBeUndefined();
    await expect(executeHarnessTool("cellSearch", { cellId: sql.id, view: "output", editVersion: 2, runId: previousRunId }, context))
      .rejects.toThrow("运行结果已变化或失效");
    const search = await executeHarnessTool("cellSearch", { cellId: sql.id, view: "output", editVersion: 2 }, context);
    expect(search.data).toMatchObject({ runStatus: "stale" });
    expect(JSON.stringify(search.data)).not.toContain('"total":240');
    await expect(executeHarnessTool("submitNotebookDraft", { editVersion: 2 }, context)).rejects.toThrow("尚未完整试运行");
  }, 15000);

  it("两个编辑目录声明不自动改码；工具参数与权限模式保持", () => {
    const { request } = fixture([parameter, python]);
    const catalog = harnessToolCatalog({ names: ["editNotebookCells", "createPythonCell"], request });
    expect(catalog).toHaveLength(2);
    for (const tool of catalog) {
      expect(tool.description).toContain("outputRenames.codeChecks");
      expect(tool.description).toMatch(/不自动改写|不会自动改写/u);
    }
  });
});
