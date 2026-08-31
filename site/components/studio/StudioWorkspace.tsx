"use client";

import { useState } from "react";
import {
  applyChangeSet,
  cancelPreview,
  createExecutionState,
  previewChangeSet,
  undoLastChange,
} from "@/core/changesets";
import { readableValidationError } from "@/core/schemas";
import { demoFixtureResult, type DemoFixtures } from "@/fixtures/demo-product";
import { AiBuilderAssistant, type ChangeSetUiStatus } from "./AiBuilderAssistant";
import { DataProductCanvas } from "./DataProductCanvas";
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

  const isApplied = execution.appliedChangeSetIds.includes(repurchaseChangeSet.id);
  const status: ChangeSetUiStatus = isApplied ? "applied" : execution.preview ? "preview" : "pending";
  const renderedSpec = execution.preview?.appSpec ?? execution.present;
  const activePage = renderedSpec.pages.find((page) => page.id === activePageId) ?? renderedSpec.pages[0];
  const dataset = dataProduct.datasets[0];

  function handlePreview() {
    try {
      setExecution(previewChangeSet(execution, repurchaseChangeSet));
      setActivePageId("page_home");
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
    setSaveLabel("已保存 · 已撤销最近变更");
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
          onPageChange={setActivePageId}
        />
        <DataProductCanvas
          appSpec={renderedSpec}
          activePageId={activePageId}
          device={device}
          isPreviewing={Boolean(execution.preview)}
          canUndo={execution.history.length > 0}
          onUndo={handleUndo}
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
