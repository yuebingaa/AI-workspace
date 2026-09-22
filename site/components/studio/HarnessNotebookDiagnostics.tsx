import type { HarnessNotebookDiagnostics } from "@/core/harness/notebook-diagnostics";
import { NotebookRunTiming } from "./notebook/NotebookRunTiming";

const statuses: Record<HarnessNotebookDiagnostics["cells"][number]["status"], string> = {
  success: "此步骤通过", failure: "此步骤失败", blocked: "上游失败 · 未运行", unknown: "未取得执行回执",
};

/** No adoption or execution path: a bounded final failure receipt is text only. */
export function HarnessNotebookDiagnosticsView({ diagnostics }: { diagnostics: HarnessNotebookDiagnostics }) {
  return <details className="notebook-failure-diagnostics">
    <summary>查看失败草稿（只读）</summary>
    <section aria-label="失败 Notebook 草稿诊断">
      <p>{diagnostics.status === "failure" ? "本次草稿试运行未通过。" : "未取得完整试运行回执，不能确认执行结果。"}正式 Notebook 与看板未修改。</p>
      <p className="notebook-diagnostic-notice">仅保留在当前会话，刷新后丢失；以下内容仅用于排查，不可直接采用或运行。</p>
      <small>基于文档 v{diagnostics.baseRevision}{diagnostics.editVersion !== undefined ? ` · 编辑版本 ${diagnostics.editVersion}` : ""}</small>
      {diagnostics.cells.map((cell) => <article className="notebook-diagnostic-cell" key={cell.cellId} aria-label={`失败草稿单元 ${cell.title}`}>
        <header><b>{cell.title}</b><span>{cell.kind} · {statuses[cell.status]}</span></header>
        {cell.timing ? <NotebookRunTiming timing={cell.timing} /> : cell.status === "unknown"
          ? <p>未取得执行回执，阶段与耗时未知。</p> : null}
        {cell.sourceTruncated && <p className="notebook-diagnostic-notice">仅显示前 {cell.source.length} / {cell.sourceChars} 字符；已省略内容，以下不是完整定义。</p>}
        <details className="notebook-diagnostic-source">
          <summary>单元定义 · JSON</summary>
          <pre tabIndex={0} role="region" aria-label={`${cell.title} 只读单元定义`}><code>{cell.source}</code></pre>
        </details>
      </article>)}
      {diagnostics.omittedCellCount > 0 && <p className="notebook-diagnostic-notice">另有 {diagnostics.omittedCellCount} 个单元因诊断体积限制省略。</p>}
    </section>
  </details>;
}
