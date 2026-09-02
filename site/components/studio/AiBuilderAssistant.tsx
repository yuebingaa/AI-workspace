import type { AiPlanMetadata } from "@/core/ai/contracts";
import type { HarnessExecutionPhase, HarnessTaskSummary } from "@/core/harness/contracts";
import type { ChangeOperation, ChangeSet, ChangeSetAuditRecord } from "@/core/models";
import { studioRoleLabels } from "@/core/permissions";

export type ChangeSetUiStatus = "pending" | "preview" | "applied";
export type AiRequestUiStatus = "idle" | "loading" | "success" | "error" | "cancelled" | "timeout";

interface AiBuilderAssistantProps {
  pageTitle: string;
  datasetName: string;
  changeSet: ChangeSet;
  status: ChangeSetUiStatus;
  validationError: string | null;
  canApply: boolean;
  canPreview: boolean;
  auditRecords: ChangeSetAuditRecord[];
  aiMessage: string;
  aiMetadata: AiPlanMetadata | null;
  instruction: string;
  requestStatus: AiRequestUiStatus;
  requestError: string | null;
  canRetry: boolean;
  harnessTask: HarnessTaskSummary | null;
  harnessTaskCount: number;
  onInstructionChange: (instruction: string) => void;
  onGenerate: () => void;
  onCancelRequest: () => void;
  onRetry: () => void;
  onPreview: () => void;
  onApply: () => void;
  onCancelPreview: () => void;
}

