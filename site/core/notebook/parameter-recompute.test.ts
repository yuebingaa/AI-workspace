import { describe, expect, it, vi } from "vitest";
import type { NotebookCell } from "./definition";
import type { NotebookDocument } from "./contracts";
import { notebookRunRequestSchema } from "./contracts";
import { parameterValueChanges, selectParameterRecompute } from "./parameter-recompute";
import { executeNotebook } from "./server/execution";
import { executeNotebookSql } from "./server/query-engine";

const parameter = (id: string, value = 1): Extract<NotebookCell, { kind: "parameter" }> => ({
  id, title: id, kind: "parameter", outputName: id, parameter: { type: "number", value },
});
const query = (id: string, inputCellIds: string[]): Extract<NotebookCell, { kind: "sql" }> => ({
  id, title: id, kind: "sql", inputCellIds, outputName: id, sql: "SELECT 1 AS value",
});
function document(cells: NotebookCell[] = [parameter("minimum")]): NotebookDocument {
  return { name: "合成重算", revision: 3, lastDraftId: "accepted", cells };
}
function changed(before: NotebookDocument): NotebookDocument {
  const after = structuredClone(before);
  after.revision += 1;
  const cell = after.cells[0];
  if (cell.kind === "parameter") cell.parameter.value = cell.parameter.type === "number" ? 2 : "second";
  return after;
}

describe("已保存参数值变化", () => {
  it.each([
    { type: "number", value: 1 }, { type: "text", value: "first" },
    { type: "date", value: "2026-09-17" }, { type: "select", value: "first", options: ["first", "second"] },
  ] as const)("检测 $type 值变化且保持输入不变", (value) => {
    const before = document([{ ...parameter("minimum"), parameter: value.type === "select" ? { ...value, options: [...value.options] } : value }]);
    const after = changed(before);
    if (after.cells[0].kind === "parameter" && after.cells[0].parameter.type === "date") after.cells[0].parameter.value = "2026-09-18";
    const snapshots = structuredClone({ before, after });
    expect(parameterValueChanges(before, after)).toEqual(["minimum"]);
    expect({ before, after }).toEqual(snapshots);
  });
  it("同值保存与单独revision变化不触发；多参数按显示序合并", () => {
    const before = document([parameter("first"), parameter("second")]);
    expect(parameterValueChanges(before, { ...before, revision: 4 })).toEqual([]);
    const after = changed(before);
    after.cells[1] = parameter("second", 9);
    expect(parameterValueChanges(before, after)).toEqual(["first", "second"]);
  });
  it.each([
    ["增加", (doc: NotebookDocument) => { doc.cells.push(parameter("new")); }],
    ["删除", (doc: NotebookDocument) => { doc.cells.pop(); }],
    ["重排", (doc: NotebookDocument) => { doc.cells.reverse(); }],
    ["改名", (doc: NotebookDocument) => { doc.cells[0].title = "新标题"; }],
    ["输出名", (doc: NotebookDocument) => { const cell = doc.cells[0]; if ("outputName" in cell) cell.outputName = "renamed"; }],
    ["类型", (doc: NotebookDocument) => { doc.cells[0] = { ...parameter("first"), parameter: { type: "text", value: "two" } }; }],
    ["Notebook名称", (doc: NotebookDocument) => { doc.name = "重命名"; }],
    ["采用草稿", (doc: NotebookDocument) => { doc.lastDraftId = "new-draft"; }],
    ["非参数定义", (doc: NotebookDocument) => { doc.cells[2] = { id: "note", kind: "text", title: "note", markdown: "new" }; }],
  ] as const)("包含%s编辑的批次不自动运行", (_, mutate) => {
    const before = document([parameter("first"), parameter("second"), { id: "note", kind: "text", title: "note", markdown: "old" }]);
    const after = changed(before); mutate(after);
    expect(parameterValueChanges(before, after)).toEqual([]);
  });
  it("单选options变化即使value也变化仍不触发", () => {
    const before = document([{ ...parameter("pick"), parameter: { type: "select", value: "first", options: ["first", "second"] } }]);
    const after = document([{ ...parameter("pick"), parameter: { type: "select", value: "second", options: ["second", "first"] } }]);
    expect(parameterValueChanges(before, after)).toEqual([]);
  });
  it("仍拒绝非法配置，不把未保存草稿判为可执行", () => {
    const before = document();
    const invalid = document([{ ...parameter("minimum"), parameter: { type: "number", value: Number.NaN } }]);
    expect(() => parameterValueChanges(before, invalid)).toThrow();
  });
});

