import type { AppNode, AppPage, AppSpec, ChangeOperation, ChangeSet } from "@/core/models";
import { assertValidAppSpecDataBindings } from "@/core/data";
import { assertOperationPermission, type StudioRole } from "@/core/permissions";
import {
  appSpecSchema,
  changeSetSchema,
  componentPropsSchemas,
  formatSchemaIssues,
  StudioValidationError,
} from "@/core/schemas";

export interface ChangeSetPreview {
  appSpec: AppSpec;
  changeSetId: string;
  operationIds: string[];
}

interface ChangeSetHistoryEntry {
  appSpec: AppSpec;
  changeSetId: string;
  requiredRole: "editor" | "admin";
}

export interface ChangeSetExecutionState {
  present: AppSpec;
  preview: ChangeSetPreview | null;
  history: ChangeSetHistoryEntry[];
  appliedChangeSetIds: string[];
}

export const MAX_COMPONENTS_PER_PAGE = 30;

export interface ChangeSetValidationOptions {
  role?: StudioRole;
  intent?: "preview" | "apply";
}

function nodeEntries(node: AppNode): AppNode[] {
  return [node, ...(node.children?.flatMap(nodeEntries) ?? [])];
}

function allNodes(appSpec: AppSpec): AppNode[] {
  return appSpec.pages.flatMap((page) => nodeEntries(page.root));
}

function componentCount(page: AppPage): number {
  return Math.max(0, nodeEntries(page.root).length - 1);
}

function assertPageComponentLimits(appSpec: AppSpec) {
  const exceeded = appSpec.pages.filter((page) => componentCount(page) > MAX_COMPONENTS_PER_PAGE);
  if (exceeded.length) {
    throw new StudioValidationError("页面组件数量校验失败", exceeded.map((page) => (
      `页面“${page.title}”包含 ${componentCount(page)} 个组件，最多允许 ${MAX_COMPONENTS_PER_PAGE} 个`
    )));
  }
}

function duplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  ids.forEach((id) => (seen.has(id) ? duplicates.add(id) : seen.add(id)));
  return [...duplicates];
}

function assertUniqueNodeIds(appSpec: AppSpec) {
  const duplicates = duplicateIds(allNodes(appSpec).map((node) => node.id));
  if (duplicates.length) {
    throw new StudioValidationError("AppSpec 节点 ID 校验失败", [
      `发现重复节点 ID：${duplicates.join("、")}`,
    ]);
  }
}

function findNode(root: AppNode, nodeId: string): AppNode | undefined {
  if (root.id === nodeId) return root;
  for (const child of root.children ?? []) {
    const match = findNode(child, nodeId);
    if (match) return match;
  }
}

function updateNode(
  node: AppNode,
  nodeId: string,
  updater: (current: AppNode) => AppNode,
): [AppNode, boolean] {
  if (node.id === nodeId) return [updater(node), true];
  if (!node.children) return [node, false];

  let changed = false;
  const children = node.children.map((child) => {
    const [nextChild, childChanged] = updateNode(child, nodeId, updater);
    changed ||= childChanged;
    return nextChild;
  });
  return changed ? [{ ...node, children } as AppNode, true] : [node, false];
}

function removeNode(node: AppNode, nodeId: string): [AppNode, boolean] {
  if (!node.children) return [node, false];
  if (node.children.some((child) => child.id === nodeId)) {
    return [{ ...node, children: node.children.filter((child) => child.id !== nodeId) } as AppNode, true];
  }

  let changed = false;
  const children = node.children.map((child) => {
    const [nextChild, childChanged] = removeNode(child, nodeId);
    changed ||= childChanged;
    return nextChild;
  });
  return changed ? [{ ...node, children } as AppNode, true] : [node, false];
}

function detachNode(node: AppNode, nodeId: string): [AppNode, AppNode | undefined] {
  if (!node.children) return [node, undefined];
  const directIndex = node.children.findIndex((child) => child.id === nodeId);
  if (directIndex >= 0) {
    const detached = node.children[directIndex];
    return [
      { ...node, children: node.children.filter((_, index) => index !== directIndex) } as AppNode,
      detached,
    ];
  }

  for (let index = 0; index < node.children.length; index += 1) {
    const [nextChild, detached] = detachNode(node.children[index], nodeId);
    if (detached) {
      const children = [...node.children];
      children[index] = nextChild;
      return [{ ...node, children } as AppNode, detached];
    }
  }
  return [node, undefined];
}

