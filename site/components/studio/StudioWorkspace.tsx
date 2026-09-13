"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  appSpecRevision,
  appSpecToPuckData,
  initializePuckDraft,
  puckDataToChangeSet,
  updatePuckDraft,
  type PuckDraftOrigin,
  type StudioPuckData,
} from "@/adapters/puck";
import type { AiPlanMetadata } from "@/core/ai/contracts";
import {
  applyChangeSet,
  cancelPreview,
  createExecutionState,
  previewChangeSet,
  undoLastChange,
} from "@/core/changesets";
import { createChangeSetAuditRecord, createChangeSetAuditRecordFromSummary, appendChangeSetAuditRecord } from "@/core/audit";
import { appendQueryExecutionRecord } from "@/core/data";
import {
  appendHarnessTask,
  settleHarnessConfirmation,
} from "@/core/harness/task-state";
import { loadUploadedDataset } from "@/core/datasets/client";
import {
  synchronizeUploadedDatasetExecution,
  synchronizeUploadedDatasetProduct,
  synchronizeUploadedDatasetWorkspace,
  removeUploadedDatasetFromWorkspace,
} from "@/core/datasets/workspace-state";
import type { DatasetUploadResponse } from "@/core/datasets/contracts";
import type { HarnessNotebookArtifact, HarnessNotebookCell } from "@/core/harness/notebook-contracts";
import type { NotebookDocument } from "@/core/notebook/contracts";
import { notebookDashboardPreview } from "@/core/notebook/dashboard";
import {
  EDS_WORKSPACE_PAGE_ID,
  getEdsWorkspaceReports,
  mergeEdsWorkspaceRuntime,
} from "@/core/eds";
import type { AiChangeSetAuditMetadata, ChangeOperation, ChangeSet, ChangeSetAuditRecord, ChangeSetAuditSource, ChangeSetAuditStatus, QueryExecutionRecord } from "@/core/models";
import type { StudioRole } from "@/core/permissions";
import {
  createBrowserStudioRepository,
  createStudioSnapshot,
  exportStudioBackup,
  importStudioBackup,
  loadStudioStateSafely,
  restoreStudioBackup,
  saveStudioStateSafely,
  STUDIO_BACKUP_MAX_BYTES,
  type StudioRepository,
} from "@/core/repository";
import { readableValidationError } from "@/core/schemas";
import {
  datasetsForWorkspace,
  ensureInitialBlankWorkspaceInExecution,
  ensureInitialBlankWorkspaceInProduct,
  INITIAL_WORKSPACE_PAGE_ID,
  reconcileDataProductWorkspaces,
} from "@/core/workspaces";
import { demoFixtureResult, type DemoFixtures } from "@/fixtures/demo-product";
import { AiBuilderAssistant, type ChangeSetUiStatus } from "./AiBuilderAssistant";
import { ActivityHistoryPanel, restoreDialogTrigger } from "./ActivityHistoryPanel";
import { CsvUploadDialog } from "./CsvUploadDialog";
import { DataProductCanvas, type CanvasMode } from "./DataProductCanvas";
import { DataSourceDetailsPanel } from "./DataSourceDetailsPanel";
import { EdsAnalysisDialog } from "./EdsAnalysisDialog";
import { triggerBrowserDownload } from "./ExcelDownloadButton";
import { PageStructurePanel } from "./PageStructurePanel";
import { PublishReadinessDialog } from "./PublishReadinessDialog";
import { OriginalWorkbookDialog } from "./OriginalWorkbookDialog";
import { StudioHeader, type PreviewDevice } from "./StudioHeader";
import { WorkspaceModeBar, type WorkspaceMode } from "./AgentWorkspace";
import { NotebookPanel } from "./notebook/NotebookPanel";
import type { ComposerResultOption } from "./ComposerContextMenu";
import { useStudioPageActions, selectablePageId, useStudioPagesState } from "./workspace/pages";
import { harnessUiClock, useStudioAssistantActions, useStudioAssistantState } from "./workspace/assistant";
import { useStudioDatasetActions, useStudioDatasetsState } from "./workspace/datasets";
import { useStudioSemanticState, useStudioSemanticActions } from "./workspace/semantics";
import { SemanticModelManager, SemanticModelSection } from "./SemanticModelManager";
import { selectedSemanticModel } from "@/core/semantic/model";
import { WorkspaceSidebarRail } from "./WorkspaceSidebarRail";
import { LocalProjectsProvider, useLocalProjects } from "./projects/LocalProjectsProvider";
import { DataBrowser } from "./projects/DataBrowser";
import type { DatasetUploadResponse as ProjectDatasetResponse } from "@/core/datasets/contracts";
import {
  ASSISTANT_PANEL_MAX_WIDTH,
  ASSISTANT_PANEL_MIN_WIDTH,
  clampAssistantPanelWidth,
  getAssistantPanelWidthBounds,
} from "./assistant-panel-layout";

function changeOperationHighlightTargets(operation: ChangeOperation): string[] {
  if (operation.type === "addPage" || operation.type === "deletePage") return [];
  if (operation.type === "addNode") return [operation.node.id];
  if (operation.type === "updatePage") return [];
  return [operation.nodeId];
}

export function StudioWorkspace() {
  return <LocalProjectsProvider><StudioProjectWorkspace /></LocalProjectsProvider>;
}

function StudioProjectWorkspace() {
  const project = useLocalProjects();
  if (!demoFixtureResult.success) {
    return (
      <main className="studio-shell fixture-failure-shell">
        <div className="brand"><span className="brand-mark">D</span><span>DataCanvas AI</span><small>AI 数据产品工作室</small></div>
        <aside className="fixture-failure-panel">
          <span className="ai-mark">!</span>
          <div><b>演示数据无法进入工作台</b><p>{demoFixtureResult.error}</p></div>
        </aside>
      </main>
    );
  }

  return <ValidatedStudioWorkspace key={`${project.session?.handle ?? "temporary"}:${project.instanceId}`} fixtures={demoFixtureResult.data} />;
}

