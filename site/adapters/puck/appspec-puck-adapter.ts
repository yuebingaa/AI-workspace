import { z } from "zod";
import type { AppNode, AppPage, AppSpec, ChangeOperation, ChangeSet } from "@/core/models";
import { validateChangeSetAgainstAppSpec } from "@/core/changesets";
import {
  appSpecSchema,
  componentPropsSchemas,
  formatSchemaIssues,
  StudioValidationError,
} from "@/core/schemas";
import type { StudioPuckComponentType, StudioPuckData } from "./types";
import type { StudioRole } from "@/core/permissions";

const supportedTypes = [
  "PageHeader",
  "InsightBanner",
  "MetricCard",
  "MetricGrid",
  "DashboardGrid",
  "BarChart",
  "DataHealth",
  "DataTable",
] as const satisfies readonly StudioPuckComponentType[];

const containerTypes = new Set<StudioPuckComponentType>(["MetricGrid", "DashboardGrid"]);
const puckDataEnvelopeSchema = z.object({
  content: z.array(z.unknown()),
  root: z.record(z.string(), z.unknown()),
  zones: z.record(z.string(), z.array(z.unknown())).optional(),
}).strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSupportedType(value: string): value is StudioPuckComponentType {
  return supportedTypes.includes(value as StudioPuckComponentType);
}

function appNodeToPuckComponent(node: AppNode): StudioPuckData["content"][number] {
  if (node.type === "PageRoot") {
    throw new StudioValidationError("Puck 转换失败", ["页面根节点不能作为普通组件转换"]);
  }
  const props: Record<string, unknown> = { ...structuredClone(node.props), id: node.id };
  if (containerTypes.has(node.type)) {
    props.children = (node.children ?? []).map(appNodeToPuckComponent);
  }
  return { type: node.type, props } as StudioPuckData["content"][number];
}

export function appSpecToPuckData(appSpec: AppSpec, pageId: string): StudioPuckData {
  const parsed = appSpecSchema.safeParse(appSpec);
  if (!parsed.success) {
    throw new StudioValidationError("AppSpec 无法转换为 Puck Data", formatSchemaIssues(parsed.error, "AppSpec"));
  }
  const page = parsed.data.pages.find((candidate) => candidate.id === pageId);
  if (!page) {
    throw new StudioValidationError("AppSpec 无法转换为 Puck Data", [`找不到页面：${pageId}`]);
  }
  return {
    content: (page.root.children ?? []).map(appNodeToPuckComponent),
    root: {},
  };
}

function puckComponentToAppNode(value: unknown, seenIds: Set<string>, path: string): AppNode {
  if (!isRecord(value) || typeof value.type !== "string" || !isRecord(value.props)) {
    throw new StudioValidationError("Puck Data 校验失败", [`${path} 必须包含合法的 type 和 props`]);
  }
  if (!isSupportedType(value.type)) {
    throw new StudioValidationError("Puck Data 校验失败", [`${path} 使用了未注册组件：${value.type}`]);
  }

  const { id, children, ...rawProps } = value.props;
  if (typeof id !== "string" || !id.trim()) {
    throw new StudioValidationError("Puck Data 校验失败", [`${path}.props.id 必须是非空字符串`]);
  }
  if (seenIds.has(id)) {
    throw new StudioValidationError("Puck Data 校验失败", [`发现重复节点 ID：${id}`]);
  }
  seenIds.add(id);

  const propsResult = componentPropsSchemas[value.type].safeParse(rawProps);
  if (!propsResult.success) {
    throw new StudioValidationError(
      `Puck 组件“${id}”属性校验失败`,
      formatSchemaIssues(propsResult.error, value.type),
    );
  }

  if (containerTypes.has(value.type)) {
    if (!Array.isArray(children)) {
      throw new StudioValidationError("Puck Data 校验失败", [`容器组件“${id}”缺少 children 插槽数据`]);
    }
    return {
      id,
      type: value.type,
      props: propsResult.data,
      children: children.map((child, index) => puckComponentToAppNode(child, seenIds, `${path}.children.${index}`)),
    } as AppNode;
  }
  if (children !== undefined) {
    throw new StudioValidationError("Puck Data 校验失败", [`非容器组件“${id}”不能包含 children`]);
  }
  return { id, type: value.type, props: propsResult.data } as AppNode;
}

export function puckDataToAppPage(page: AppPage, data: unknown): AppPage {
  const envelope = puckDataEnvelopeSchema.safeParse(data);
  if (!envelope.success) {
    throw new StudioValidationError("Puck Data Schema 校验失败", formatSchemaIssues(envelope.error, "Puck Data"));
  }
  const seenIds = new Set<string>([page.root.id]);
  const children = envelope.data.content.map((component, index) => (
    puckComponentToAppNode(component, seenIds, `content.${index}`)
  ));
  return { ...page, root: { ...page.root, children } as AppNode };
}

