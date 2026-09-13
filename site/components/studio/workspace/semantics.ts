"use client";

import { useState } from "react";
import type { DataProduct } from "@/core/models";
import type { StudioRole } from "@/core/permissions";
import type { SemanticModel } from "@/core/semantic/contracts";
import { deleteSemanticModel, saveSemanticModel, selectSemanticModel, selectedSemanticModel, semanticModelsForWorkspace } from "@/core/semantic/model";
import type { PersistWorkspace, StateSetter, WorkspaceSnapshotRef } from "./contracts";

export function useStudioSemanticState(product: DataProduct, pageId: string, dataSourceId: string) {
  const [editor, setEditor] = useState<{ modelId?: string } | null>(null);
  const models = semanticModelsForWorkspace(product, pageId);
  const selected = selectedSemanticModel(product, pageId, dataSourceId);
  return { editor, setEditor, models, selected };
}

export interface SemanticActionsContext {
  pageId: string;
  role: StudioRole;
  busy: boolean;
  latestDatasetWorkspaceRef: WorkspaceSnapshotRef;
  setDataProduct: StateSetter<DataProduct>;
  setActiveDataSourceId: StateSetter<string>;
  setSaveLabel: StateSetter<string>;
  setPersistenceNotice: StateSetter<string | null>;
  persistExplicitly: PersistWorkspace;
}

export function createStudioSemanticActions(context: SemanticActionsContext) {
  const assertIdle = () => { if (context.busy) throw new Error("请等待当前 AI 任务完成，再切换或修改语义模型。"); };
  function commit(product: DataProduct, label: string, dataSourceId?: string) {
    const latest = context.latestDatasetWorkspaceRef.current;
    context.latestDatasetWorkspaceRef.current = { ...latest, dataProduct: product,
      ...(dataSourceId ? { activeDataSourceId: dataSourceId } : {}) };
    context.setDataProduct(product);
    if (dataSourceId) context.setActiveDataSourceId(dataSourceId);
    const result = context.persistExplicitly(latest.execution, latest.auditRecords, latest.queryRecords,
      product, latest.harnessTasks, latest.edsWorkspace, latest.assistantConversation);
    context.setSaveLabel(result.persisted ? `已保存 · ${label}` : `仅当前会话 · ${label}`);
    context.setPersistenceNotice(result.notice);
  }
  return {
    save(model: SemanticModel) {
      assertIdle();
      const latest = context.latestDatasetWorkspaceRef.current;
      const product = saveSemanticModel({ ...latest.dataProduct, appSpec: latest.execution.present }, model, context.pageId, context.role);
      commit(product, "语义模型已保存并选中", model.sourceDatasetId);
    },
    select(modelId: string | null) {
      assertIdle();
      const latest = context.latestDatasetWorkspaceRef.current;
      const product = selectSemanticModel({ ...latest.dataProduct, appSpec: latest.execution.present }, context.pageId, modelId);
      commit(product, modelId ? "已选择语义模型" : "已取消语义模型选择", selectedSemanticModel(product, context.pageId)?.sourceDatasetId);
    },
    remove(modelId: string) {
      assertIdle();
      const latest = context.latestDatasetWorkspaceRef.current;
      const model = semanticModelsForWorkspace(latest.dataProduct, context.pageId).find((item) => item.id === modelId);
      if (!model) throw new Error("当前界面没有这个语义模型。");
      const next = deleteSemanticModel(latest.dataProduct, modelId, context.role);
      if (!window.confirm(`确定删除语义模型“${model.name}”吗？\n\n仅删除模型定义和选择状态；原始表格、已有图表及历史分析结果都会保留。`)) return false;
      commit(next, "语义模型已删除");
      return true;
    },
  };
}

export function useStudioSemanticActions(context: SemanticActionsContext) { return createStudioSemanticActions(context); }
