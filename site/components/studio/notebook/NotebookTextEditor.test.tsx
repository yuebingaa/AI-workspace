import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NotebookCell } from "@/core/notebook/definition";
import { notebookDependencyCandidates } from "@/core/notebook/graph";
import { NotebookCellEditor } from "./NotebookCellEditor";
import { insertNotebookTextPlaceholder, NotebookTextEditor, removeNotebookTextReference } from "./NotebookTextEditor";

const parameter: NotebookCell = { id: "parameter", kind: "parameter", title: "数值参数", outputName: "threshold", parameter: { type: "number", value: 5 } };
const query: NotebookCell = { id: "query", kind: "sql", title: "汇总结果", outputName: "totals", inputCellIds: ["parameter"], sql: "SELECT value AS 总额 FROM threshold" };
const note: Extract<NotebookCell, { kind: "text" }> = { id: "note", kind: "text", title: "分析说明", markdown: "总额：{{amount}}", references: [{ key: "amount", cellId: "query", field: "总额" }] };
function render(cell = note, inputs: NotebookCell[] = [parameter, query], disabled = false) {
  return renderToStaticMarkup(<NotebookTextEditor cell={cell} availableInputs={inputs} disabled={disabled} onSave={() => {}} onCancel={() => {}} />);
}

describe("Notebook text editor", () => {
  it("uses a dedicated accessible editor without changing the canonical save/cancel actions", () => {
    const html = renderToStaticMarkup(<NotebookCellEditor cell={note} availableInputs={notebookDependencyCandidates([note, parameter, query], note.id)} sources={[]} models={[]} disabled={false} onSave={() => {}} onCancel={() => {}} />);
    expect(html).toContain('aria-label="说明单元编辑器"');
    expect(html).toContain('aria-label="分析说明"');
    expect(html).toContain('aria-label="引用键 1"');
    expect(html).toContain('aria-label="引用单元 1"');
    expect(html).toContain('aria-label="引用字段 1"');
    expect(html).toContain('aria-label="插入占位符 1"');
    expect(html).toContain('aria-label="移除引用 1"');
    expect(html).toContain("添加数据引用");
    expect(html).toContain("保存单元"); expect(html).toContain("取消编辑");
    expect(html).not.toContain("输出表名（SQL 中使用）");
  });
  it("retains Chinese field names and the selected stable ID even for a visually later input", () => {
    const html = render();
    expect(html).toContain('<option value="query" selected="">汇总结果 · totals</option>');
    expect(html).toContain('value="总额"');
    expect(html).toContain("{{amount}}");
    expect(html).toContain("实际字段名，而非显示标签");
  });
  it("shows a missing reference explicitly instead of silently selecting another source", () => {
    const html = render(note, [parameter]);
    expect(html).toContain('<option value="query" selected="">原引用不可用，请重新选择</option>');
    expect(html).toContain('value="总额"');
  });
  it("keeps old static placeholders unchanged and can save text without any data input", () => {
    const html = render({ id: "static", kind: "text", title: "静态", markdown: "{{literal}} <script>" }, []);
    expect(html).toContain("{{literal}} &lt;script&gt;");
    expect(html).not.toContain('aria-label="数据引用 1"');
    expect(html).toMatch(/disabled=""[^>]*>添加数据引用/);
    expect(html).not.toMatch(/disabled=""[^>]*>保存单元/);
  });
  it("respects read-only/execution locks while still allowing cancel", () => {
    const html = render(note, [parameter, query], true);
    expect(html).toContain('<fieldset disabled="">');
    expect(html).toMatch(/disabled=""[^>]*>保存单元/);
    expect(html).toContain('<button type="button">取消编辑</button>');
  });
  it("shows bounded literal-only behavior and manual execution requirements", () => {
    const html = render();
    expect(html).toContain("结果完整且恰好一行");
    expect(html).toContain("不执行代码、表达式或 HTML");
    expect(html).toContain("保存只修改定义，不会自动运行");
    expect(html).toContain("更改引用键后请同步修改正文");
    expect(html).toContain("8,000 字符");
  });
  it("disables add at the domain reference limit", () => {
    const references = Array.from({ length: 10 }, (_, index) => ({ key: `value_${index}`, cellId: "parameter", field: "value" }));
    const html = render({ ...note, references });
    expect(html).toMatch(/disabled=""[^>]*>添加数据引用/);
    expect(html.match(/role="group"/gu)).toHaveLength(10);
  });
});

describe("Literal placeholder editor actions", () => {
  it("inserts a canonical placeholder at the cursor without parsing text", () => {
    expect(insertNotebookTextPlaceholder("前后", "amount", 1)).toEqual({ markdown: "前{{amount}}后", caret: 11 });
  });
  it("replaces only the selected text range, preserving surrounding HTML-like content literally", () => {
    expect(insertNotebookTextPlaceholder("<b>旧值</b>", "amount", 3, 5)).toEqual({ markdown: "<b>{{amount}}</b>", caret: 13 });
  });
  it("defaults to the end and clamps out-of-range selection positions", () => {
    expect(insertNotebookTextPlaceholder("x", "value")).toEqual({ markdown: "x{{value}}", caret: 10 });
    expect(insertNotebookTextPlaceholder("x", "value", 50, 80)).toEqual({ markdown: "x{{value}}", caret: 10 });
    expect(insertNotebookTextPlaceholder("x", "value", -5, -2)).toEqual({ markdown: "{{value}}x", caret: 9 });
  });
  it("removes all exact placeholders for a deleted binding but leaves unrelated text and bindings intact", () => {
    const references = [{ key: "amount", cellId: "query", field: "总额" }, { key: "other", cellId: "parameter", field: "value" }];
    const before = structuredClone(references);
    expect(removeNotebookTextReference("{{amount}}/{{other}}/{{amount}}/{{ amount }}", references, 0)).toEqual({ markdown: "/{{other}}//{{ amount }}", references: [references[1]] });
    expect(references).toEqual(before);
  });
  it("leaves an absent binding unchanged", () => {
    const references = note.references!;
    expect(removeNotebookTextReference("{{amount}}", references, 99)).toEqual({ markdown: "{{amount}}", references });
  });
});
