import { describe, expect, it } from "vitest";
import type { UploadedDatasetDescriptor } from "@/core/datasets/contracts";
import type { NotebookCell } from "./definition";
import type { NotebookDocument } from "./contracts";
import {
  createNotebookDashboardReview,
  notebookSnapshotDefinitionStatus,
} from "./dashboard-review";

const input: NotebookCell = {
  id: "input_cell",
  kind: "data",
  title: "输入数据",
  sourceDataSourceId: "source_sales",
  outputName: "sales",
};
const summary: NotebookCell = {
  id: "summary_cell",
  kind: "sql",
  title: "销售汇总",
  inputCellIds: [input.id],
  outputName: "summary",
  sql: "SELECT region, SUM(amount) AS amount FROM sales GROUP BY region",
};
const unrelated: NotebookCell = {
  id: "unrelated_note",
  kind: "text",
  title: "无关说明",
  markdown: "初始说明",
};

function lineageDefinitions() {
  return [
    {
      cellId: input.id,
      kind: input.kind,
      title: input.title,
      inputCellIds: [],
      definition: JSON.stringify({ ...input, title: `  ${input.title}  ` }),
    },
    {
      cellId: summary.id,
      kind: summary.kind,
      title: summary.title,
      inputCellIds: [input.id],
      definition: JSON.stringify({ ...summary, title: `  ${summary.title}  ` }),
    },
  ];
}

function dataset(options: { cellId?: string; lineage?: boolean; storageMode?: "project" } = {}): UploadedDatasetDescriptor {
  const datasetId = "dataset_upload_snapshot_fixture_0001";
  return {
    datasetId,
    originalFileName: "notebook-summary.csv",
    source: {
      id: datasetId,
      name: "Notebook 销售汇总",
      rowCount: 2,
      columnCount: 2,
      qualityScore: 100,
      updatedAt: "2026-09-21T08:00:00.000Z",
      sourceType: "local-fixture",
      fields: [
        { name: "region", label: "区域", type: "string", aggregatable: true, supportedAggregations: ["none", "count", "countDistinct", "min", "max"] },
        { name: "amount", label: "金额", type: "number", aggregatable: true, supportedAggregations: ["none", "sum", "average", "count", "countDistinct", "min", "max"] },
      ],
    },
    recipe: {
      id: "recipe_snapshot_fixture",
      name: "Notebook 快照",
      sourceDatasetId: datasetId,
      outputDatasetId: datasetId,
      status: "ready",
      steps: [],
    },
    fieldMappings: [
      { index: 0, originalName: "region", normalizedName: "region" },
      { index: 1, originalName: "amount", normalizedName: "amount" },
    ],
    sensitiveFields: [],
    aiAccessPolicy: "not-required",
    createdAt: "2026-09-21T08:00:00.000Z",
    ...(options.storageMode ? { storageMode: options.storageMode } : {}),
    persistenceNotice: "Synthetic fixture only",
    provenance: {
      kind: "notebook",
      runId: "run_snapshot_fixture",
      resultId: "result_snapshot_fixture",
      cellId: options.cellId ?? summary.id,
      revision: 7,
      connectionIds: [],
      ...(options.lineage === false ? {} : {
        lineage: {
          version: 1,
          recordedAt: "2026-09-21T08:00:00.000Z",
          accessMode: "user",
          sourceDatasetIds: ["source_sales"],
          rowCount: 2,
          complete: true,
          dataSignature: "a".repeat(64),
          steps: lineageDefinitions(),
        },
      }),
    },
  };
}

function document(cells: NotebookCell[] = [input, summary, unrelated], revision = 7): NotebookDocument {
  return { name: "快照审阅测试", revision, cells };
}

describe("Notebook dashboard snapshot review metadata", () => {
  it("copies bounded metadata and definitions without retaining result rows", () => {
    const descriptor = Object.assign(dataset({ storageMode: "project" }), {
      rows: [{ region: "private-row-marker", amount: 999 }],
    });
    const review = createNotebookDashboardReview("changeset_snapshot", "page_home", summary, descriptor);

    expect(review).toEqual({
      changeSetId: "changeset_snapshot",
      pageId: "page_home",
      datasetId: descriptor.datasetId,
      cellId: summary.id,
      title: summary.title,
      rowCount: 2,
      columnCount: 2,
      createdAt: descriptor.createdAt,
      storageMode: "project",
      runId: "run_snapshot_fixture",
      revision: 7,
      definitions: lineageDefinitions().map(({ cellId, definition }) => ({ cellId, definition })),
    });
    expect(review).not.toHaveProperty("rows");
    expect(JSON.stringify(review)).not.toContain("private-row-marker");
  });

  it("rejects a Dataset whose recorded producer differs from the requested cell", () => {
    expect(() => createNotebookDashboardReview(
      "changeset_snapshot",
      "page_home",
      summary,
      dataset({ cellId: input.id }),
    )).toThrow("快照来源与当前单元不一致");
  });
});

describe("Notebook snapshot definition status", () => {
  it("normalizes saved and current definitions before reporting a match", () => {
    const review = createNotebookDashboardReview("changeset_snapshot", "page_home", summary, dataset());
    expect(notebookSnapshotDefinitionStatus(review, document())).toBe("matching");
  });

  it("reports changed when a recorded definition is edited", () => {
    const review = createNotebookDashboardReview("changeset_snapshot", "page_home", summary, dataset());
    const edited = { ...summary, sql: `${summary.sql} ORDER BY amount DESC` };
    expect(notebookSnapshotDefinitionStatus(review, document([input, edited, unrelated], 8))).toBe("changed");
  });

  it.each([
    ["upstream", [summary, unrelated]],
    ["target", [input, unrelated]],
  ] as const)("reports changed when the recorded %s cell is removed", (_label, cells) => {
    const review = createNotebookDashboardReview("changeset_snapshot", "page_home", summary, dataset());
    expect(notebookSnapshotDefinitionStatus(review, document([...cells], 8))).toBe("changed");
  });

  it("reports unknown for an old receipt without detailed lineage", () => {
    const review = createNotebookDashboardReview(
      "changeset_snapshot",
      "page_home",
      summary,
      dataset({ lineage: false }),
    );
    expect(review.definitions).toBeUndefined();
    expect(notebookSnapshotDefinitionStatus(review, document())).toBe("unknown");
  });

  it("ignores unrelated cell edits and document revision changes", () => {
    const review = createNotebookDashboardReview("changeset_snapshot", "page_home", summary, dataset());
    const changedUnrelated = { ...unrelated, title: "已修改的无关说明", markdown: "新的无关内容" };
    expect(notebookSnapshotDefinitionStatus(review, document([input, summary, changedUnrelated], 99))).toBe("matching");
  });
});