function updatePage(appSpec: AppSpec, pageId: string, updater: (page: AppPage) => AppPage): AppSpec {
  return { ...appSpec, pages: appSpec.pages.map((page) => page.id === pageId ? updater(page) : page) };
}

function applyOperationUnchecked(appSpec: AppSpec, operation: ChangeOperation): AppSpec {
  if (operation.type === "updatePage") {
    return {
      ...appSpec,
      pages: appSpec.pages.map((page) => page.id === operation.pageId ? {
        ...page,
        ...(operation.title === undefined ? {} : { title: operation.title }),
        ...(operation.route === undefined ? {} : { route: operation.route }),
      } : page),
      navigation: appSpec.navigation.map((item) => (
        item.pageId === operation.pageId && operation.title !== undefined
          ? { ...item, title: operation.title }
          : item
      )),
    };
  }
  return updatePage(appSpec, operation.pageId, (page) => {
    if (operation.type === "removeNode") {
      const [root] = removeNode(page.root, operation.nodeId);
      return { ...page, root };
    }

    if (operation.type === "moveNode") {
      const [rootWithoutNode, detached] = detachNode(page.root, operation.nodeId);
      if (!detached) return page;
      const [root] = updateNode(rootWithoutNode, operation.parentId, (parent) => {
        const children = [...(parent.children ?? [])];
        children.splice(operation.position, 0, detached);
        return { ...parent, children } as AppNode;
      });
      return { ...page, root };
    }

    const targetId = operation.type === "addNode" ? operation.parentId : operation.nodeId;
    const [root] = updateNode(page.root, targetId, (node) => {
      if (operation.type === "addNode") {
        const children = [...(node.children ?? [])];
        children.splice(operation.position ?? children.length, 0, structuredClone(operation.node));
        return { ...node, children } as AppNode;
      }
      return { ...node, props: { ...node.props, ...operation.props } } as AppNode;
    });
    return { ...page, root };
  });
}

function validateOperationTarget(appSpec: AppSpec, operation: ChangeOperation) {
  const page = appSpec.pages.find((candidate) => candidate.id === operation.pageId);
  if (!page) {
    throw new StudioValidationError("ChangeSet 目标校验失败", [
      `操作“${operation.label}”引用了不存在的页面：${operation.pageId}`,
    ]);
  }

  if (operation.type === "updatePage") {
    if (operation.title === undefined && operation.route === undefined) {
      throw new StudioValidationError("ChangeSet 目标校验失败", ["页面更新至少需要提供标题或路由"]);
    }
    return;
  }

  if (operation.type === "addNode") {
    if (!findNode(page.root, operation.parentId)) {
      throw new StudioValidationError("ChangeSet 目标校验失败", [
        `操作“${operation.label}”引用了不存在的父组件：${operation.parentId}`,
      ]);
    }
    const currentIds = new Set(allNodes(appSpec).map((node) => node.id));
    const addedIds = nodeEntries(operation.node).map((node) => node.id);
    const repeatedInsideNode = duplicateIds(addedIds);
    const repeatedInApp = addedIds.filter((id) => currentIds.has(id));
    const duplicates = [...new Set([...repeatedInsideNode, ...repeatedInApp])];
    if (duplicates.length) {
      throw new StudioValidationError("ChangeSet 节点 ID 校验失败", [
        `操作“${operation.label}”包含重复节点 ID：${duplicates.join("、")}`,
      ]);
    }
    return;
  }

  const target = findNode(page.root, operation.nodeId);
  if (!target) {
    throw new StudioValidationError("ChangeSet 目标校验失败", [
      `操作“${operation.label}”引用了不存在的组件：${operation.nodeId}`,
    ]);
  }
  if (operation.type === "removeNode" && page.root.id === operation.nodeId) {
    throw new StudioValidationError("ChangeSet 目标校验失败", ["不能删除页面根节点"]);
  }
  if (operation.type === "moveNode") {
    if (page.root.id === operation.nodeId) {
      throw new StudioValidationError("ChangeSet 目标校验失败", ["不能移动页面根节点"]);
    }
    const parent = findNode(page.root, operation.parentId);
    if (!parent) {
      throw new StudioValidationError("ChangeSet 目标校验失败", [
        `操作“${operation.label}”引用了不存在的父组件：${operation.parentId}`,
      ]);
    }
    if (nodeEntries(target).some((node) => node.id === operation.parentId)) {
      throw new StudioValidationError("ChangeSet 目标校验失败", ["不能把组件移动到自身或其子节点中"]);
    }
    if (operation.position > (parent.children?.length ?? 0)) {
      throw new StudioValidationError("ChangeSet 目标校验失败", [
        `移动位置 ${operation.position} 超出父组件范围`,
      ]);
    }
  }
  if (operation.type === "updateNodeProps") {
    const result = componentPropsSchemas[target.type].safeParse({ ...target.props, ...operation.props });
    if (!result.success) {
      throw new StudioValidationError(
        `组件“${operation.nodeId}”属性校验失败`,
        formatSchemaIssues(result.error, target.type),
      );
    }
  }
}

