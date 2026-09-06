import { useEffect, useRef } from "react";
import type { AiPlanMetadata } from "@/core/ai/contracts";
import {
  MAX_HARNESS_IMAGE_ATTACHMENTS,
  type HarnessExecutionPhase,
  type HarnessTaskSummary,
} from "@/core/harness/contracts";
import type { AssistantConversationTurn } from "@/core/harness/conversation";
import type { ChangeOperation, ChangeSet, ChangeSetAuditRecord } from "@/core/models";
import { studioRoleLabels } from "@/core/permissions";
import { ExcelDownloadButton } from "./ExcelDownloadButton";

export type ChangeSetUiStatus = "pending" | "preview" | "applied";
export type AiRequestUiStatus = "idle" | "loading" | "success" | "blocked" | "error" | "cancelled" | "timeout";
export const CONVERSATION_BOTTOM_THRESHOLD_PX = 48;

export function isConversationNearBottom(position: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">) {
  return position.scrollHeight - position.scrollTop - position.clientHeight <= CONVERSATION_BOTTOM_THRESHOLD_PX;
}

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
  conversationTurns: AssistantConversationTurn[];
  pendingInstruction: string;
  dataAnalysisMode: boolean;
  rawDataAccessEnabled?: boolean;
  imageAttachments: File[];
  onInstructionChange: (instruction: string) => void;
  onImageAttachmentsChange: (files: File[]) => void;
  onGenerate: () => void;
  onCancelRequest: () => void;
  onClearConversation: () => void;
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
const verifierStatusLabels = {
  pending: "等待验收",
  passed: "验收通过",
  replan: "退回重规划",
  failed: "验收失败",
} as const;
const visualVerifierStatusLabels = {
  passed: "视觉通过",
  failed: "视觉未通过",
  unavailable: "视觉不可用",
  deferred: "待最终渲染",
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
  conversationTurns,
  pendingInstruction,
  dataAnalysisMode,
  rawDataAccessEnabled = false,
  imageAttachments,
  onInstructionChange,
  onImageAttachmentsChange,
  onGenerate,
  onCancelRequest,
  onClearConversation,
  onRetry,
  onPreview,
  onApply,
  onCancelPreview,
}: AiBuilderAssistantProps) {
  const affectedPages = [...new Set(changeSet.operations.map((operation) => operation.pageId))];
  const affectedComponents = [...new Set(changeSet.operations.flatMap(operationTargets))];
  const needsAdmin = changeSet.operations.some((operation) => operation.type === "removeNode" || operation.type === "updatePage");
  const isLoading = requestStatus === "loading";
  const showChangePlan = canPreview && (!harnessTask || Boolean(harnessTask.pendingChangeSet));
  const timing = harnessTask?.executionTiming;
  const displayedElapsedMs = timing?.activeElapsedMs ?? 0;
  const displayedRemainingMs = Math.max(0, (timing?.totalBudgetMs ?? 0) - displayedElapsedMs);
  const displayedPhase = isLoading ? "等待服务端执行结果（客户端等待不计时）" : timing ? harnessPhaseLabels[timing.phase] : "未开始";
  const contextUsage = harnessTask?.contextUsage;
  const contextLimits = contextUsage?.limits;
  const conversationRef = useRef<HTMLDivElement>(null);
  const conversationPinnedToBottomRef = useRef(true);
  const previousPendingInstructionRef = useRef("");
  const imageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const conversation = conversationRef.current;
    const requestStarted = Boolean(pendingInstruction)
      && pendingInstruction !== previousPendingInstructionRef.current;
    if (conversation && (conversationPinnedToBottomRef.current || requestStarted)) {
      conversation.scrollTop = conversation.scrollHeight;
      conversationPinnedToBottomRef.current = true;
    }
    previousPendingInstructionRef.current = pendingInstruction;
  }, [conversationTurns.length, isLoading, pendingInstruction]);

  return (
    <aside className="right-panel panel">
      <div className="assistant-head">
        <div><span className="ai-mark">✦</span><div><b>{dataAnalysisMode ? "AI 数据分析与看板助手" : "AI 构建助手"}</b><small>{dataAnalysisMode ? (isLoading ? "正在扫描授权数据并请求 DeepSeek" : rawDataAccessEnabled ? "EDS 汇总 + 会话级原始数据完整扫描" : "EDS 派生汇总分析 · 看板变更需确认") : (isLoading ? "正在生成结构化 ChangeSet" : "AppSpec 安全规划模式")}</small></div></div>
        <button type="button" aria-label="助手菜单">···</button>
      </div>
      <div className="context-pill">上下文：{pageTitle} · {datasetName.replace(".csv", "")}</div>
      <details className="assistant-diagnostics">
        <summary><b>运行详情</b><span>任务 {harnessTaskCount} · 审计 {auditRecords.length}</span></summary>
        <div className="assistant-diagnostics-popover">
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
            <details className="harness-task-card">
              <summary>
                <div><b>Harness 任务</b><small>{harnessTask.id}</small></div>
                <span className={harnessTask.state}>{harnessStateLabels[harnessTask.state]}</span>
              </summary>
              <div className="harness-task-body">
                <div className="harness-task-meta">
                  <span>循环 {harnessTask.counters.loopCount}</span>
                  <span>模型 {harnessTask.counters.modelCallCount}</span>
                  <span>工具 {harnessTask.counters.toolCallCount}</span>
                  {harnessTask.semanticIntent && <span>语义 {harnessTask.semanticIntent.mode === "changePreview" ? "变更预览" : harnessTask.semanticIntent.mode === "readOnlyTask" ? "只读任务" : "对话"} · {Math.round(harnessTask.semanticIntent.confidence * 100)}%</span>}
                  {timing && <span>阶段 {displayedPhase}</span>}
                  {timing && <span>已用 {(displayedElapsedMs / 1_000).toFixed(1)}s</span>}
                  {timing && <span>剩余 {(displayedRemainingMs / 1_000).toFixed(1)}s</span>}
                  {harnessTask.usage && <span>Tokens {harnessTask.usage.totalTokens}</span>}
                  {contextUsage && <span>输入 {contextUsage.totalInputChars}/{contextLimits?.maxTotalInputChars ?? "-"} chars</span>}
                  {contextUsage && <span>输入 Tokens {contextUsage.totalPromptTokens}/{contextLimits?.maxTotalPromptTokens ?? "-"}</span>}
                  {contextUsage && <span>{contextUsage.complexity === "simpleReadOnly" ? "简单只读" : "多步骤"}</span>}
                  <span>历史任务 {harnessTaskCount}</span>
                </div>
                {harnessTask.skills?.length ? (
                  <div className="harness-skills" aria-label="本次加载的技能">
                    <span>已加载 Skill</span>
                    {harnessTask.skills.map((skill) => <b key={skill.id}>{skill.name} v{skill.version}</b>)}
                  </div>
                ) : null}
                {harnessTask.workingMemory ? (
                  <div className="harness-working-memory" aria-label="Harness Working Memory">
                    <div>
                      <b>Working Memory</b>
                      <span>第 {harnessTask.workingMemory.iteration} 轮</span>
                    </div>
                    <div>
                      <span>已完成 {harnessTask.workingMemory.completedSteps.length}</span>
                      <span>已验证 {harnessTask.workingMemory.keyStatistics.length}</span>
                      <span>待办 {harnessTask.workingMemory.pendingGoals.length}</span>
                      <span>失败路径 {harnessTask.workingMemory.failedAttempts.length}</span>
                    </div>
                    {harnessTask.workingMemory.pendingGoals[0] ? <small>下一步：{harnessTask.workingMemory.pendingGoals[0]}</small> : null}
                  </div>
                ) : null}
                {harnessTask.executionPlan ? (
                  <div className="harness-execution-plan" aria-label="Planner 执行计划">
                    <div><b>Planner 执行计划</b><span>v{harnessTask.executionPlan.revision}</span></div>
                    <ol>
                      {harnessTask.executionPlan.steps.map((step) => (
                        <li className={step.status} key={step.id}>
                          <i />
                          <span>{step.objective}</span>
                          <small>{step.status === "completed" ? "已完成" : step.status === "active" ? "执行中" : step.status === "failed" ? "失败" : step.status === "skipped" ? "已跳过" : "等待"}</small>
                        </li>
                      ))}
                    </ol>
                    {harnessTask.executionPlan.replanReason ? <small>Replan：{harnessTask.executionPlan.replanReason}</small> : null}
                  </div>
                ) : null}
                {harnessTask.verification ? (
                  <div className={`harness-verification ${harnessTask.verification.status}`} aria-label="任务级 Verifier">
                    <div>
                      <b>任务级 Verifier</b>
                      <span>{verifierStatusLabels[harnessTask.verification.status]} · 第 {harnessTask.verification.attempt} 次</span>
                    </div>
                    {harnessTask.verification.checks.length ? (
                      <ol>
                        {harnessTask.verification.checks.map((item) => (
                          <li className={item.status} key={item.id} title={item.detail}>
                            <i />
                            <span>{item.label}</span>
                            <small>{item.status === "passed" ? "通过" : "未通过"}</small>
                          </li>
                        ))}
                      </ol>
                    ) : <small>等待 Executor 提交任务结果。</small>}
                    {harnessTask.verification.visualEvidence ? (
                      <div className="harness-visual-evidence" aria-label="Playwright 视觉证据">
                        <b>Playwright + 多模态模型</b>
                        <span>{visualVerifierStatusLabels[harnessTask.verification.visualEvidence.status]} · {harnessTask.verification.visualEvidence.screenshots.length} 张截图</span>
                        <small>{harnessTask.verification.visualEvidence.summary}</small>
                      </div>
                    ) : null}
                    {harnessTask.verification.issues[0] ? <small>验收缺口：{harnessTask.verification.issues[0]}</small> : null}
                  </div>
                ) : null}
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
                {harnessTask.exportArtifact && (
                  <div className="excel-export-ready">
                    <div>
                      <b>{harnessTask.exportArtifact.fileName}</b>
                      <small>{harnessTask.exportArtifact.rowCount} 行 · {harnessTask.exportArtifact.fieldCount} 个字段 · {(harnessTask.exportArtifact.sizeBytes / 1024).toFixed(1)} KB</small>
                    </div>
                    <ExcelDownloadButton artifact={harnessTask.exportArtifact} label="下载 Excel" />
                  </div>
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
        </div>
      </details>
      <div
        ref={conversationRef}
        className="conversation"
        role="log"
        aria-label="AI 对话上下文"
        aria-live="polite"
        onScroll={(event) => {
          conversationPinnedToBottomRef.current = isConversationNearBottom(event.currentTarget);
        }}
      >
        <div className="conversation-heading">
          <b>对话上下文</b>
          <div><span>{conversationTurns.length ? `已保留 ${conversationTurns.length} 轮` : "尚无历史对话"}</span><button type="button" disabled={!conversationTurns.length || isLoading} onClick={onClearConversation}>清除上下文</button></div>
        </div>
        {conversationTurns.map((turn) => (
          <article className={`conversation-turn ${turn.state}`} key={turn.id}>
            <div className="user-message">
              <small>你 · {new Date(turn.createdAt).toLocaleString("zh-CN")}</small>
              <span>{turn.instruction}</span>
            </div>
            <div className="assistant-message">
              <span className="ai-mark small">✦</span>
              <div>
                <p>{turn.response}</p>
                <small className="conversation-meta">
                  {turn.state === "success" ? "已回复" : turn.state === "blocked" ? "任务受限" : turn.state === "cancelled" ? "已取消" : "执行失败"}
                  {turn.taskId ? " · Harness" : " · 本地回复"}
                </small>
              </div>
            </div>
          </article>
        ))}
        {pendingInstruction && <div className="user-message pending-message"><small>你 · 正在处理</small><span>{pendingInstruction}</span></div>}
        {!conversationTurns.length && !pendingInstruction && (
          <div className="assistant-message conversation-empty">
            <span className="ai-mark small">✦</span>
            <div><p>{aiMessage}</p><small>发送问题后，会在这里保留连续的聊天上下文。</small></div>
          </div>
        )}
        {isLoading && (
          <div className="assistant-message conversation-pending">
            <span className="ai-mark small">✦</span>
            <div className="ai-request-state" role="status"><span className="ai-spinner" />正在请求 DeepSeek 并校验结果…</div>
          </div>
        )}
        <div className="assistant-message assistant-controls">
          <span className="ai-mark small">✦</span>
          <div>
            {requestError && (
              <div className={`validation-error${requestStatus === "blocked" ? " blocked-warning" : ""}`} role={requestStatus === "blocked" ? "status" : "alert"}>
                <b>{requestStatus === "blocked" ? "任务受限/缺少能力" : requestStatus === "timeout" ? "请求超时" : requestStatus === "cancelled" ? "请求已取消" : "AI 生成失败"}</b>
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
            <p className="safe-note">{dataAnalysisMode ? rawDataAccessEnabled
              ? "原始数据访问仅限当前会话：相关提问会完整扫描全部数据行并执行结构化查询，只向模型返回统计结果和最多 30 条可溯源记录；相同文件复用 30 分钟短期内存索引，不写入磁盘、localStorage、备份或审计正文。AI 回答仍会保留在对话中，看板修改只生成待预览 ChangeSet。"
              : "AI 当前只读取 EDS 派生汇总，不会获得原始工作簿或逐行明细；重新导入时可单独授权原始行访问。看板修改仍只生成待预览 ChangeSet。"
              : "AI 只生成待预览 ChangeSet，不会自动修改正式 AppSpec。"}</p>
          </div>
        </div>
      </div>
      <div className="prompt-box">
        {imageAttachments.length > 0 && (
          <div className="prompt-image-list" aria-label="待发送图片">
            {imageAttachments.map((file, index) => (
              <span className="prompt-image-chip" key={`${file.name}_${file.size}_${index}`}>
                <span aria-hidden="true">▧</span>
                <span title={file.name}>{file.name}</span>
                <button
                  type="button"
                  aria-label={`移除图片 ${file.name}`}
                  disabled={isLoading}
                  onClick={() => onImageAttachmentsChange(imageAttachments.filter((_, itemIndex) => itemIndex !== index))}
                >×</button>
              </span>
            ))}
          </div>
        )}
        <textarea
          aria-label="AI 指令"
          maxLength={1_000}
          value={instruction}
          disabled={isLoading}
          placeholder={dataAnalysisMode ? "例如：分析白夜班差异，或增加 B5FSL01 异常类型柱状图……" : "例如：将本月收入指标标题改为月度总收入……"}
          onChange={(event) => onInstructionChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && (instruction.trim() || imageAttachments.length) && !isLoading) onGenerate();
          }}
        />
        <div className="prompt-box-actions">
          <span className="prompt-box-meta">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length) onImageAttachmentsChange([...imageAttachments, ...files]);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className="prompt-attach-button"
              aria-label="上传图片"
              title="上传 JPEG、PNG 或 WebP，最多 3 张"
              disabled={isLoading || imageAttachments.length >= MAX_HARNESS_IMAGE_ATTACHMENTS}
              onClick={() => imageInputRef.current?.click()}
            >＋</button>
            <span>{imageAttachments.length ? `${imageAttachments.length} 张图片 · ` : ""}{instruction.length}/1000 · Ctrl + Enter</span>
          </span>
          {isLoading ? (
            <button type="button" aria-label="取消 AI 请求" onClick={onCancelRequest}>■</button>
          ) : (
            <button type="button" aria-label="发送 AI 指令" disabled={!instruction.trim() && !imageAttachments.length} onClick={onGenerate}>↑</button>
          )}
        </div>
      </div>
    </aside>
  );
}
