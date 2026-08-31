import type { AppNode, AppPage, AppSpec, ChangeOperation, ChangeSet } from "@/core/models";

export interface ChangeSetPreview {
  appSpec: AppSpec;
  operationIds: string[];
}

export interface ChangeSetExecutionState {
  present: AppSpec;
  history: AppSpec[];
  appliedChangeSetIds: string[];
}

export function createExecutionState(appSpec: AppSpec): ChangeSetExecutionState {
  return { present: structuredClone(appSpec), history: [], appliedChangeSetIds: [] };
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

function updatePage(appSpec: AppSpec, pageId: string, updater: (page: AppPage) => AppPage): AppSpec {
  let found = false;
  const pages = appSpec.pages.map((page) => {
    if (page.id !== pageId) return page;
    found = true;
    return updater(page);
  });
  if (!found) throw new Error(`找不到页面：${pageId}`);
  return { ...appSpec, pages };
}

function applyOperation(appSpec: AppSpec, operation: ChangeOperation): AppSpec {
  return updatePage(appSpec, operation.pageId, (page) => {
    if (operation.type === "removeNode") {
      const [root, changed] = removeNode(page.root, operation.nodeId);
      if (!changed) throw new Error(`找不到待删除组件：${operation.nodeId}`);
      return { ...page, root };
    }

    const targetId = operation.type === "addNode" ? operation.parentId : operation.nodeId;
    const [root, changed] = updateNode(page.root, targetId, (node) => {
      if (operation.type === "addNode") {
        const children = [...(node.children ?? [])];
        children.splice(operation.position ?? children.length, 0, structuredClone(operation.node));
        return { ...node, children } as AppNode;
      }
      return { ...node, props: { ...node.props, ...operation.props } } as AppNode;
    });
    if (!changed) throw new Error(`找不到变更目标：${targetId}`);
    return { ...page, root };
  });
}

export function previewChangeSet(appSpec: AppSpec, changeSet: ChangeSet): ChangeSetPreview {
  return {
    appSpec: changeSet.operations.reduce(applyOperation, structuredClone(appSpec)),
    operationIds: changeSet.operations.map((operation) => operation.id),
  };
}

export function applyChangeSet(
  state: ChangeSetExecutionState,
  changeSet: ChangeSet,
): ChangeSetExecutionState {
  if (state.appliedChangeSetIds.includes(changeSet.id)) return state;
  const preview = previewChangeSet(state.present, changeSet);
  return {
    present: preview.appSpec,
    history: [...state.history, state.present],
    appliedChangeSetIds: [...state.appliedChangeSetIds, changeSet.id],
  };
}

export function undoLastChange(state: ChangeSetExecutionState): ChangeSetExecutionState {
  const previous = state.history.at(-1);
  if (!previous) return state;
  return {
    present: previous,
    history: state.history.slice(0, -1),
    appliedChangeSetIds: state.appliedChangeSetIds.slice(0, -1),
  };
}