const statusLabels: Record<ChangeSetUiStatus, string> = {
  pending: "等待预览",
  preview: "画布预览中",
  applied: "已应用",
};
const auditSourceLabels = { ai: "AI", puck: "Puck", manual: "手动" } as const;
const harnessStateLabels: Record<HarnessTaskSummary["state"], string> = {
  planning: "规划中",
  executingTool: "执行工具",
  observing: "观察结果",
  awaitingConfirmation: "等待确认",
  blocked: "已阻塞",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
const harnessPhaseLabels: Record<HarnessExecutionPhase, string> = {
  planning: "规划上下文",
  modelRequest: "模型请求",
  toolExecution: "工具执行",
  awaitingConfirmation: "等待人工确认",
  completed: "已完成",
  blocked: "已阻塞",
  failed: "执行失败",
  cancelled: "已取消",
};
const harnessContextLimitLabels = {
  singleRequestChars: "单次模型输入字符限制",
  taskInputChars: "任务累计输入字符限制",
  taskPromptTokens: "任务累计实际输入 token 限制",
} as const;

function operationTargets(operation: ChangeOperation): string[] {
  if (operation.type === "addNode") return [operation.parentId, operation.node.id];
  if (operation.type === "updatePage") return [operation.pageId];
  if (operation.type === "moveNode") return [operation.nodeId, operation.parentId];
  return [operation.nodeId];
}

export function AiBuilderAssistant({
  pageTitle,
  datasetName,
  changeSet,
  status,
  validationError,
  canApply,
  canPreview,
  auditRecords,
  aiMessage,
  aiMetadata,
  instruction,
  requestStatus,
  requestError,
  canRetry,
  harnessTask,
  harnessTaskCount,
  onInstructionChange,
  onGenerate,
  onCancelRequest,
  onRetry,
  onPreview,
  onApply,
  onCancelPreview,
}: AiBuilderAssistantProps) {
  const affectedPages = [...new Set(changeSet.operations.map((operation) => operation.pageId))];
  const affectedComponents = [...new Set(changeSet.operations.flatMap(operationTargets))];
  const needsAdmin = changeSet.operations.some((operation) => operation.type === "removeNode" || operation.type === "updatePage");
  const isLoading = requestStatus === "loading";
  const showChangePlan = !harnessTask || Boolean(harnessTask.pendingChangeSet);
  const timing = harnessTask?.executionTiming;
  const displayedElapsedMs = timing?.activeElapsedMs ?? 0;
  const displayedRemainingMs = Math.max(0, (timing?.totalBudgetMs ?? 0) - displayedElapsedMs);
  const displayedPhase = isLoading ? "等待服务端执行结果（客户端等待不计时）" : timing ? harnessPhaseLabels[timing.phase] : "未开始";
  const contextUsage = harnessTask?.contextUsage;
  const contextLimits = contextUsage?.limits;

  return (
    <aside className="right-panel panel">
      <div className="assistant-head">
        <div><span className="ai-mark">✦</span><div><b>AI 构建助手</b><small>{isLoading ? "正在生成结构化 ChangeSet" : "AppSpec 安全规划模式"}</small></div></div>
        <button type="button" aria-label="助手菜单">···</button>
      </div>
      <div className="context-pill">上下文：{pageTitle} · {datasetName.replace(".csv", "")}</div>
      <details className="audit-history">
        <summary>变更审计记录 <span>{auditRecords.length}</span></summary>
        <div>
          {!auditRecords.length && <p>预览、应用、取消或撤销后会在这里留下记录。</p>}
          {auditRecords.slice(0, 12).map((record) => (
            <article key={record.id} className={record.status}>
              <div><b>{record.status === "previewed" ? "已预览" : record.status === "applied" ? "已应用" : record.status === "cancelled" ? "已取消" : record.status === "undone" ? "已撤销" : "失败"}</b><span>{studioRoleLabels[record.role]} · {auditSourceLabels[record.source]}</span></div>
              <p>{record.operationSummary || record.changeSetId}</p>
              <small>{new Date(record.timestamp).toLocaleString("zh-CN")}</small>
              {record.ai && <small>{record.ai.model} · {record.ai.durationMs}ms · {record.ai.usage.totalTokens} tokens</small>}
              {record.error && <em>{record.error}</em>}
            </article>
          ))}
        </div>
      </details>
      {harnessTask && (
        <details className="harness-task-card" open>
          <summary>
            <div><b>Harness 任务</b><small>{harnessTask.id}</small></div>
            <span className={harnessTask.state}>{harnessStateLabels[harnessTask.state]}</span>
          </summary>
          <div className="harness-task-body">
            <div className="harness-task-meta">
              <span>循环 {harnessTask.counters.loopCount}</span>
              <span>模型 {harnessTask.counters.modelCallCount}</span>
              <span>工具 {harnessTask.counters.toolCallCount}</span>
              {timing && <span>阶段 {displayedPhase}</span>}
              {timing && <span>已用 {(displayedElapsedMs / 1_000).toFixed(1)}s</span>}
              {timing && <span>剩余 {(displayedRemainingMs / 1_000).toFixed(1)}s</span>}
              {harnessTask.usage && <span>Tokens {harnessTask.usage.totalTokens}</span>}
              {contextUsage && <span>输入 {contextUsage.totalInputChars}/{contextLimits?.maxTotalInputChars ?? "-"} chars</span>}
              {contextUsage && <span>输入 Tokens {contextUsage.totalPromptTokens}/{contextLimits?.maxTotalPromptTokens ?? "-"}</span>}
              {contextUsage && <span>{contextUsage.complexity === "simpleReadOnly" ? "简单只读" : "多步骤"}</span>}
              <span>历史任务 {harnessTaskCount}</span>
            </div>
            {contextUsage && contextLimits && (
              <p className="harness-timing-detail">
                输入字符剩余 {Math.max(0, contextLimits.maxTotalInputChars - contextUsage.totalInputChars)} · 输入 token 剩余 {Math.max(0, contextLimits.maxTotalPromptTokens - contextUsage.totalPromptTokens)}
                {contextUsage.limitReached ? ` · 触发限制：${harnessContextLimitLabels[contextUsage.limitReached]}` : ""}
              </p>
            )}
            {timing && (
              <p className="harness-timing-detail">
                模型 {(timing.modelDurationMs / 1_000).toFixed(2)}s · 工具 {(timing.toolDurationMs / 1_000).toFixed(2)}s · 其他 {(timing.otherDurationMs / 1_000).toFixed(2)}s · 已保留观察 {timing.retainedObservationCount}
              </p>
            )}
            <ol className="harness-events">
              {harnessTask.events.map((event) => (
                <li key={event.id} className={event.state}>
                  <i />
                  <div><b>{harnessStateLabels[event.state]}</b><p>{event.message}</p><small>{new Date(event.timestamp).toLocaleTimeString("zh-CN")}{event.toolCall ? ` · ${event.toolCall.name} · ${event.toolCall.durationMs}ms` : ""}</small></div>
                </li>
              ))}
            </ol>
            {harnessTask.state === "awaitingConfirmation" && <p className="harness-confirm-note">Harness 已停止执行。请先画布预览，再由用户决定确认或拒绝。</p>}
          </div>
        </details>
      )}
      <div className="conversation">
        <div className="user-message">{instruction || "描述你希望调整的数据产品内容。"}</div>
        <div className="assistant-message">
          <span className="ai-mark small">✦</span>
          <div>
            <p>{aiMessage}</p>
            {isLoading && <div className="ai-request-state" role="status"><span className="ai-spinner" />正在请求 DeepSeek 并校验 JSON…</div>}
            {requestError && (
              <div className="validation-error" role="alert">
                <b>{requestStatus === "timeout" ? "请求超时" : requestStatus === "cancelled" ? "请求已取消" : "AI 生成失败"}</b>
                <p>{requestError}</p>
                {canRetry && <button type="button" onClick={onRetry}>重试</button>}
              </div>
            )}
            {validationError && (
              <div className="validation-error" role="alert">
                <b>无法执行变更</b>
                <p>{validationError}</p>
              </div>
            )}
            {showChangePlan && <div className="change-plan">
              <div className="plan-head"><b>结构化变更计划</b><span className={status === "applied" ? "done" : status}>{statusLabels[status]}</span></div>
              <ol>
                {changeSet.operations.map((operation, index) => (
                  <li key={operation.id}>
                    <span>{index + 1}</span>
                    <div><b>{operation.label}</b><small>{operation.description}</small></div>
                  </li>
                ))}
              </ol>
              <div className="ai-plan-scope">
                <span>页面：{affectedPages.join("、")}</span>
                <span>组件：{affectedComponents.join("、")}</span>
                <span className={needsAdmin ? "risk" : "safe"}>{needsAdmin ? "包含页面结构或删除操作，需要管理员确认" : "正式应用前仍会执行 Schema、目标和权限校验"}</span>
              </div>
              {aiMetadata && (
                <div className="ai-plan-meta">
                  <span>模型 {aiMetadata.model}</span>
                  <span>{aiMetadata.durationMs}ms</span>
                  <span>{aiMetadata.usage.totalTokens} tokens</span>
                  {aiMetadata.repairAttempted && <span>已执行一次 JSON 修复</span>}
                </div>
              )}
              <div className="plan-actions">
                {status === "preview" ? (
                  <button type="button" onClick={onCancelPreview}>取消预览</button>
                ) : (
                  <>
                    {harnessTask?.state === "awaitingConfirmation" && <button type="button" className="reject" onClick={onCancelPreview}>拒绝变更</button>}
                    <button type="button" disabled={!canPreview || status === "applied" || isLoading} title={canPreview ? "预览已校验的 ChangeSet" : "当前没有通过校验的 AI ChangeSet"} onClick={onPreview}>画布预览</button>
                  </>
                )}
                <button
                  type="button"
                  className="apply"
                  disabled={status !== "preview" || !canApply || isLoading}
                  title={!canApply ? "当前角色无权应用变更" : status !== "preview" ? "请先完成画布预览" : "人工确认并应用变更"}
                  onClick={onApply}
                >
                  {status === "applied" ? "已全部应用 ✓" : "确认并应用"}
                </button>
              </div>
            </div>}
            <p className="safe-note">AI 只生成待预览 ChangeSet，不会自动修改正式 AppSpec。</p>
          </div>
        </div>
      </div>
      <div className="prompt-box">
        <textarea
          aria-label="AI 指令"
          maxLength={1_000}
          value={instruction}
          disabled={isLoading}
          placeholder="例如：将本月收入指标标题改为月度总收入……"
          onChange={(event) => onInstructionChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && instruction.trim() && !isLoading) onGenerate();
          }}
        />
        <div>
          <span>{instruction.length}/1000 · Ctrl + Enter</span>
          {isLoading ? (
            <button type="button" aria-label="取消 AI 请求" onClick={onCancelRequest}>■</button>
          ) : (
            <button type="button" aria-label="发送 AI 指令" disabled={!instruction.trim()} onClick={onGenerate}>↑</button>
          )}
        </div>
      </div>
    </aside>
  );
}
