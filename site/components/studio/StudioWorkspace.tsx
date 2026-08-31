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
import { AiPlanClientError, requestAiPlan } from "@/core/ai/client";
import type { AiPlanMetadata } from "@/core/ai/contracts";
import {
  applyChangeSet,
  cancelPreview,
  createExecutionState,
  previewChangeSet,
  undoLastChange,
  validateChangeSetAgainstAppSpec,
} from "@/core/changesets";
import { createChangeSetAuditRecord, createChangeSetAuditRecordFromSummary, appendChangeSetAuditRecord } from "@/core/audit";
import { appendQueryExecutionRecord } from "@/core/data";
import type { AiChangeSetAuditMetadata, ChangeSet, ChangeSetAuditRecord, ChangeSetAuditSource, ChangeSetAuditStatus, QueryExecutionRecord } from "@/core/models";
import type { StudioRole } from "@/core/permissions";
import {
  createBrowserStudioRepository,
  createStudioSnapshot,
  loadStudioStateSafely,
  restoreDemoData,
  type StudioRepository,
} from "@/core/repository";
import { readableValidationError } from "@/core/schemas";
import { demoFixtureResult, type DemoFixtures } from "@/fixtures/demo-product";
import { AiBuilderAssistant, type AiRequestUiStatus, type ChangeSetUiStatus } from "./AiBuilderAssistant";
import { DataProductCanvas, type CanvasMode } from "./DataProductCanvas";
import { DataSourceDetailsPanel } from "./DataSourceDetailsPanel";
import { PageStructurePanel } from "./PageStructurePanel";
import { StudioHeader, type PreviewDevice } from "./StudioHeader";

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
  const { repurchaseChangeSet, dataRuntime } = fixtures;
  const [dataProduct, setDataProduct] = useState(() => structuredClone(fixtures.dataProduct));
  const [execution, setExecution] = useState(() => createExecutionState(fixtures.dataProduct.appSpec));
  const [activePageId, setActivePageId] = useState(fixtures.dataProduct.appSpec.navigation[0].pageId);
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
  const [persistenceNotice, setPersistenceNotice] = useState<string | null>(null);
  const [aiChangeSet, setAiChangeSet] = useState<ChangeSet>(() => structuredClone(repurchaseChangeSet));
  const [aiMessage, setAiMessage] = useState("我已检查数据结构和当前画布，建议先预览以下结构化变更。");
  const [aiMetadata, setAiMetadata] = useState<AiPlanMetadata | null>(null);
  const [aiInstruction, setAiInstruction] = useState("整理华东异常订单，创建复购分析，并提供 Excel 下载。");
  const [lastSubmittedInstruction, setLastSubmittedInstruction] = useState("");
  const [aiRequestStatus, setAiRequestStatus] = useState<AiRequestUiStatus>("idle");
  const [aiRequestError, setAiRequestError] = useState<string | null>(null);
  const [hasValidAiPlan, setHasValidAiPlan] = useState(true);
  const repositoryRef = useRef<StudioRepository | null>(null);
  const puckDraftOriginRef = useRef<PuckDraftOrigin | null>(null);
  const aiRequestAbortRef = useRef<AbortController | null>(null);

  const isApplied = execution.appliedChangeSetIds.includes(aiChangeSet.id);
  const isAiPreview = execution.preview?.changeSetId === aiChangeSet.id;
  const status: ChangeSetUiStatus = isApplied ? "applied" : isAiPreview ? "preview" : "pending";
  const renderedSpec = execution.preview?.appSpec ?? execution.present;
  const activePage = renderedSpec.pages.find((page) => page.id === activePageId) ?? renderedSpec.pages[0];
  const dataset = dataProduct.datasets[0];
  const activeDataSource = renderedSpec.dataSources.find((source) => source.id === dataset?.id) ?? renderedSpec.dataSources[0];
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
      setQueryRecords(restored.queryRecords);
      setSaveLabel(restored.restored ? "已恢复 · 本地草稿" : "已保存 · 演示草稿");
      setPersistenceNotice(restored.notice?.includes("回退") ? restored.notice : null);
    });
    return () => { cancelled = true; };
  }, [fixtures.dataProduct]);

  useEffect(() => () => aiRequestAbortRef.current?.abort(), []);

  function persistExplicitly(
    nextExecution = execution,
    nextAuditRecords = auditRecords,
    nextQueryRecords = queryRecords,
    nextDataProduct = dataProduct,
  ) {
    const repository = repositoryRef.current;
    if (!repository) return;
    try {
      repository.save(createStudioSnapshot(nextDataProduct, nextExecution, nextAuditRecords, nextQueryRecords));
    } catch (error) {
      setPersistenceNotice(`本地保存失败，当前页面仍可继续使用。${error instanceof Error ? ` ${error.message}` : ""}`);
    }
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
      setExecution(nextExecution);
      setActivePageId(aiChangeSet.operations[0]?.pageId ?? activePageId);
      setCanvasMode("preview");
      setPendingPuckChangeSet(null);
      setPendingChangeSource(null);
      clearPuckDraft();
      setPuckSessionKey((value) => value + 1);
      setSaveLabel("已保存 · 变更已应用");
      setValidationError(null);
      persistExplicitly(nextExecution, appendChangeSetAuditRecord(auditRecords, audit));
    } catch (error) {
      const message = readableValidationError(error);
      setValidationError(message);
      addAudit(aiChangeSet, "ai", "failed", message);
    }
  }

  function handleCancelPreview() {
    addAudit(aiChangeSet, "ai", "cancelled");
    setExecution(cancelPreview(execution));
    setSaveLabel("已保存 · 已取消 AI 预览");
    setValidationError(null);
  }

  async function handleGenerateAiPlan(instructionOverride?: string) {
    const submittedInstruction = (instructionOverride ?? aiInstruction).trim();
    if (!submittedInstruction || aiRequestStatus === "loading") return;

    aiRequestAbortRef.current?.abort();
    const controller = new AbortController();
    aiRequestAbortRef.current = controller;
    const baseExecution = cancelPreview(execution);
    if (execution.preview) auditCurrentPreviewCancellation();
    setExecution(baseExecution);
    setPendingPuckChangeSet(null);
    setPendingChangeSource(null);
    setCanvasMode("preview");
    setLastSubmittedInstruction(submittedInstruction);
    setAiRequestStatus("loading");
    setAiRequestError(null);
    setHasValidAiPlan(false);
    setValidationError(null);
    setSaveLabel("AI 规划中 · 正式 AppSpec 未修改");

    try {
      const result = await requestAiPlan({
        instruction: submittedInstruction,
        pageId: activePageId,
        appSpec: baseExecution.present,
        role,
      }, { signal: controller.signal, timeoutMs: 25_000 });
      validateChangeSetAgainstAppSpec(baseExecution.present, result.changeSet, { role, intent: "apply" });
      setAiChangeSet(result.changeSet);
      setAiMessage(result.message);
      setAiMetadata(result.metadata);
      setAiRequestStatus("success");
      setAiRequestError(null);
      setHasValidAiPlan(true);
      setSaveLabel("AI 已生成 · 等待画布预览");
    } catch (error) {
      const clientError = error instanceof AiPlanClientError
        ? error
        : new AiPlanClientError("invalid_response", readableValidationError(error), true);
      const nextStatus: AiRequestUiStatus = clientError.code === "timeout"
        ? "timeout"
        : clientError.code === "cancelled"
          ? "cancelled"
          : "error";
      setAiRequestStatus(nextStatus);
      setAiRequestError(clientError.message);
      setAiMessage("本次请求未生成可用 ChangeSet，正式 AppSpec 保持不变。");
      setAiMetadata(clientError.metadata ?? null);
      setHasValidAiPlan(false);
      setSaveLabel("已保存 · AI 未修改 AppSpec");
      addAuditSummary(
        `changeset_ai_request_${Date.now()}`,
        "AI 生成结构化 ChangeSet",
        "ai",
        "failed",
        clientError.message,
        clientError.metadata ?? null,
      );
    } finally {
      if (aiRequestAbortRef.current === controller) aiRequestAbortRef.current = null;
    }
  }

  function handleCancelAiRequest() {
    aiRequestAbortRef.current?.abort();
  }

  function handleRetryAiRequest() {
    if (lastSubmittedInstruction) void handleGenerateAiPlan(lastSubmittedInstruction);
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

  function handleResetDemo() {
    if (!window.confirm("确定恢复演示数据吗？当前已应用编辑、查询记录和审计记录都会被清除。")) return;
    aiRequestAbortRef.current?.abort();
    const restored = restoreDemoData(repositoryRef.current, fixtures.dataProduct);
    setDataProduct(restored.dataProduct);
    setExecution(restored.execution);
    setAuditRecords(restored.auditRecords);
    setQueryRecords(restored.queryRecords);
    setPendingPuckChangeSet(null);
    setPendingChangeSource(null);
    clearPuckDraft();
    setPuckSessionKey((value) => value + 1);
    setCanvasMode("preview");
    setActivePageId(fixtures.dataProduct.appSpec.navigation[0].pageId);
    setSaveLabel("已保存 · 已恢复演示数据");
    setValidationError(null);
    setPersistenceNotice(null);
    setAiChangeSet(structuredClone(repurchaseChangeSet));
    setAiMessage("我已检查数据结构和当前画布，建议先预览以下结构化变更。");
    setAiMetadata(null);
    setAiRequestStatus("idle");
    setAiRequestError(null);
    setLastSubmittedInstruction("");
    setHasValidAiPlan(true);
  }

  return (
    <main className="studio-shell">
      <StudioHeader
        productName={dataProduct.name}
        device={device}
        canUndo={role !== "viewer" && execution.history.length > 0}
        saveLabel={saveLabel}
        role={role}
        onDeviceChange={setDevice}
        onUndo={handleUndo}
        onRoleChange={handleRoleChange}
        onResetDemo={handleResetDemo}
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
          onOpenDataSource={() => setIsDataSourceOpen(true)}
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
          source={activeDataSource}
          rows={dataRuntime.rowsByDataSourceId[activeDataSource.id] ?? []}
          queryRecords={queryRecords}
          onClose={() => setIsDataSourceOpen(false)}
        />
      )}
    </main>
  );
}
