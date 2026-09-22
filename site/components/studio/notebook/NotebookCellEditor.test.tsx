import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { NotebookCell } from "@/core/notebook/definition";
import { notebookDependencyCandidates } from "@/core/notebook/graph";
import { NotebookCellEditor } from "./NotebookCellEditor";

const source: NotebookCell = { id: "data", kind: "data", title: "后方原始数据", sourceDataSourceId: "synthetic", outputName: "raw_data" };
const query: NotebookCell = { id: "query", kind: "sql", title: "汇总", inputCellIds: ["data"], outputName: "totals", sql: "SELECT * FROM raw_data" };
const downstream: NotebookCell = { id: "child", kind: "sql", title: "不能作为输入的下游", inputCellIds: ["query"], outputName: "child_output", sql: "SELECT * FROM totals" };
function render(cell: NotebookCell, cells: NotebookCell[], disabled = false) {
  return renderToStaticMarkup(<NotebookCellEditor cell={cell} availableInputs={notebookDependencyCandidates(cells, cell.id)}
    sources={[]} models={[]} disabled={disabled} onSave={() => {}} onCancel={() => {}} />);
}
describe("依赖候选与编辑器展示", () => {
  it("SQL保留视觉后方已选输入，不展示自身与下游输入", () => {
    const html = render(query, [query, downstream, source]);
    expect(html).toContain('type="checkbox" checked=""');
    expect(html).toContain("后方原始数据");
    expect(html).not.toContain("不能作为输入的下游");
    expect(html).not.toContain("child_output");
    expect(html.match(/type="checkbox"/gu)).toHaveLength(1);
    expect(html).toContain("按依赖关系运行，不受页面排列限制");
  });
  it("图表即使排在首位也显示当前输入选项", () => {
    const chart: NotebookCell = { id: "chart", kind: "chart", title: "图", inputCellId: "query", chartType: "bar", categoryField: "area", valueFields: ["amount"] };
    const html = render(chart, [chart, query, source]);
    expect(html).toContain('<option value="query" selected="">totals');
    expect(html).toContain("raw_data");
    expect(html).toContain("取消编辑");
  });
  it("Python同样仅展示无环候选并保留禁用行为", () => {
    const python: NotebookCell = { id: "py", kind: "python", title: "Python", inputCellIds: ["data"], outputName: "result", fileNames: [], code: "result = raw_data" };
    const html = render(python, [python, { ...downstream, inputCellIds: ["py"] }, source], true);
    expect(html).toContain('<fieldset disabled="">');
    expect(html.match(/type="checkbox"/gu)).toHaveLength(1);
    expect(html).toContain("后方原始数据");
    expect(html).not.toContain("child_output");
  });
  it("无依赖的文字编辑器不显示无关的执行提示", () => {
    const note: NotebookCell = { id: "note", kind: "text", title: "说明", markdown: "保留原样" };
    expect(render(note, [note])).not.toContain("按依赖关系运行");
  });
});