describe("参数联合重算选择", () => {
  function branches() {
    return document([
      { id: "narrative", kind: "text", title: "说明", markdown: "{{total}}", references: [{ key: "total", cellId: "join", field: "value" }] },
      query("join", ["left", "right"]), query("independent", ["shared"]),
      query("left", ["first", "shared"]), query("right", ["second", "shared"]),
      parameter("first"), parameter("second"),
      { id: "shared", kind: "warehouseSql", title: "共享上游", connectionId: "authorized", outputName: "shared", sql: "SELECT 1 AS value" },
      { id: "note", kind: "text", title: "静态", markdown: "不执行" },
    ]);
  }
  it("合并菱形依赖的多个根，裁剪保留revision/ID/连接且共同祖先只执行一次", () => {
    const full = branches(); const before = structuredClone(full);
    const selected = selectParameterRecompute(full, ["second", "first", "first"]);
    expect(selected.parameterCellIds).toEqual(["first", "second"]);
    expect(selected.affectedCellIds).toEqual(["narrative", "join", "left", "right", "first", "second"]);
    expect(selected.executionCellIds).toEqual(["first", "second", "shared", "left", "right", "join", "narrative"]);
    expect(selected.document).toEqual({ ...full, cells: full.cells.filter((cell) => !["independent", "note"].includes(cell.id)) });
    expect(full).toEqual(before);
    expect(notebookRunRequestSchema.parse({ pageId: "test", document: selected.document, action: "run" })).toMatchObject({
      action: "run", document: { revision: 3, lastDraftId: "accepted" },
    });
    expect(selected.document.cells.find((cell) => cell.id === "shared")).toEqual(full.cells.find((cell) => cell.id === "shared"));
  });
  it("没有下游的参数仅运行自己，不把其他单元放入裁剪请求", () => {
    expect(selectParameterRecompute(document([parameter("first"), parameter("other")]), ["first"]).executionCellIds).toEqual(["first"]);
  });
  it.each([{ ids: [] }, { ids: ["missing"] }, { ids: ["shared"] }, { ids: ["narrative"] }])("非法根$ids拒绝而不是自动扩大到全部", ({ ids }) => {
    expect(() => selectParameterRecompute(branches(), ids)).toThrow(ids.length
      ? `需要重新计算的参数不存在：${ids[0]}` : "没有需要重新计算的参数");
  });
  it("裁剪前仍校验整个Notebook，独立分支的非法依赖不能绕过", () => {
    const full = branches(); full.cells.push(query("broken", ["missing"]));
    expect(() => selectParameterRecompute(full, ["first"])).toThrow(/依赖不存在/u);
  });
  it("真实SQL按联合闭包执行，不调用不相关分支；文本用本次结果", async () => {
    const doc = document([
      parameter("first", 2), parameter("second", 3),
      { ...query("sum", ["first", "second"]), sql: "SELECT a.value + b.value AS value FROM first a CROSS JOIN second b" },
      { id: "text", kind: "text", title: "本次合计", markdown: "合计 {{total}}", references: [{ key: "total", cellId: "sum", field: "value" }] },
      { ...query("independent", ["second"]), sql: "SELECT missing FROM second" },
    ]);
    const selected = selectParameterRecompute(doc, ["first"]);
    // second is a necessary ancestor, not an affected root: its other consumer is excluded.
    expect(selected.executionCellIds).toEqual(["first", "second", "sum", "text"]);
    const queryPort = vi.fn(executeNotebookSql);
    const run = await executeNotebook({ document: selected.document, sources: [] }, { query: queryPort, log: vi.fn() });
    expect(run.status).toBe("success");
    expect(queryPort).toHaveBeenCalledTimes(1);
    expect(run.cells.at(-1)).toMatchObject({ cellId: "text", text: "合计 5" });
    expect(run.revision).toBe(doc.revision);
  }, 15_000);
});