function ValidatedStudioWorkspace({ fixtures }: { fixtures: DemoFixtures }) {
  const localProject = useLocalProjects();
  const [dataBrowserOpen, setDataBrowserOpen] = useState(false);
  const { repurchaseChangeSet } = fixtures;
  const initialProduct = useMemo(
    () => {
      const product = ensureInitialBlankWorkspaceInProduct(structuredClone(fixtures.dataProduct));
      if (!localProject.session) return product;
      return { ...product, id: `project_${localProject.session.manifest.id}`, name: localProject.session.manifest.name,
        datasets: [], recipes: [], notebooks: {}, semanticLayer: { models: [], selectedByWorkspace: {} },
        appSpec: { ...product.appSpec, dataSources: [], pages: product.appSpec.pages.filter((page) => page.id === INITIAL_WORKSPACE_PAGE_ID),
          navigation: product.appSpec.navigation.filter((entry) => entry.pageId === INITIAL_WORKSPACE_PAGE_ID) } };
    },
    [fixtures.dataProduct, localProject.session],
  );
  const [dataProduct, setDataProduct] = useState(() => structuredClone(initialProduct));
  const [execution, setExecution] = useState(() => createExecutionState(initialProduct.appSpec));
  const [dataRuntime, setDataRuntime] = useState(() => localProject.session ? { rowsByDataSourceId: {} } : structuredClone(fixtures.dataRuntime));
  const renderedSpec = execution.preview?.appSpec ?? execution.present;
  const { activePageId, setActivePageId, activePage, interfaces } = useStudioPagesState(renderedSpec, dataProduct);
  const datasets = useStudioDatasetsState(dataProduct, renderedSpec, activePageId);
  const {
    edsWorkspace,
    setEdsWorkspace,
    activeDataSourceId,
    setActiveDataSourceId,
    isDataSourceOpen,
    setIsDataSourceOpen,
    isCsvUploadOpen,
    setIsCsvUploadOpen,
    composerImportFiles,
    setComposerImportFiles,
    isEdsAnalysisOpen,
    setOriginalWorkbooks,
    setOpenOriginalWorkbookId,
    dataset,
    activeDataSource,
    workspaceDatasets,
    activeOriginalWorkbooks,
    activeOriginalWorkbook,
    openOriginalWorkbook,
    edsReportOptions,
    originalWorkbookButtonRef,
    originalWorkbookTriggerRef,
    handleOpenEdsAnalysis,
    handleCloseEdsAnalysis,
    handleOpenOriginalWorkbook,
  } = datasets;
  const semantic = useStudioSemanticState(dataProduct, activePageId, activeDataSource?.id ?? "");
  const [spreadsheetResultFocusRevision, setSpreadsheetResultFocusRevision] = useState(0);
  const [device] = useState<PreviewDevice>("desktop");
  const [saveLabel, setSaveLabel] = useState("已保存 · 演示草稿");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("preview");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("canvas");
  const [notebookInteractionBusy, setNotebookInteractionBusy] = useState(false);
  const [puckDraft, setPuckDraft] = useState<StudioPuckData | null>(null);
  const [puckSessionKey, setPuckSessionKey] = useState(0);
  const [pendingPuckChangeSet, setPendingPuckChangeSet] = useState<ChangeSet | null>(null);
  const [role, setRole] = useState<StudioRole>("editor");
  const [queryRecords, setQueryRecords] = useState<QueryExecutionRecord[]>([]);
  const [auditRecords, setAuditRecords] = useState<ChangeSetAuditRecord[]>([]);
  const [pendingChangeSource, setPendingChangeSource] = useState<ChangeSetAuditSource | null>(null);
  const [persistenceNotice, setPersistenceNotice] = useState<string | null>(null);
  const assistant = useStudioAssistantState(repurchaseChangeSet);
  const {
    aiChangeSet,
    setAiChangeSet,
    aiMessage,
    setAiMessage,
    aiMetadata,
    setAiMetadata,
    aiInstruction,
    setAiInstruction,
    aiImageAttachments,
    lastSubmittedInstruction,
    setLastSubmittedInstruction,
    aiRequestStatus,
    setAiRequestStatus,
    aiRequestError,
    setAiRequestError,
    hasValidAiPlan,
    setHasValidAiPlan,
    harnessTasks,
    setHarnessTasks,
    assistantConversation,
    setAssistantConversation,
    setLastHarnessTaskId,
    isLocalAssistantReply,
    setIsLocalAssistantReply,
    aiRequestAbortRef,
  } = assistant;
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isPublishInfoOpen, setIsPublishInfoOpen] = useState(false);
  const [compactPanel, setCompactPanel] = useState<"pages" | "assistant" | null>(null);
  const [isPagesExpanded, setIsPagesExpanded] = useState(false);
  const [assistantPanelWidth, setAssistantPanelWidth] = useState<number | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(true);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const publishButtonRef = useRef<HTMLButtonElement>(null);
  const pagesButtonRef = useRef<HTMLButtonElement>(null);
  const assistantButtonRef = useRef<HTMLButtonElement>(null);
  const backupFileInputRef = useRef<HTMLInputElement>(null);
  const sidebarRailToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarPanelCloseRef = useRef<HTMLButtonElement>(null);
  const assistantPanelSlotRef = useRef<HTMLDivElement>(null);
  const assistantResizeStateRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const repositoryRef = useRef<StudioRepository | null>(null);
  const persistedQueryRecordsRef = useRef<QueryExecutionRecord[] | null>(null);
  const puckDraftOriginRef = useRef<PuckDraftOrigin | null>(null);
  const latestDatasetWorkspaceRef = useRef({
    execution,
    dataProduct,
    dataRuntime,
    activeDataSourceId,
    auditRecords,
    queryRecords,
    harnessTasks,
    assistantConversation,
    edsWorkspace,
  });

  const isApplied = execution.appliedChangeSetIds.includes(aiChangeSet.id);
  const isAiPreview = execution.preview?.changeSetId === aiChangeSet.id;
  const status: ChangeSetUiStatus = isApplied ? "applied" : isAiPreview ? "preview" : "pending";
  const contextResults = useMemo<ComposerResultOption[]>(() => {
    const sources = new Set(workspaceDatasets.map((source) => source.id));
    return [
      ...dataProduct.recipes.filter((recipe) => sources.has(recipe.sourceDatasetId)).map((recipe) => ({
        id: recipe.id, name: recipe.name, kind: "recipe" as const,
        detail: `${recipe.steps.length} 个步骤 · 填入配方结果分析问题`,
      })),
      ...harnessTasks.flatMap((task, index) => task.tableArtifact && sources.has(task.tableArtifact.sourceDataSourceId)
        && harnessTasks.findIndex((candidate) => candidate.tableArtifact?.sourceDataSourceId === task.tableArtifact?.sourceDataSourceId) === index ? [{
        id: task.tableArtifact.id, name: task.tableArtifact.name, kind: "artifact" as const,
        detail: `${task.tableArtifact.totalRowCount} 行 · 在看板中查看`,
      }] : []),
    ];
  }, [workspaceDatasets, dataProduct.recipes, harnessTasks]);
  const notebookDocument = dataProduct.notebooks?.[activePageId] ?? { name: `${activePage?.title ?? "工作界面"} · 分析文档`, revision: 0, cells: [] };
  const notebookSources = renderedSpec.dataSources.filter((source) => workspaceDatasets.some((item) => item.id === source.id)
    && (source.sourceType === "csv" || source.sourceType === "local-fixture"));
  const notebookDraft = harnessTasks.find((task) => task.pageId === activePageId && task.notebookArtifact
    && (task.state === "awaitingConfirmation" || task.state === "completed"))?.notebookArtifact;
  const formalAppSpecRevision = useMemo(() => appSpecRevision(execution.present), [execution.present]);
  const canvasChangeFeedback = useMemo(() => {
    if (status !== "preview" && status !== "applied") return null;
    return {
      revision: `${aiChangeSet.id}:${status}`,
      status,
      nodeIds: [...new Set(aiChangeSet.operations.flatMap(changeOperationHighlightTargets))],
    };
  }, [aiChangeSet, status]);
  useEffect(() => {
    if (!compactPanel) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const trigger = compactPanel === "pages" ? pagesButtonRef.current : assistantButtonRef.current;
      setCompactPanel(null);
      queueMicrotask(() => trigger?.focus());
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [compactPanel]);

  useEffect(() => {
    if (assistantPanelWidth === null) return;
    const clampToViewport = () => {
      setAssistantPanelWidth((current) => current === null
        ? null
        : clampAssistantPanelWidth(current, window.innerWidth, isPagesExpanded));
    };
    clampToViewport();
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, [assistantPanelWidth, isPagesExpanded]);

  useEffect(() => () => {
    document.documentElement.classList.remove("assistant-panel-resizing");
  }, []);

  function handleWorkspaceModeChange(mode: WorkspaceMode) {
    setWorkspaceMode(mode);
    setCompactPanel(null);
    try {
      window.localStorage.setItem("datacanvas-ai:workspace-mode:v1", mode);
    } catch { /* Keeping a view preference is optional. */ }
  }

  function handleNotebookChange(document: NotebookDocument, adopted?: HarnessNotebookArtifact) {
    if (role === "viewer" || aiRequestStatus === "loading") throw new Error("当前不能修改 Notebook，请等待任务结束或切换为编辑者");
    const current = latestDatasetWorkspaceRef.current;
    const nextProduct = { ...current.dataProduct, notebooks: { ...current.dataProduct.notebooks, [activePageId]: document } };
    const related = adopted ? current.harnessTasks.find((task) => task.notebookArtifact?.id === adopted.id && task.state === "awaitingConfirmation") : undefined;
    const nextTasks = related ? appendHarnessTask(current.harnessTasks, settleHarnessConfirmation(related, true, harnessUiClock)) : current.harnessTasks;
    latestDatasetWorkspaceRef.current = { ...current, dataProduct: nextProduct, harnessTasks: nextTasks };
    setDataProduct(nextProduct); setHarnessTasks(nextTasks);
    setSaveLabel(adopted ? "已采用 Notebook 草稿 · 正式看板未修改" : "Notebook 步骤已保存 · 受影响结果需重算");
    persistExplicitly(current.execution, current.auditRecords, current.queryRecords, nextProduct, nextTasks);
  }

  function handleNotebookSnapshot(snapshot: DatasetUploadResponse, cell: HarnessNotebookCell) {
    if (role === "viewer" || aiRequestStatus === "loading") throw new Error("当前不能创建看板预览");
    const current = latestDatasetWorkspaceRef.current;
    const page = current.execution.present.pages.find((item) => item.id === activePageId);
    if (!page) throw new Error("目标工作界面已经移除");
    const changeSet = notebookDashboardPreview(page, cell, snapshot, crypto.randomUUID().replaceAll("-", ""));
    const synchronized = synchronizeUploadedDatasetWorkspace(current, snapshot.dataset, snapshot.rows);
    const nextProduct = { ...synchronized.dataProduct, datasets: synchronized.dataProduct.datasets.map((item) => item.id === snapshot.dataset.datasetId ? { ...item, workspaceId: activePageId } : item) };
    const nextExecution = previewChangeSet(cancelPreview(synchronized.execution), changeSet, role);
    auditCurrentPreviewCancellation();
    const audit = addAudit(changeSet, "manual", "previewed");
    latestDatasetWorkspaceRef.current = { ...current, execution: nextExecution, dataProduct: nextProduct, dataRuntime: synchronized.dataRuntime };
    setDataProduct(nextProduct); setDataRuntime(synchronized.dataRuntime); setExecution(nextExecution);
    setPendingPuckChangeSet(changeSet); setPendingChangeSource("manual"); setCanvasMode("preview");
    setValidationError(null); setSaveLabel("Notebook 结果预览 · 确认后加入看板");
    handleWorkspaceModeChange("canvas");
    persistExplicitly(nextExecution, appendChangeSetAuditRecord(current.auditRecords, audit), current.queryRecords, nextProduct);
  }

  function handleNotebookDataset(snapshot: DatasetUploadResponse) {
    if (role === "viewer" || aiRequestStatus === "loading") throw new Error("当前不能保存数据集");
    const current = latestDatasetWorkspaceRef.current;
    const synchronized = synchronizeUploadedDatasetWorkspace(current, snapshot.dataset, snapshot.rows);
    const nextProduct = { ...synchronized.dataProduct, datasets: synchronized.dataProduct.datasets.map((item) => item.id === snapshot.dataset.datasetId ? { ...item, workspaceId: activePageId } : item) };
    latestDatasetWorkspaceRef.current = { ...current, execution: synchronized.execution, dataProduct: nextProduct, dataRuntime: synchronized.dataRuntime };
    setDataProduct(nextProduct); setDataRuntime(synchronized.dataRuntime); setExecution(synchronized.execution);
    setSaveLabel("Notebook 结果已保存为 Dataset");
    persistExplicitly(synchronized.execution, current.auditRecords, current.queryRecords, nextProduct);
  }

  function handleSelectContextResult(result: ComposerResultOption) {
    if (result.kind === "recipe") {
      const recipe = dataProduct.recipes.find((item) => item.id === result.id);
      if (!recipe) return;
      const reference = `请先预览数据配方“${recipe.name}”（ID：${recipe.id}），基于配方输出结果回答。`;
      const instruction = aiInstruction.trim() ? `${aiInstruction.trim()}\n${reference}` : `${reference}说明主要统计与值得关注的发现。`;
      if (instruction.length > 1000) {
        setAiRequestError("当前问题较长，无法添加配方引用；请缩短问题后重试。");
        setAiRequestStatus("error");
        return;
      }
      setActiveDataSourceId(recipe.sourceDatasetId);
      setAiInstruction(instruction);
    } else {
      const artifact = harnessTasks.find((task) => task.tableArtifact?.id === result.id)?.tableArtifact;
      if (!artifact) return;
      setActiveDataSourceId(artifact.sourceDataSourceId);
      setSpreadsheetResultFocusRevision((revision) => revision + 1);
      handleWorkspaceModeChange("canvas");
      requestAnimationFrame(() => document.querySelector(".spreadsheet-workspace")?.scrollIntoView({ block: "nearest" }));
    }
  }

  function closeCompactPanel(restoreFocus = false) {
    const trigger = compactPanel === "pages" ? pagesButtonRef.current : assistantButtonRef.current;
    setCompactPanel(null);
    if (restoreFocus) queueMicrotask(() => trigger?.focus());
  }

  function expandPagesPanel() {
    setIsPagesExpanded(true);
    requestAnimationFrame(() => sidebarPanelCloseRef.current?.focus());
  }

  function collapsePagesPanel() {
    setIsPagesExpanded(false);
    requestAnimationFrame(() => sidebarRailToggleRef.current?.focus());
  }

  function resizeAssistantPanel(width: number) {
    setAssistantPanelWidth(clampAssistantPanelWidth(width, window.innerWidth, isPagesExpanded));
  }

  function handleAssistantResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const startWidth = assistantPanelSlotRef.current?.getBoundingClientRect().width;
    if (!startWidth) return;
    assistantResizeStateRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.classList.add("assistant-panel-resizing");
    event.preventDefault();
  }

  function handleAssistantResizeMove(event: ReactPointerEvent<HTMLDivElement>) {
    const resizeState = assistantResizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    resizeAssistantPanel(resizeState.startWidth + resizeState.startX - event.clientX);
  }

  function handleAssistantResizeEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const resizeState = assistantResizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    assistantResizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    document.documentElement.classList.remove("assistant-panel-resizing");
  }

  function handleAssistantResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const bounds = getAssistantPanelWidthBounds(window.innerWidth, isPagesExpanded);
    const currentWidth = assistantPanelSlotRef.current?.getBoundingClientRect().width ?? assistantPanelWidth ?? 350;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = currentWidth + 24;
    if (event.key === "ArrowRight") nextWidth = currentWidth - 24;
    if (event.key === "Home") nextWidth = bounds.minimum;
    if (event.key === "End") nextWidth = bounds.maximum;
    if (nextWidth === null) return;
    event.preventDefault();
    resizeAssistantPanel(nextWidth);
  }

  const handleQueryExecuted = useCallback((record: QueryExecutionRecord) => {
    setQueryRecords((current) => current.some((item) => item.id === record.id)
      ? current
      : appendQueryExecutionRecord(current, record));
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const savedMode = window.localStorage.getItem("datacanvas-ai:workspace-mode:v1");
        if (savedMode === "agent" || savedMode === "notebook") setWorkspaceMode(savedMode);
      } catch { /* Mode switching also works without browser storage. */ }
      const repository = localProject.repository ?? createBrowserStudioRepository();
      repositoryRef.current = repository;
      const restored = loadStudioStateSafely(repository, initialProduct);
      const restoredDataProduct = ensureInitialBlankWorkspaceInProduct(restored.dataProduct);
      const restoredExecution = ensureInitialBlankWorkspaceInExecution(restored.execution);
      setDataProduct({ ...restoredDataProduct, appSpec: restoredExecution.present });
      setExecution(restoredExecution);
      setAuditRecords(restored.auditRecords);
      if (restored.restored) setQueryRecords(restored.queryRecords);
      setHarnessTasks(restored.harnessTasks);
      setAssistantConversation(restored.assistantConversation);
      setEdsWorkspace(restored.edsWorkspace);
      setDataRuntime(mergeEdsWorkspaceRuntime(localProject.session ? { rowsByDataSourceId: {} } : fixtures.dataRuntime, restored.edsWorkspace));
      setActivePageId(INITIAL_WORKSPACE_PAGE_ID);
      setActiveDataSourceId(selectedSemanticModel(restoredDataProduct, INITIAL_WORKSPACE_PAGE_ID)?.sourceDatasetId
        ?? datasetsForWorkspace(restoredDataProduct.datasets, INITIAL_WORKSPACE_PAGE_ID)[0]?.id ?? "");
      const uploadedSourceIds = restoredExecution.present.dataSources
        .filter((source) => source.sourceType === "csv")
        .map((source) => source.id);
      uploadedSourceIds.forEach((datasetId) => {
        void loadUploadedDataset(datasetId).then((loaded) => {
          if (cancelled) return;
          setExecution((current) => synchronizeUploadedDatasetExecution(current, loaded.dataset));
          setDataProduct((current) => synchronizeUploadedDatasetProduct(current, loaded.dataset));
          setDataRuntime((current) => ({
            rowsByDataSourceId: { ...current.rowsByDataSourceId, [datasetId]: loaded.rows },
          }));
        }).catch(() => {
          if (!cancelled) setPersistenceNotice(localProject.session ? `项目数据表 ${datasetId} 恢复失败，请在 Data Browser 检查文件，不会自动删除数据。` : `临时数据集 ${datasetId} 已过期、未启用服务端持久化或恢复失败，请重新上传。`);
        });
      });
      const latestConversationTurn = restored.assistantConversation.at(-1);
      if (latestConversationTurn) {
        setLastSubmittedInstruction(latestConversationTurn.instruction);
        setAiInstruction("");
        setAiMessage(latestConversationTurn.response);
        setHasValidAiPlan(false);
        setAiRequestStatus(latestConversationTurn.state === "success"
          ? "success"
          : latestConversationTurn.state === "blocked"
            ? "blocked"
            : latestConversationTurn.state === "cancelled"
              ? "cancelled"
              : "error");
        setIsLocalAssistantReply(!latestConversationTurn.taskId);
      }
      const pendingHarnessTask = restored.harnessTasks.find((task) => task.state === "awaitingConfirmation" && task.pendingChangeSet);
      if (pendingHarnessTask?.pendingChangeSet) {
        setAiChangeSet(pendingHarnessTask.pendingChangeSet);
        setAiMessage(pendingHarnessTask.resultMessage ?? "Harness 已恢复待确认变更，请重新预览后人工确认。");
        setAiMetadata(null);
        setHasValidAiPlan(true);
        setAiRequestStatus("success");
      } else if (restored.edsWorkspace && !latestConversationTurn) {
        setAiInstruction("检查 EDS 分析数据，说明异常次数最多的线体和累计时间最长的异常类型。不要修改页面。");
        setAiMessage("EDS 派生汇总已从本地工作区恢复，并进入当前页面与 AI 数据上下文；原始工作簿和逐行明细未保存。");
        setAiMetadata(null);
        setHasValidAiPlan(false);
        setAiRequestStatus("idle");
      } else if (!latestConversationTurn) {
        setAiMessage("告诉我你想分析的数据或希望调整的页面。对话会保存在当前浏览器中，也可以随时清除上下文。");
        setAiMetadata(null);
        setHasValidAiPlan(false);
        setAiRequestStatus("idle");
      }
      setSaveLabel(restored.restored ? "已恢复 · 本地草稿" : "已保存 · 演示草稿");
      setPersistenceNotice(restored.notice?.includes("回退") ? restored.notice : null);
      setIsHistoryLoading(false);
    });
    return () => { cancelled = true; };
  }, [fixtures.dataRuntime, initialProduct, setActivePageId, setAiChangeSet, setAiInstruction, setAiMessage,
    setAiMetadata, setAiRequestStatus, setAssistantConversation, setHarnessTasks, setHasValidAiPlan,
    setIsLocalAssistantReply, setLastSubmittedInstruction, setActiveDataSourceId, setEdsWorkspace, localProject.repository, localProject.session]);


  useEffect(() => {
    latestDatasetWorkspaceRef.current = {
      execution,
      dataProduct,
      dataRuntime,
      activeDataSourceId,
      auditRecords,
      queryRecords,
      harnessTasks,
      assistantConversation,
      edsWorkspace,
    };
  }, [activeDataSourceId, assistantConversation, auditRecords, dataProduct, dataRuntime, edsWorkspace, execution, harnessTasks, queryRecords]);

  useEffect(() => {
    if (localProject.repository && !isHistoryLoading) {
      const result = saveStudioStateSafely(localProject.repository, createStudioSnapshot(dataProduct, execution, auditRecords, queryRecords, harnessTasks, edsWorkspace, assistantConversation));
      if (!result.persisted) setPersistenceNotice(result.notice);
      return;
    }
    if (isHistoryLoading || persistedQueryRecordsRef.current === queryRecords) return;
    persistedQueryRecordsRef.current = queryRecords;
    const result = saveStudioStateSafely(
      repositoryRef.current,
      createStudioSnapshot(dataProduct, execution, auditRecords, queryRecords, harnessTasks, edsWorkspace, assistantConversation),
    );
    if (!result.persisted) setPersistenceNotice(result.notice);
  }, [assistantConversation, auditRecords, dataProduct, edsWorkspace, execution, harnessTasks, isHistoryLoading, queryRecords, localProject.repository]);

  function persistExplicitly(
    nextExecution = execution,
    nextAuditRecords = auditRecords,
    nextQueryRecords = queryRecords,
    nextDataProduct = dataProduct,
    nextHarnessTasks = harnessTasks,
    nextEdsWorkspace = edsWorkspace,
    nextAssistantConversation = assistantConversation,
  ) {
    const result = saveStudioStateSafely(
      repositoryRef.current,
      createStudioSnapshot(nextDataProduct, nextExecution, nextAuditRecords, nextQueryRecords, nextHarnessTasks, nextEdsWorkspace, nextAssistantConversation),
    );
    if (!result.persisted) setPersistenceNotice(result.notice);
    return result;
  }

  function clearPuckDraft() {
    puckDraftOriginRef.current = null;
    setPuckDraft(null);
  }

  function ensurePuckDraft(pageId: string, appSpec = execution.present) {
    const origin = { pageId, appSpecRevision: appSpecRevision(appSpec) };
    const current = { data: puckDraft, origin: puckDraftOriginRef.current };
    const next = initializePuckDraft(current, origin, () => appSpecToPuckData(appSpec, pageId));
    if (next === current) return;
    puckDraftOriginRef.current = next.origin;
    setPuckDraft(next.data);
    setPuckSessionKey((value) => value + 1);
  }

  const handlePuckDataChange = useCallback((data: StudioPuckData) => {
    setPuckDraft((current) => updatePuckDraft(current, data));
  }, []);
  const handleOpenHistory = useCallback(() => setIsHistoryOpen(true), []);
  const handleCloseHistory = useCallback(() => setIsHistoryOpen(false), []);
  const handleRestoreHistoryFocus = useCallback(() => restoreDialogTrigger(historyButtonRef.current), []);
  const handleOpenPublishInfo = useCallback(() => setIsPublishInfoOpen(true), []);
  const handleClosePublishInfo = useCallback(() => {
    setIsPublishInfoOpen(false);
    requestAnimationFrame(() => restoreDialogTrigger(publishButtonRef.current));
  }, []);
  function toAuditMetadata(metadata: AiPlanMetadata | AiChangeSetAuditMetadata | null): AiChangeSetAuditMetadata | undefined {
    return metadata ? {
      model: metadata.model,
      durationMs: metadata.durationMs,
      usage: metadata.usage,
      ...(metadata && "transport" in metadata ? { transport: metadata.transport } : {}),
      ...(metadata && "repairAttempted" in metadata ? { repairAttempted: metadata.repairAttempted } : {}),
      ...(metadata && "validationIssues" in metadata && metadata.validationIssues
        ? { validationIssues: metadata.validationIssues }
        : {}),
    } : undefined;
  }

  function addAudit(
    changeSet: ChangeSet,
    source: ChangeSetAuditSource,
    auditStatus: ChangeSetAuditStatus,
    error?: string,
    metadata: AiPlanMetadata | AiChangeSetAuditMetadata | null = source === "ai" ? aiMetadata : null,
  ) {
    const record = createChangeSetAuditRecord(changeSet, role, source, auditStatus, error, undefined, toAuditMetadata(metadata));
    setAuditRecords((current) => appendChangeSetAuditRecord(
      current,
      record,
    ));
    return record;
  }

  function addAuditSummary(
    changeSetId: string,
    summary: string,
    source: ChangeSetAuditSource,
    auditStatus: ChangeSetAuditStatus,
    error?: string,
    metadata: AiPlanMetadata | AiChangeSetAuditMetadata | null = source === "ai" ? aiMetadata : null,
  ) {
    const record = createChangeSetAuditRecordFromSummary(changeSetId, summary, role, source, auditStatus, error, undefined, toAuditMetadata(metadata));
    setAuditRecords((current) => appendChangeSetAuditRecord(
      current,
      record,
    ));
    return record;
  }

  function auditCurrentPreviewCancellation() {
    const changeSetId = execution.preview?.changeSetId;
    if (!changeSetId) return;
    const previous = auditRecords.find((record) => record.changeSetId === changeSetId && record.status === "previewed");
    addAuditSummary(
      changeSetId,
      previous?.operationSummary ?? "取消当前变更预览",
      changeSetId === aiChangeSet.id ? "ai" : pendingChangeSource ?? "manual",
      "cancelled",
    );
  }

  function handlePreview() {
    try {
      if (!hasValidAiPlan) throw new Error("当前没有通过校验的 AI ChangeSet，请先重新生成。");
      if (execution.preview && execution.preview.changeSetId !== aiChangeSet.id) auditCurrentPreviewCancellation();
      const nextExecution = previewChangeSet(execution, aiChangeSet, role);
      setExecution(nextExecution);
      setActivePageId(selectablePageId(nextExecution.preview?.appSpec ?? nextExecution.present, aiChangeSet.operations[0]?.type === "deletePage" ? undefined : aiChangeSet.operations[0]?.pageId));
      setCanvasMode("preview");
      handleWorkspaceModeChange("canvas");
      setPendingPuckChangeSet(null);
      setPendingChangeSource(null);
      setSaveLabel("预览中 · 尚未保存");
      setValidationError(null);
      addAudit(aiChangeSet, "ai", "previewed");
    } catch (error) {
      const message = readableValidationError(error);
      setValidationError(message);
      addAudit(aiChangeSet, "ai", "failed", message);
    }
  }

  function handleApply() {
    try {
      if (execution.preview?.changeSetId !== aiChangeSet.id) {
        throw new Error("请先完成当前 AI ChangeSet 的画布预览，再人工确认应用。");
      }
      const nextExecution = applyChangeSet(execution, aiChangeSet, role);
      const nextDataProduct = reconcileDataProductWorkspaces(latestDatasetWorkspaceRef.current.dataProduct, nextExecution.present);
      const audit = addAudit(aiChangeSet, "ai", "applied");
      const relatedTask = harnessTasks.find((task) => task.pendingChangeSet?.id === aiChangeSet.id);
      const nextHarnessTasks = relatedTask
        ? appendHarnessTask(harnessTasks, settleHarnessConfirmation(relatedTask, true, harnessUiClock))
        : harnessTasks;
      setExecution(nextExecution);
      setDataProduct(nextDataProduct);
      setHarnessTasks(nextHarnessTasks);
      setActivePageId(selectablePageId(nextExecution.present, aiChangeSet.operations[0]?.pageId));
      setOriginalWorkbooks((current) => {
        const validPages = new Set(nextExecution.present.pages.map((page) => page.id));
        const fallback = selectablePageId(nextExecution.present);
        return current.map((workbook) => validPages.has(workbook.workspaceId) ? workbook : { ...workbook, workspaceId: fallback });
      });
      setCanvasMode("preview");
      setPendingPuckChangeSet(null);
      setPendingChangeSource(null);
      clearPuckDraft();
      setPuckSessionKey((value) => value + 1);
      setSaveLabel("已保存 · 变更已应用");
      setValidationError(null);
      persistExplicitly(nextExecution, appendChangeSetAuditRecord(auditRecords, audit), queryRecords, nextDataProduct, nextHarnessTasks);
    } catch (error) {
      const message = readableValidationError(error);
      setValidationError(message);
      addAudit(aiChangeSet, "ai", "failed", message);
    }
  }

  function handleCancelPreview() {
    const audit = addAudit(aiChangeSet, "ai", "cancelled");
    const nextExecution = cancelPreview(execution);
    const relatedTask = harnessTasks.find((task) => task.pendingChangeSet?.id === aiChangeSet.id);
    const nextHarnessTasks = relatedTask
      ? appendHarnessTask(harnessTasks, settleHarnessConfirmation(relatedTask, false, harnessUiClock))
      : harnessTasks;
    setExecution(nextExecution);
    setHarnessTasks(nextHarnessTasks);
    if (relatedTask) setHasValidAiPlan(false);
    setSaveLabel("已保存 · 已取消 AI 预览");
    setValidationError(null);
    persistExplicitly(nextExecution, appendChangeSetAuditRecord(auditRecords, audit), queryRecords, dataProduct, nextHarnessTasks);
  }

  function handleUndo() {
    const changeSetId = execution.appliedChangeSetIds.at(-1) ?? "unknown_changeset";
    const prior = auditRecords.find((record) => record.changeSetId === changeSetId && record.status === "applied");
    try {
      const nextExecution = undoLastChange(execution, role);
      const audit = addAuditSummary(changeSetId, prior?.operationSummary ?? "撤销最近一次正式变更", prior?.source ?? "manual", "undone", undefined, prior?.ai ?? null);
      setExecution(nextExecution);
      setCanvasMode("preview");
      setPendingPuckChangeSet(null);
      clearPuckDraft();
      setPuckSessionKey((value) => value + 1);
      setSaveLabel("已保存 · 已撤销最近变更");
      setValidationError(null);
      persistExplicitly(nextExecution, appendChangeSetAuditRecord(auditRecords, audit));
    } catch (error) {
      const message = readableValidationError(error);
      setValidationError(message);
      addAuditSummary(changeSetId, prior?.operationSummary ?? "撤销最近一次正式变更", prior?.source ?? "manual", "failed", message);
    }
  }

  function handleCanvasModeChange(mode: CanvasMode) {
    if (mode === canvasMode) return;
    if (mode === "preview") {
      setCanvasMode("preview");
      return;
    }

    if (role === "viewer") {
      setValidationError("查看者只能查看和预览，不能进入编辑模式。");
      return;
    }

    try {
      auditCurrentPreviewCancellation();
      const nextExecution = cancelPreview(execution);
      setExecution(nextExecution);
      ensurePuckDraft(activePageId, nextExecution.present);
      setPendingPuckChangeSet(null);
      setCanvasMode("edit");
      setSaveLabel("可视化编辑 · 尚未生成变更集");
      setValidationError(null);
    } catch (error) {
      setValidationError(readableValidationError(error));
    }
  }

  function handleRequestPuckPreview(data: StudioPuckData) {
    try {
      auditCurrentPreviewCancellation();
      const changeSet = puckDataToChangeSet(execution.present, activePageId, data, role);
      const nextExecution = previewChangeSet(cancelPreview(execution), changeSet, role);
      setExecution(nextExecution);
      handlePuckDataChange(data);
      setPendingPuckChangeSet(changeSet);
      setPendingChangeSource("puck");
      setCanvasMode("preview");
      setSaveLabel(`预览中 · ${changeSet.operations.length} 项可视化变更`);
      setValidationError(null);
      addAudit(changeSet, "puck", "previewed");
    } catch (error) {
      const message = readableValidationError(error);
      setValidationError(message);
      addAuditSummary(`changeset_puck_failed_${Date.now()}`, "生成可视化编辑变更", "puck", "failed", message);
    }
  }

  function handlePreviewRecipeBinding(changeSet: ChangeSet) {
    try {
      auditCurrentPreviewCancellation();
      const nextExecution = previewChangeSet(cancelPreview(execution), changeSet, role);
      setExecution(nextExecution);
      setActivePageId(changeSet.operations[0]?.pageId ?? activePageId);
      setPendingPuckChangeSet(changeSet);
      setPendingChangeSource("manual");
      setCanvasMode("preview");
      setIsDataSourceOpen(false);
      setSaveLabel(`预览中 · ${changeSet.operations.length} 项配方绑定变更`);
      setValidationError(null);
      addAudit(changeSet, "manual", "previewed");
    } catch (error) {
      const message = readableValidationError(error);
      setValidationError(message);
      addAudit(changeSet, "manual", "failed", message);
    }
  }

  function handleApplyPuckPreview() {
    if (!pendingPuckChangeSet) return;
    try {
      const nextExecution = applyChangeSet(cancelPreview(execution), pendingPuckChangeSet, role);
      const nextDataProduct = reconcileDataProductWorkspaces(latestDatasetWorkspaceRef.current.dataProduct, nextExecution.present);
      const audit = addAudit(pendingPuckChangeSet, pendingChangeSource ?? "puck", "applied");
      setExecution(nextExecution);
      setDataProduct(nextDataProduct);
      setActivePageId(selectablePageId(nextExecution.present, activePageId));
      setOriginalWorkbooks((current) => {
        const validPages = new Set(nextExecution.present.pages.map((page) => page.id));
        const fallback = selectablePageId(nextExecution.present);
        return current.map((workbook) => validPages.has(workbook.workspaceId) ? workbook : { ...workbook, workspaceId: fallback });
      });
      setPendingPuckChangeSet(null);
      setPendingChangeSource(null);
      clearPuckDraft();
      setPuckSessionKey((value) => value + 1);
      setCanvasMode("preview");
      setSaveLabel("已保存 · 可视化编辑已应用");
      setValidationError(null);
      persistExplicitly(nextExecution, appendChangeSetAuditRecord(auditRecords, audit), queryRecords, nextDataProduct);
    } catch (error) {
      const message = readableValidationError(error);
      setValidationError(message);
      addAudit(pendingPuckChangeSet, pendingChangeSource ?? "puck", "failed", message);
    }
  }

  function handleCancelPuckPreview() {
    if (pendingPuckChangeSet) addAudit(pendingPuckChangeSet, pendingChangeSource ?? "puck", "cancelled");
    setExecution(cancelPreview(execution));
    setPendingPuckChangeSet(null);
    setPendingChangeSource(null);
    setCanvasMode(puckDraft ? "edit" : "preview");
    setSaveLabel(puckDraft ? "可视化编辑 · 尚未应用" : "已保存 · 已取消页面变更");
    setValidationError(null);
  }

  function handleRoleChange(nextRole: StudioRole) {
    aiRequestAbortRef.current?.abort();
    auditCurrentPreviewCancellation();
    setRole(nextRole);
    setExecution(cancelPreview(execution));
    setCanvasMode("preview");
    setPendingPuckChangeSet(null);
    setPendingChangeSource(null);
    clearPuckDraft();
    setPuckSessionKey((value) => value + 1);
    setSaveLabel(`演示角色 · ${nextRole}`);
    setValidationError(null);
  }

  function handleExportBackup() {
    try {
      const now = new Date();
      const serialized = exportStudioBackup(createStudioSnapshot(
        dataProduct,
        execution,
        auditRecords,
        queryRecords,
        harnessTasks,
        edsWorkspace,
        assistantConversation,
      ), now);
      const timestamp = now.toISOString().replaceAll(":", "-").replace(".000Z", "Z");
      triggerBrowserDownload(
        new Blob([serialized], { type: "application/json;charset=utf-8" }),
        `datacanvas-workspace-${timestamp}.json`,
      );
      setPersistenceNotice("工作区备份已下载。文件不包含原始工作簿、逐行明细或 API Key，请妥善保管其中的派生汇总与聊天记录。");
    } catch (error) {
      setPersistenceNotice(`工作区备份导出失败。${readableValidationError(error)}`);
    }
  }

  function handleChooseBackupFile() {
    backupFileInputRef.current?.click();
  }

  async function handleRestoreBackupFile(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > STUDIO_BACKUP_MAX_BYTES) {
        throw new Error(`备份文件不得超过 ${Math.floor(STUDIO_BACKUP_MAX_BYTES / 1024 / 1024)} MiB。`);
      }
      const serialized = await file.text();
      const inspected = importStudioBackup(serialized);
      const summary = [
        inspected.edsWorkspace ? `${getEdsWorkspaceReports(inspected.edsWorkspace).length} 份 EDS 派生汇总` : "无 EDS 派生汇总",
        `${inspected.assistantConversation.length} 轮聊天`,
        `${inspected.harnessTasks.length} 个 Harness 任务`,
        `${inspected.auditRecords.length} 条审计记录`,
      ].join("、");
      if (!window.confirm(`确定从“${file.name}”恢复工作区吗？\n\n备份包含：${summary}。\n\n当前页面状态将被覆盖；原始工作簿、逐行明细和 API Key 不在备份中。`)) return;
      const repository = repositoryRef.current;
      if (!repository) throw new Error("浏览器本地存储不可用，无法安全保存恢复结果。");
      aiRequestAbortRef.current?.abort();
      restoreStudioBackup(repository, serialized);
      const restored = loadStudioStateSafely(repository, initialProduct);
      if (!restored.restored) throw new Error(restored.notice ?? "备份未能恢复。");
      const restoredDataProduct = ensureInitialBlankWorkspaceInProduct(restored.dataProduct);
      const restoredExecution = ensureInitialBlankWorkspaceInExecution(restored.execution);

      const latestConversationTurn = restored.assistantConversation.at(-1);
      const pendingHarnessTask = restored.harnessTasks.find((task) => task.state === "awaitingConfirmation" && task.pendingChangeSet);
      setDataProduct({ ...restoredDataProduct, appSpec: restoredExecution.present });
      setExecution(restoredExecution);
      setDataRuntime(mergeEdsWorkspaceRuntime(fixtures.dataRuntime, restored.edsWorkspace));
      setEdsWorkspace(restored.edsWorkspace);
      setOriginalWorkbooks([]);
      setOpenOriginalWorkbookId(null);
      setAuditRecords(restored.auditRecords);
      setHarnessTasks(restored.harnessTasks);
      setAssistantConversation(restored.assistantConversation);
      persistedQueryRecordsRef.current = restored.queryRecords;
      setQueryRecords(restored.queryRecords);
      setActivePageId(INITIAL_WORKSPACE_PAGE_ID);
      setActiveDataSourceId(selectedSemanticModel(restoredDataProduct, INITIAL_WORKSPACE_PAGE_ID)?.sourceDatasetId
        ?? datasetsForWorkspace(restoredDataProduct.datasets, INITIAL_WORKSPACE_PAGE_ID)[0]?.id ?? "");
      setPendingPuckChangeSet(null);
      setPendingChangeSource(null);
      clearPuckDraft();
      setPuckSessionKey((value) => value + 1);
      setCanvasMode("preview");
      setIsCsvUploadOpen(false);
      setIsDataSourceOpen(false);
      setValidationError(null);
      setAiMetadata(null);
      setAiRequestError(null);
      setLastHarnessTaskId(pendingHarnessTask?.id ?? "");

      if (pendingHarnessTask?.pendingChangeSet) {
        setAiChangeSet(pendingHarnessTask.pendingChangeSet);
        setAiMessage(pendingHarnessTask.resultMessage ?? "备份中的 Harness 待确认变更已恢复，请重新预览后人工确认。");
        setLastSubmittedInstruction(pendingHarnessTask.instruction);
        setAiInstruction("");
        setAiRequestStatus("success");
        setHasValidAiPlan(true);
        setIsLocalAssistantReply(false);
      } else if (latestConversationTurn) {
        setAiChangeSet(structuredClone(repurchaseChangeSet));
        setAiMessage(latestConversationTurn.response);
        setLastSubmittedInstruction(latestConversationTurn.instruction);
        setAiInstruction("");
        setAiRequestStatus(latestConversationTurn.state === "success"
          ? "success"
          : latestConversationTurn.state === "blocked"
            ? "blocked"
            : latestConversationTurn.state === "cancelled"
              ? "cancelled"
              : "error");
        setHasValidAiPlan(false);
        setIsLocalAssistantReply(!latestConversationTurn.taskId);
      } else {
        setAiChangeSet(structuredClone(repurchaseChangeSet));
        setAiMessage(restored.edsWorkspace
          ? "EDS 派生汇总已从备份恢复，并进入当前页面与 AI 数据上下文；原始工作簿和逐行明细不在备份中。"
          : "工作区已从备份恢复。告诉我你想分析的数据或希望调整的页面。");
        setLastSubmittedInstruction("");
        setAiInstruction(restored.edsWorkspace ? "检查 EDS 分析数据，说明异常次数最多的线体和累计时间最长的异常类型。不要修改页面。" : "");
        setAiRequestStatus("idle");
        setHasValidAiPlan(false);
        setIsLocalAssistantReply(true);
      }
      setSaveLabel("已恢复 · 工作区备份");
      setPersistenceNotice(`已从“${file.name}”恢复：${summary}。临时 CSV 原始数据仍需在原服务端有效期内重新加载。`);

      restored.execution.present.dataSources
        .filter((source) => source.sourceType === "csv")
        .forEach((source) => {
          void loadUploadedDataset(source.id).then((loaded) => {
            setExecution((current) => synchronizeUploadedDatasetExecution(current, loaded.dataset));
            setDataProduct((current) => synchronizeUploadedDatasetProduct(current, loaded.dataset));
            setDataRuntime((current) => ({
              rowsByDataSourceId: { ...current.rowsByDataSourceId, [source.id]: loaded.rows },
            }));
          }).catch(() => setPersistenceNotice(`工作区已恢复，但临时数据集 ${source.id} 已过期或不属于当前服务端，请重新上传原始 CSV。`));
        });
    } catch (error) {
      setPersistenceNotice(`工作区备份恢复失败，当前页面未被覆盖。${readableValidationError(error)}`);
    } finally {
      if (backupFileInputRef.current) backupFileInputRef.current.value = "";
    }
  }

  const semanticActions = useStudioSemanticActions({
    pageId: activePageId, role, busy: aiRequestStatus === "loading", latestDatasetWorkspaceRef,
    setDataProduct, setActiveDataSourceId, setSaveLabel, setPersistenceNotice, persistExplicitly,
  });
  function handleSelectSemanticModel(id: string | null) {
    try { semanticActions.select(id); } catch (error) { setPersistenceNotice(readableValidationError(error)); }
  }

  const { handleGenerateAiPlan, handleCancelAiRequest, handleClearAssistantConversation, handleRetryAiRequest, handleImageAttachmentsChange } = useStudioAssistantActions({
    assistant, role, activePageId, renderedSpec, activeDataSource, activeOriginalWorkbook,
    edsWorkspace, dataProduct, execution, auditRecords, queryRecords, persistExplicitly,
    setExecution, setPendingPuckChangeSet, setPendingChangeSource, setCanvasMode,
    auditCurrentPreviewCancellation, setValidationError, setSaveLabel,
    notebookInteractionBusy,
    ...(workspaceMode === "notebook" ? { notebookContext: { document: notebookDocument,
      sourceIds: [...new Set([...notebookSources.map((source) => source.id), ...notebookDocument.cells.flatMap((cell) => cell.kind === "data" ? [cell.sourceDataSourceId] : [])])].slice(0, 10) } } : {}),
  });

  const { handleCreateEdsWorkspace, handleSelectEdsWorkspaceReport, handleAnalyzeEdsReports, handleAnalyzeDataSource, handleCsvUploaded, handleConfirmDatasetAiAccess, handleDeleteDataset } = useStudioDatasetActions({
    datasets, assistant, role, renderedSpec, activePageId, pendingChangeSource, latestDatasetWorkspaceRef,
    setExecution, setDataProduct, setDataRuntime, setAuditRecords, setActivePageId,
    setPendingPuckChangeSet, setPendingChangeSource, setCanvasMode, clearPuckDraft,
    setPuckSessionKey, setValidationError, setSaveLabel, setPersistenceNotice,
    persistExplicitly, handleGenerateAiPlan,
  });

  const { handlePageChange, handleInterfaceChange, handleCreateInterface, handleRenamePage, handleDeletePage } = useStudioPageActions({
    role, dataProduct, renderedSpec, activePageId, interfaces, canvasMode,
    execution, latestDatasetWorkspaceRef, setExecution, setDataProduct,
    setActivePageId, setActiveDataSourceId, setIsDataSourceOpen,
    setPendingPuckChangeSet, setPendingChangeSource, setCanvasMode,
    clearPuckDraft, setPuckSessionKey, setValidationError, setSaveLabel,
    ensurePuckDraft, auditCurrentPreviewCancellation, addAudit, persistExplicitly,
  });

  function useProjectTable(result: ProjectDatasetResponse, destination: "preview" | "notebook" | "agent") {
    handleCsvUploaded(result, undefined, activePageId);
    if (destination === "preview") setIsDataSourceOpen(true);
    else if (destination === "notebook") handleWorkspaceModeChange("notebook");
    else {
      handleWorkspaceModeChange("agent");
      setAiInstruction(`请分析数据表“${result.dataset.source.name}”，先检查字段、质量和关键指标，再给出有依据的分析结论。`);
      setPersistenceNotice("数据表已加入 AI 上下文，请确认敏感字段处理方式后发送分析要求。");
    }
  }
  function removeProjectTable(id: string) {
    const current = latestDatasetWorkspaceRef.current;
    const next = removeUploadedDatasetFromWorkspace(current, id);
    latestDatasetWorkspaceRef.current = { ...current, ...next };
    setExecution(next.execution); setDataProduct(next.dataProduct); setDataRuntime(next.dataRuntime);
    setOriginalWorkbooks((items) => items.filter((item) => item.datasetId !== id));
    if (activeDataSourceId === id) { setActiveDataSourceId(""); setIsDataSourceOpen(false); }
    persistExplicitly(next.execution, current.auditRecords, current.queryRecords, next.dataProduct, current.harnessTasks);
  }

  return (
    <main className="studio-shell with-workspace-modes">
      <input
        ref={backupFileInputRef}
        className="visually-hidden"
        type="file"
        accept="application/json,.json"
        aria-label="选择工作区备份文件"
        onChange={(event) => { void handleRestoreBackupFile(event.target.files?.[0]); }}
      />
      <StudioHeader
        interfaces={interfaces}
        activeInterfaceId={activePageId}
        canUndo={role !== "viewer" && execution.history.length > 0}
        saveLabel={localProject.session ? localProject.status.message : saveLabel}
        role={role}
        historyCount={harnessTasks.length + auditRecords.length}
        historyButtonRef={historyButtonRef}
        publishButtonRef={publishButtonRef}
        pagesButtonRef={pagesButtonRef}
        assistantButtonRef={assistantButtonRef}
        onUndo={handleUndo}
        onRoleChange={handleRoleChange}
        onExportBackup={handleExportBackup}
        onChooseBackupFile={handleChooseBackupFile}
        onInterfaceChange={handleInterfaceChange}
        onCreateInterface={handleCreateInterface}
        onOpenHistory={handleOpenHistory}
        onOpenPublish={handleOpenPublishInfo}
        onOpenPages={() => setCompactPanel("pages")}
        onOpenAssistant={() => {
          if (workspaceMode === "agent") assistantPanelSlotRef.current?.querySelector("textarea")?.focus();
          else setCompactPanel("assistant");
        }}
      />
      <WorkspaceModeBar mode={workspaceMode} pageTitle={activePage?.title ?? "工作界面"} onChange={handleWorkspaceModeChange} />
      {localProject.notice && <div className="persistence-notice" role="alert">{localProject.notice}</div>}
      {localProject.status.state === "error" && <div className="persistence-notice" role="alert">{localProject.status.message}。请先使用“备份”导出当前定义，避免丢失未保存修改。</div>}
      {persistenceNotice && <div className="persistence-notice" role="alert"><span>{persistenceNotice}</span><button type="button" onClick={() => setPersistenceNotice(null)}>知道了</button></div>}
      <div
        id="workspace-view-panel"
        role="tabpanel"
        aria-labelledby={`workspace-tab-${workspaceMode}`}
        className={`workspace${isPagesExpanded ? " pages-expanded" : ""}${workspaceMode === "agent" ? " workspace-agent" : ""}`}
        style={assistantPanelWidth === null ? undefined : { "--assistant-panel-width": `${assistantPanelWidth}px` } as CSSProperties}
      >
        <div className={`workspace-panel-slot pages-panel-slot${compactPanel === "pages" ? " open" : ""}`}>
          <WorkspaceSidebarRail
            toggleButtonRef={sidebarRailToggleRef}
            hasOriginalWorkbook={activeOriginalWorkbooks.length > 0}
            onExpand={expandPagesPanel}
            onUploadCsv={() => setIsCsvUploadOpen(true)}
            onOpenOriginalWorkbook={handleOpenOriginalWorkbook}
            onOpenDataBrowser={() => { if (aiRequestStatus !== "loading" && !notebookInteractionBusy && !isCsvUploadOpen) setDataBrowserOpen(true); }}
          />
          <button ref={sidebarPanelCloseRef} type="button" className="workspace-sidebar-collapse" aria-label="收起侧边栏" onClick={collapsePagesPanel}>‹</button>
          <button type="button" className="compact-panel-close" aria-label="关闭页面与结构面板" onClick={() => closeCompactPanel(true)}>×</button>
          <PageStructurePanel
            dataBrowserPanel={<button type="button" className="data-browser-launch" disabled={aiRequestStatus === "loading" || notebookInteractionBusy || isCsvUploadOpen} onClick={() => setDataBrowserOpen(true)}><span>▦</span><span>Data Browser<small>{localProject.session?.manifest.name ?? "打开本地项目与数据资源库"}</small></span></button>}
            semanticModelsPanel={<SemanticModelSection models={semantic.models} selectedId={semantic.selected?.id}
              canCreate={role !== "viewer" && workspaceDatasets.length > 0} busy={aiRequestStatus === "loading"}
              onManage={(modelId) => semantic.setEditor({ modelId })} onSelect={handleSelectSemanticModel} />}
            dataProduct={dataProduct}
            appSpec={renderedSpec}
            activePageId={activePageId}
            onPageChange={(pageId) => { handlePageChange(pageId); closeCompactPanel(); }}
            onCreateInterface={() => {
              const blankCount = interfaces.filter((item) => item.label.startsWith("空白工作界面")).length;
              handleCreateInterface(`空白工作界面 ${blankCount + 1}`);
            }}
            role={role}
            onRenamePage={handleRenamePage}
            onDeletePage={handleDeletePage}
            activeDataSourceId={activeDataSource?.id ?? ""}
            onOpenDataSource={(dataSourceId) => { setActiveDataSourceId(dataSourceId); setIsDataSourceOpen(true); closeCompactPanel(); }}
            onUploadCsv={() => { setIsCsvUploadOpen(true); closeCompactPanel(); }}
            originalWorkbooks={activeOriginalWorkbooks}
            originalWorkbookButtonRef={originalWorkbookButtonRef}
            onOpenOriginalWorkbook={(workbookId) => { handleOpenOriginalWorkbook(workbookId); closeCompactPanel(); }}
            onAnalyzeDataSource={(dataSourceId) => { handleWorkspaceModeChange("agent"); handleAnalyzeDataSource(dataSourceId); }}
            analysisRunning={aiRequestStatus === "loading"}
          />
        </div>
        <DataProductCanvas
          hidden={workspaceMode !== "canvas"}
          appSpec={renderedSpec}
          dataRuntime={dataRuntime}
          role={role}
          appSpecRevision={formalAppSpecRevision}
          activePageId={activePageId}
          device={device}
          isPreviewing={Boolean(execution.preview)}
          canUndo={role !== "viewer" && execution.history.length > 0}
          mode={canvasMode}
          puckData={puckDraft}
          puckSessionKey={puckSessionKey}
          hasPuckPreview={Boolean(pendingPuckChangeSet && execution.preview?.changeSetId === pendingPuckChangeSet.id)}
          changeFeedback={canvasChangeFeedback}
          edsReportOptions={edsReportOptions}
          edsAnalysisRunning={aiRequestStatus === "loading"}
          spreadsheetSource={activeDataSource}
          spreadsheetRows={activeDataSource ? dataRuntime.rowsByDataSourceId[activeDataSource.id] ?? [] : []}
          spreadsheetRecipe={activeDataSource ? dataProduct.recipes.find((recipe) => recipe.sourceDatasetId === activeDataSource.id) : undefined}
          spreadsheetAiResult={harnessTasks.find((task) => task.tableArtifact?.sourceDataSourceId === activeDataSource?.id)?.tableArtifact}
          spreadsheetResultFocusRevision={spreadsheetResultFocusRevision}
          spreadsheetExportArtifact={harnessTasks.find((task) => task.exportArtifact)?.exportArtifact}
          onUndo={handleUndo}
          onModeChange={handleCanvasModeChange}
          onPuckDataChange={handlePuckDataChange}
          onRequestPuckPreview={handleRequestPuckPreview}
          onApplyPuckPreview={handleApplyPuckPreview}
          onCancelPuckPreview={handleCancelPuckPreview}
          onEdsReportChange={handleSelectEdsWorkspaceReport}
          onAnalyzeEdsReports={handleAnalyzeEdsReports}
          onImportSpreadsheet={() => setIsCsvUploadOpen(true)}
          onOpenSpreadsheetSource={() => { if (activeDataSource) setIsDataSourceOpen(true); }}
          onQueryExecuted={handleQueryExecuted}
        />
        <NotebookPanel key={activePageId} hidden={workspaceMode !== "notebook"} document={notebookDocument} pageId={activePageId}
          onInteractionChange={setNotebookInteractionBusy}
          sources={notebookSources} models={semantic.models} draft={notebookDraft} canEdit={role !== "viewer"} externalBusy={aiRequestStatus === "loading"}
          onChange={handleNotebookChange} onImport={() => setIsCsvUploadOpen(true)} onSnapshot={handleNotebookSnapshot} onDataset={handleNotebookDataset}
          onAskAi={() => { setAiInstruction("请基于当前 Notebook 和已导入的数据，生成可运行的分析步骤草稿；先汇总关键指标，再生成图表和结果表，保留已有相关步骤，不修改正式看板。"); setCompactPanel("assistant"); }} />
        <div ref={assistantPanelSlotRef} className={`workspace-panel-slot assistant-panel-slot${compactPanel === "assistant" ? " open" : ""}`}>
          <div
            className="assistant-resize-handle"
            role="separator"
            aria-label="调整 AI 助手宽度"
            aria-orientation="vertical"
            aria-valuemin={ASSISTANT_PANEL_MIN_WIDTH}
            aria-valuemax={ASSISTANT_PANEL_MAX_WIDTH}
            aria-valuenow={Math.round(assistantPanelWidth ?? 350)}
            aria-valuetext="左右拖动调整宽度，双击恢复默认宽度"
            tabIndex={0}
            title="左右拖动调整 AI 助手宽度；双击恢复默认宽度"
            onPointerDown={handleAssistantResizeStart}
            onPointerMove={handleAssistantResizeMove}
            onPointerUp={handleAssistantResizeEnd}
            onPointerCancel={handleAssistantResizeEnd}
            onDoubleClick={() => setAssistantPanelWidth(null)}
            onKeyDown={handleAssistantResizeKeyDown}
          />
          <button type="button" className="compact-panel-close" aria-label="关闭 AI 助手面板" onClick={() => closeCompactPanel(true)}>×</button>
          <AiBuilderAssistant
            presentation={workspaceMode === "agent" ? "workspace" : "sidebar"}
            dataSources={workspaceDatasets.map(({ id, name, rowCount, columnCount }) => ({ id, name, detail: `${rowCount.toLocaleString("zh-CN")} 行 · ${columnCount} 列` }))}
            workspaces={interfaces.map(({ id, label, description }) => ({ id, name: label, detail: description }))}
            activeWorkspaceId={activePageId}
            contextResults={contextResults}
            semanticModels={semantic.models.map((model) => ({ id: model.id, name: model.name, detail: `${model.dimensions.length} 个维度 · ${model.measures.length} 个指标 · v${model.version}` }))}
            activeSemanticModelId={semantic.selected?.id}
            onSelectSemanticModel={handleSelectSemanticModel}
            onManageSemanticModels={() => semantic.setEditor({ modelId: semantic.selected?.id })}
            onSelectWorkspace={handleInterfaceChange}
            onSelectResult={handleSelectContextResult}
            onImportFiles={(files) => { setComposerImportFiles(files); setIsCsvUploadOpen(true); }}
            activeDataSourceId={activeDataSourceId}
            onSelectDataSource={setActiveDataSourceId}
            onImportData={() => setIsCsvUploadOpen(true)}
            onOpenWorkspace={() => handleWorkspaceModeChange("agent")}
            onOpenNotebook={() => handleWorkspaceModeChange("notebook")}
            pageTitle={activePage?.title ?? "未选择页面"}
            datasetName={dataset?.name ?? "未选择数据集"}
            changeSet={aiChangeSet}
            status={status}
            validationError={validationError}
            canApply={role !== "viewer"}
            canPreview={hasValidAiPlan}
            aiMessage={aiMessage}
            aiMetadata={aiMetadata}
            instruction={aiInstruction}
            requestStatus={aiRequestStatus}
            requestError={aiRequestError}
            canRetry={Boolean(lastSubmittedInstruction && aiRequestError)}
            harnessTask={isLocalAssistantReply ? null : harnessTasks[0] ?? null}
            harnessTasks={harnessTasks}
            conversationTurns={assistantConversation}
            pendingInstruction={aiRequestStatus === "loading" ? lastSubmittedInstruction : ""}
            dataAnalysisMode={Boolean(edsWorkspace && activePageId === EDS_WORKSPACE_PAGE_ID)}
            rawDataAccessEnabled={activeOriginalWorkbook?.aiRawAccess ?? false}
            imageAttachments={aiImageAttachments}
            onInstructionChange={setAiInstruction}
            onImageAttachmentsChange={handleImageAttachmentsChange}
            onGenerate={() => { void handleGenerateAiPlan(); }}
            onCancelRequest={handleCancelAiRequest}
            onClearConversation={handleClearAssistantConversation}
            onRetry={handleRetryAiRequest}
            onPreview={handlePreview}
            onApply={handleApply}
            onCancelPreview={handleCancelPreview}
          />
        </div>
      </div>
      {compactPanel && <button type="button" className="compact-panel-scrim" aria-label="关闭侧栏" onClick={() => closeCompactPanel(true)} />}
      {isDataSourceOpen && activeDataSource && (
        <DataSourceDetailsPanel
          key={activeDataSource.id}
          source={activeDataSource}
          rows={dataRuntime.rowsByDataSourceId[activeDataSource.id] ?? []}
          recipe={dataProduct.recipes.find((recipe) => recipe.sourceDatasetId === activeDataSource.id)}
          queryRecords={queryRecords}
          onPreviewRecipeBinding={handlePreviewRecipeBinding}
          onConfirmAiAccess={activeDataSource.sourceType === "csv" ? handleConfirmDatasetAiAccess : undefined}
          onDelete={activeDataSource.sourceType === "csv" ? async () => { await localProject.flush(); await handleDeleteDataset(); } : undefined}
          onClose={() => setIsDataSourceOpen(false)}
        />
      )}
      {isCsvUploadOpen && <CsvUploadDialog
        initialFiles={composerImportFiles}
        onUploaded={handleCsvUploaded}
        onClose={() => { setIsCsvUploadOpen(false); setComposerImportFiles([]); }}
        workspaceOptions={interfaces.map(({ id, label }) => ({ id, label }))}
        activeWorkspaceId={activePageId}
        onOpenEdsImport={handleOpenEdsAnalysis}
      />}
      {dataBrowserOpen && <DataBrowser onClose={() => setDataBrowserOpen(false)} onImport={() => setIsCsvUploadOpen(true)}
        onUse={useProjectTable} onRemoved={removeProjectTable} models={semantic.models} canEdit={role !== "viewer"} preview={execution.preview?.appSpec}
        onModel={(id) => semantic.setEditor({ modelId: id })} />}
      {isEdsAnalysisOpen && <EdsAnalysisDialog onCreateWorkspace={handleCreateEdsWorkspace} onClose={handleCloseEdsAnalysis} />}
      {openOriginalWorkbook && (
        <OriginalWorkbookDialog
          file={openOriginalWorkbook.file}
          sheetNames={openOriginalWorkbook.sheetNames}
          aiRawAccess={openOriginalWorkbook.aiRawAccess}
          onClose={() => {
            setOpenOriginalWorkbookId(null);
            requestAnimationFrame(() => restoreDialogTrigger(originalWorkbookTriggerRef.current ?? originalWorkbookButtonRef.current));
          }}
        />
      )}
      {semantic.editor && <SemanticModelManager key={activePageId}
        models={semantic.models} initialModelId={semantic.editor.modelId}
        sources={renderedSpec.dataSources.filter((source) => workspaceDatasets.some((dataset) => dataset.id === source.id))}
        rowsByDataSourceId={dataRuntime.rowsByDataSourceId} activeDataSourceId={activeDataSource?.id ?? ""}
        role={role} busy={aiRequestStatus === "loading"} onSave={semanticActions.save} onDelete={semanticActions.remove}
        onClose={() => semantic.setEditor(null)} />}
      <ActivityHistoryPanel
        open={isHistoryOpen}
        harnessTasks={harnessTasks}
        auditRecords={auditRecords}
        loading={isHistoryLoading}
        onRestoreFocus={handleRestoreHistoryFocus}
        onClose={handleCloseHistory}
      />
      {isPublishInfoOpen && <PublishReadinessDialog onDownloadBackup={handleExportBackup} onClose={handleClosePublishInfo} />}
    </main>
  );
}
