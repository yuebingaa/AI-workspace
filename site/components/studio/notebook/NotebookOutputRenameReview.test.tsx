import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NotebookArtifact, NotebookCell } from "@/core/notebook/definition";
import type { NotebookDocument } from "@/core/notebook/contracts";
import { analyzeNotebookOutputRenames } from "@/core/notebook/output-renames";
import { NotebookDraftReview } from "./NotebookDraftReview";
import { NotebookOutputRenameConfirmation, NotebookOutputRenameReview } from "./NotebookOutputRenameReview";

const source: NotebookCell = { id: "data", kind: "data", title: "合成源", sourceDataSourceId: "source", outputName: "records" };
const query: NotebookCell = { id: "sql", kind: "sql", title: "汇总SQL", inputCellIds: ["data"], outputName: "totals", sql: "SELECT * FROM records" };
const python: NotebookCell = { id: "python", kind: "python", title: "Python整理", inputCellIds: ["data"], outputName: "frame", fileNames: [], code: "frame = records" };
const table: NotebookCell = { id: "table", kind: "table", title: "直接表格", inputCellId: "data", columns: ["group"] };
const downstream: NotebookCell = { id: "chart", kind: "chart", title: "下游图表", inputCellId: "sql", chartType: "bar", categoryField: "group", valueFields: ["amount"] };
const cells = [source, query, python, table, downstream];
const renamed = [{ ...source, outputName: "renamed_records" }, query, python, table, downstream];
const renames = analyzeNotebookOutputRenames(cells, renamed);

describe("Notebook output rename review", () => {
  it("renders nothing for unchanged output names", () => {
    expect(renderToStaticMarkup(<NotebookOutputRenameReview renames={[]} />)).toBe("");
  });
  it("separates stable input references from conservative free-code checks and manual reruns", () => {
    const html = renderToStaticMarkup(<NotebookOutputRenameReview renames={renames} />);
    expect(html).toContain("输出变量改名影响");
    expect(html).toContain("按单元 ID 保持关联");
    expect(html).toContain("不会自动改写自由 SQL / Python 代码");
    expect(html).toContain("<code>records</code> → <code>renamed_records</code>");
    expect(html).toContain("汇总SQL（SQL）");
    expect(html).toContain("Python整理（Python）");
    expect(html).toContain("直接表格（表格）");
    expect(html).toContain("及 4 个下游单元需手动重新运行");
    expect(html).toContain("即使已经手动修改，也请运行验证");
    expect(html).not.toContain("SELECT * FROM records");
    expect(html).not.toContain("frame = records");
  });
  it("warns about the Python producer's own output without requiring a downstream consumer", () => {
    const ownRename = analyzeNotebookOutputRenames([python], [{ ...python, outputName: "new_frame" }]);
    const html = renderToStaticMarkup(<NotebookOutputRenameReview renames={ownRename} />);
    expect(html).toContain("确认代码实际产生 <code>new_frame</code> 输出变量");
    expect(html).toContain("0 个下游单元");
  });
  it("escapes cell titles rather than interpreting them as HTML", () => {
    const html = renderToStaticMarkup(<NotebookOutputRenameReview renames={renames.map((rename) => ({ ...rename, title: "<script>alert(1)</script>" }))} />);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("offers explicit confirm and return actions without calling them during render", () => {
    const mustNotRun = () => { throw new Error("Must not mutate during render"); };
    const html = renderToStaticMarkup(<NotebookOutputRenameConfirmation renames={renames} disabled={false} stale={false} onConfirm={mustNotRun} onBack={mustNotRun} />);
    expect(html).toContain('aria-label="确认输出变量改名"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("返回编辑");
    expect(html).toContain("确认改名并保存");
    expect(html).not.toContain('disabled=""');
  });
  it.each([{ disabled: true, stale: false }, { disabled: false, stale: true }])("prevents confirmation when execution/permissions or stale state lock the edit: %j", (state) => {
    const html = renderToStaticMarkup(<NotebookOutputRenameConfirmation renames={renames} {...state} onConfirm={() => {}} onBack={() => {}} />);
    expect(html).toMatch(/disabled=""[^>]*>确认改名并保存/);
    if (state.stale) {
      expect(html).toContain('role="alert"');
      expect(html).toContain("不会覆盖当前文档");
      expect(html).toContain("关闭过期编辑");
    } else expect(html).toContain("返回编辑");
  });
  it.each(["missing-trial", "stale", "valid"] as const)("shows the same rename impact without bypassing AI draft adoption gates: %s", (state) => {
    const document: NotebookDocument = { name: "合成文档", revision: 2, cells };
    const draft: NotebookArtifact = {
      id: "draft", version: 1, status: "draft", name: document.name, baseRevision: state === "stale" ? 1 : 2,
      cells: renamed, sourceDataSourceIds: ["source"], executionOrder: cells.map((cell) => cell.id), lineage: [], createdAt: "2026-09-17T00:00:00.000Z",
      ...(state === "missing-trial" ? {} : { executionEvidence: { runId: "trial", status: "success" as const, completedCellIds: cells.map((cell) => cell.id), summary: "合成试运行通过" } }),
    };
    const before = structuredClone(document);
    const html = renderToStaticMarkup(<NotebookDraftReview document={document} draft={draft} disabled={false} onAdopt={() => { throw Error("Must not adopt during render"); }} onDismiss={() => {}} />);
    expect(html).toContain("输出变量改名影响");
    expect(html).toContain("renamed_records");
    expect(html).not.toContain("确认改名并保存");
    if (state === "valid") expect(html).not.toMatch(/disabled=""[^>]*>采用草稿/);
    else expect(html).toMatch(/disabled=""[^>]*>采用草稿/);
    expect(document).toEqual(before);
  });
});
