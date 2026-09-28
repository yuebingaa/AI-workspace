import { Button } from "@/components/ui/button";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { AiPlanMetadata } from "@/core/ai/contracts";
import type { HarnessTaskSummary } from "@/core/harness/contracts";
import type { AssistantConversationTurn } from "@/core/harness/conversation";
import type { ChangeOperation, ChangeSet } from "@/core/models";
import { ExcelDownloadButton } from "./ExcelDownloadButton";
import { ComposerContextMenu, type ComposerDataOption, type ComposerResultOption } from "./ComposerContextMenu";
import { ConversationSwitcher, type ConversationSwitcherProps } from "./ConversationSwitcher";
import { NotebookContextChips, type NotebookContextOption } from "./notebook/NotebookContextSelection";
import { DshWebFrame } from "./dsh-web/DshWebFrame";
import { StudioArtwork } from "./StudioArtwork";

export type ChangeSetUiStatus = "pending" | "preview" | "applied";
export type AiRequestUiStatus = "idle" | "loading" | "success" | "blocked" | "error" | "cancelled" | "timeout";
export const CONVERSATION_BOTTOM_THRESHOLD_PX = 48;

export function isConversationNearBottom(position: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">) {
  return position.scrollHeight - position.scrollTop - position.clientHeight <= CONVERSATION_BOTTOM_THRESHOLD_PX;
}

