import type { SemanticModelReference } from "@/core/semantic/model-references";

/** Current definitions only: snapshots and historical Agent artifacts are not live references. */
export function SemanticModelDeletionImpact({ references, id }: { references: SemanticModelReference[]; id: string }) {
  return <section id={id} className="semantic-deletion-impact" aria-label="语义模型删除影响">
    <h3>{references.length ? `暂不能删除 · ${references.length} 个 Notebook 单元正在引用` : "删除影响"}</h3>
    {references.length > 0 ? <>
      <p>请先在对应 Notebook 中移除或更换以下语义查询单元；不会自动删除下游分析。</p>
      <ul>{references.slice(0, 10).map((reference) => <li key={`${reference.pageId}:${reference.cellId}`}>
        <b>{reference.notebookName} / {reference.cellTitle}</b>
        <small>界面 {reference.pageId} · 单元 {reference.cellId}</small>
      </li>)}</ul>
      {references.length > 10 && <p>另有 {references.length - 10} 个引用未展开，仍受删除保护。</p>}
    </> : <p>当前 Notebook 定义中没有引用；删除前仍会再次检查并要求确认。仅移除模型和选择状态，原数据、看板及历史结果不变；未采用的旧草稿若依赖此模型，需重新生成。</p>}
  </section>;
}
