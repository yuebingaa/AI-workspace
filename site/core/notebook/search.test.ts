import { describe, expect, it } from "vitest";
import type { NotebookDocument } from "./contracts";
import { buildNotebookSearchIndex, searchNotebookIndex, type NotebookIndexSearch } from "./search";

function document(): NotebookDocument {
  return { name: "声明依赖图", revision: 2, cells: [
    { id: "a", kind: "data", title: "工作表一", sourceDataSourceId: "dataset_a", outputName: "raw_a" },
    { id: "b", kind: "data", title: "工作表二", sourceDataSourceId: "dataset_b", outputName: "raw_b" },
    { id: "join", kind: "sql", title: "合并报警", inputCellIds: ["a", "b"], outputName: "alarms", sql: "SELECT * FROM raw_a UNION ALL SELECT * FROM raw_b" },
    { id: "left", kind: "sql", title: "工站汇总", inputCellIds: ["join"], outputName: "stations", sql: "SELECT station FROM alarms" },
    { id: "right", kind: "sql", title: "报警分类", inputCellIds: ["join"], outputName: "issues", sql: "SELECT issue FROM alarms" },
    { id: "totals", kind: "sql", title: "统计结果", inputCellIds: ["left", "right"], outputName: "downtime_summary", sql: "SELECT * FROM stations CROSS JOIN issues" },
    { id: "chart", kind: "chart", title: "停机图表", inputCellId: "totals", chartType: "bar", categoryField: "station", valueFields: ["minutes"] },
    { id: "note", kind: "text", title: "说明", markdown: "只在源码中出现的特殊短语 phantom_variable" },
  ] };
}
const defaults: NotebookIndexSearch = { searchIn: "metadata", direction: "self", depth: 30 };
describe("Notebook 结构索引与声明血缘", () => {
  it("索引输出定义、输入变量、直接消费者及两份源数据，不改原文档", () => {
    const doc = document(); const before = structuredClone(doc);
    const index = buildNotebookSearchIndex(doc);
    expect(index.byVariable.get("downtime_summary")).toMatchObject({ id: "totals", downstream: ["chart"],
      inputs: [{ cellId: "left", variable: "stations" }, { cellId: "right", variable: "issues" }],
      sourceDataSourceIds: ["dataset_a", "dataset_b"] });
    expect(index.byId.get("a")!.downstream).toEqual(["join"]);
    expect(doc).toEqual(before);
  });
  it("遍历菱形 DAG 时去重，保留最短距离、方向、锚点及深度边界", () => {
    const index = buildNotebookSearchIndex(document());
    const upstream = searchNotebookIndex(index, { ...defaults, variable: "downtime_summary", direction: "upstream", depth: 2 });
    expect(upstream.matches.map(({ entry, relation, distance }) => [entry.id, relation, distance])).toEqual([
      ["join", "upstream", 2], ["left", "upstream", 1], ["right", "upstream", 1], ["totals", "self", 0],
    ]);
    const both = searchNotebookIndex(index, { ...defaults, cellId: "join", direction: "both" });
    expect(both.matches.map(({ entry }) => entry.id)).toEqual(["a", "b", "join", "left", "right", "totals", "chart"]);
    expect(both.matches.find(({ entry }) => entry.id === "totals")!.distance).toBe(2);
  });
  it("可组合变量锚点、下游范围与图表类型筛选", () => {
    const index = buildNotebookSearchIndex(document());
    const result = searchNotebookIndex(index, { ...defaults, variable: "alarms", direction: "downstream", kind: "chart" });
    expect(result.anchor!.id).toBe("join");
    expect(result.matches.map(({ entry }) => entry.id)).toEqual(["chart"]);
  });
  it("关键词检索区分元数据与源码，源码出现的名字不虚构成变量定义", () => {
    const index = buildNotebookSearchIndex(document());
    expect(searchNotebookIndex(index, { ...defaults, query: "alarms" }).matches.map(({ entry }) => entry.id)).toEqual(["join", "left", "right"]);
    expect(searchNotebookIndex(index, { ...defaults, query: "phantom_variable" }).matches).toEqual([]);
    expect(searchNotebookIndex(index, { ...defaults, query: "phantom_variable", searchIn: "source" }).matches[0].entry.id).toBe("note");
    expect(() => searchNotebookIndex(index, { ...defaults, variable: "phantom_variable" })).toThrow("找不到");
    expect(() => searchNotebookIndex(index, { ...defaults, direction: "upstream" })).toThrow("需要指定");
  });
  it("换绑源数据后重新建立索引，旧索引不会被偷偷改写", () => {
    const doc = document(); const old = buildNotebookSearchIndex(doc);
    doc.cells[0] = { id: "a", kind: "data", title: "换源", sourceDataSourceId: "dataset_new", outputName: "raw_a" };
    const next = buildNotebookSearchIndex(doc);
    expect(next.byId.get("chart")!.sourceDataSourceIds).toEqual(["dataset_new", "dataset_b"]);
    expect(old.byId.get("chart")!.sourceDataSourceIds).toEqual(["dataset_a", "dataset_b"]);
  });
  it("拒绝重复定义、断链及循环，空文档仍可正常检索", () => {
    const duplicate = document(); duplicate.cells[1] = { ...duplicate.cells[0], id: "b" };
    expect(() => buildNotebookSearchIndex(duplicate)).toThrow("输出名称重复");
    const cycle = document(); cycle.cells[2] = { id: "join", kind: "sql", title: "循环", outputName: "alarms", inputCellIds: ["totals"], sql: "SELECT 1" };
    expect(() => buildNotebookSearchIndex(cycle)).toThrow("循环依赖");
    const missing = document(); missing.cells.splice(0, 1);
    expect(() => buildNotebookSearchIndex(missing)).toThrow("引用的依赖不存在：a");
    expect(searchNotebookIndex(buildNotebookSearchIndex({ name: "空分析", revision: 0, cells: [] }), defaults).matches).toEqual([]);
  });
  it("显示顺序与执行顺序分离后仍保留位置、原始源码和完整血缘", () => {
    const original = document();
    const doc = { ...original, cells: [...original.cells].reverse() };
    const index = buildNotebookSearchIndex(doc);
    expect(index.entries.map((entry) => entry.id)).toEqual(doc.cells.map((cell) => cell.id));
    expect(index.byId.get("chart")).toMatchObject({ index: 1, upstream: ["totals"], sourceDataSourceIds: ["dataset_a", "dataset_b"] });
    for (const [position, cell] of doc.cells.entries()) {
      expect(index.byId.get(cell.id)?.index).toBe(position);
      expect(index.sourceById.get(cell.id)).toBe(JSON.stringify(cell, null, 2));
    }
    const matches = searchNotebookIndex(index, { ...defaults, cellId: "chart", direction: "upstream" });
    expect(matches.matches.map(({ entry }) => entry.id)).toEqual(["chart", "totals", "right", "left", "join", "b", "a"]);
    expect(index.byId.get("join")?.downstream).toEqual(["right", "left"]);
  });
  it("乱序索引不混淆各单元未修剪的存储源码或原件与连接范围", () => {
    const doc: NotebookDocument = { name: "来源", revision: 1, cells: [
      { id: "show", kind: "table", title: "展示", inputCellId: "py", columns: ["value"] },
      { id: "py", kind: "python", title: "计算", inputCellIds: ["remote"], outputName: "result", code: "result = remote_data\n", fileNames: ["synthetic.csv"] },
      { id: "remote", kind: "warehouseSql", title: "数据库", connectionId: "test_connection", outputName: "remote_data", sql: "SELECT 1 AS value\n" },
    ] };
    const index = buildNotebookSearchIndex(doc);
    expect(index.byId.get("show")).toMatchObject({ connectionIds: ["test_connection"], sourceFileNames: ["synthetic.csv"] });
    expect(index.sourceById.get("remote")).toBe(JSON.stringify(doc.cells[2], null, 2));
    expect(index.sourceById.get("py")).toBe(JSON.stringify(doc.cells[1], null, 2));
  });
  it("沿用Schema修剪标识的兼容性，但读取源码仍为原始定义", () => {
    const doc: NotebookDocument = { name: "兼容", revision: 0, cells: [
      { id: " show ", kind: "table", title: " 展示 ", inputCellId: " query ", columns: ["value"] },
      { id: " query ", kind: "warehouseSql", title: " 查询 ", connectionId: "synthetic_connection", outputName: " totals ", sql: "SELECT 1 AS value\n" },
    ] };
    const index = buildNotebookSearchIndex(doc);
    expect(index.entries.map((entry) => [entry.id, entry.index])).toEqual([["show", 0], ["query", 1]]);
    expect(index.byId.get("show")?.inputs).toEqual([{ cellId: "query", variable: "totals" }]);
    expect(index.sourceById.get("query")).toBe(JSON.stringify(doc.cells[1], null, 2));
  });
});
