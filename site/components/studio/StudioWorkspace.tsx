"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  HarnessClientError,
  requestHarnessTask,
} from "@/core/harness/client";
import {
  DEFAULT_HARNESS_LIMITS,
  type HarnessExecutionTiming,
  type HarnessTaskSummary,
} from "@/core/harness/contracts";
import {
  appendHarnessEvent,
  appendHarnessTask,
  createHarnessTask,
  settleHarnessConfirmation,
  type HarnessTaskClock,
} from "@/core/harness/task-state";
import {
  confirmDatasetAiAccess,
  DatasetAiAccessConflictError,
  deleteUploadedDataset,
  loadUploadedDataset,
} from "@/core/datasets/client";
import type { DatasetUploadResponse, UploadedDatasetDescriptor } from "@/core/datasets";
import {
  removeUploadedDatasetFromWorkspace,
  synchronizeUploadedDatasetExecution,
  synchronizeUploadedDatasetProduct,
  synchronizeUploadedDatasetWorkspace,
} from "@/core/datasets/workspace-state";
import {
  createEdsAuditSummary,
  createEdsWorkspaceSnapshot,
  EDS_OVERVIEW_DATA_SOURCE_ID,
  EDS_WORKSPACE_PAGE_ID,
  installEdsWorkspaceInDataProduct,
  installEdsWorkspaceInExecution,
  mergeEdsWorkspaceRuntime,
  type EdsAnalysisResponse,
  type EdsWorkspaceSnapshot,
} from "@/core/eds";
import type { AiChangeSetAuditMetadata, AppNode, AppSpec, ChangeSet, ChangeSetAuditRecord, ChangeSetAuditSource, ChangeSetAuditStatus, QueryExecutionRecord } from "@/core/models";
import type { StudioRole } from "@/core/permissions";
import {
  createBrowserStudioRepository,
  createStudioSnapshot,
  loadStudioStateSafely,
  restoreDemoData,
  saveStudioStateSafely,
  type StudioRepository,
} from "@/core/repository";
import { readableValidationError } from "@/core/schemas";
import { demoFixtureResult, type DemoFixtures } from "@/fixtures/demo-product";
import { AiBuilderAssistant, type AiRequestUiStatus, type ChangeSetUiStatus } from "./AiBuilderAssistant";
import { ActivityHistoryPanel, restoreDialogTrigger, restoreDialogTriggerUnlessOpen } from "./ActivityHistoryPanel";
import { CsvUploadDialog } from "./CsvUploadDialog";
import { DataProductCanvas, type CanvasMode } from "./DataProductCanvas";
import { DataSourceDetailsPanel } from "./DataSourceDetailsPanel";
import { EdsAnalysisDialog } from "./EdsAnalysisDialog";
import { PageStructurePanel } from "./PageStructurePanel";
import { StudioHeader, type PreviewDevice } from "./StudioHeader";

const harnessUiClock: HarnessTaskClock = {
  now: () => new Date(),
  id: () => `harness_ui_${Date.now()}_${crypto.randomUUID().replaceAll("-", "")}`,
};

function initialHarnessTiming(): HarnessExecutionTiming {
  return {
    phase: "planning",
    activeElapsedMs: 0,
    remainingMs: DEFAULT_HARNESS_LIMITS.totalExecutionTimeoutMs,
    totalBudgetMs: DEFAULT_HARNESS_LIMITS.totalExecutionTimeoutMs,
    modelRequestTimeoutMs: DEFAULT_HARNESS_LIMITS.modelRequestTimeoutMs,
    toolCallTimeoutMs: DEFAULT_HARNESS_LIMITS.toolCallTimeoutMs,
    modelDurationMs: 0,
    toolDurationMs: 0,
    otherDurationMs: 0,
    retainedObservationCount: 0,
  };
}

function nodeUsesDataSource(node: AppNode, dataSourceId: string): boolean {
  const binding = "binding" in node.props ? node.props.binding : undefined;
  return Boolean(binding && typeof binding === "object" && "dataSourceId" in binding && binding.dataSourceId === dataSourceId)
    || Boolean(node.children?.some((child) => nodeUsesDataSource(child, dataSourceId)));
}

function appSpecUsesDataSource(appSpec: AppSpec, dataSourceId: string): boolean {
  return appSpec.pages.some((page) => nodeUsesDataSource(page.root, dataSourceId));
}

export function StudioWorkspace() {
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

  return <ValidatedStudioWorkspace fixtures={demoFixtureResult.data} />;
}

