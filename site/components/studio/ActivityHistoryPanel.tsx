"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { HarnessExecutionPhase, HarnessTaskSummary } from "@/core/harness/contracts";
import type { ChangeSetAuditRecord } from "@/core/models";
import { studioRoleLabels } from "@/core/permissions";

export type HistoryTab = "tasks" | "changesets";

interface ActivityHistoryPanelProps {
  open: boolean;
  harnessTasks: HarnessTaskSummary[];
  auditRecords: ChangeSetAuditRecord[];
  loading?: boolean;
  initialTab?: HistoryTab;
  onRestoreFocus: () => void;
  onClose: () => void;
}

const stateLabels: Record<HarnessTaskSummary["state"], string> = {
  planning: "规划中",
  executingTool: "执行工具",
  observing: "观察结果",
  awaitingConfirmation: "等待确认",
  blocked: "已阻塞",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const phaseLabels: Record<HarnessExecutionPhase, string> = {
  planning: "规划上下文",
  modelRequest: "模型请求",
  toolExecution: "工具执行",
  awaitingConfirmation: "等待人工确认",
  completed: "已完成",
  blocked: "已阻塞",
  failed: "执行失败",
  cancelled: "已取消",
};

const auditStatusLabels: Record<ChangeSetAuditRecord["status"], string> = {
  previewed: "已预览",
  applied: "已应用",
  cancelled: "已取消",
  undone: "已撤销",
  failed: "失败",
};

const auditSourceLabels = { ai: "AI", puck: "Puck", manual: "手动" } as const;
const activeStates = new Set<HarnessTaskSummary["state"]>(["planning", "executingTool", "observing"]);
const focusableSelector = "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])";

export function keepFocusInsideDialog(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">,
  focusableElements: HTMLElement[],
  activeElement: Element | null,
): void {
  if (event.key !== "Tab" || focusableElements.length === 0) return;
  const first = focusableElements[0];
  const last = focusableElements.at(-1)!;
  if (event.shiftKey && (activeElement === first || !focusableElements.includes(activeElement as HTMLElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (activeElement === last || !focusableElements.includes(activeElement as HTMLElement))) {
    event.preventDefault();
    first.focus();
  }
}

export function focusDialogControl(element: HTMLElement | null): void {
  element?.focus();
}

export function restoreDialogTrigger(element: HTMLElement | null): void {
  if (element?.isConnected) element.focus();
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "—";
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function taskDuration(task: HarnessTaskSummary): number | undefined {
  if (task.totalDurationMs !== undefined) return task.totalDurationMs;
  if (task.executionTiming) return task.executionTiming.activeElapsedMs;
  const start = new Date(task.createdAt).getTime();
  const end = new Date(task.updatedAt).getTime();
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}

function formatDate(timestamp: string): string {
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StateBadge({ state }: { state: HarnessTaskSummary["state"] }) {
  return <span className={`history-state ${state}`}>{stateLabels[state]}</span>;
}

function EmptyHistory({ tab }: { tab: HistoryTab }) {
  return (
    <div className="history-empty">
      <span aria-hidden="true">{tab === "tasks" ? "⌁" : "◇"}</span>
      <b>{tab === "tasks" ? "还没有数据任务" : "还没有 ChangeSet 记录"}</b>
      <p>{tab === "tasks" ? "从 AI 构建助手运行任务后，状态、工具调用和预算会显示在这里。" : "预览、应用、取消、撤销或执行失败后会自动留下审计记录。"}</p>
    </div>
  );
}

function LoadingHistory() {
  return (
    <div className="history-loading" role="status">
      <span className="history-loading-mark" />
      <div><b>正在读取任务历史</b><p>已保存的 Harness 与 ChangeSet 记录加载完成后会显示在这里。</p></div>
    </div>
  );
}

function TaskList({ tasks, selectedId, onSelect }: { tasks: HarnessTaskSummary[]; selectedId: string; onSelect: (id: string) => void }) {
  return (
    <div className="history-list" aria-label="数据任务列表">
      {tasks.map((task) => (
        <button key={task.id} type="button" className={selectedId === task.id ? "selected" : ""} onClick={() => onSelect(task.id)}>
          <span className="history-list-top"><StateBadge state={task.state} /><time dateTime={task.updatedAt}>{formatDate(task.updatedAt)}</time></span>
          <b>{task.instruction}</b>
          <small>{task.counters.toolCallCount} 次工具调用 · {formatDuration(taskDuration(task))}</small>
          {(task.error || task.state === "blocked") && <em>{task.error ?? task.resultMessage ?? "任务已阻塞"}</em>}
        </button>
      ))}
    </div>
  );
}

function TaskDetail({ task }: { task: HarnessTaskSummary }) {
  const timing = task.executionTiming;
  const context = task.contextUsage;
  const limits = context?.limits;
  const toolEvents = task.events.filter((event) => event.toolCall);
  const remainingMs = timing ? Math.max(0, timing.totalBudgetMs - timing.activeElapsedMs) : undefined;
  const timePercent = timing ? Math.min(100, (timing.activeElapsedMs / timing.totalBudgetMs) * 100) : 0;
  const charPercent = context && limits ? Math.min(100, (context.totalInputChars / limits.maxTotalInputChars) * 100) : 0;
  const tokenPercent = context && limits ? Math.min(100, (context.totalPromptTokens / limits.maxTotalPromptTokens) * 100) : 0;
  const reasonKind = task.state === "failed" ? "failed" : task.state === "blocked" ? "blocked" : task.state === "cancelled" ? "cancelled" : "neutral";
  const reasonLabel = reasonKind === "failed" ? "失败原因" : reasonKind === "blocked" ? "阻塞原因" : reasonKind === "cancelled" ? "取消原因" : "任务说明";

  return (
    <article className="history-detail task-detail">
      <header>
        <div><span className="history-eyebrow">HARNESS TASK</span><h3>{task.instruction}</h3><p>{task.id}</p></div>
        <StateBadge state={task.state} />
      </header>

      {activeStates.has(task.state) && <div className="history-inline-state" role="status"><span className="ai-spinner" />任务正在服务端运行，历史会在执行结束后自动更新。</div>}
      {(task.error || task.state === "failed" || task.state === "blocked") && (
        <section className={`history-failure ${reasonKind}`} role={reasonKind === "failed" ? "alert" : "status"}>
          <b>{reasonLabel}</b>
          <p>{task.error ?? task.resultMessage ?? "服务端未返回具体原因。"}</p>
        </section>
      )}

      <section className="history-metrics" aria-label="任务概览">
        <div><span>当前阶段</span><b>{timing ? phaseLabels[timing.phase] : stateLabels[task.state]}</b></div>
        <div><span>总耗时</span><b>{formatDuration(taskDuration(task))}</b></div>
        <div><span>模型调用</span><b>{task.counters.modelCallCount}</b></div>
        <div><span>工具调用</span><b>{task.counters.toolCallCount}</b></div>
      </section>

      <section className="history-section">
        <div className="history-section-title"><div><b>预算与耗时</b><small>只统计 Harness 服务端主动执行时间</small></div>{task.usage && <span>{task.usage.totalTokens} tokens</span>}</div>
        {timing ? (
          <div className="history-budget-grid">
            <div className="history-budget-card wide">
              <div><span>执行时间</span><b>{formatDuration(timing.activeElapsedMs)} / {formatDuration(timing.totalBudgetMs)}</b></div>
              <div className="history-progress"><i style={{ width: `${timePercent}%` }} /></div>
              <small>剩余 {formatDuration(remainingMs)} · 模型 {formatDuration(timing.modelDurationMs)} · 工具 {formatDuration(timing.toolDurationMs)} · 其他 {formatDuration(timing.otherDurationMs)}</small>
            </div>
            <div><span>模型单次超时</span><b>{formatDuration(timing.modelRequestTimeoutMs)}</b></div>
            <div><span>工具单次超时</span><b>{formatDuration(timing.toolCallTimeoutMs)}</b></div>
          </div>
        ) : <p className="history-unavailable">该历史任务未保存耗时预算明细。</p>}
        {context && limits ? (
          <div className="history-context-budget">
            <div><span>累计输入字符</span><b>{context.totalInputChars.toLocaleString()} / {limits.maxTotalInputChars.toLocaleString()}</b><div className="history-progress"><i style={{ width: `${charPercent}%` }} /></div></div>
            <div><span>累计输入 Tokens</span><b>{context.totalPromptTokens.toLocaleString()} / {limits.maxTotalPromptTokens.toLocaleString()}</b><div className="history-progress violet"><i style={{ width: `${tokenPercent}%` }} /></div></div>
            {context.limitReached && <p>已触发上下文限制：{context.limitReached}</p>}
          </div>
        ) : <p className="history-unavailable">该历史任务未保存上下文预算明细。</p>}
      </section>

      <section className="history-section">
        <div className="history-section-title"><div><b>工具调用</b><small>按实际执行顺序显示</small></div><span>{toolEvents.length}</span></div>
        {toolEvents.length ? (
          <ol className="history-tool-list">
            {toolEvents.map((event) => (
              <li key={event.id} className={event.toolCall?.status}>
                <span className="history-tool-icon" aria-hidden="true">{event.toolCall?.status === "success" ? "✓" : event.toolCall?.status === "failure" ? "!" : "…"}</span>
                <div><b>{event.toolCall?.name}</b><p>{event.message}</p><small>{formatDate(event.timestamp)} · {formatDuration(event.toolCall?.durationMs)}</small></div>
              </li>
            ))}
          </ol>
        ) : <p className="history-unavailable">此任务没有工具调用记录。</p>}
      </section>

      <details className="history-event-log">
        <summary>查看完整事件时间线 <span>{task.events.length}</span></summary>
        <ol>
          {task.events.map((event) => <li key={event.id}><i className={event.state} /><div><b>{stateLabels[event.state]}</b><p>{event.message}</p><small>{formatDate(event.timestamp)}</small></div></li>)}
        </ol>
      </details>
    </article>
  );
}

function ChangeSetHistory({ records }: { records: ChangeSetAuditRecord[] }) {
  return (
    <div className="changeset-history-view">
      <div className="changeset-summary-grid">
        {(["previewed", "applied", "undone", "failed"] as const).map((status) => (
          <div key={status} className={status}><span>{auditStatusLabels[status]}</span><b>{records.filter((record) => record.status === status).length}</b></div>
        ))}
      </div>
      <ol className="changeset-timeline">
        {records.map((record) => (
          <li key={record.id} className={record.status}>
            <span className="changeset-line-mark" aria-hidden="true" />
            <article>
              <header><div><span className={`changeset-status ${record.status}`}>{auditStatusLabels[record.status]}</span><b>{record.operationSummary || record.changeSetId}</b></div><time dateTime={record.timestamp}>{formatDate(record.timestamp)}</time></header>
              <dl>
                <div><dt>ChangeSet</dt><dd>{record.changeSetId}</dd></div>
                <div><dt>来源</dt><dd>{auditSourceLabels[record.source]}</dd></div>
                <div><dt>角色</dt><dd>{studioRoleLabels[record.role]}</dd></div>
              </dl>
              {record.ai && <p className="changeset-ai-meta">{record.ai.model} · {formatDuration(record.ai.durationMs)} · {record.ai.usage.totalTokens} tokens{record.ai.repairAttempted ? " · 已执行 JSON 修复" : ""}</p>}
              {record.error && <div className="changeset-error"><b>失败原因</b><p>{record.error}</p></div>}
            </article>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function ActivityHistoryPanel({ open, harnessTasks, auditRecords, loading = false, initialTab = "tasks", onRestoreFocus, onClose }: ActivityHistoryPanelProps) {
  const [tab, setTab] = useState<HistoryTab>(initialTab);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const sortedTasks = useMemo(() => [...harnessTasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [harnessTasks]);
  const sortedRecords = useMemo(() => [...auditRecords].sort((a, b) => b.timestamp.localeCompare(a.timestamp)), [auditRecords]);
  const selectedTask = sortedTasks.find((task) => task.id === selectedTaskId) ?? sortedTasks[0];

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      const focusableElements = [...(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])];
      keepFocusInsideDialog(event, focusableElements, document.activeElement);
    }
    document.addEventListener("keydown", handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    focusDialogControl(closeButtonRef.current);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      onRestoreFocus();
    };
  }, [open, onClose, onRestoreFocus]);

  if (!open) return null;

  return (
    <div className="history-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="history-panel" role="dialog" aria-modal="true" aria-labelledby="history-panel-title">
        <header className="history-panel-head">
          <div><span className="history-head-icon" aria-hidden="true">↺</span><div><h2 id="history-panel-title">任务与变更历史</h2><p>检查 Harness 执行过程和 ChangeSet 审计轨迹</p></div></div>
          <button ref={closeButtonRef} type="button" aria-label="关闭任务历史" onClick={onClose}>×</button>
        </header>
        <nav className="history-tabs" aria-label="历史类型">
          <button type="button" className={tab === "tasks" ? "active" : ""} aria-pressed={tab === "tasks"} onClick={() => setTab("tasks")}>数据任务 <span>{harnessTasks.length}</span></button>
          <button type="button" className={tab === "changesets" ? "active" : ""} aria-pressed={tab === "changesets"} onClick={() => setTab("changesets")}>ChangeSet <span>{auditRecords.length}</span></button>
        </nav>
        <div className={`history-panel-body ${tab}`}>
          {loading ? <LoadingHistory /> : tab === "tasks" ? (
            sortedTasks.length ? <><TaskList tasks={sortedTasks} selectedId={selectedTask?.id ?? ""} onSelect={setSelectedTaskId} />{selectedTask && <TaskDetail task={selectedTask} />}</> : <EmptyHistory tab="tasks" />
          ) : sortedRecords.length ? <ChangeSetHistory records={sortedRecords} /> : <EmptyHistory tab="changesets" />}
        </div>
      </section>
    </div>
  );
}
