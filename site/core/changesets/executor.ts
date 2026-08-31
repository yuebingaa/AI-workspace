import type { AppNode, AppPage, AppSpec, ChangeOperation, ChangeSet } from "@/core/models";
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
}

export interface ChangeSetExecutionState {
  present: AppSpec;
  preview: ChangeSetPreview | null;
  history: ChangeSetHistoryEntry[];
  appliedChangeSetIds: string[];
}

function nodeEntries(node: AppNode): AppNode[] {
  return [node, ...(node.children?.flatMap(nodeEntries) ?? [])];
}

function allNodes(appSpec: AppSpec): AppNode[] {
  return appSpec.pages.flatMap((page) => nodeEntries(page.root));
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
  return result.data;
}

function parseChangeSet(changeSet: ChangeSet): ChangeSet {
  const result = changeSetSchema.safeParse(changeSet);
  if (!result.success) {
    throw new StudioValidationError("ChangeSet Schema 校验失败", formatSchemaIssues(result.error, "ChangeSet"));
  }
  return result.data;
}

export function validateChangeSetAgainstAppSpec(appSpec: AppSpec, changeSet: ChangeSet): AppSpec {
  let working = structuredClone(parseAppSpec(appSpec));
  const parsedChangeSet = parseChangeSet(changeSet);

  for (const operation of parsedChangeSet.operations) {
    validateOperationTarget(working, operation);
    working = applyOperationUnchecked(working, operation);
    assertUniqueNodeIds(working);
  }

  return parseAppSpec(working);
}

export function createExecutionState(appSpec: AppSpec): ChangeSetExecutionState {
  return { present: parseAppSpec(appSpec), preview: null, history: [], appliedChangeSetIds: [] };
}

export function previewChangeSet(
  state: ChangeSetExecutionState,
  changeSet: ChangeSet,
): ChangeSetExecutionState {
  const appSpec = validateChangeSetAgainstAppSpec(state.present, changeSet);
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
): ChangeSetExecutionState {
  const nextAppSpec = validateChangeSetAgainstAppSpec(state.present, changeSet);
  return {
    present: nextAppSpec,
    preview: null,
    history: [...state.history, { appSpec: state.present, changeSetId: changeSet.id }],
    appliedChangeSetIds: [...state.appliedChangeSetIds, changeSet.id],
  };
}

export function undoLastChange(state: ChangeSetExecutionState): ChangeSetExecutionState {
  const previous = state.history.at(-1);
  if (!previous) return { ...state, preview: null };
  return {
    present: previous.appSpec,
    preview: null,
    history: state.history.slice(0, -1),
    appliedChangeSetIds: state.appliedChangeSetIds.slice(0, -1),
  };
}
