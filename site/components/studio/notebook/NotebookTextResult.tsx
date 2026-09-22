import type { NotebookCell } from "@/core/notebook/definition";
import type { NotebookCellRun } from "@/core/notebook/contracts";

/** The server's successful text receipt is the result; never interpolate browser data. */
export function NotebookTextResult({ cell, cells, result, stale, running }: {
  cell: Extract<NotebookCell, { kind: "text" }>; cells: NotebookCell[]; result?: NotebookCellRun; stale: boolean; running: boolean;
}) {
  if (!cell.references?.length) return <p className="notebook-text">{cell.markdown}</p>;
  const available = !running && !stale && result?.cellId === cell.id && result.status === "success" && result.text !== undefined;
  const pending = running ? "正在计算引用说明，请等待本次运行完成。"
    : stale ? "引用结果已失效，请重新运行此说明单元。"
      : result?.status === "failure" ? "引用说明计算失败，请查看错误并修正后重新运行。"
        : result?.status === "blocked" ? "引用说明未计算：上游步骤失败，请先修正并重新运行。"
          : result?.status === "success" ? "未取得说明文本结果，请重新运行。"
            : "引用结果待运行。保存定义后，请运行此说明单元以生成文本。";
  return <div className="notebook-text-result">
    {available ? <>
      <p className="notebook-text" aria-label="说明计算结果">{result.text}</p>
      {result.text === "" && <p className="notebook-text-pending">本次说明结果为空文本。</p>}
    </> : <p className="notebook-text-pending" role="status">{pending}</p>}
    <details><summary>查看说明模板和引用</summary><pre aria-label="说明模板">{cell.markdown}</pre>
      <ul>{cell.references.map((reference) => {
        const input = cells.find((item) => item.id === reference.cellId);
        return <li key={reference.key}><code>{`{{${reference.key}}}`}</code> → {input?.title ?? "单元不可用"} · <code>{input && "outputName" in input ? input.outputName : reference.cellId}.{reference.field}</code></li>;
      })}</ul>
      <p>引用按单元 ID 关联；只显示本次成功运行的纯文本，不解析 HTML 或 Markdown。保存说明定义不会自动运行；参数值变更是否重算遵循当前窗口设置。</p>
    </details>
  </div>;
}
