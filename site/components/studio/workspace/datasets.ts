"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { cancelPreview } from "@/core/changesets";
import { appendChangeSetAuditRecord, createChangeSetAuditRecordFromSummary } from "@/core/audit";
import { confirmDatasetAiAccess, DatasetAiAccessConflictError, deleteUploadedDataset } from "@/core/datasets/client";
import type { DatasetUploadResponse, UploadedDatasetDescriptor } from "@/core/datasets";
import { removeUploadedDatasetFromWorkspace, synchronizeUploadedDatasetWorkspace } from "@/core/datasets/workspace-state";
import {
  createEdsAuditSummary, createEdsWorkspaceSnapshotForResults, EDS_OVERVIEW_DATA_SOURCE_ID,
  EDS_WORKSPACE_PAGE_ID, getEdsWorkspaceReports, installEdsWorkspaceInDataProduct,
  installEdsWorkspaceInExecution, mergeEdsWorkspaceRuntime, selectEdsWorkspaceReport,
  type EdsAnalysisResponse, type EdsWorkspaceSnapshot,
} from "@/core/eds";
import { settleHarnessConfirmation } from "@/core/harness/task-state";
import type { AppNode, AppSpec, ChangeSetAuditRecord, ChangeSetAuditSource, DataProduct, LocalDataRuntime } from "@/core/models";
import type { StudioRole } from "@/core/permissions";
import { assignDatasetToWorkspace, datasetsForWorkspace } from "@/core/workspaces";
import type { ImportedWorkbookAttachment } from "../CsvUploadDialog";
import { restoreDialogTriggerUnlessOpen } from "../ActivityHistoryPanel";
import { harnessUiClock, type StudioAssistantState, type createStudioAssistantActions } from "./assistant";
import type { PersistWorkspace, StateSetter, WorkspaceFeedback, WorkspacePreviewBindings, WorkspaceSnapshotRef } from "./contracts";

const EDS_AI_ANALYSIS_INSTRUCTION = "请读取全部 EDS 日期和班次的派生汇总，对比异常次数、异常时长、命中率、主要异常线体和异常类别，指出跨班次差异、优先排查项与可执行改善建议。引用具体数值，不要修改页面，不要创建 ChangeSet。";

function nodeUsesDataSource(node: AppNode, dataSourceId: string): boolean {
  const binding = "binding" in node.props ? node.props.binding : undefined;
  return Boolean(binding && typeof binding === "object" && "dataSourceId" in binding && binding.dataSourceId === dataSourceId)
    || Boolean(node.children?.some((child) => nodeUsesDataSource(child, dataSourceId)));
}

function appSpecUsesDataSource(appSpec: AppSpec, dataSourceId: string): boolean {
  return appSpec.pages.some((page) => nodeUsesDataSource(page.root, dataSourceId));
}

