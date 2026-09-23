import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { NotebookCell } from "@/core/notebook/definition";
import { notebookDependencyCandidates } from "@/core/notebook/graph";
import { NotebookCellEditor } from "./NotebookCellEditor";

const source: NotebookCell = { id: "data", kind: "data", title: "后方原始数据", sourceDataSourceId: "synthetic", outputName: "raw_data" };
const query: NotebookCell = { id: "query", kind: "sql", title: "汇总", inputCellIds: ["data"], outputName: "totals", sql: "SELECT * FROM raw_data" };
const downstream: NotebookCell = { id: "child", kind: "sql", title: "不能作为输入的下游", inputCellIds: ["query"], outputName: "child_output", sql: "SELECT * FROM totals" };
function render(cell: NotebookCell, cells: NotebookCell[], disabled = false, codeMode = false) {
  return renderToStaticMarkup(<NotebookCellEditor cell={cell} availableInputs={notebookDependencyCandidates(cells, cell.id)}
    sources={[]} models={[]} disabled={disabled} codeMode={codeMode} onSave={() => {}} onCancel={() => {}} />);
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
  it.each([false, true])("Python原始文件在codeMode=%s时按行显示已保存的原始名称", (codeMode) => {
    const python: NotebookCell = { id: "py", kind: "python", title: "Python", inputCellIds: [], outputName: "result",
      fileNames: [" orders.csv", "Sales & returns.xlsx", "汇总.csv"], code: "result = pd.DataFrame()" };
    const html = render(python, [python], false, codeMode);
    expect(html).toContain('aria-label="Python 原始文件"');
    expect(html).toContain('rows="2"> orders.csv\nSales &amp; returns.xlsx\n汇总.csv</textarea>');
    expect(html).toContain("原始文件（每行一个文件名，可选）");
    expect(html).not.toContain("orders.csv,Sales");
  });
  it("Python未选择原件时保留可选的空文件列表", () => {
    const python: NotebookCell = { id: "py", kind: "python", title: "Python", inputCellIds: [], outputName: "result",
      fileNames: [], code: "result = pd.DataFrame()" };
    const html = render(python, [python]);
    expect(html).toContain('<textarea aria-label="Python 原始文件" rows="2"></textarea>');
    expect(html).toContain("保存单元");
  });
  it("Python编辑锁保留逐行原件定义并禁用保存，仍可取消", () => {
    const python: NotebookCell = { id: "py", kind: "python", title: "Python", inputCellIds: [], outputName: "result",
      fileNames: ["orders.csv", "returns.csv"], code: "result = pd.DataFrame()" };
    const html = render(python, [python], true, true);
    expect(html).toContain('<fieldset disabled="">');
    expect(html).toContain('rows="2">orders.csv\nreturns.csv</textarea>');
    expect(html).toMatch(/disabled=""[^>]*>保存单元/);
    expect(html).toContain('<button type="button">取消编辑</button>');
  });
  it("无依赖的文字编辑器不显示无关的执行提示", () => {
    const note: NotebookCell = { id: "note", kind: "text", title: "说明", markdown: "保留原样" };
    expect(render(note, [note])).not.toContain("按依赖关系运行");
  });
  it("配方表单接入数值草稿控件并保留保存、取消和代码入口", () => {
    const transform: NotebookCell = { id: "transform", kind: "transform", title: "数字筛选", inputCellId: "data", outputName: "filtered",
      steps: [{ id: "filter", type: "filter", field: "amount", operator: "greaterThan", value: 5 }] };
    const html = render(transform, [source, transform]);
    expect(html).toContain("data-recipe-number");
    expect(html).toContain('type="number"');
    expect(html).toContain('value="5"');
    expect(html).toContain("规则代码");
    expect(html).toContain("保存单元");
    expect(html).toContain('<button type="button">取消编辑</button>');
  });
  it("配方编辑锁禁用保存与控件但仍允许取消", () => {
    const transform: NotebookCell = { id: "transform", kind: "transform", title: "数字筛选", inputCellId: "data", outputName: "filtered",
      steps: [{ id: "filter", type: "filter", field: "amount", operator: "greaterThan", value: 5 }] };
    const html = render(transform, [source, transform], true);
    expect(html).toContain('<fieldset disabled="">');
    expect(html).toMatch(/disabled=""[^>]*>保存单元/);
    expect(html).toContain('<button type="button">取消编辑</button>');
    expect(html).toContain("data-recipe-number");
  });
});
