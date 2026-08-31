import { z } from "zod";
import type { AppNode, AppNodeType } from "@/core/models";
import { studioCapabilities } from "@/core/permissions";
import { componentPropsSchemas, StudioValidationError } from "@/core/schemas";
import type { AiPlanRequest } from "./contracts";

export const MAX_DEEPSEEK_CONTEXT_BYTES = 90_000;

function compactNode(node: AppNode, includeProps: boolean): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type,
    ...(includeProps ? { props: node.props } : {}),
    ...(node.children?.length ? { children: node.children.map((child) => compactNode(child, includeProps)) } : {}),
  };
}

function compactNodeIds(node: AppNode): string[] {
  return [node.id, ...(node.children?.flatMap(compactNodeIds) ?? [])];
}

export function allowedOperationTypes(role: AiPlanRequest["role"]): string[] {
  const capabilities = studioCapabilities[role];
  return (["addNode", "updateNodeProps", "removeNode", "moveNode", "updatePage"] as const)
    .filter((operation) => capabilities[operation]);
}

export function buildPlannerContext(input: AiPlanRequest) {
  const activePage = input.appSpec.pages.find((page) => page.id === input.pageId);
  if (!activePage) {
    throw new StudioValidationError("AI 上下文校验失败", [`当前页面不存在：${input.pageId}`]);
  }

  const componentTypes = Object.keys(componentPropsSchemas) as AppNodeType[];
  const context = {
    instruction: input.instruction,
    currentPageId: input.pageId,
    appSpec: {
      id: input.appSpec.id,
      siteId: input.appSpec.siteId,
      schemaVersion: input.appSpec.schemaVersion,
      navigation: input.appSpec.navigation,
      pages: input.appSpec.pages.map((page) => ({
        id: page.id,
        title: page.title,
        route: page.route,
        root: compactNode(page.root, page.id === input.pageId),
      })),
    },
    componentCatalog: componentTypes.map((type) => ({
      type,
      propsSchema: z.toJSONSchema(componentPropsSchemas[type]),
    })),
    dataSources: input.appSpec.dataSources.map((source) => ({
      id: source.id,
      name: source.name,
      fields: source.fields.map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        aggregatable: field.aggregatable,
        supportedAggregations: field.supportedAggregations,
      })),
    })),
    role: input.role,
    permissions: studioCapabilities[input.role],
    allowedOperationTypes: allowedOperationTypes(input.role),
    allowedTargets: input.appSpec.pages.map((page) => ({
      pageId: page.id,
      componentIds: compactNodeIds(page.root),
    })),
  };

  if (new TextEncoder().encode(JSON.stringify(context)).byteLength > MAX_DEEPSEEK_CONTEXT_BYTES) {
    throw new StudioValidationError("AI 上下文过大", ["精简后的 AppSpec 超过允许大小，请减少页面组件后重试"]);
  }
  return context;
}

export const DEEPSEEK_CHANGESET_SYSTEM_PROMPT = `你是 AI 数据产品工作室的结构化变更规划器。
只返回符合所给 JSON Schema 的 JSON，不得返回 Markdown、代码围栏、解释文字或 reasoning_content。
顶层只允许 message 和 operations。不要生成 ChangeSet ID、状态、时间、来源、操作 ID、标签或模型元数据；这些可信字段由服务端生成。
operations 只允许 addNode、updateNodeProps、removeNode、moveNode、updatePage 五种类型，并且只能使用 Schema 枚举中的页面、组件、数据源和字段。
更新“标题”时先识别目标组件的真实标题属性。例如指标卡标题使用 updateNodeProps.props.label。
不得执行或应用变更。message 使用简洁中文。`;
