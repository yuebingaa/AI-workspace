import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NotebookCell } from "@/core/notebook/definition";
import { notebookContextOptions, NotebookContextChips, NotebookContextOptions } from "./NotebookContextSelection";

const cells: NotebookCell[] = [
  { id: "param", title: "Threshold", kind: "parameter", outputName: "threshold", parameter: { type: "text", value: "synthetic-private-value" } },
  { id: "sql", title: "Filtered result", kind: "sql", outputName: "filtered", inputCellIds: ["param"], sql: "SELECT 'synthetic-private-sql' FROM threshold" },
  { id: "text", title: "Summary", kind: "text", markdown: "synthetic-private-explanation" },
];
const options = notebookContextOptions(cells);

describe("Notebook context metadata and accessible selection", () => {
  it("publishes only display metadata, never parameter values, code or text body", () => {
    expect(options[0]).toEqual({ id: "param", name: "Threshold", kind: "parameter", detail: "参数 · threshold" });
    expect(JSON.stringify(options)).not.toContain("synthetic-private");
    expect(options).toHaveLength(3);
  });
  it("renders parameter/other groups as keyboard-selectable multi-choice items", () => {
    const html = renderToStaticMarkup(<NotebookContextOptions options={options} selectedIds={["param"]} limit={10} disabled={false} query="" onToggle={() => {}} />);
    expect(html).toContain("其他单元");
    expect(html.match(/role="menuitemcheckbox"/gu)).toHaveLength(3);
    expect(html.match(/aria-checked="true"/gu)).toHaveLength(1);
    expect(html).not.toContain("synthetic-private");
  });
  it.each(["threshold", "THRESHOLD", "参数"])("searches only title/output/type metadata: %s", (query) => {
    const html = renderToStaticMarkup(<NotebookContextOptions options={options} selectedIds={[]} limit={10} disabled={false} query={query} onToggle={() => {}} />);
    expect(html.match(/role="menuitemcheckbox"/gu)).toHaveLength(1);
    expect(html).toContain("Threshold");
    expect(html).not.toContain("Filtered result");
  });
  it("does not search parameter values or source code", () => {
    const html = renderToStaticMarkup(<NotebookContextOptions options={options} selectedIds={[]} limit={10} disabled={false} query="synthetic-private" onToggle={() => {}} />);
    expect(html).toContain("没有匹配的 Notebook 参数或单元");
    expect(html).not.toContain('role="menuitemcheckbox"');
  });
  it("shows the saved-definition boundary in the empty state", () => {
    const html = renderToStaticMarkup(<NotebookContextOptions options={[]} selectedIds={[]} limit={10} disabled={false} query="" onToggle={() => {}} />);
    expect(html).toContain("当前工作界面暂无 Notebook 单元");
    expect(html).toContain("未保存的编辑不会加入");
  });
  it("disables unselected options at the limit while retaining removal", () => {
    const html = renderToStaticMarkup(<NotebookContextOptions options={options} selectedIds={["param", "sql"]} limit={2} disabled={false} query="" onToggle={() => {}} />);
    expect(html.match(/disabled=""/gu)).toHaveLength(1);
    expect(html).toContain("已选择 2 项，请先移除一项再添加");
  });
  it("disables all choice changes while editing or execution is busy", () => {
    const html = renderToStaticMarkup(<NotebookContextOptions options={options} selectedIds={["param"]} limit={10} disabled query="" onToggle={() => {}} />);
    expect(html.match(/disabled=""/gu)).toHaveLength(3);
    expect(html).toContain("请先完成当前编辑或运行");
  });
  it("renders removable chips with focus-only and window-lifetime guidance", () => {
    const html = renderToStaticMarkup(<NotebookContextChips options={options} selectedIds={["sql", "param"]} disabled={false} onRemove={() => {}} />);
    expect(html).toContain('aria-label="移除 Notebook 上下文 Filtered result"');
    expect(html).toContain("仅当前窗口的关注对象");
    expect(html).toContain("选择本身不会读取或运行数据");
    expect(html).not.toContain("synthetic-private");
    expect(html.indexOf("Filtered result")).toBeLessThan(html.indexOf("Threshold"));
  });
  it("does not render missing IDs or an empty selection region", () => {
    expect(renderToStaticMarkup(<NotebookContextChips options={options} selectedIds={["deleted"]} disabled={false} onRemove={() => {}} />)).toBe("");
  });
  it("uses the current name by stable ID and escapes markup-looking titles", () => {
    const renamed = options.map((option) => ({ ...option, name: "<script>synthetic</script>" }));
    const html = renderToStaticMarkup(<NotebookContextChips options={renamed} selectedIds={["param"]} disabled onRemove={() => {}} />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;synthetic&lt;/script&gt;");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("Threshold");
  });
});
