import type { HarnessTaskSummary, HarnessTraceEvent } from "@/core/harness/contracts";

export function traceRows(events: HarnessTraceEvent[]) {
  const rows: HarnessTraceEvent[] = [];
  for (const event of events) {
    if (["status_update", "answer_delta", "completed", "task_started"].includes(event.type)) continue;
    // Replace only the matching active tool; retries retain their own receipts.
    const active = event.toolCall && event.type !== "tool_started"
      ? rows.findIndex((row) => row.type === "tool_started" && row.toolCall?.id === event.toolCall?.id) : -1;
    const verifying = event.type === "verification_completed"
      ? rows.findIndex((row) => row.type === "verification_started") : -1;
    if (active >= 0) rows[active] = event;
    else if (verifying >= 0) rows[verifying] = event;
    else rows.push(event);
  }
  return rows;
}

export function HarnessTrace({ task, running = false }: { task?: HarnessTaskSummary | null; running?: boolean }) {
  if (!task?.trace?.length) return running ? <div className="harness-trace-connecting" role="status">正在连接执行服务…</div> : null;
  // A runtime status update is not a terminal receipt; wait for the validated final response.
  const active = running;
  const rows = traceRows(task.trace);
  const failed = task.state === "failed" || task.state === "blocked";
  const label = active ? "正在分析 · 查看执行过程" : task.state === "awaitingConfirmation" ? "预览已生成 · 等待确认"
    : task.state === "cancelled" ? "任务已取消" : failed ? "分析未完成 · 查看原因" : "已完成分析";
  const tone = active ? "running" : failed ? "failed" : task.state === "awaitingConfirmation" ? "waiting" : task.state === "cancelled" ? "cancelled" : "success";
  return <details key={`${task.id}:${active}`} className={`harness-trace ${tone}`} open={active ? true : undefined}>
    <summary><span className="trace-status-dot" aria-hidden="true" /><b>{label}</b><small>{rows.length} 个步骤</small><span className="trace-chevron" aria-hidden="true">⌄</span></summary>
    <div className="harness-trace-body">
      {active && rows.length === 0 && <p role="status">{task.trace.at(-1)?.message}</p>}
      <ol aria-label="真实执行记录">
        {rows.map((event) => {
          const pending = event.type === "tool_started" || event.type === "verification_started";
          const rejected = event.type === "tool_failed" || (event.type === "verification_completed" && event.verificationStatus !== "passed");
          return <li key={event.id} className={rejected ? "trace-rejected" : pending ? "trace-active" : "trace-done"}>
            <span className="trace-step-icon" aria-hidden="true">{rejected ? "!" : pending ? (active ? "●" : "–") : "✓"}</span>
            <div><p>{event.message}</p>
              {pending && !active && <small>未收到完成回执</small>}
              {event.toolCall && !pending && <small>{event.toolCall.name} · {(event.toolCall.durationMs / 1_000).toFixed(1)} s</small>}
              {event.plan && <ul>{event.plan.steps.map((step) => <li key={step.id}>{step.objective}</li>)}</ul>}
              {event.evidenceIds?.length ? <details className="trace-evidence"><summary>证据引用 · {event.evidenceIds.length}</summary><code>{event.evidenceIds.join("\n")}</code></details> : null}
            </div>
          </li>;
        })}
      </ol>
      {failed && <p className="trace-failure-detail">{task.error ?? "未达到任务完成条件。"}</p>}
      {task.state === "awaitingConfirmation" && <p>正式页面尚未修改，确认后才应用 ChangeSet。</p>}
      {task.conversationStorage === "memory" && <small>会话暂存在服务内存，重启后可能丢失。</small>}
      {task.conversationStorage === "unavailable" && <small>会话持久化失败；本次结果有效，但重启后无法保证恢复上下文。</small>}
      <footer>来自 Harness 实际事件，不展示模型内部推理。</footer>
    </div>
  </details>;
}