interface NodeLocation {
  node: AppNode;
  parentId: string;
  index: number;
}

function nodeLocations(root: AppNode): Map<string, NodeLocation> {
  const locations = new Map<string, NodeLocation>();
  function visit(parent: AppNode) {
    (parent.children ?? []).forEach((node, index) => {
      locations.set(node.id, { node, parentId: parent.id, index });
      visit(node);
    });
  }
  visit(root);
  return locations;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyGeneratedOperation(appSpec: AppSpec, pageId: string, operation: ChangeOperation, role: StudioRole): AppSpec {
  return validateChangeSetAgainstAppSpec(appSpec, {
    id: `puck_validation_${operation.id}`,
    title: "Puck 操作中间校验",
    status: "ready",
    operations: [{ ...operation, pageId }],
  }, { role, intent: "apply" });
}

export function puckDataToChangeSet(
  appSpec: AppSpec,
  pageId: string,
  data: unknown,
  role: StudioRole = "editor",
): ChangeSet {
  const page = appSpec.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new StudioValidationError("Puck 变更转换失败", [`找不到页面：${pageId}`]);
  const targetPage = puckDataToAppPage(page, data);
  const targetLocations = nodeLocations(targetPage.root);
  let working = structuredClone(appSpec);
  const operations: ChangeOperation[] = [];
  let sequence = 0;

  const nextId = (kind: string) => `puck_${kind}_${++sequence}`;
  const append = (operation: ChangeOperation) => {
    operations.push(operation);
    working = applyGeneratedOperation(working, pageId, operation, role);
  };

  const originalLocations = nodeLocations(page.root);
  for (const location of [...originalLocations.values()].reverse()) {
    if (
      !targetLocations.has(location.node.id)
      && (targetLocations.has(location.parentId) || location.parentId === targetPage.root.id)
    ) {
      append({
        id: nextId("remove"),
        type: "removeNode",
        label: "删除组件",
        description: `删除 ${location.node.type} 组件`,
        pageId,
        nodeId: location.node.id,
      });
    }
  }

  function reconcileParent(targetParent: AppNode) {
    for (let targetIndex = 0; targetIndex < (targetParent.children ?? []).length; targetIndex += 1) {
      const targetNode = targetParent.children![targetIndex];
      let currentPage = working.pages.find((candidate) => candidate.id === pageId)!;
      let currentLocations = nodeLocations(currentPage.root);
      let current = currentLocations.get(targetNode.id);

      if (!current) {
        append({
          id: nextId("add"),
          type: "addNode",
          label: "添加组件",
          description: `添加 ${targetNode.type} 组件`,
          pageId,
          parentId: targetParent.id,
          position: targetIndex,
          node: structuredClone(targetNode),
        });
        continue;
      }
      if (current.node.type !== targetNode.type) {
        throw new StudioValidationError("Puck 变更转换失败", [
          `节点“${targetNode.id}”不能从 ${current.node.type} 直接变更为 ${targetNode.type}`,
        ]);
      }

      if (current.parentId !== targetParent.id || current.index !== targetIndex) {
        append({
          id: nextId("move"),
          type: "moveNode",
          label: "调整组件顺序",
          description: `将 ${targetNode.type} 移动到第 ${targetIndex + 1} 位`,
          pageId,
          nodeId: targetNode.id,
          parentId: targetParent.id,
          position: targetIndex,
        });
      }

      currentPage = working.pages.find((candidate) => candidate.id === pageId)!;
      currentLocations = nodeLocations(currentPage.root);
      current = currentLocations.get(targetNode.id)!;
      if (!sameValue(current.node.props, targetNode.props)) {
        append({
          id: nextId("update"),
          type: "updateNodeProps",
          label: "编辑组件属性",
          description: `更新 ${targetNode.type} 的属性`,
          pageId,
          nodeId: targetNode.id,
          props: structuredClone(targetNode.props) as Record<string, unknown>,
        });
      }
      reconcileParent(targetNode);
    }
  }

  reconcileParent(targetPage.root);
  if (!operations.length) {
    throw new StudioValidationError("Puck 变更转换失败", ["未检测到可预览的编辑变更"]);
  }

  const changeSet: ChangeSet = {
    id: `changeset_puck_${Date.now()}`,
    title: `可视化编辑：${page.title}`,
    status: "ready",
    operations,
  };
  const validated = validateChangeSetAgainstAppSpec(appSpec, changeSet, { role, intent: "apply" });
  const validatedPage = validated.pages.find((candidate) => candidate.id === pageId)!;
  if (!sameValue(validatedPage.root, targetPage.root)) {
    throw new StudioValidationError("Puck 变更转换失败", ["生成的 ChangeSet 与编辑结果不一致"]);
  }
  return changeSet;
}
