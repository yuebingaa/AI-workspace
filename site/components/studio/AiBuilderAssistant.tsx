import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { AiPlanMetadata } from "@/core/ai/contracts";
import {
  MAX_HARNESS_IMAGE_ATTACHMENTS,
  type HarnessTaskSummary,
} from "@/core/harness/contracts";
import type { AssistantConversationTurn } from "@/core/harness/conversation";
import type { ChangeOperation, ChangeSet } from "@/core/models";
import { ExcelDownloadButton } from "./ExcelDownloadButton";
import { AiApiSettings } from "./AiApiSettings";
import { WecomSettings } from "./WecomSettings";
import { HarnessTrace } from "./HarnessTrace";
import { AgentWorkspaceWelcome } from "./AgentWorkspace";
import { ComposerContextMenu, type ComposerDataOption, type ComposerResultOption } from "./ComposerContextMenu";

export type ChangeSetUiStatus = "pending" | "preview" | "applied";
export type AiRequestUiStatus = "idle" | "loading" | "success" | "blocked" | "error" | "cancelled" | "timeout";
export const CONVERSATION_BOTTOM_THRESHOLD_PX = 48;

export function isConversationNearBottom(position: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">) {
  return position.scrollHeight - position.scrollTop - position.clientHeight <= CONVERSATION_BOTTOM_THRESHOLD_PX;
}

const acceptedHarnessImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export function clipboardImageFiles(items: ArrayLike<Pick<DataTransferItem, "kind" | "type" | "getAsFile">>): File[] {
  return Array.from(items).flatMap((item) => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile();
    return file && acceptedHarnessImageTypes.has(file.type || item.type) ? [file] : [];
  });
}

