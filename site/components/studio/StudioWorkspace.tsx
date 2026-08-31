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
import {
  applyChangeSet,
  cancelPreview,
  createExecutionState,
  previewChangeSet,
  undoLastChange,
} from "@/core/changesets";
import { createChangeSetAuditRecord, createChangeSetAuditRecordFromSummary, appendChangeSetAuditRecord } from "@/core/audit";
import { appendQueryExecutionRecord } from "@/core/data";
import type { ChangeSet, ChangeSetAuditRecord, ChangeSetAuditSource, ChangeSetAuditStatus, QueryExecutionRecord } from "@/core/models";
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
import { AiBuilderAssistant, type ChangeSetUiStatus } from "./AiBuilderAssistant";
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
  const repositoryRef = useRef<StudioRepository | null>(null);
  const puckDraftOriginRef = useRef<PuckDraftOrigin | null>(null);

  const isApplied = execution.appliedChangeSetIds.includes(repurchaseChangeSet.id);
  const isAiPreview = execution.preview?.changeSetId === repurchaseChangeSet.id;
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

  function addAudit(
    changeSet: ChangeSet,
    source: ChangeSetAuditSource,
    auditStatus: ChangeSetAuditStatus,
    error?: string,
  ) {
    const record = createChangeSetAuditRecord(changeSet, role, source, auditStatus, error);
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
  ) {
    const record = createChangeSetAuditRecordFromSummary(changeSetId, summary, role, source, auditStatus, error);
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
      changeSetId === repurchaseChangeSet.id ? "ai" : pendingChangeSource ?? "manual",
      "cancelled",
    );
  }

  function handlePreview() {
    try {
      if (execution.preview && execution.preview.changeSetId !== repurchaseChangeSet.id) auditCurrentPreviewCancellation();
      setExecution(previewChangeSet(execution, repurchaseChangeSet, role));
      setActivePageId("page_home");
      setCanvasMode("preview");
      setPendingPuckChangeSet(null);
      setPendingChangeSource(null);
      setSaveLabel("预览中 · 尚未保存");
      setValidationError(null);
      addAudit(repurchaseChangeSet, "ai", "previewed");
    } catch (error) {
      const message = readableValidationError(error);
      setValidationError(message);
      addAudit(repurchaseChangeSet, "ai", "failed", message);
    }
  }

  function handleApply() {
    try {
      if (execution.preview && execution.preview.changeSetId !== repurchaseChangeSet.id) auditCurrentPreviewCancellation();
      const nextExecution = applyChangeSet(execution, repurchaseChangeSet, role);
      const audit = addAudit(repurchaseChangeSet, "ai", "applied");
      setExecution(nextExecution);
      setActivePageId("page_home");
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
      addAudit(repurchaseChangeSet, "ai", "failed", message);
    }
  }

  function handleCancelPreview() {
    addAudit(repurchaseChangeSet, "ai", "cancelled");
    setExecution(cancelPreview(execution));
    setSaveLabel("已保存 · 演示草稿");
    setValidationError(null);
  }

  function handleUndo() {
    const changeSetId = execution.appliedChangeSetIds.at(-1) ?? "unknown_changeset";
    const prior = auditRecords.find((record) => record.changeSetId === changeSetId && record.status === "applied");
    try {
      const nextExecution = undoLastChange(execution, role);
      const audit = addAuditSummary(changeSetId, prior?.operationSummary ?? "撤销最近一次正式变更", prior?.source ?? "manual", "undone");
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
          changeSet={repurchaseChangeSet}
          status={status}
          validationError={validationError}
          canApply={role !== "viewer"}
          auditRecords={auditRecords}
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
