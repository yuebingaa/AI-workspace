"use client";
import { selectedSemanticModel } from "@/core/semantic/model";

import { useMemo, useState } from "react";
import { cancelPreview, previewChangeSet } from "@/core/changesets";
import type { AppSpec, ChangeSet, DataProduct } from "@/core/models";
import type { StudioRole } from "@/core/permissions";
import { readableValidationError } from "@/core/schemas";
import { createBlankWorkspaceInAppSpec, datasetsForWorkspace, INITIAL_WORKSPACE_PAGE_ID, workspaceInterfaceSummaries } from "@/core/workspaces";
import type { CanvasMode } from "../DataProductCanvas";
import type { PersistWorkspace, StateSetter, WorkspaceFeedback, WorkspacePreviewBindings, WorkspaceSnapshotRef } from "./contracts";

export function selectablePageId(appSpec: AppSpec, requestedPageId?: string): string {
  if (requestedPageId && appSpec.pages.some((page) => page.id === requestedPageId)) return requestedPageId;
  if (appSpec.pages.some((page) => page.id === INITIAL_WORKSPACE_PAGE_ID)) return INITIAL_WORKSPACE_PAGE_ID;
  return appSpec.navigation.find((item) => appSpec.pages.some((page) => page.id === item.pageId))?.pageId
    ?? appSpec.pages[0].id;
}

export function useStudioPagesState(renderedSpec: AppSpec, dataProduct: DataProduct) {
  const [activePageId, setActivePageId] = useState(INITIAL_WORKSPACE_PAGE_ID);
  const activePage = renderedSpec.pages.find((page) => page.id === activePageId)
    ?? renderedSpec.pages.find((page) => page.id === INITIAL_WORKSPACE_PAGE_ID)
    ?? renderedSpec.pages[0];
  const interfaces = useMemo(
    () => workspaceInterfaceSummaries(renderedSpec, dataProduct.datasets),
    [dataProduct.datasets, renderedSpec],
  );
  return { activePageId, setActivePageId, activePage, interfaces };
}

export interface StudioPageActionsContext extends WorkspaceFeedback, WorkspacePreviewBindings {
  role: StudioRole;
  dataProduct: DataProduct;
  renderedSpec: AppSpec;
  activePageId: string;
  interfaces: ReturnType<typeof workspaceInterfaceSummaries>;
  canvasMode: CanvasMode;
  latestDatasetWorkspaceRef: WorkspaceSnapshotRef;
  setDataProduct: StateSetter<DataProduct>;
  setActivePageId: StateSetter<string>;
  setActiveDataSourceId: StateSetter<string>;
  setIsDataSourceOpen: StateSetter<boolean>;
  ensurePuckDraft(pageId: string, appSpec?: AppSpec): void;
  persistExplicitly: PersistWorkspace;
}

