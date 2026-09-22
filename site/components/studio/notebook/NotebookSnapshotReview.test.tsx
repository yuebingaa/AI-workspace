import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NotebookDashboardReview } from "@/core/notebook/dashboard-review";
import { NotebookSnapshotReview } from "./NotebookSnapshotReview";

function review(overrides: Partial<NotebookDashboardReview> = {}): NotebookDashboardReview {
  return {
    changeSetId: "changeset_snapshot",
    pageId: "page_home",
    datasetId: "dataset_upload_snapshot_fixture_0001",
    cellId: "summary_cell",
    title: "销售汇总",
    rowCount: 2,
    columnCount: 3,
    createdAt: "2026-09-21T08:00:00.000Z",
    storageMode: "project",
    runId: "run_snapshot_fixture",
    revision: 7,
    definitions: [{
      cellId: "summary_cell",
      definition: JSON.stringify({
        id: "summary_cell",
        kind: "sql",
        title: "销售汇总",
        inputCellIds: ["input_cell"],
        outputName: "summary",
        sql: "SELECT secret_amount FROM private_orders",
      }),
    }],
    ...overrides,
  };
}

function render(input: NotebookDashboardReview, definitionStatus: "matching" | "changed" | "unknown") {
  return renderToStaticMarkup(<NotebookSnapshotReview review={input} definitionStatus={definitionStatus} />);
}

describe("Notebook snapshot review presentation", () => {
  it("shows the fixed snapshot source metadata without exposing stored definitions", () => {
    const html = render(review(), "matching");
    for (const value of [
      'aria-label="Notebook 快照审阅"',
      "确认加入独立结果快照",
      "销售汇总 · 2 行 · 3 列 · 来源版本 7",
      "来源单元",
      "summary_cell",
      "运行标识",
      "run_snapshot_fixture",
      "生成时间",
      "2026-09-21T08:00:00.000Z",
      "结果数据集",
      "dataset_upload_snapshot_fixture_0001",
      "修改或重跑 Notebook 不会自动更新此快照",
    ]) expect(html).toContain(value);
    expect(html).not.toContain("SELECT secret_amount");
    expect(html).not.toContain("private_orders");
  });

  it("distinguishes project persistence from temporary retention and legacy source metadata", () => {
    const project = render(review(), "matching");
    expect(project).toContain("快照数据已保存到本地项目");
    expect(project).not.toContain("按临时保留期保存");

    const temporary = render(review({ storageMode: "temporary", runId: undefined, revision: undefined }), "unknown");
    expect(temporary).toContain("来源版本未知");
    expect(temporary).toContain("旧快照未记录");
    expect(temporary).toContain("快照数据按临时保留期保存");
    expect(temporary).not.toContain("已保存到本地项目");
  });

  it("explains that a changed definition does not mutate the historical snapshot", () => {
    const html = render(review(), "changed");
    expect(html).toContain("来源步骤已修改或移除");
    expect(html).toContain("仍是上述历史版本快照");
    expect(html).toContain("需要最新结果请取消并重新生成");
    expect(html).not.toContain("无法核对来源步骤定义");
  });

  it("labels unknown lineage without claiming that the snapshot is current", () => {
    const html = render(review({ definitions: undefined }), "unknown");
    expect(html).toContain("无法核对来源步骤定义");
    expect(html).toContain("仅加入已保存的固定结果");
    expect(html).toContain("不代表当前 Notebook 的最新结果");
    expect(html).not.toContain("来源步骤定义仍一致");
  });

  it("escapes user-controlled metadata and never renders SQL definitions", () => {
    const html = render(review({
      title: "<script>alert('title')</script>",
      cellId: "<img src=x onerror=alert(1)>",
      runId: "<iframe>run</iframe>",
      datasetId: "<svg onload=alert(1)>",
      definitions: [{ cellId: "unsafe", definition: "SELECT private_secret FROM hidden_table -- <script>" }],
    }), "unknown");

    for (const rawTag of ["<script>", "<img", "<iframe>", "<svg"]) expect(html).not.toContain(rawTag);
    for (const escaped of ["&lt;script&gt;", "&lt;img src=x onerror=alert(1)&gt;", "&lt;iframe&gt;run&lt;/iframe&gt;", "&lt;svg onload=alert(1)&gt;"]) {
      expect(html).toContain(escaped);
    }
    expect(html).not.toContain("SELECT private_secret");
    expect(html).not.toContain("hidden_table");
  });
});
