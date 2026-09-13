import type { AppNode, AppPage, AppSpec, ChangeOperation, ChangeSet } from "@/core/models";
import { sanitizeHarnessText } from "./security";

const propertyLabels: Record<string, string> = {
  label: "标题",
  title: "标题",
  subtitle: "副标题",
  description: "说明",
  eyebrow: "眉标题",
  dateRange: "日期范围",
  actionLabel: "按钮文字",
  color: "颜色",
  accentColor: "强调色",
  chartType: "图表类型",
  showValues: "数据标签",
  density: "表格密度",
  stripedRows: "斑马纹",
  columns: "列数",
  score: "得分",
  binding: "数据绑定",
};

function findNode(root: AppNode, nodeId: string): AppNode | undefined {
  if (root.id === nodeId) return root;
  for (const child of root.children ?? []) {
    const found = findNode(child, nodeId);
    if (found) return found;
  }
  return undefined;
}

function pageFor(appSpec: AppSpec, pageId: string): AppPage | undefined {
  return appSpec.pages.find((page) => page.id === pageId);
}

function nodeName(node: AppNode | undefined, fallbackId: string): string {
  if (!node) return fallbackId;
  const props = node.props as Record<string, unknown>;
  const title = [props.label, props.title, props.eyebrow].find((value) => typeof value === "string" && value.trim());
  return typeof title === "string" ? `${title}（${node.type}）` : `${node.type}（${node.id}）`;
}

function compactValue(value: unknown): string {
  if (value === undefined) return "未设置";
  if (value === null) return "空值";
  if (typeof value === "string") return `“${sanitizeHarnessText(value).slice(0, 90)}”`;
  if (typeof value === "boolean") return value ? "开启" : "关闭";
  if (typeof value === "number") return String(value);
  try {
    const json = JSON.stringify(value);
    return sanitizeHarnessText(json).slice(0, 150) + (json.length > 150 ? "…" : "");
  } catch {
    return "结构化配置";
  }
}

function propertyChanges(operation: Extract<ChangeOperation, { type: "updateNodeProps" }>, node?: AppNode): string {
  const currentProps = (node?.props ?? {}) as Record<string, unknown>;
  const entries = Object.entries(operation.props).slice(0, 8).map(([key, nextValue]) => {
    const label = propertyLabels[key] ?? key;
    return `${label}：${compactValue(currentProps[key])} → ${compactValue(nextValue)}`;
  });
  const omitted = Object.keys(operation.props).length - entries.length;
  return `${entries.join("；")}${omitted > 0 ? `；另有 ${omitted} 个字段` : ""}`;
}

function describeOperation(operation: ChangeOperation, appSpec: AppSpec): string {
  const page = pageFor(appSpec, operation.pageId);
  const pageName = page?.title ?? operation.pageId;
  switch (operation.type) {
    case "addPage":
      return `新增工作界面“${operation.page.title}”`;
    case "deletePage":
      return `删除工作界面“${pageName}”；其中的数据将保留并转移到剩余界面`;
    case "addNode": {
      const parent = page ? findNode(page.root, operation.parentId) : undefined;
      return `在页面“${pageName}”的“${nodeName(parent, operation.parentId)}”中新增“${nodeName(operation.node, operation.node.id)}”${operation.position === undefined ? "" : `，位置 ${operation.position + 1}`}`;
    }
    case "updateNodeProps": {
      const node = page ? findNode(page.root, operation.nodeId) : undefined;
      return `修改页面“${pageName}”中的“${nodeName(node, operation.nodeId)}”：${propertyChanges(operation, node)}`;
    }
    case "removeNode": {
      const node = page ? findNode(page.root, operation.nodeId) : undefined;
      return `从页面“${pageName}”删除“${nodeName(node, operation.nodeId)}”`;
    }
    case "moveNode": {
      const node = page ? findNode(page.root, operation.nodeId) : undefined;
      const parent = page ? findNode(page.root, operation.parentId) : undefined;
      return `把页面“${pageName}”中的“${nodeName(node, operation.nodeId)}”移动到“${nodeName(parent, operation.parentId)}”的第 ${operation.position + 1} 个位置`;
    }
    case "updatePage": {
      const changes = [
        operation.title === undefined ? undefined : `标题：${compactValue(page?.title)} → ${compactValue(operation.title)}`,
        operation.route === undefined ? undefined : `路径：${compactValue(page?.route)} → ${compactValue(operation.route)}`,
      ].filter((item): item is string => Boolean(item));
      return `修改页面“${pageName}”：${changes.join("；")}`;
    }
  }
}

export function describeHarnessChangeSet(changeSet: ChangeSet, appSpec: AppSpec): string {
  const details = changeSet.operations.slice(0, 12).map((operation, index) => (
    `${index + 1}. ${describeOperation(operation, appSpec)}`
  ));
  const omitted = changeSet.operations.length - details.length;
  const response = [
    `已生成 ${changeSet.operations.length} 项待确认变更：`,
    ...details,
    ...(omitted > 0 ? [`另有 ${omitted} 项变更，请在结构化变更计划中查看。`] : []),
    "当前仅生成了 ChangeSet 预览，正式页面尚未修改；请先查看画布预览，再决定是否应用。",
  ].join("\n");
  return sanitizeHarnessText(response).slice(0, 2_000);
}