function parseAppSpec(appSpec: AppSpec): AppSpec {
  const result = appSpecSchema.safeParse(appSpec);
  if (!result.success) {
    throw new StudioValidationError("AppSpec Schema 校验失败", formatSchemaIssues(result.error, "AppSpec"));
  }
  assertUniqueNodeIds(result.data);
  assertPageComponentLimits(result.data);
  assertValidAppSpecDataBindings(result.data);
  return result.data;
}

function parseChangeSet(changeSet: ChangeSet): ChangeSet {
  const result = changeSetSchema.safeParse(changeSet);
  if (!result.success) {
    throw new StudioValidationError("ChangeSet Schema 校验失败", formatSchemaIssues(result.error, "ChangeSet"));
  }
  return result.data;
}

export function validateChangeSetAgainstAppSpec(
  appSpec: AppSpec,
  changeSet: ChangeSet,
  options: ChangeSetValidationOptions = {},
): AppSpec {
  let working = structuredClone(parseAppSpec(appSpec));
  const parsedChangeSet = parseChangeSet(changeSet);
  const role = options.role ?? "editor";
  const intent = options.intent ?? "apply";

  for (const operation of parsedChangeSet.operations) {
    if (intent === "apply") assertOperationPermission(role, operation);
    validateOperationTarget(working, operation);
    working = applyOperationUnchecked(working, operation);
    assertUniqueNodeIds(working);
    assertPageComponentLimits(working);
    assertValidAppSpecDataBindings(working);
  }

  return parseAppSpec(working);
}

export function createExecutionState(appSpec: AppSpec): ChangeSetExecutionState {
  return { present: parseAppSpec(appSpec), preview: null, history: [], appliedChangeSetIds: [] };
}

export function previewChangeSet(
  state: ChangeSetExecutionState,
  changeSet: ChangeSet,
  role: StudioRole = "editor",
): ChangeSetExecutionState {
  const appSpec = validateChangeSetAgainstAppSpec(state.present, changeSet, { role, intent: "preview" });
  return {
    ...state,
    preview: {
      appSpec,
      changeSetId: changeSet.id,
      operationIds: changeSet.operations.map((operation) => operation.id),
    },
  };
}

export function cancelPreview(state: ChangeSetExecutionState): ChangeSetExecutionState {
  return { ...state, preview: null };
}

export function applyChangeSet(
  state: ChangeSetExecutionState,
  changeSet: ChangeSet,
  role: StudioRole = "editor",
): ChangeSetExecutionState {
  const nextAppSpec = validateChangeSetAgainstAppSpec(state.present, changeSet, { role, intent: "apply" });
  return {
    present: nextAppSpec,
    preview: null,
    history: [...state.history, {
      appSpec: state.present,
      changeSetId: changeSet.id,
      requiredRole: changeSet.operations.some((operation) => operation.type === "removeNode" || operation.type === "updatePage")
        ? "admin"
        : "editor",
    }],
    appliedChangeSetIds: [...state.appliedChangeSetIds, changeSet.id],
  };
}

export function undoLastChange(
  state: ChangeSetExecutionState,
  role: StudioRole = "editor",
): ChangeSetExecutionState {
  const previous = state.history.at(-1);
  if (!previous) return { ...state, preview: null };
  if (role === "viewer" || (previous.requiredRole === "admin" && role !== "admin")) {
    throw new StudioValidationError("编辑权限校验失败", [
      role === "viewer" ? "查看者无权撤销正式变更" : "该变更涉及管理员操作，只能由管理员撤销",
    ]);
  }
  return {
    present: previous.appSpec,
    preview: null,
    history: state.history.slice(0, -1),
    appliedChangeSetIds: state.appliedChangeSetIds.slice(0, -1),
  };
}
