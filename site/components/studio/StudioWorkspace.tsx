"use client";

import { useState } from "react";
import {
  applyChangeSet,
  createExecutionState,
  previewChangeSet,
  undoLastChange,
} from "@/core/changesets";
import type { AppSpec } from "@/core/models";
import { demoDataProduct, repurchaseChangeSet } from "@/fixtures/demo-product";
import { AiBuilderAssistant, type ChangeSetUiStatus } from "./AiBuilderAssistant";
import { DataProductCanvas } from "./DataProductCanvas";
import { PageStructurePanel } from "./PageStructurePanel";
import { StudioHeader, type PreviewDevice } from "./StudioHeader";

export function StudioWorkspace() {
  const [execution, setExecution] = useState(() => createExecutionState(demoDataProduct.appSpec));
  const [previewSpec, setPreviewSpec] = useState<AppSpec | null>(null);
  const [activePageId, setActivePageId] = useState(demoDataProduct.appSpec.navigation[0].pageId);
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [saveLabel, setSaveLabel] = useState("已保存 · 演示草稿");

  const isApplied = execution.appliedChangeSetIds.includes(repurchaseChangeSet.id);
  const status: ChangeSetUiStatus = isApplied ? "applied" : previewSpec ? "preview" : "pending";
  const renderedSpec = previewSpec ?? execution.present;
  const activePage = renderedSpec.pages.find((page) => page.id === activePageId) ?? renderedSpec.pages[0];
  const dataset = demoDataProduct.datasets[0];

  function handlePreview() {
    setPreviewSpec(previewChangeSet(execution.present, repurchaseChangeSet).appSpec);
    setActivePageId("page_home");
    setSaveLabel("预览中 · 尚未保存");
  }

  function handleApply() {
    setExecution((current) => applyChangeSet(current, repurchaseChangeSet));
    setPreviewSpec(null);
    setActivePageId("page_home");
    setSaveLabel("已保存 · 变更已应用");
  }

  function handleCancelPreview() {
    setPreviewSpec(null);
    setSaveLabel("已保存 · 演示草稿");
  }

  function handleUndo() {
    setExecution((current) => undoLastChange(current));
    setPreviewSpec(null);
    setSaveLabel("已保存 · 已撤销最近变更");
  }

  return (
    <main className="studio-shell">
      <StudioHeader
        productName={demoDataProduct.name}
        device={device}
        canUndo={execution.history.length > 0}
        saveLabel={saveLabel}
        onDeviceChange={setDevice}
        onUndo={handleUndo}
      />
      <div className="workspace">
        <PageStructurePanel
          dataProduct={demoDataProduct}
          appSpec={renderedSpec}
          activePageId={activePageId}
          onPageChange={setActivePageId}
        />
        <DataProductCanvas
          appSpec={renderedSpec}
          activePageId={activePageId}
          device={device}
          isPreviewing={Boolean(previewSpec)}
          canUndo={execution.history.length > 0}
          onUndo={handleUndo}
        />
        <AiBuilderAssistant
          pageTitle={activePage?.title ?? "未选择页面"}
          datasetName={dataset?.name ?? "未选择数据集"}
          changeSet={repurchaseChangeSet}
          status={status}
          onPreview={handlePreview}
          onApply={handleApply}
          onCancelPreview={handleCancelPreview}
        />
      </div>
    </main>
  );
}
