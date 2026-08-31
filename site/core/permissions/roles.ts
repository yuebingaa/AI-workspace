import type { ChangeOperation } from "@/core/models";
import { StudioValidationError } from "@/core/schemas/errors";

export type StudioRole = "viewer" | "editor" | "admin";

export const studioRoleLabels: Record<StudioRole, string> = {
  viewer: "查看者",
  editor: "编辑者",
  admin: "管理员",
};

export interface StudioCapabilities {
  preview: boolean;
  addNode: boolean;
  moveNode: boolean;
  updateNodeProps: boolean;
  removeNode: boolean;
  updatePage: boolean;
}

export const studioCapabilities: Record<StudioRole, StudioCapabilities> = {
  viewer: { preview: true, addNode: false, moveNode: false, updateNodeProps: false, removeNode: false, updatePage: false },
  editor: { preview: true, addNode: true, moveNode: true, updateNodeProps: true, removeNode: false, updatePage: false },
  admin: { preview: true, addNode: true, moveNode: true, updateNodeProps: true, removeNode: true, updatePage: true },
};

export function assertOperationPermission(role: StudioRole, operation: ChangeOperation): void {
  if (studioCapabilities[role][operation.type]) return;
  const actionLabels: Record<ChangeOperation["type"], string> = {
    addNode: "添加组件",
    moveNode: "调整组件顺序",
    updateNodeProps: "修改组件属性",
    removeNode: "删除组件",
    updatePage: "修改页面结构",
  };
  throw new StudioValidationError("编辑权限校验失败", [
    `${studioRoleLabels[role]}无权${actionLabels[operation.type]}（操作：${operation.label}）`,
  ]);
}

export function puckPermissionsForRole(role: StudioRole) {
  const capabilities = studioCapabilities[role];
  return {
    drag: capabilities.moveNode,
    duplicate: false,
    delete: capabilities.removeNode,
    edit: capabilities.updateNodeProps,
    insert: capabilities.addNode,
  };
}
