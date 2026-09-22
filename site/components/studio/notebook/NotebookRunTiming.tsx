import type { NotebookCellTiming } from "@/core/notebook/contracts";

function duration(milliseconds: number): string {
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(2)} s`;
}

/** Actual execution receipts only; absent timing is not a zero-duration run. */
export function NotebookRunTiming({ timing }: { timing?: NotebookCellTiming }) {
  if (!timing) return null;
  const phase = timing.failurePhase === "preparation" ? "环境准备" : "执行计算";
  const termination = timing.termination === "timeout" ? "执行超时"
    : timing.termination === "cancelled" ? "已取消" : timing.termination === "error" ? "执行失败" : undefined;
  return <div className="notebook-run-timing" role="group" aria-label="Notebook 单元耗时">
    <dl>
      <div><dt>环境准备</dt><dd>{duration(timing.preparationMs)}</dd></div>
      <div><dt>执行计算</dt><dd>{timing.failurePhase === "preparation" ? "未开始" : duration(timing.executionMs)}</dd></div>
    </dl>
    {timing.failurePhase && <p>{timing.termination === "cancelled" ? "终止阶段" : "失败阶段"}：{phase}{termination ? ` · ${termination}` : ""}</p>}
    {!timing.failurePhase && termination && <p>{termination}</p>}
    <small>按实际阶段计时，包含运行调用与结果转换，并非纯计算耗时。</small>
  </div>;
}