export function useStudioDatasetsState(dataProduct: DataProduct, renderedSpec: AppSpec, activePageId: string) {
  const [edsWorkspace, setEdsWorkspace] = useState<EdsWorkspaceSnapshot | null>(null);
  const [activeDataSourceId, setActiveDataSourceId] = useState("");
  const [isDataSourceOpen, setIsDataSourceOpen] = useState(false);
  const [isCsvUploadOpen, setIsCsvUploadOpen] = useState(false);
  const [composerImportFiles, setComposerImportFiles] = useState<File[]>([]);
  const [isEdsAnalysisOpen, setIsEdsAnalysisOpen] = useState(false);
  const [originalWorkbooks, setOriginalWorkbooks] = useState<Array<ImportedWorkbookAttachment & { id: string; datasetId: string; workspaceId: string }>>([]);
  const [openOriginalWorkbookId, setOpenOriginalWorkbookId] = useState<string | null>(null);
  const originalWorkbookButtonRef = useRef<HTMLButtonElement>(null);
  const originalWorkbookTriggerRef = useRef<HTMLButtonElement | null>(null);
  const edsAnalysisTriggerRef = useRef<HTMLButtonElement | null>(null);
  const edsAnalysisOpenRef = useRef(false);

  const dataset = activeDataSourceId
    ? dataProduct.datasets.find((candidate) => candidate.id === activeDataSourceId)
    : undefined;
  const activeDataSource = activeDataSourceId
    ? renderedSpec.dataSources.find((source) => source.id === activeDataSourceId)
    : undefined;
  const workspaceDatasets = useMemo(() => datasetsForWorkspace(dataProduct.datasets, activePageId), [dataProduct.datasets, activePageId]);
  const activeOriginalWorkbooks = useMemo(
    () => originalWorkbooks.filter((workbook) => workbook.workspaceId === activePageId),
    [activePageId, originalWorkbooks],
  );
  const activeOriginalWorkbook = originalWorkbooks.find((workbook) => workbook.datasetId === activeDataSourceId)
    ?? activeOriginalWorkbooks[0];
  const openOriginalWorkbook = originalWorkbooks.find((workbook) => workbook.id === openOriginalWorkbookId);
  const edsReportOptions = useMemo(() => {
    if (!edsWorkspace || activePageId !== EDS_WORKSPACE_PAGE_ID) return undefined;
    return getEdsWorkspaceReports(edsWorkspace).map((report) => ({
      date: report.summary.date,
      shift: report.summary.shift,
      selected: report.summary.date === edsWorkspace.summary.date && report.summary.shift === edsWorkspace.summary.shift,
    }));
  }, [activePageId, edsWorkspace]);

  const handleOpenEdsAnalysis = useCallback(() => {
    if (document.activeElement instanceof HTMLButtonElement) edsAnalysisTriggerRef.current = document.activeElement;
    edsAnalysisOpenRef.current = true;
    setIsEdsAnalysisOpen(true);
  }, []);
  const handleCloseEdsAnalysis = useCallback(() => {
    edsAnalysisOpenRef.current = false;
    setIsEdsAnalysisOpen(false);
    requestAnimationFrame(() => restoreDialogTriggerUnlessOpen(
      edsAnalysisTriggerRef.current,
      edsAnalysisOpenRef.current,
    ));
  }, []);
  function handleOpenOriginalWorkbook(workbookId?: string) {
    const candidate = workbookId
      ? originalWorkbooks.find((workbook) => workbook.id === workbookId)
      : activeOriginalWorkbook;
    if (!candidate) {
      setIsCsvUploadOpen(true);
      return;
    }
    if (document.activeElement instanceof HTMLButtonElement) originalWorkbookTriggerRef.current = document.activeElement;
    setOpenOriginalWorkbookId(candidate.id);
  }

  return {
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
    setIsEdsAnalysisOpen,
    originalWorkbooks,
    setOriginalWorkbooks,
    openOriginalWorkbookId,
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
    handleOpenOriginalWorkbook
  };
}
export type StudioDatasetsState = ReturnType<typeof useStudioDatasetsState>;

export interface StudioDatasetActionsContext extends WorkspaceFeedback,
  Pick<WorkspacePreviewBindings, "setExecution" | "setPendingPuckChangeSet" | "setPendingChangeSource" | "setCanvasMode" | "clearPuckDraft" | "setPuckSessionKey"> {
  datasets: StudioDatasetsState;
  assistant: Pick<StudioAssistantState, "aiChangeSet" | "setAiMessage" | "setAiMetadata" | "setAiInstruction" | "setAiRequestStatus" | "setAiRequestError" | "setHasValidAiPlan" | "setHarnessTasks" | "aiRequestAbortRef" | "harnessRequestActiveRef">;
  role: StudioRole;
  renderedSpec: AppSpec;
  activePageId: string;
  pendingChangeSource: ChangeSetAuditSource | null;
  latestDatasetWorkspaceRef: WorkspaceSnapshotRef;
  setDataProduct: StateSetter<DataProduct>;
  setDataRuntime: StateSetter<LocalDataRuntime>;
  setAuditRecords: StateSetter<ChangeSetAuditRecord[]>;
  setActivePageId: StateSetter<string>;
  setPersistenceNotice: StateSetter<string | null>;
  persistExplicitly: PersistWorkspace;
  handleGenerateAiPlan: ReturnType<typeof createStudioAssistantActions>["handleGenerateAiPlan"];
}