// Same per-render snapshot semantics as the original component handlers.
// Shared apply/undo policy remains in the workspace coordinator.
export function createStudioPageActions(context: StudioPageActionsContext) {
  const {
    role, dataProduct, renderedSpec, activePageId, interfaces, canvasMode,
    execution, latestDatasetWorkspaceRef, setExecution, setDataProduct,
    setActivePageId, setActiveDataSourceId, setIsDataSourceOpen,
    setPendingPuckChangeSet, setPendingChangeSource, setCanvasMode,
    clearPuckDraft, setPuckSessionKey, setValidationError, setSaveLabel,
    ensurePuckDraft, auditCurrentPreviewCancellation, addAudit, persistExplicitly,
  } = context;

  function handlePageChange(pageId: string) {
    try {
      auditCurrentPreviewCancellation();
      const nextExecution = cancelPreview(execution);
      setExecution(nextExecution);
      setActivePageId(pageId);
      setActiveDataSourceId(selectedSemanticModel(dataProduct, pageId)?.sourceDatasetId
        ?? datasetsForWorkspace(dataProduct.datasets, pageId)[0]?.id ?? "");
      setIsDataSourceOpen(false);
      setPendingPuckChangeSet(null);
      if (canvasMode === "edit") {
        ensurePuckDraft(pageId, nextExecution.present);
      }
      setValidationError(null);
    } catch (error) {
      setValidationError(readableValidationError(error));
    }
  }


  function handleInterfaceChange(interfaceId: string) {
    if (!renderedSpec.pages.some((page) => page.id === interfaceId)) return;
    handlePageChange(interfaceId);
  }


  function handleCreateInterface(label: string) {
    if (role === "viewer") {
      setValidationError("查看者不能创建工作界面，请切换为编辑者或管理员。");
      return;
    }
    try {
      const current = latestDatasetWorkspaceRef.current;
      const baseExecution = cancelPreview(current.execution);
      const created = createBlankWorkspaceInAppSpec(
        baseExecution.present,
        label,
        () => `${Date.now()}_${crypto.randomUUID().replaceAll("-", "")}`,
      );
      const nextExecution = { ...baseExecution, present: created.appSpec, preview: null };
      const nextDataProduct = { ...current.dataProduct, appSpec: created.appSpec };
      latestDatasetWorkspaceRef.current = {
        ...current,
        execution: nextExecution,
        dataProduct: nextDataProduct,
        activeDataSourceId: "",
      };
      setExecution(nextExecution);
      setDataProduct(nextDataProduct);
      setActivePageId(created.page.id);
      setActiveDataSourceId("");
      setIsDataSourceOpen(false);
      setPendingPuckChangeSet(null);
      setPendingChangeSource(null);
      clearPuckDraft();
      setPuckSessionKey((value) => value + 1);
      setCanvasMode("preview");
      setValidationError(null);
      const persistence = persistExplicitly(
        nextExecution,
        current.auditRecords,
        current.queryRecords,
        nextDataProduct,
        current.harnessTasks,
      );
      setSaveLabel(persistence.persisted ? `已创建 · ${created.page.title}` : "已创建 · 当前页面未持久化");
    } catch (error) {
      setValidationError(readableValidationError(error));
    }
  }


  function handleRenamePage(pageId: string, currentTitle: string) {
    if (role === "viewer") return;
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


  function handleDeletePage(pageId: string, currentTitle: string) {
    if (role === "viewer") return;
    const visiblePageCount = interfaces.length;
    if (visiblePageCount <= 1) {
      setValidationError("至少需要保留一个工作界面。");
      return;
    }
    const datasetCount = datasetsForWorkspace(dataProduct.datasets, pageId).length;
    const transferNotice = datasetCount > 0 ? `\n该界面的 ${datasetCount} 份数据不会删除，将转移到保留的工作界面。` : "";
    if (!window.confirm(`确定删除工作界面“${currentTitle}”吗？${transferNotice}\n此操作会先生成 ChangeSet 预览。`)) return;
    const changeSet: ChangeSet = {
      id: `changeset_page_delete_${Date.now()}`,
      title: `删除工作界面：${currentTitle}`,
      status: "ready",
      operations: [{
        id: `operation_page_delete_${Date.now()}`,
        type: "deletePage",
        label: "删除工作界面",
        description: `删除工作界面“${currentTitle}”，保留并转移其中的数据`,
        pageId,
      }],
    };
    try {
      auditCurrentPreviewCancellation();
      const nextExecution = previewChangeSet(cancelPreview(execution), changeSet, role);
      setExecution(nextExecution);
      setActivePageId(selectablePageId(nextExecution.preview?.appSpec ?? nextExecution.present, activePageId === pageId ? undefined : activePageId));
      setPendingPuckChangeSet(changeSet);
      setPendingChangeSource("manual");
      setCanvasMode("preview");
      setSaveLabel("预览中 · 删除工作界面");
      setValidationError(null);
      addAudit(changeSet, "manual", "previewed");
    } catch (error) {
      const message = readableValidationError(error);
      setValidationError(message);
      addAudit(changeSet, "manual", "failed", message);
    }
  }

  return { handlePageChange, handleInterfaceChange, handleCreateInterface, handleRenamePage, handleDeletePage };
}

// React-facing adapter: callbacks close over this render, never execute here.
export function useStudioPageActions(context: StudioPageActionsContext) {
  return createStudioPageActions(context);
}
