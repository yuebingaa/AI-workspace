import type { NotebookDashboardReview } from "@/core/notebook/dashboard-review";

export function NotebookSnapshotReview({ review, definitionStatus }: {
  review: NotebookDashboardReview;
  definitionStatus: "matching" | "changed" | "unknown";
}) {
  return <section className="notebook-snapshot-review" aria-label="Notebook 快照审阅">
    <strong>确认加入独立结果快照</strong>
    <p>{review.title} · {review.rowCount} 行 · {review.columnCount} 列 · {review.revision === undefined ? "来源版本未知" : `来源版本 ${review.revision}`}</p>
    <details><summary>查看快照来源</summary>
      <dl><dt>来源单元</dt><dd>{review.cellId}</dd><dt>运行标识</dt><dd>{review.runId ?? "旧快照未记录"}</dd>
        <dt>生成时间</dt><dd><time dateTime={review.createdAt}>{review.createdAt}</time></dd>
        <dt>结果数据集</dt><dd>{review.datasetId}</dd></dl>
    </details>
    <p>{definitionStatus === "changed" ? "来源步骤已修改或移除；确认后加入的仍是上述历史版本快照。需要最新结果请取消并重新生成。"
      : definitionStatus === "unknown" ? "无法核对来源步骤定义；此处仅加入已保存的固定结果，不代表当前 Notebook 的最新结果。"
        : "来源步骤定义仍一致；源数据是否变化未检测。修改或重跑 Notebook 不会自动更新此快照。"}</p>
    <small>{review.storageMode === "project" ? "快照数据已保存到本地项目。" : "快照数据按临时保留期保存。"}取消预览或撤销加入操作不会删除该数据；未确认预览不会在重开后自动应用。</small>
  </section>;
}