export function createStudioDatasetActions(context: StudioDatasetActionsContext) {
  const { edsWorkspace, setEdsWorkspace, setActiveDataSourceId, setIsDataSourceOpen,
    originalWorkbooks, setOriginalWorkbooks, activeDataSource, handleCloseEdsAnalysis } = context.datasets;
  const { aiChangeSet, setAiMessage, setAiMetadata, setAiInstruction, setAiRequestStatus,
    setAiRequestError, setHasValidAiPlan, setHarnessTasks, aiRequestAbortRef, harnessRequestActiveRef } = context.assistant;
  const {
    role, renderedSpec, activePageId, pendingChangeSource, latestDatasetWorkspaceRef,
    setExecution, setDataProduct, setDataRuntime, setAuditRecords, setActivePageId,
    setPendingPuckChangeSet, setPendingChangeSource, setCanvasMode, clearPuckDraft,
    setPuckSessionKey, setValidationError, setSaveLabel, setPersistenceNotice,
    persistExplicitly, handleGenerateAiPlan,
  } = context;

  function handleCreateEdsWorkspace(results: EdsAnalysisResponse[], activeResultIndex: number, source: File, allowAiRawAccess: boolean) {
    if (role === "viewer") throw new Error("查看者无权生成 EDS 工作区看板，请切换为编辑者或管理员。");
    aiRequestAbortRef.current?.abort();
    const current = latestDatasetWorkspaceRef.current;
    const snapshot = createEdsWorkspaceSnapshotForResults(results, activeResultIndex);
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
    setOriginalWorkbooks((current) => [
      ...current.filter((workbook) => workbook.datasetId !== EDS_OVERVIEW_DATA_SOURCE_ID),
      {
        id: `workbook_${crypto.randomUUID()}`,
        datasetId: EDS_OVERVIEW_DATA_SOURCE_ID,
        workspaceId: EDS_WORKSPACE_PAGE_ID,
        file: source,
        sheetNames: [...new Set(results.flatMap((result) => result.summary.sourceSheets))],
        aiRawAccess: allowAiRawAccess,
      },
    ]);
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
    setAiMessage(allowAiRawAccess
      ? "EDS 派生汇总已进入 AI 数据上下文；原始工作簿仅保留在本次浏览器会话，并已授权 Harness 在相关提问中完整扫描所有数据行、执行结构化查询。原文件不会写入聊天、localStorage、备份或审计正文。"
      : "EDS 派生汇总已进入 AI 数据上下文；原始工作簿仅挂载在本次会话的“原始资料”区，AI 完整扫描尚未授权。原文件不会进入本地持久化。");
    setAiMetadata(null);
    setAiRequestStatus("idle");
    setAiRequestError(null);
    setHasValidAiPlan(false);
    setSaveLabel("已保存 · EDS 分析看板");
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


  function handleSelectEdsWorkspaceReport(reportIndex: number) {
    const current = latestDatasetWorkspaceRef.current;
    if (!current.edsWorkspace) return;
    const reports = getEdsWorkspaceReports(current.edsWorkspace);
    const selected = reports[reportIndex];
    if (!selected || (
      selected.summary.date === current.edsWorkspace.summary.date
      && selected.summary.shift === current.edsWorkspace.summary.shift
    )) return;
    aiRequestAbortRef.current?.abort();
    const nextSnapshot = selectEdsWorkspaceReport(current.edsWorkspace, reportIndex);
    const nextExecution = installEdsWorkspaceInExecution(current.execution, nextSnapshot);
    const nextDataProduct = {
      ...installEdsWorkspaceInDataProduct(current.dataProduct, nextSnapshot),
      appSpec: nextExecution.present,
    };
    const nextDataRuntime = mergeEdsWorkspaceRuntime(current.dataRuntime, nextSnapshot);

    setExecution(nextExecution);
    setDataProduct(nextDataProduct);
    setDataRuntime(nextDataRuntime);
    setEdsWorkspace(nextSnapshot);
    setActivePageId(EDS_WORKSPACE_PAGE_ID);
    setActiveDataSourceId(EDS_OVERVIEW_DATA_SOURCE_ID);
    setCanvasMode("preview");
    setPendingPuckChangeSet(null);
    setPendingChangeSource(null);
    clearPuckDraft();
    setPuckSessionKey((value) => value + 1);
    setAiInstruction("比较当前 EDS 班次与同批次其他班次的异常次数、异常时间和主要异常类别。不要修改页面。");
    setAiMessage(`EDS 看板已切换到 ${nextSnapshot.summary.date} ${nextSnapshot.summary.shift}；${reports.length} 份派生汇总仍同时保存在 AI 数据上下文和本地工作区，原始工作簿仍只挂载于本次会话。`);
    setAiMetadata(null);
    setAiRequestStatus("idle");
    setAiRequestError(null);
    setHasValidAiPlan(false);
    setSaveLabel(`已保存 · ${nextSnapshot.summary.shift}报告`);
    setValidationError(null);
    const persistence = persistExplicitly(
      nextExecution,
      current.auditRecords,
      current.queryRecords,
      nextDataProduct,
      current.harnessTasks,
      nextSnapshot,
    );
    if (!persistence.persisted) setSaveLabel(`已切换 · ${nextSnapshot.summary.shift}未持久化`);
  }


  function handleAnalyzeEdsReports() {
    if (!edsWorkspace || harnessRequestActiveRef.current) return;
    setAiInstruction(EDS_AI_ANALYSIS_INSTRUCTION);
    void handleGenerateAiPlan(EDS_AI_ANALYSIS_INSTRUCTION);
  }


  function handleAnalyzeDataSource(dataSourceId: string) {
    if (harnessRequestActiveRef.current) return;
    const source = renderedSpec.dataSources.find((candidate) => candidate.id === dataSourceId);
    if (!source) {
      setValidationError("该表格对应的数据源已经失效，请重新导入后再分析。");
      return;
    }
    const workbook = originalWorkbooks.find((candidate) => candidate.datasetId === dataSourceId);
    const isEdsDataSource = Boolean(edsWorkspace && dataSourceId.startsWith("dataset_eds_"));
    const instruction = isEdsDataSource
      ? EDS_AI_ANALYSIS_INSTRUCTION
      : workbook?.aiRawAccess
        ? `请完整分析原始工作簿和当前数据集“${source.name}”。先检查工作表结构、字段类型、数据质量和关键统计，再说明主要分布、异常点、可能原因及可执行建议，并引用具体数值。只进行数据分析，不要修改页面，不要创建 ChangeSet。`
        : `请分析当前数据集“${source.name}”。先检查字段结构与数据质量，再计算关键统计，说明主要分布、异常点、可能原因及可执行建议，并引用具体数值。只进行数据分析，不要修改页面，不要创建 ChangeSet。`;
    setActiveDataSourceId(dataSourceId);
    setIsDataSourceOpen(false);
    setValidationError(null);
    void handleGenerateAiPlan(instruction, undefined, {
      dataSourceId,
      ...(workbook?.aiRawAccess ? { rawWorkbook: workbook.file } : {}),
    });
  }


  function applyUploadedDescriptor(descriptor: UploadedDatasetDescriptor, workspaceId?: string, rows?: DatasetUploadResponse["rows"]) {
    const current = latestDatasetWorkspaceRef.current;
    const synchronized = synchronizeUploadedDatasetWorkspace(current, descriptor, rows);
    const nextDataProduct = workspaceId
      ? { ...assignDatasetToWorkspace(synchronized.dataProduct, descriptor.datasetId, workspaceId), appSpec: synchronized.execution.present }
      : synchronized.dataProduct;
    const next = { ...synchronized, dataProduct: nextDataProduct };
    latestDatasetWorkspaceRef.current = {
      ...current,
      execution: next.execution,
      dataProduct: next.dataProduct,
      dataRuntime: next.dataRuntime,
      activeDataSourceId: descriptor.datasetId,
    };
    setExecution(next.execution);
    setDataProduct(next.dataProduct);
    setDataRuntime(next.dataRuntime);
    const persistence = persistExplicitly(
      next.execution,
      current.auditRecords,
      current.queryRecords,
      next.dataProduct,
      current.harnessTasks,
    );
    return { nextExecution: next.execution, nextDataProduct: next.dataProduct, persistence };
  }


  function handleCsvUploaded(result: DatasetUploadResponse, workbook: ImportedWorkbookAttachment | undefined, targetWorkspaceId: string) {
    const destination = renderedSpec.pages.some((page) => page.id === targetWorkspaceId)
      ? targetWorkspaceId
      : activePageId;
    const { persistence } = applyUploadedDescriptor(result.dataset, destination, result.rows);
    setActivePageId(destination);
    setActiveDataSourceId(result.dataset.datasetId);
    if (workbook) setOriginalWorkbooks((current) => [
      ...current.filter((candidate) => candidate.datasetId !== result.dataset.datasetId),
      {
        ...workbook,
        id: `workbook_${crypto.randomUUID()}`,
        datasetId: result.dataset.datasetId,
        workspaceId: destination,
      },
    ]);
    setIsDataSourceOpen(false);
    setPersistenceNotice(persistence.persisted
      ? result.dataset.persistenceNotice
      : `${persistence.notice} ${result.dataset.persistenceNotice}`);
    setSaveLabel(persistence.persisted ? `已导入 · ${workbook ? "XLSX 工作表" : "CSV 数据源"}` : "已导入 · 当前页面未持久化");
  }


  async function handleConfirmDatasetAiAccess(policy: "masked" | "exclude-sensitive-samples") {
    if (!activeDataSource || (!activeDataSource.ephemeral && activeDataSource.sourceType !== "csv")) return;
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
    if (!activeDataSource || (!activeDataSource.ephemeral && activeDataSource.sourceType !== "csv")) return;
    const dataSourceId = activeDataSource.id;
    const beforeDelete = latestDatasetWorkspaceRef.current;
    if (beforeDelete.dataProduct.semanticLayer?.models.some((model) => model.sourceDatasetId === dataSourceId)) {
      throw new Error("该数据源仍被语义模型引用，请先删除或重新绑定对应模型。");
    }
    if (appSpecUsesDataSource(beforeDelete.execution.present, dataSourceId) || beforeDelete.execution.history.some((entry) => appSpecUsesDataSource(entry.appSpec, dataSourceId))) {
      throw new Error("该数据源仍被页面组件或变更历史引用，无法删除。请先撤销相关绑定。");
    }
    await deleteUploadedDataset(dataSourceId);
    const current = latestDatasetWorkspaceRef.current;
    const next = removeUploadedDatasetFromWorkspace(current, dataSourceId);
    setExecution(next.execution);
    setDataProduct(next.dataProduct);
    setDataRuntime(next.dataRuntime);
    setOriginalWorkbooks((workbooks) => workbooks.filter((workbook) => workbook.datasetId !== dataSourceId));
    if (current.activeDataSourceId === dataSourceId) {
      setActiveDataSourceId(datasetsForWorkspace(next.dataProduct.datasets, activePageId)[0]?.id ?? "");
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

  return { handleCreateEdsWorkspace, handleSelectEdsWorkspaceReport, handleAnalyzeEdsReports, handleAnalyzeDataSource, applyUploadedDescriptor, handleCsvUploaded, handleConfirmDatasetAiAccess, handleDeleteDataset };
}

export function useStudioDatasetActions(context: StudioDatasetActionsContext) {
  return createStudioDatasetActions(context);
}
