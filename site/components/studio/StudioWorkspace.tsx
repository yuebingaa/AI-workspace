"use client";

import { useState } from "react";
import {
  appSpecToPuckData,
  puckDataToChangeSet,
  type StudioPuckData,
} from "@/adapters/puck";
import {
  applyChangeSet,
  cancelPreview,
  createExecutionState,
  previewChangeSet,
  undoLastChange,
} from "@/core/changesets";
import type { ChangeSet } from "@/core/models";
import { readableValidationError } from "@/core/schemas";
import { demoFixtureResult, type DemoFixtures } from "@/fixtures/demo-product";
import { AiBuilderAssistant, type ChangeSetUiStatus } from "./AiBuilderAssistant";
import { DataProductCanvas, type CanvasMode } from "./DataProductCanvas";
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
  const { dataProduct, repurchaseChangeSet } = fixtures;
  const [execution, setExecution] = useState(() => createExecutionState(dataProduct.appSpec));
  const [activePageId, setActivePageId] = useState(dataProduct.appSpec.navigation[0].pageId);
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [saveLabel, setSaveLabel] = useState("已保存 · 演示草稿");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("preview");
  const [puckDraft, setPuckDraft] = useState<StudioPuckData | null>(null);
  const [puckSessionKey, setPuckSessionKey] = useState(0);
  const [pendingPuckChangeSet, setPendingPuckChangeSet] = useState<ChangeSet | null>(null);

  const isApplied = execution.appliedChangeSetIds.includes(repurchaseChangeSet.id);
  const isAiPreview = execution.preview?.changeSetId === repurchaseChangeSet.id;
  const status: ChangeSetUiStatus = isApplied ? "applied" : isAiPreview ? "preview" : "pending";
  const renderedSpec = execution.preview?.appSpec ?? execution.present;
  const activePage = renderedSpec.pages.find((page) => page.id === activePageId) ?? renderedSpec.pages[0];
  const dataset = dataProduct.datasets[0];

  function handlePreview() {
    try {
      setExecution(previewChangeSet(execution, repurchaseChangeSet));
      setActivePageId("page_home");
      setCanvasMode("preview");
      setPendingPuckChangeSet(null);
      setSaveLabel("预览中 · 尚未保存");
      setValidationError(null);
    } catch (error) {
      setValidationError(readableValidationError(error));
    }
  }

  function handleApply() {
    try {
      setExecution(applyChangeSet(execution, repurchaseChangeSet));
      setActivePageId("page_home");
      setCanvasMode("preview");
      setPendingPuckChangeSet(null);
      setPuckDraft(null);
      setPuckSessionKey((value) => value + 1);
      setSaveLabel("已保存 · 变更已应用");
      setValidationError(null);
    } catch (error) {
      setValidationError(readableValidationError(error));
    }
  }

  function handleCancelPreview() {
    setExecution(cancelPreview(execution));
    setSaveLabel("已保存 · 演示草稿");
    setValidationError(null);
  }

  function handleUndo() {
    setExecution(undoLastChange(execution));
    setCanvasMode("preview");
    setPendingPuckChangeSet(null);
    setPuckDraft(null);
    setPuckSessionKey((value) => value + 1);
    setSaveLabel("已保存 · 已撤销最近变更");
    setValidationError(null);
  }

  function handleCanvasModeChange(mode: CanvasMode) {
    if (mode === canvasMode) return;
    if (mode === "preview") {
      setCanvasMode("preview");
      return;
    }

    try {
      const nextExecution = cancelPreview(execution);
      setExecution(nextExecution);
      if (!pendingPuckChangeSet || !puckDraft) {
        setPuckDraft(appSpecToPuckData(nextExecution.present, activePageId));
        setPuckSessionKey((value) => value + 1);
      }
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
      const nextExecution = cancelPreview(execution);
      setExecution(nextExecution);
      setActivePageId(pageId);
      setPendingPuckChangeSet(null);
      if (canvasMode === "edit") {
        setPuckDraft(appSpecToPuckData(nextExecution.present, pageId));
        setPuckSessionKey((value) => value + 1);
      }
      setValidationError(null);
    } catch (error) {
      setValidationError(readableValidationError(error));
    }
  }

  function handleRequestPuckPreview(data: StudioPuckData) {
    try {
      const changeSet = puckDataToChangeSet(execution.present, activePageId, data);
      const nextExecution = previewChangeSet(cancelPreview(execution), changeSet);
      setExecution(nextExecution);
      setPuckDraft(structuredClone(data));
      setPendingPuckChangeSet(changeSet);
      setCanvasMode("preview");
      setSaveLabel(`预览中 · ${changeSet.operations.length} 项可视化变更`);
      setValidationError(null);
    } catch (error) {
      setValidationError(readableValidationError(error));
    }
  }

  function handleApplyPuckPreview() {
    if (!pendingPuckChangeSet) return;
    try {
      setExecution(applyChangeSet(cancelPreview(execution), pendingPuckChangeSet));
      setPendingPuckChangeSet(null);
      setPuckDraft(null);
      setPuckSessionKey((value) => value + 1);
      setCanvasMode("preview");
      setSaveLabel("已保存 · 可视化编辑已应用");
      setValidationError(null);
    } catch (error) {
      setValidationError(readableValidationError(error));
    }
  }

  function handleCancelPuckPreview() {
    setExecution(cancelPreview(execution));
    setPendingPuckChangeSet(null);
    setCanvasMode("edit");
    setSaveLabel("可视化编辑 · 尚未应用");
    setValidationError(null);
  }

  return (
    <main className="studio-shell">
      <StudioHeader
        productName={dataProduct.name}
        device={device}
        canUndo={execution.history.length > 0}
        saveLabel={saveLabel}
        onDeviceChange={setDevice}
        onUndo={handleUndo}
      />
      <div className="workspace">
        <PageStructurePanel
          dataProduct={dataProduct}
          appSpec={renderedSpec}
          activePageId={activePageId}
          onPageChange={handlePageChange}
        />
        <DataProductCanvas
          appSpec={renderedSpec}
          activePageId={activePageId}
          device={device}
          isPreviewing={Boolean(execution.preview)}
          canUndo={execution.history.length > 0}
          mode={canvasMode}
          puckData={puckDraft}
          puckSessionKey={puckSessionKey}
          hasPuckPreview={Boolean(pendingPuckChangeSet && execution.preview?.changeSetId === pendingPuckChangeSet.id)}
          onUndo={handleUndo}
          onModeChange={handleCanvasModeChange}
          onPuckDataChange={setPuckDraft}
          onRequestPuckPreview={handleRequestPuckPreview}
          onApplyPuckPreview={handleApplyPuckPreview}
          onCancelPuckPreview={handleCancelPuckPreview}
        />
        <AiBuilderAssistant
          pageTitle={activePage?.title ?? "未选择页面"}
          datasetName={dataset?.name ?? "未选择数据集"}
          changeSet={repurchaseChangeSet}
          status={status}
          validationError={validationError}
          onPreview={handlePreview}
          onApply={handleApply}
          onCancelPreview={handleCancelPreview}
        />
      </div>
    </main>
  );
}