interface AiBuilderAssistantProps {
  onSubmitInstruction: (instruction: string, onAccepted: () => void) => Promise<void>;
  presentation?: "sidebar" | "workspace";
  dataSources?: ComposerDataOption[];
  workspaces?: ComposerDataOption[];
  activeWorkspaceId?: string;
  contextResults?: ComposerResultOption[];
  notebookOptions?: NotebookContextOption[];
  selectedNotebookCellIds?: string[];
  notebookContextDisabled?: boolean;
  onToggleNotebookCell?: (id: string) => void;
  onRemoveNotebookCell?: (id: string) => void;
  semanticModels?: ComposerDataOption[];
  activeSemanticModelId?: string;
  onSelectSemanticModel?: (id: string | null) => void;
  onManageSemanticModels?: () => void;
  onSelectWorkspace?: (id: string) => void;
  onSelectResult?: (result: ComposerResultOption) => void;
  activeDataSourceId?: string;
  onSelectDataSource?: (dataSourceId: string) => void;
  onImportData?: () => void;
  onOpenWorkspace?: () => void;
  onOpenNotebook?: () => void;
  notebookAutoRunEnabled?: boolean;
  pageTitle: string;
  changeSet: ChangeSet;
  status: ChangeSetUiStatus;
  validationError: string | null;
  canApply: boolean;
  canPreview: boolean;
  aiMetadata: AiPlanMetadata | null;
  instruction: string;
  requestStatus: AiRequestUiStatus;
  requestError: string | null;
  canRetry: boolean;
  harnessTask: HarnessTaskSummary | null;
  conversationTurns: AssistantConversationTurn[];
  conversationSwitcher?: ConversationSwitcherProps;
  pendingInstruction: string;
  dataAnalysisMode: boolean;
  rawDataAccessEnabled?: boolean;
  imageAttachments: File[];
  onInstructionChange: (instruction: string) => void;
  onImageAttachmentsChange: (files: File[]) => void;
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

function operationTargets(operation: ChangeOperation): string[] {
  if (operation.type === "addPage" || operation.type === "deletePage") return [operation.pageId];
  if (operation.type === "addNode") return [operation.parentId, operation.node.id];
  if (operation.type === "updatePage") return [operation.pageId];
  if (operation.type === "moveNode") return [operation.nodeId, operation.parentId];
  return [operation.nodeId];
}

export function AiBuilderAssistant({
  onSubmitInstruction,
  presentation = "sidebar",
  dataSources = [],
  workspaces = [],
  activeWorkspaceId = "",
  contextResults = [],
  notebookOptions = [],
  selectedNotebookCellIds = [],
  notebookContextDisabled = false,
  onToggleNotebookCell,
  onRemoveNotebookCell,
  semanticModels = [],
  activeSemanticModelId,
  onSelectSemanticModel,
  onManageSemanticModels,
  onSelectWorkspace,
  onSelectResult,
  activeDataSourceId = "",
  onSelectDataSource,
  onImportData,
  onOpenWorkspace,
  onOpenNotebook,
  notebookAutoRunEnabled = false,
  pageTitle,
  changeSet,
  status,
  validationError,
  canApply,
  canPreview,
  aiMetadata,
  instruction,
  requestStatus,
  requestError,
  canRetry,
  harnessTask,
  conversationTurns,
  conversationSwitcher,
  pendingInstruction,
  dataAnalysisMode,
  rawDataAccessEnabled = false,
  imageAttachments,
  onInstructionChange,
  onImageAttachmentsChange,
  onCancelRequest,
  onRetry,
  onPreview,
  onApply,
  onCancelPreview,
}: AiBuilderAssistantProps) {
  const affectedPages = [...new Set(changeSet.operations.map((operation) => operation.pageId))];
  const affectedComponents = [...new Set(changeSet.operations.flatMap(operationTargets))];
  const needsAdmin = changeSet.operations.some((operation) => operation.type === "removeNode");
  const isLoading = requestStatus === "loading";
  const showChangePlan = canPreview && (!harnessTask || Boolean(harnessTask.pendingChangeSet));
  const conversationRef = useRef<HTMLDivElement>(null);
  const conversationPinnedToBottomRef = useRef(true);
  const previousPendingInstructionRef = useRef("");
  const previousSessionIdRef = useRef("");
  const sessionId = conversationSwitcher?.sessions.activeId;
  const [contextMenuAnchor, setContextMenuAnchor] = useState<HTMLElement | null>(null);
  const isWorkspace = presentation === "workspace";
  const latestTurn = conversationTurns.at(-1);
  const errorShownInConversation = Boolean(requestError && !isLoading && (!harnessTask || latestTurn?.taskId === harnessTask.id)
    && latestTurn?.state !== "success" && latestTurn?.response === requestError);
  const isConversationEmpty = !conversationTurns.length && !pendingInstruction
    && !isLoading && !requestError && !validationError && !showChangePlan && !harnessTask;
  const isWorkspaceEmpty = isWorkspace && isConversationEmpty;
  const showDshEmptyWelcome = isWorkspaceEmpty && !instruction.trim()
    && imageAttachments.length === 0 && !conversationSwitcher?.disabledReason;
  const selectedSource = dataSources.find((source) => source.id === activeDataSourceId);
  const showControls = Boolean((requestError && !errorShownInConversation) || validationError || showChangePlan);
  const closeContextMenu = useCallback((restoreFocus = false) => {
    if (restoreFocus) requestAnimationFrame(() => { if (contextMenuAnchor?.isConnected) contextMenuAnchor.focus(); });
    setContextMenuAnchor(null);
  }, [contextMenuAnchor]);

  useEffect(() => {
    const conversation = conversationRef.current;
    const requestStarted = Boolean(pendingInstruction)
      && pendingInstruction !== previousPendingInstructionRef.current;
    if (conversation && (conversationPinnedToBottomRef.current || requestStarted || previousSessionIdRef.current !== sessionId)) {
      conversation.scrollTop = conversation.scrollHeight;
      conversationPinnedToBottomRef.current = true;
    }
    previousPendingInstructionRef.current = pendingInstruction;
    previousSessionIdRef.current = sessionId ?? "";
  }, [conversationTurns.length, isLoading, pendingInstruction, harnessTask?.trace?.length, sessionId]);

  return (
    <aside className={`right-panel panel${isWorkspace ? " agent-workspace-panel" : ""} official-dsh-panel`} aria-label={isWorkspace ? "AI 工作台" : "AI 助手"}>
      <div className={`assistant-head${conversationSwitcher ? " assistant-session-header" : ""}`}>
        {conversationSwitcher ? <ConversationSwitcher {...conversationSwitcher} /> : <div><span className="ai-mark">✦</span><div><b>{isWorkspace ? "AI 工作台" : dataAnalysisMode ? "AI 数据分析与看板助手" : "AI 构建助手"}</b><small>{isWorkspace ? "分析数据 · 创建图表 · 继续追问" : dataAnalysisMode ? (isLoading ? "正在分析已授权的数据" : rawDataAccessEnabled ? "分析汇总与已授权原始数据" : "分析数据 · 看板变更需确认") : (isLoading ? "正在准备看板变更预览" : "先预览，确认后应用")}</small></div></div>}
        <div className="assistant-head-actions">
            <span className="dsh-assistant-label" title="DSH 官方对话，目前支持文字；/、@、+ 扩展尚未接入，分析来源请用“数据”选择。">DSH</span>
            <Button variant="secondary" type="button" className="dsh-context-trigger" aria-label="选择分析数据与上下文" aria-haspopup="menu" aria-controls="composer-context-menu"
              aria-expanded={Boolean(contextMenuAnchor)} disabled={isLoading || Boolean(conversationSwitcher?.disabledReason)}
              title={selectedSource ? `当前数据：${selectedSource.name}` : "选择数据表、Notebook 单元或语义模型"}
              onClick={(event) => setContextMenuAnchor(contextMenuAnchor ? null : event.currentTarget)}>数据</Button>
          {!isWorkspace && onOpenWorkspace && <Button variant="secondary" type="button" className="assistant-expand-button" aria-label="在 AI 工作台中打开" title="在 AI 工作台中打开" onClick={onOpenWorkspace}>⤢</Button>}
        </div>
      </div>
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
        <DshWebFrame key={sessionId ?? "current"} snapshot={{ version: 1,
          session: { id: sessionId ?? "current", title: pageTitle.slice(0, 200) },
          turns: conversationTurns.map(({ id, instruction, response, createdAt, state }) => ({ id, instruction, response, createdAt, state })),
          draft: instruction, busy: isLoading,
          canSend: !isLoading && !conversationSwitcher?.disabledReason && imageAttachments.length === 0,
          pendingInstruction, statusText: (isLoading ? harnessTask?.trace?.at(-1)?.message ?? "DSH 正在处理" : requestError ?? "").slice(0, 1_000),
        }} onDraft={onInstructionChange} onCancel={onCancelRequest}
          onSend={onSubmitInstruction} />
        {showDshEmptyWelcome && <div className="dsh-web-empty-welcome" data-agentcanvas-dsh-empty-welcome="true">
          <StudioArtwork className="dsh-web-empty-art" />
          <h2>想从数据中了解什么？</h2>
          <p>提问、分析数据、创建图表。<br />从一个问题开始，让发现有据可循。</p>
        </div>}
        {!isLoading && canRetry && errorShownInConversation && <div className="dsh-web-feedback"><Button variant="secondary" type="button" onClick={onRetry}>重试这次任务</Button></div>}
        {imageAttachments.length > 0 && <div className="dsh-web-feedback" role="alert">
          <p>当前 DSH 对话暂不支持图片，请移除待发送图片后继续。</p>
          <Button variant="secondary" type="button" disabled={isLoading} onClick={() => onImageAttachmentsChange([])}>移除待发送图片</Button>
        </div>}
        {!isLoading && harnessTask?.notebookArtifact && onOpenNotebook && (
          <section className="notebook-assistant-artifact"><b>▤ {harnessTask.notebookArtifact.name}</b>
            <p>{harnessTask.notebookArtifact.cells.length} 个分析单元 · {harnessTask.notebookArtifact.executionEvidence?.status === "success" ? "已试运行" : "结构草稿"} · 正式看板未修改</p>
            <Button variant="secondary" type="button" onClick={onOpenNotebook}>{notebookAutoRunEnabled ? "打开 Notebook 查看分析 →" : "打开 Notebook 查看草稿 →"}</Button>
          </section>
        )}
        {!isLoading && harnessTask?.exportArtifact && (
          <div className="excel-export-ready">
            <div>
              <b>{harnessTask.exportArtifact.fileName}</b>
              <small>{harnessTask.exportArtifact.rowCount} 行 · {harnessTask.exportArtifact.fieldCount} 个字段 · {(harnessTask.exportArtifact.sizeBytes / 1024).toFixed(1)} KB</small>
            </div>
            <ExcelDownloadButton artifact={harnessTask.exportArtifact} label="下载 Excel" />
          </div>
        )}
        {showControls && <div className="assistant-message assistant-controls">
          <div>
            {requestError && !errorShownInConversation && (
              <div className={`validation-error${requestStatus === "blocked" ? " blocked-warning" : ""}`} role={requestStatus === "blocked" ? "status" : "alert"}>
                <b>{requestStatus === "blocked" ? "任务受限/缺少能力" : requestStatus === "timeout" ? "请求超时" : requestStatus === "cancelled" ? "请求已取消" : "AI 生成失败"}</b>
                <p>{requestError}</p>
                {canRetry && <Button variant="secondary" type="button" onClick={onRetry}>重试</Button>}
              </div>
            )}
            {validationError && (
              <div className="validation-error" role="alert">
                <b>无法执行变更</b>
                <p>{validationError}</p>
              </div>
            )}
            {showChangePlan && <div className={`change-plan change-plan-${status}`}>
              <div className="plan-head"><b>结构化变更计划</b><span className={status === "applied" ? "done" : status}>{statusLabels[status]}</span></div>
              <ol>
                {changeSet.operations.map((operation, index) => (
                  <li key={operation.id} style={{ "--change-index": index } as CSSProperties}>
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
                  <Button variant="secondary" type="button" onClick={onCancelPreview}>取消预览</Button>
                ) : (
                  <>
                    {harnessTask?.state === "awaitingConfirmation" && <Button variant="secondary" type="button" className="reject" onClick={onCancelPreview}>拒绝变更</Button>}
                    <Button variant="secondary" type="button" disabled={!canPreview || status === "applied" || isLoading} title={canPreview ? "预览已校验的 ChangeSet" : "当前没有通过校验的 AI ChangeSet"} onClick={onPreview}>画布预览</Button>
                  </>
                )}
                <Button variant="secondary"
                  type="button"
                  className="apply"
                  disabled={status !== "preview" || !canApply || isLoading}
                  title={!canApply ? "当前角色无权应用变更" : status !== "preview" ? "请先完成画布预览" : "人工确认并应用变更"}
                  onClick={onApply}
                >
                  {status === "applied" ? "已全部应用 ✓" : "确认并应用"}
                </Button>
              </div>
            </div>}
          </div>
        </div>}
      </div>
      <NotebookContextChips options={notebookOptions} selectedIds={selectedNotebookCellIds} disabled={isLoading || notebookContextDisabled}
        onRemove={(id) => onRemoveNotebookCell?.(id)} />
      {activeSemanticModelId && <div className="semantic-context"><span>◇ 使用语义模型：{semanticModels.find((model) => model.id === activeSemanticModelId)?.name}</span>
        <Button variant="secondary" type="button" disabled={isLoading} onClick={onManageSemanticModels}>管理</Button>
        <Button variant="secondary" type="button" disabled={isLoading} aria-label="取消语义模型选择" onClick={() => onSelectSemanticModel?.(null)}>×</Button></div>}
      {contextMenuAnchor && !isLoading && <ComposerContextMenu
        key={`${activeWorkspaceId}:${sessionId ?? "current"}`}
        anchor={contextMenuAnchor} placement="below" workspaces={workspaces} activeWorkspaceId={activeWorkspaceId}
        dataSources={dataSources} activeDataSourceId={activeDataSourceId} results={contextResults}
        notebookOptions={notebookOptions} selectedNotebookCellIds={selectedNotebookCellIds} notebookContextDisabled={notebookContextDisabled}
        onToggleNotebookCell={onToggleNotebookCell} onOpenNotebook={onOpenNotebook}
        semanticModels={semanticModels} activeSemanticModelId={activeSemanticModelId}
        onSelectSemanticModel={(id) => onSelectSemanticModel?.(id)} onManageSemanticModels={onManageSemanticModels}
        onClose={closeContextMenu}
        onChooseFiles={() => onImportData?.()}
        onImportData={() => onImportData?.()}
        onSelectWorkspace={(id) => onSelectWorkspace?.(id)}
        onSelectDataSource={(id) => onSelectDataSource?.(id)}
        onSelectResult={(result) => onSelectResult?.(result)}
      />}
    </aside>
  );
}