interface AiBuilderAssistantProps {
  presentation?: "sidebar" | "workspace";
  dataSources?: ComposerDataOption[];
  workspaces?: ComposerDataOption[];
  activeWorkspaceId?: string;
  contextResults?: ComposerResultOption[];
  semanticModels?: ComposerDataOption[];
  activeSemanticModelId?: string;
  onSelectSemanticModel?: (id: string | null) => void;
  onManageSemanticModels?: () => void;
  onSelectWorkspace?: (id: string) => void;
  onSelectResult?: (result: ComposerResultOption) => void;
  onImportFiles?: (files: File[]) => void;
  activeDataSourceId?: string;
  onSelectDataSource?: (dataSourceId: string) => void;
  onImportData?: () => void;
  onOpenWorkspace?: () => void;
  onOpenNotebook?: () => void;
  pageTitle: string;
  datasetName: string;
  changeSet: ChangeSet;
  status: ChangeSetUiStatus;
  validationError: string | null;
  canApply: boolean;
  canPreview: boolean;
  aiMessage: string;
  aiMetadata: AiPlanMetadata | null;
  instruction: string;
  requestStatus: AiRequestUiStatus;
  requestError: string | null;
  canRetry: boolean;
  harnessTask: HarnessTaskSummary | null;
  harnessTasks?: HarnessTaskSummary[];
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

function operationTargets(operation: ChangeOperation): string[] {
  if (operation.type === "addPage" || operation.type === "deletePage") return [operation.pageId];
  if (operation.type === "addNode") return [operation.parentId, operation.node.id];
  if (operation.type === "updatePage") return [operation.pageId];
  if (operation.type === "moveNode") return [operation.nodeId, operation.parentId];
  return [operation.nodeId];
}

export function AiBuilderAssistant({
  presentation = "sidebar",
  dataSources = [],
  workspaces = [],
  activeWorkspaceId = "",
  contextResults = [],
  semanticModels = [],
  activeSemanticModelId,
  onSelectSemanticModel,
  onManageSemanticModels,
  onSelectWorkspace,
  onSelectResult,
  onImportFiles,
  activeDataSourceId = "",
  onSelectDataSource,
  onImportData,
  onOpenWorkspace,
  onOpenNotebook,
  pageTitle,
  datasetName,
  changeSet,
  status,
  validationError,
  canApply,
  canPreview,
  aiMessage,
  aiMetadata,
  instruction,
  requestStatus,
  requestError,
  canRetry,
  harnessTask,
  harnessTasks = [],
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
  const needsAdmin = changeSet.operations.some((operation) => operation.type === "removeNode");
  const isLoading = requestStatus === "loading";
  const showChangePlan = canPreview && (!harnessTask || Boolean(harnessTask.pendingChangeSet));
  const conversationRef = useRef<HTMLDivElement>(null);
  const conversationPinnedToBottomRef = useRef(true);
  const previousPendingInstructionRef = useRef("");
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [contextMenuAnchor, setContextMenuAnchor] = useState<HTMLElement | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const isWorkspace = presentation === "workspace";
  const latestTurn = conversationTurns.at(-1);
  const errorShownInConversation = Boolean(requestError && !isLoading && latestTurn?.taskId === harnessTask?.id
    && latestTurn?.state !== "success" && latestTurn?.response === requestError);
  const isWorkspaceEmpty = isWorkspace && !conversationTurns.length && !pendingInstruction
    && !isLoading && !requestError && !validationError && !showChangePlan;
  const selectedSource = dataSources.find((source) => source.id === activeDataSourceId);
  const closeContextMenu = useCallback((restoreFocus = false) => {
    if (restoreFocus) requestAnimationFrame(() => { if (contextMenuAnchor?.isConnected) contextMenuAnchor.focus(); });
    setContextMenuAnchor(null);
  }, [contextMenuAnchor]);

  function handleAttachmentFiles(files: File[]) {
    const images = files.filter((file) => acceptedHarnessImageTypes.has(file.type));
    const tables = files.filter((file) => /\.(?:csv|xlsx)$/iu.test(file.name));
    const unsupported = files.filter((file) => !images.includes(file) && !tables.includes(file));
    if (unsupported.length) {
      setAttachmentError("目前支持 CSV、XLSX、JPEG、PNG 和 WebP 文件，请重新选择。");
      return;
    }
    setAttachmentError(null);
    if (images.length) onImageAttachmentsChange([...imageAttachments, ...images]);
    if (tables.length) onImportFiles?.(tables);
  }

  useEffect(() => {
    const conversation = conversationRef.current;
    const requestStarted = Boolean(pendingInstruction)
      && pendingInstruction !== previousPendingInstructionRef.current;
    if (conversation && (conversationPinnedToBottomRef.current || requestStarted)) {
      conversation.scrollTop = conversation.scrollHeight;
      conversationPinnedToBottomRef.current = true;
    }
    previousPendingInstructionRef.current = pendingInstruction;
  }, [conversationTurns.length, isLoading, pendingInstruction, harnessTask?.trace?.length]);

  return (
    <aside className={`right-panel panel${isWorkspace ? " agent-workspace-panel" : ""}${isWorkspaceEmpty ? " agent-workspace-empty" : ""}`} aria-label={isWorkspace ? "AI 工作台" : "AI 助手"}>
      <div className="assistant-head">
        <div><span className="ai-mark">✦</span><div><b>{isWorkspace ? "AI 工作台" : dataAnalysisMode ? "AI 数据分析与看板助手" : "AI 构建助手"}</b><small>{isWorkspace ? "分析数据 · 创建图表 · 继续追问" : dataAnalysisMode ? (isLoading ? "正在分析已授权的数据" : rawDataAccessEnabled ? "分析汇总与已授权原始数据" : "分析数据 · 看板变更需确认") : (isLoading ? "正在准备看板变更预览" : "先预览，确认后应用")}</small></div></div>
        <div className="assistant-head-actions">
          {!isWorkspace && onOpenWorkspace && <button type="button" className="assistant-expand-button" aria-label="在 AI 工作台中打开" title="在 AI 工作台中打开" onClick={onOpenWorkspace}>⤢</button>}
          <AiApiSettings />
          <WecomSettings onSuggestion={onInstructionChange} />
        </div>
      </div>
      {!isWorkspace && <div className="context-pill">上下文：{pageTitle} · {datasetName.replace(".csv", "")}</div>}
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
        {!isWorkspaceEmpty && <div className="conversation-heading">
          <b>对话上下文</b>
          <div><span>{conversationTurns.length ? `已保留 ${conversationTurns.length} 轮` : "尚无历史对话"}</span><button type="button" disabled={!conversationTurns.length || isLoading} onClick={onClearConversation}>清除上下文</button></div>
        </div>}
        {isWorkspaceEmpty && <AgentWorkspaceWelcome onSuggestion={(value) => {
          onInstructionChange(value);
          promptRef.current?.focus();
        }} />}
        {conversationTurns.map((turn) => (
          <article className={`conversation-turn ${turn.state}`} key={turn.id}>
            <div className="user-message">
              <small>你 · {new Date(turn.createdAt).toLocaleString("zh-CN")}</small>
              <span>{turn.instruction}</span>
            </div>
            <HarnessTrace task={harnessTasks.find((task) => task.id === turn.taskId) ?? (harnessTask?.id === turn.taskId ? harnessTask : undefined)} />
            <div className="assistant-message">
              <span className="ai-mark small">✦</span>
              <div>
                <p>{turn.response}</p>
                <small className="conversation-meta">
                  {turn.state === "success" ? "已回复" : turn.state === "blocked" ? "任务受限" : turn.state === "cancelled" ? "已取消" : "执行失败"}
                  {turn.taskId ? " · Harness" : " · 本地回复"}
                </small>
                {turn.id === latestTurn?.id && errorShownInConversation && canRetry && (
                  <div><button className="conversation-retry" type="button" onClick={onRetry}>重试这次任务</button></div>
                )}
              </div>
            </div>
          </article>
        ))}
        {pendingInstruction && <div className="user-message pending-message"><small>你 · 正在处理</small><span>{pendingInstruction}</span></div>}
        {isLoading && <HarnessTrace task={harnessTask} running />}
        {!isWorkspaceEmpty && !conversationTurns.length && !pendingInstruction && (
          <div className="assistant-message conversation-empty">
            <span className="ai-mark small">✦</span>
            <div><p>{aiMessage}</p><small>发送问题后，会在这里保留连续的聊天上下文。</small></div>
          </div>
        )}
        {isLoading && !harnessTask?.trace?.length && (
          <div className="assistant-message conversation-pending">
            <span className="ai-mark small">✦</span>
            <div className="ai-request-state" role="status"><span className="ai-spinner" />正在请求 DeepSeek 并校验结果…</div>
          </div>
        )}
        {!isLoading && harnessTask?.notebookArtifact && onOpenNotebook && (
          <section className="notebook-assistant-artifact"><b>▤ {harnessTask.notebookArtifact.name}</b>
            <p>{harnessTask.notebookArtifact.cells.length} 个分析单元 · {harnessTask.notebookArtifact.executionEvidence?.status === "success" ? "已试运行" : "结构草稿"} · 正式看板未修改</p>
            <button type="button" onClick={onOpenNotebook}>打开 Notebook 查看草稿 →</button>
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
        {!isWorkspaceEmpty && (!errorShownInConversation || validationError || showChangePlan) && <div className="assistant-message assistant-controls">
          <span className="ai-mark small">✦</span>
          <div>
            {requestError && !errorShownInConversation && (
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
            <p className="safe-note">{isWorkspace ? "分析基于当前工作界面的数据；看板变更会先生成预览，确认后应用。" : dataAnalysisMode ? rawDataAccessEnabled
              ? "原始数据访问仅限当前会话：相关提问会完整扫描全部数据行并执行结构化查询，只向模型返回统计结果和最多 30 条可溯源记录；相同文件复用 30 分钟短期内存索引，不写入磁盘、localStorage、备份或审计正文。AI 回答仍会保留在对话中，看板修改只生成待预览 ChangeSet。"
              : "AI 当前只读取 EDS 派生汇总，不会获得原始工作簿或逐行明细；重新导入时可单独授权原始行访问。看板修改仍只生成待预览 ChangeSet。"
              : "看板修改会先生成预览，由你确认后应用。"}</p>
          </div>
        </div>}
      </div>
      {isWorkspace && <div className="agent-context-bar agent-context-bar-menu">
        <div className="composer-context-chips">
          {selectedSource ? <span className="composer-context-chip" title={`优先分析：${selectedSource.name}`}><span aria-hidden="true">▦</span><b>{selectedSource.name}</b><button type="button" disabled={isLoading} aria-label={`取消指定数据表 ${selectedSource.name}`} onClick={() => onSelectDataSource?.("")}>×</button></span>
            : <span className="composer-context-placeholder"><span aria-hidden="true">✧</span>添加上下文，让回答更有依据</span>}
        </div>
        <button type="button" className="context-add-trigger" disabled={isLoading} aria-haspopup="menu" aria-expanded={Boolean(contextMenuAnchor)} onClick={(event) => setContextMenuAnchor(contextMenuAnchor ? null : event.currentTarget)}>添加上下文 <span aria-hidden="true">↗</span></button>
      </div>}
      {activeSemanticModelId && <div className="semantic-context"><span>◇ 使用语义模型：{semanticModels.find((model) => model.id === activeSemanticModelId)?.name}</span>
        <button type="button" disabled={isLoading} onClick={onManageSemanticModels}>管理</button>
        <button type="button" disabled={isLoading} aria-label="取消语义模型选择" onClick={() => onSelectSemanticModel?.(null)}>×</button></div>}
      <div className="prompt-box">
        {attachmentError && <p className="composer-attachment-error" role="alert">{attachmentError}</p>}
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
          ref={promptRef}
          aria-label="AI 指令"
          title="可输入文字，也可按 Ctrl+V 直接粘贴截图"
          maxLength={1_000}
          value={instruction}
          disabled={isLoading}
          placeholder={isWorkspace ? "问一个关于数据的问题，或描述你想创建的看板…" : dataAnalysisMode ? "例如：分析白夜班差异，或增加 B5FSL01 异常类型柱状图……" : "例如：将本月收入指标标题改为月度总收入……"}
          onChange={(event) => onInstructionChange(event.target.value)}
          onPaste={(event) => {
            const files = clipboardImageFiles(event.clipboardData.items);
            if (!files.length) return;
            event.preventDefault();
            onImageAttachmentsChange([...imageAttachments, ...files]);
          }}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && (instruction.trim() || imageAttachments.length) && !isLoading) onGenerate();
          }}
        />
        <div className="prompt-box-actions">
          <span className="prompt-box-meta">
            {onImportFiles && <input ref={attachmentInputRef} type="file" hidden multiple aria-label="选择文件或图片" accept=".csv,.xlsx,image/jpeg,image/png,image/webp" onChange={(event) => {
              handleAttachmentFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }} />}
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
            {onImportFiles ? <button type="button" className="prompt-attach-button context-plus-trigger" aria-label="添加附件或上下文" aria-haspopup="menu" aria-controls="composer-context-menu" aria-expanded={Boolean(contextMenuAnchor)} title="添加文件、数据表或处理结果" disabled={isLoading} onClick={(event) => setContextMenuAnchor(contextMenuAnchor ? null : event.currentTarget)}>＋</button> : <button
              type="button"
              className="prompt-attach-button"
              aria-label="上传图片"
              title="上传 JPEG、PNG 或 WebP，最多 3 张"
              disabled={isLoading || imageAttachments.length >= MAX_HARNESS_IMAGE_ATTACHMENTS}
              onClick={() => imageInputRef.current?.click()}
            >＋</button>}
            <span className="prompt-shortcuts">{imageAttachments.length ? `${imageAttachments.length} 张图片 · ` : ""}{instruction.length}/1000 · Ctrl+V 粘贴图片 · Ctrl+Enter 发送</span>
          </span>
          {isLoading ? (
            <button type="button" aria-label="取消 AI 请求" onClick={onCancelRequest}>■</button>
          ) : (
            <button type="button" aria-label="发送 AI 指令" disabled={!instruction.trim() && !imageAttachments.length} onClick={onGenerate}>↑</button>
          )}
        </div>
      </div>
      {contextMenuAnchor && !isLoading && <ComposerContextMenu
        anchor={contextMenuAnchor} workspaces={workspaces} activeWorkspaceId={activeWorkspaceId}
        dataSources={dataSources} activeDataSourceId={activeDataSourceId} results={contextResults}
        semanticModels={semanticModels} activeSemanticModelId={activeSemanticModelId}
        onSelectSemanticModel={(id) => onSelectSemanticModel?.(id)} onManageSemanticModels={onManageSemanticModels}
        onClose={closeContextMenu}
        onChooseFiles={() => attachmentInputRef.current?.click()}
        onImportData={() => onImportData?.()}
        onSelectWorkspace={(id) => onSelectWorkspace?.(id)}
        onSelectDataSource={(id) => onSelectDataSource?.(id)}
        onSelectResult={(result) => onSelectResult?.(result)}
      />}
    </aside>
  );
}