function ValidatedStudioWorkspace({ fixtures }: { fixtures: DemoFixtures }) {
  const { repurchaseChangeSet } = fixtures;
  const [dataProduct, setDataProduct] = useState(() => structuredClone(fixtures.dataProduct));
  const [execution, setExecution] = useState(() => createExecutionState(fixtures.dataProduct.appSpec));
  const [dataRuntime, setDataRuntime] = useState(() => structuredClone(fixtures.dataRuntime));
  const [edsWorkspace, setEdsWorkspace] = useState<EdsWorkspaceSnapshot | null>(null);
  const [activePageId, setActivePageId] = useState(fixtures.dataProduct.appSpec.navigation[0].pageId);
  const [activeDataSourceId, setActiveDataSourceId] = useState(fixtures.dataProduct.datasets[0]?.id ?? "");
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [saveLabel, setSaveLabel] = useState("已保存 · 演示草稿");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("preview");
  const [puckDraft, setPuckDraft] = useState<StudioPuckData | null>(null);
  const [puckSessionKey, setPuckSessionKey] = useState(0);
  const [pendingPuckChangeSet, setPendingPuckChangeSet] = useState<ChangeSet | null>(null);
  const [role, setRole] = useState<StudioRole>("editor");
  const [queryRecords, setQueryRecords] = useState<QueryExecutionRecord[]>([]);
  const [auditRecords, setAuditRecords] = useState<ChangeSetAuditRecord[]>([]);
  const [pendingChangeSource, setPendingChangeSource] = useState<ChangeSetAuditSource | null>(null);
  const [isDataSourceOpen, setIsDataSourceOpen] = useState(false);
  const [isCsvUploadOpen, setIsCsvUploadOpen] = useState(false);
  const [isEdsAnalysisOpen, setIsEdsAnalysisOpen] = useState(false);
  const [persistenceNotice, setPersistenceNotice] = useState<string | null>(null);
  const [aiChangeSet, setAiChangeSet] = useState<ChangeSet>(() => structuredClone(repurchaseChangeSet));
  const [aiMessage, setAiMessage] = useState("我已检查数据结构和当前画布，建议先预览以下结构化变更。");
  const [aiMetadata, setAiMetadata] = useState<AiPlanMetadata | null>(null);
  const [aiInstruction, setAiInstruction] = useState("整理华东异常订单，创建复购分析，并提供 Excel 下载。");
  const [lastSubmittedInstruction, setLastSubmittedInstruction] = useState("");
  const [aiRequestStatus, setAiRequestStatus] = useState<AiRequestUiStatus>("idle");
  const [aiRequestError, setAiRequestError] = useState<string | null>(null);
  const [hasValidAiPlan, setHasValidAiPlan] = useState(true);
  const [harnessTasks, setHarnessTasks] = useState<HarnessTaskSummary[]>([]);
  const [lastHarnessTaskId, setLastHarnessTaskId] = useState("");
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(true);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const edsAnalysisButtonRef = useRef<HTMLButtonElement>(null);
  const edsAnalysisOpenRef = useRef(false);
  const repositoryRef = useRef<StudioRepository | null>(null);
  const persistedQueryRecordsRef = useRef<QueryExecutionRecord[] | null>(null);
  const puckDraftOriginRef = useRef<PuckDraftOrigin | null>(null);
  const aiRequestAbortRef = useRef<AbortController | null>(null);
  const harnessRequestActiveRef = useRef(false);
  const latestDatasetWorkspaceRef = useRef({
    execution,
    dataProduct,
    dataRuntime,
    activeDataSourceId,
    auditRecords,
    queryRecords,
    harnessTasks,
    edsWorkspace,
  });

  const isApplied = execution.appliedChangeSetIds.includes(aiChangeSet.id);
  const isAiPreview = execution.preview?.changeSetId === aiChangeSet.id;
  const status: ChangeSetUiStatus = isApplied ? "applied" : isAiPreview ? "preview" : "pending";
  const renderedSpec = execution.preview?.appSpec ?? execution.present;
  const activePage = renderedSpec.pages.find((page) => page.id === activePageId) ?? renderedSpec.pages[0];
  const dataset = dataProduct.datasets.find((candidate) => candidate.id === activeDataSourceId) ?? dataProduct.datasets[0];
  const activeDataSource = renderedSpec.dataSources.find((source) => source.id === activeDataSourceId) ?? renderedSpec.dataSources[0];
  const formalAppSpecRevision = useMemo(() => appSpecRevision(execution.present), [execution.present]);

  const handleQueryExecuted = useCallback((record: QueryExecutionRecord) => {
    setQueryRecords((current) => current.some((item) => item.id === record.id)
      ? current
      : appendQueryExecutionRecord(current, record));
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const repository = createBrowserStudioRepository();
      repositoryRef.current = repository;
      const restored = loadStudioStateSafely(repository, fixtures.dataProduct);
      setDataProduct(restored.dataProduct);
      setExecution(restored.execution);
      setAuditRecords(restored.auditRecords);
      if (restored.restored) setQueryRecords(restored.queryRecords);
      setHarnessTasks(restored.harnessTasks);
      setEdsWorkspace(restored.edsWorkspace);
      setDataRuntime(mergeEdsWorkspaceRuntime(fixtures.dataRuntime, restored.edsWorkspace));
      setActivePageId(restored.edsWorkspace ? EDS_WORKSPACE_PAGE_ID : restored.dataProduct.appSpec.navigation[0].pageId);
      setActiveDataSourceId(restored.edsWorkspace ? EDS_OVERVIEW_DATA_SOURCE_ID : restored.dataProduct.datasets[0]?.id ?? "");
      const uploadedSourceIds = restored.execution.present.dataSources
        .filter((source) => source.sourceType === "csv" && source.ephemeral)
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
          if (!cancelled) setPersistenceNotice(`临时数据集 ${datasetId} 已过期、未启用服务端持久化或恢复失败，请重新上传。`);
        });
      });
      const pendingHarnessTask = restored.harnessTasks.find((task) => task.state === "awaitingConfirmation" && task.pendingChangeSet);
      if (pendingHarnessTask?.pendingChangeSet) {
        setAiChangeSet(pendingHarnessTask.pendingChangeSet);
        setAiMessage(pendingHarnessTask.resultMessage ?? "Harness 已恢复待确认变更，请重新预览后人工确认。");
        setAiMetadata(null);
        setHasValidAiPlan(true);
        setAiRequestStatus("success");
      } else if (restored.edsWorkspace) {
        setAiInstruction("检查 EDS 分析数据，说明异常次数最多的线体和累计时间最长的异常类型。不要修改页面。");
        setAiMessage("EDS 派生汇总已从本地工作区恢复，并进入当前页面与 AI 数据上下文；原始工作簿和逐行明细未保存。");
        setAiMetadata(null);
        setHasValidAiPlan(false);
        setAiRequestStatus("idle");
      }
      setSaveLabel(restored.restored ? "已恢复 · 本地草稿" : "已保存 · 演示草稿");
      setPersistenceNotice(restored.notice?.includes("回退") ? restored.notice : null);
      setIsHistoryLoading(false);
    });
    return () => { cancelled = true; };
  }, [fixtures.dataProduct, fixtures.dataRuntime]);

  useEffect(() => () => aiRequestAbortRef.current?.abort(), []);

  useEffect(() => {
    latestDatasetWorkspaceRef.current = {
      execution,
      dataProduct,
      dataRuntime,
      activeDataSourceId,
      auditRecords,
      queryRecords,
      harnessTasks,
      edsWorkspace,
    };
  }, [activeDataSourceId, auditRecords, dataProduct, dataRuntime, edsWorkspace, execution, harnessTasks, queryRecords]);

  useEffect(() => {
    if (isHistoryLoading || persistedQueryRecordsRef.current === queryRecords) return;
    persistedQueryRecordsRef.current = queryRecords;
    const result = saveStudioStateSafely(
      repositoryRef.current,
      createStudioSnapshot(dataProduct, execution, auditRecords, queryRecords, harnessTasks, edsWorkspace),
    );
    if (!result.persisted) setPersistenceNotice(result.notice);
  }, [auditRecords, dataProduct, edsWorkspace, execution, harnessTasks, isHistoryLoading, queryRecords]);

  function persistExplicitly(
    nextExecution = execution,
    nextAuditRecords = auditRecords,
    nextQueryRecords = queryRecords,
    nextDataProduct = dataProduct,
    nextHarnessTasks = harnessTasks,
    nextEdsWorkspace = edsWorkspace,
  ) {
    const result = saveStudioStateSafely(
      repositoryRef.current,
      createStudioSnapshot(nextDataProduct, nextExecution, nextAuditRecords, nextQueryRecords, nextHarnessTasks, nextEdsWorkspace),
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
  const handleOpenEdsAnalysis = useCallback(() => {
    edsAnalysisOpenRef.current = true;
    setIsEdsAnalysisOpen(true);
  }, []);
  const handleCloseEdsAnalysis = useCallback(() => {
    edsAnalysisOpenRef.current = false;
    setIsEdsAnalysisOpen(false);
    requestAnimationFrame(() => restoreDialogTriggerUnlessOpen(
      edsAnalysisButtonRef.current,
      edsAnalysisOpenRef.current,
    ));
  }, []);

  function handleCreateEdsWorkspace(result: EdsAnalysisResponse) {
    if (role === "viewer") throw new Error("查看者无权生成 EDS 工作区看板，请切换为编辑者或管理员。");
    aiRequestAbortRef.current?.abort();
    const current = latestDatasetWorkspaceRef.current;
    const snapshot = createEdsWorkspaceSnapshot(result);
    let nextAuditRecords = current.auditRecords;
    if (current.execution.preview) {
      const previewId = current.execution.preview.changeSetId;
      const previous = current.auditRecords.find((record) => record.changeSetId === previewId && record.status === "previewed");
      const cancelled = createChangeSetAuditRecordFromSummary(
        previewId,
        previous?.operationSummary ?? "取消当前变更预览",
        role,
        previewId === aiChangeSet.id ? "ai" : pendingChangeSource ?? "manual",
        "cancelled",
      );
      nextAuditRecords = appendChangeSetAuditRecord(nextAuditRecords, cancelled);
    }
    const nextExecution = installEdsWorkspaceInExecution(cancelPreview(current.execution), snapshot);
    const nextDataProduct = {
      ...installEdsWorkspaceInDataProduct(current.dataProduct, snapshot),
      appSpec: nextExecution.present,
    };
    const nextDataRuntime = mergeEdsWorkspaceRuntime(current.dataRuntime, snapshot);
    const nextHarnessTasks = current.harnessTasks.map((task) => (
      task.state === "awaitingConfirmation" && task.pendingChangeSet
        ? settleHarnessConfirmation(task, false, harnessUiClock)
        : task
    ));
    const audit = createChangeSetAuditRecordFromSummary(
      `eds_workspace_${Date.now()}_${crypto.randomUUID().replaceAll("-", "")}`,
      createEdsAuditSummary(snapshot),
      role,
      "manual",
      "applied",
    );
    nextAuditRecords = appendChangeSetAuditRecord(nextAuditRecords, audit);

    setExecution(nextExecution);
    setDataProduct(nextDataProduct);
    setDataRuntime(nextDataRuntime);
    setEdsWorkspace(snapshot);
    setAuditRecords(nextAuditRecords);
    setHarnessTasks(nextHarnessTasks);
    setActivePageId(EDS_WORKSPACE_PAGE_ID);
    setActiveDataSourceId(EDS_OVERVIEW_DATA_SOURCE_ID);
    setCanvasMode("preview");
    setPendingPuckChangeSet(null);
    setPendingChangeSource(null);
    clearPuckDraft();
    setPuckSessionKey((value) => value + 1);
    setIsDataSourceOpen(false);
    setAiInstruction("检查 EDS 分析数据，说明异常次数最多的线体和累计时间最长的异常类型。不要修改页面。");
    setAiMessage("EDS 派生汇总已进入当前页面与 AI 数据上下文；原始工作簿和逐行明细未保存。可让 AI 检查总览或分类字段。");
    setAiMetadata(null);
    setAiRequestStatus("idle");
    setAiRequestError(null);
    setHasValidAiPlan(false);
    setSaveLabel("已保存 · EDS 演示看板");
    setValidationError(null);
    const persistence = persistExplicitly(
      nextExecution,
      nextAuditRecords,
      current.queryRecords,
      nextDataProduct,
      nextHarnessTasks,
      snapshot,
    );
    if (!persistence.persisted) setSaveLabel("已生成 · 当前页面未持久化");
    handleCloseEdsAnalysis();
  }

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
      setExecution(previewChangeSet(execution, aiChangeSet, role));
      setActivePageId(aiChangeSet.operations[0]?.pageId ?? activePageId);
      setCanvasMode("preview");
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
      const audit = addAudit(aiChangeSet, "ai", "applied");
      const relatedTask = harnessTasks.find((task) => task.pendingChangeSet?.id === aiChangeSet.id);
      const nextHarnessTasks = relatedTask
        ? appendHarnessTask(harnessTasks, settleHarnessConfirmation(relatedTask, true, harnessUiClock))
        : harnessTasks;
      setExecution(nextExecution);
      setHarnessTasks(nextHarnessTasks);
      setActivePageId(aiChangeSet.operations[0]?.pageId ?? activePageId);
      setCanvasMode("preview");
      setPendingPuckChangeSet(null);
      setPendingChangeSource(null);
      clearPuckDraft();
      setPuckSessionKey((value) => value + 1);
      setSaveLabel("已保存 · 变更已应用");
      setValidationError(null);
      persistExplicitly(nextExecution, appendChangeSetAuditRecord(auditRecords, audit), queryRecords, dataProduct, nextHarnessTasks);
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

  async function handleGenerateAiPlan(instructionOverride?: string, retryOfTaskId?: string) {
    const submittedInstruction = (instructionOverride ?? aiInstruction).trim();
    if (!submittedInstruction || harnessRequestActiveRef.current) return;

    aiRequestAbortRef.current?.abort();
    const controller = new AbortController();
    aiRequestAbortRef.current = controller;
    harnessRequestActiveRef.current = true;
    const baseExecution = cancelPreview(execution);
    if (execution.preview) auditCurrentPreviewCancellation();
    const idempotencyKey = `request_${Date.now()}_${crypto.randomUUID().replaceAll("-", "")}`;
    const initialTask = createHarnessTask(idempotencyKey, submittedInstruction, activePageId, role, harnessUiClock, {
      executionTiming: initialHarnessTiming(),
      ...(retryOfTaskId ? { retryOfTaskId } : {}),
    });
    const initialTasks = appendHarnessTask(harnessTasks, initialTask);
    setExecution(baseExecution);
    setHarnessTasks(initialTasks);
    setPendingPuckChangeSet(null);
    setPendingChangeSource(null);
    setCanvasMode("preview");
    setLastSubmittedInstruction(submittedInstruction);
    setLastHarnessTaskId(initialTask.id);
    setAiRequestStatus("loading");
    setAiRequestError(null);
    setHasValidAiPlan(false);
    setValidationError(null);
    setSaveLabel("Harness 运行中 · 正式 AppSpec 未修改");
    persistExplicitly(baseExecution, auditRecords, queryRecords, dataProduct, initialTasks);

    try {
      const { task } = await requestHarnessTask({
        idempotencyKey,
        instruction: submittedInstruction,
        pageId: activePageId,
        ...(activeDataSource ? { dataSourceId: activeDataSource.id } : {}),
        appSpec: baseExecution.present,
        recipes: dataProduct.recipes,
        ...(edsWorkspace ? { edsWorkspace } : {}),
        ...(retryOfTaskId ? { retryOfTaskId } : {}),
      }, { signal: controller.signal });
      const nextTasks = appendHarnessTask(initialTasks, task);
      setHarnessTasks(nextTasks);
      setAiMetadata(null);
      setAiMessage(task.resultMessage ?? task.events.at(-1)?.message ?? "Harness 任务已结束。");
      if (task.state === "awaitingConfirmation" && task.pendingChangeSet) {
        setAiChangeSet(task.pendingChangeSet);
        setAiRequestStatus("success");
        setAiRequestError(null);
        setHasValidAiPlan(true);
        setSaveLabel("Harness 已暂停 · 等待人工确认");
      } else if (task.state === "completed") {
        setAiRequestStatus("success");
        setAiRequestError(null);
        setHasValidAiPlan(false);
        setSaveLabel(task.exportArtifact ? "Harness 已完成 · Excel 可下载" : "Harness 已完成 · 只读任务");
      } else {
        const taskError = task.error ?? (task.state === "cancelled" ? "Harness 任务已取消。" : "Harness 任务执行失败。");
        setAiRequestStatus(task.state === "blocked" ? "blocked" : task.state === "cancelled" ? "cancelled" : "error");
        setAiRequestError(taskError);
        setHasValidAiPlan(false);
        setSaveLabel("已保存 · Harness 未修改 AppSpec");
      }
      persistExplicitly(baseExecution, auditRecords, queryRecords, dataProduct, nextTasks);
    } catch (error) {
      const clientError = error instanceof HarnessClientError
        ? error
        : new HarnessClientError("invalid_response", readableValidationError(error), true);
      const nextStatus: AiRequestUiStatus = clientError.code === "timeout"
        ? "timeout"
        : clientError.code === "cancelled"
          ? "cancelled"
          : "error";
      setAiRequestStatus(nextStatus);
      setAiRequestError(clientError.message);
      setAiMessage("Harness 未生成可用待确认变更，正式 AppSpec 保持不变。");
      setAiMetadata(null);
      setHasValidAiPlan(false);
      setSaveLabel("已保存 · Harness 未修改 AppSpec");
      const failedTask = appendHarnessEvent(initialTask, {
        type: clientError.code === "cancelled" ? "state" : "error",
        state: clientError.code === "cancelled" ? "cancelled" : "failed",
        message: clientError.message,
      }, harnessUiClock, { error: clientError.message, resultMessage: "任务未完成，正式 AppSpec 未修改。" });
      const nextTasks = appendHarnessTask(initialTasks, failedTask);
      setHarnessTasks(nextTasks);
      persistExplicitly(baseExecution, auditRecords, queryRecords, dataProduct, nextTasks);
    } finally {
      if (aiRequestAbortRef.current === controller) aiRequestAbortRef.current = null;
      harnessRequestActiveRef.current = false;
    }
  }

  function handleCancelAiRequest() {
    aiRequestAbortRef.current?.abort();
  }

  function handleRetryAiRequest() {
    if (lastSubmittedInstruction) void handleGenerateAiPlan(lastSubmittedInstruction, lastHarnessTaskId || undefined);
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

  function handlePageChange(pageId: string) {
    try {
      auditCurrentPreviewCancellation();
      const nextExecution = cancelPreview(execution);
      setExecution(nextExecution);
      setActivePageId(pageId);
      setPendingPuckChangeSet(null);
      if (canvasMode === "edit") {
        ensurePuckDraft(pageId, nextExecution.present);
      }
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
      const audit = addAudit(pendingPuckChangeSet, pendingChangeSource ?? "puck", "applied");
      setExecution(nextExecution);
      setPendingPuckChangeSet(null);
      setPendingChangeSource(null);
      clearPuckDraft();
      setPuckSessionKey((value) => value + 1);
      setCanvasMode("preview");
      setSaveLabel("已保存 · 可视化编辑已应用");
      setValidationError(null);
      persistExplicitly(nextExecution, appendChangeSetAuditRecord(auditRecords, audit));
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

  function handleRenamePage(pageId: string, currentTitle: string) {
    if (role !== "admin") return;
    const title = window.prompt("输入新的页面名称", currentTitle)?.trim();
    if (!title || title === currentTitle) return;
    const changeSet: ChangeSet = {
      id: `changeset_page_title_${Date.now()}`,
      title: `重命名页面：${currentTitle}`,
      status: "ready",
      operations: [{
        id: `operation_page_title_${Date.now()}`,
        type: "updatePage",
        label: "修改页面结构",
        description: `将页面“${currentTitle}”重命名为“${title}”`,
        pageId,
        title,
      }],
    };
    try {
      auditCurrentPreviewCancellation();
      setExecution(previewChangeSet(cancelPreview(execution), changeSet, role));
      setPendingPuckChangeSet(changeSet);
      setPendingChangeSource("manual");
      setCanvasMode("preview");
      setSaveLabel("预览中 · 页面结构变更");
      setValidationError(null);
      addAudit(changeSet, "manual", "previewed");
    } catch (error) {
      const message = readableValidationError(error);
      setValidationError(message);
      addAudit(changeSet, "manual", "failed", message);
    }
  }

  function applyUploadedDescriptor(descriptor: UploadedDatasetDescriptor) {
    const current = latestDatasetWorkspaceRef.current;
    const next = synchronizeUploadedDatasetWorkspace(current, descriptor);
    setExecution(next.execution);
    setDataProduct(next.dataProduct);
    const persistence = persistExplicitly(
      next.execution,
      current.auditRecords,
      current.queryRecords,
      next.dataProduct,
      current.harnessTasks,
    );
    return { nextExecution: next.execution, nextDataProduct: next.dataProduct, persistence };
  }

  function handleCsvUploaded(result: DatasetUploadResponse) {
    const { persistence } = applyUploadedDescriptor(result.dataset);
    setDataRuntime((current) => ({
      rowsByDataSourceId: { ...current.rowsByDataSourceId, [result.dataset.datasetId]: result.rows },
    }));
    setActiveDataSourceId(result.dataset.datasetId);
    setIsCsvUploadOpen(false);
    setIsDataSourceOpen(true);
    setPersistenceNotice(persistence.persisted
      ? result.dataset.persistenceNotice
      : `${persistence.notice} ${result.dataset.persistenceNotice}`);
    setSaveLabel(persistence.persisted ? "已注册 · 临时 CSV 数据源" : "已注册 · 当前页面未持久化");
  }

  async function handleConfirmDatasetAiAccess(policy: "masked" | "exclude-sensitive-samples") {
    if (!activeDataSource?.ephemeral) return;
    try {
      const descriptor = await confirmDatasetAiAccess(activeDataSource.id, policy);
      const { persistence } = applyUploadedDescriptor(descriptor);
      setSaveLabel(persistence.persisted ? "已保存 · 敏感字段策略已确认" : "已更新 · 当前页面未持久化");
    } catch (error) {
      if (error instanceof DatasetAiAccessConflictError) {
        const { persistence } = applyUploadedDescriptor(error.currentDataset);
        setSaveLabel(persistence.persisted ? "已保存 · 已同步服务端敏感字段策略" : "已同步 · 当前页面未持久化");
      }
      throw error;
    }
  }

  async function handleDeleteDataset() {
    if (!activeDataSource?.ephemeral) return;
    const dataSourceId = activeDataSource.id;
    const beforeDelete = latestDatasetWorkspaceRef.current;
    if (appSpecUsesDataSource(beforeDelete.execution.present, dataSourceId) || beforeDelete.execution.history.some((entry) => appSpecUsesDataSource(entry.appSpec, dataSourceId))) {
      throw new Error("该数据源仍被页面组件或变更历史引用，无法删除。请先撤销相关绑定。");
    }
    await deleteUploadedDataset(dataSourceId);
    const current = latestDatasetWorkspaceRef.current;
    const next = removeUploadedDatasetFromWorkspace(current, dataSourceId);
    setExecution(next.execution);
    setDataProduct(next.dataProduct);
    setDataRuntime(next.dataRuntime);
    if (current.activeDataSourceId === dataSourceId) {
      setActiveDataSourceId(next.dataProduct.datasets[0]?.id ?? "");
      setIsDataSourceOpen(false);
    }
    const persistence = persistExplicitly(
      next.execution,
      current.auditRecords,
      current.queryRecords,
      next.dataProduct,
      current.harnessTasks,
    );
    setSaveLabel(persistence.persisted ? "已保存 · 临时数据源已删除" : "已删除 · 当前页面未持久化");
  }

  function handleResetDemo() {
    if (!window.confirm("确定恢复演示数据吗？当前已应用编辑、查询记录和审计记录都会被清除。")) return;
    aiRequestAbortRef.current?.abort();
    const restored = restoreDemoData(repositoryRef.current, fixtures.dataProduct);
    void Promise.all(dataProduct.datasets.filter((dataset) => dataset.ephemeral).map((dataset) => deleteUploadedDataset(dataset.id)))
      .catch(() => setPersistenceNotice("页面已恢复演示数据，但部分服务端临时数据未能立即删除；它们仍会在 TTL 到期后自动清理。"));
    setDataProduct(restored.dataProduct);
    setExecution(restored.execution);
    setDataRuntime(structuredClone(fixtures.dataRuntime));
    setEdsWorkspace(null);
    setAuditRecords(restored.auditRecords);
    persistedQueryRecordsRef.current = restored.queryRecords;
    setQueryRecords(restored.queryRecords);
    setPendingPuckChangeSet(null);
    setPendingChangeSource(null);
    clearPuckDraft();
    setPuckSessionKey((value) => value + 1);
    setCanvasMode("preview");
    setActivePageId(fixtures.dataProduct.appSpec.navigation[0].pageId);
    setActiveDataSourceId(fixtures.dataProduct.datasets[0]?.id ?? "");
    setIsCsvUploadOpen(false);
    setIsDataSourceOpen(false);
    setSaveLabel("已保存 · 已恢复演示数据");
    setValidationError(null);
    setPersistenceNotice(restored.notice?.includes("未能清除") ? restored.notice : null);
    setAiChangeSet(structuredClone(repurchaseChangeSet));
    setAiMessage("我已检查数据结构和当前画布，建议先预览以下结构化变更。");
    setAiMetadata(null);
    setAiRequestStatus("idle");
    setAiRequestError(null);
    setLastSubmittedInstruction("");
    setHasValidAiPlan(true);
    setHarnessTasks([]);
    setLastHarnessTaskId("");
  }

  return (
    <main className="studio-shell">
      <StudioHeader
        productName={dataProduct.name}
        device={device}
        canUndo={role !== "viewer" && execution.history.length > 0}
        saveLabel={saveLabel}
        role={role}
        historyCount={harnessTasks.length + auditRecords.length}
        historyButtonRef={historyButtonRef}
        onDeviceChange={setDevice}
        onUndo={handleUndo}
        onRoleChange={handleRoleChange}
        onResetDemo={handleResetDemo}
        onOpenHistory={handleOpenHistory}
      />
      {persistenceNotice && <div className="persistence-notice" role="alert"><span>{persistenceNotice}</span><button type="button" onClick={() => setPersistenceNotice(null)}>知道了</button></div>}
      <div className="workspace">
        <PageStructurePanel
          dataProduct={dataProduct}
          appSpec={renderedSpec}
          activePageId={activePageId}
          onPageChange={handlePageChange}
          role={role}
          onRenamePage={handleRenamePage}
          activeDataSourceId={activeDataSource?.id ?? ""}
          onOpenDataSource={(dataSourceId) => { setActiveDataSourceId(dataSourceId); setIsDataSourceOpen(true); }}
          onUploadCsv={() => setIsCsvUploadOpen(true)}
          onOpenEdsAnalysis={handleOpenEdsAnalysis}
          edsAnalysisButtonRef={edsAnalysisButtonRef}
        />
        <DataProductCanvas
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
          onUndo={handleUndo}
          onModeChange={handleCanvasModeChange}
          onPuckDataChange={handlePuckDataChange}
          onRequestPuckPreview={handleRequestPuckPreview}
          onApplyPuckPreview={handleApplyPuckPreview}
          onCancelPuckPreview={handleCancelPuckPreview}
          onQueryExecuted={handleQueryExecuted}
        />
        <AiBuilderAssistant
          pageTitle={activePage?.title ?? "未选择页面"}
          datasetName={dataset?.name ?? "未选择数据集"}
          changeSet={aiChangeSet}
          status={status}
          validationError={validationError}
          canApply={role !== "viewer"}
          canPreview={hasValidAiPlan}
          auditRecords={auditRecords}
          aiMessage={aiMessage}
          aiMetadata={aiMetadata}
          instruction={aiInstruction}
          requestStatus={aiRequestStatus}
          requestError={aiRequestError}
          canRetry={Boolean(lastSubmittedInstruction && aiRequestError)}
          harnessTask={harnessTasks[0] ?? null}
          harnessTaskCount={harnessTasks.length}
          onInstructionChange={setAiInstruction}
          onGenerate={() => { void handleGenerateAiPlan(); }}
          onCancelRequest={handleCancelAiRequest}
          onRetry={handleRetryAiRequest}
          onPreview={handlePreview}
          onApply={handleApply}
          onCancelPreview={handleCancelPreview}
        />
      </div>
      {isDataSourceOpen && activeDataSource && (
        <DataSourceDetailsPanel
          key={activeDataSource.id}
          source={activeDataSource}
          rows={dataRuntime.rowsByDataSourceId[activeDataSource.id] ?? []}
          recipe={dataProduct.recipes.find((recipe) => recipe.sourceDatasetId === activeDataSource.id)}
          queryRecords={queryRecords}
          onPreviewRecipeBinding={handlePreviewRecipeBinding}
          onConfirmAiAccess={activeDataSource.ephemeral ? handleConfirmDatasetAiAccess : undefined}
          onDelete={activeDataSource.ephemeral ? handleDeleteDataset : undefined}
          onClose={() => setIsDataSourceOpen(false)}
        />
      )}
      {isCsvUploadOpen && <CsvUploadDialog onUploaded={handleCsvUploaded} onClose={() => setIsCsvUploadOpen(false)} />}
      {isEdsAnalysisOpen && <EdsAnalysisDialog onCreateWorkspace={handleCreateEdsWorkspace} onClose={handleCloseEdsAnalysis} />}
      <ActivityHistoryPanel
        open={isHistoryOpen}
        harnessTasks={harnessTasks}
        auditRecords={auditRecords}
        loading={isHistoryLoading}
        onRestoreFocus={handleRestoreHistoryFocus}
        onClose={handleCloseHistory}
      />
    </main>
  );
}
