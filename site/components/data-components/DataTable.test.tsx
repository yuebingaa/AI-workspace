import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataTable } from "./DataTable";

describe("DataTable", () => {
  it("呈现受控的紧凑、斑马纹和强调色样式", () => {
    const html = renderToStaticMarkup(<DataTable
      title="线体异常明细"
      subtitle="按线体和异常分类排序"
      actionLabel="派生汇总"
      density="compact"
      stripedRows
      accentColor="blue"
      columns={[{ key: "line", label: "线体" }, { key: "category", label: "异常分类" }]}
      rows={[{ line: "A5FNL01", category: "飞达工位超时" }]}
    />);

    expect(html).toContain("table-density-compact");
    expect(html).toContain("table-striped");
    expect(html).toContain("table-accent-blue");
    expect(html).toContain("A5FNL01");
    expect(html).toContain("飞达工位超时");
  });
});
