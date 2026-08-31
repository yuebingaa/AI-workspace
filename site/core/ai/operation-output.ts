import { z } from "zod";
import type { AppNode, AppNodeType, ChangeOperation, ChangeSet } from "@/core/models";
import { studioCapabilities } from "@/core/permissions";
import { appNodeSchema, componentPropsSchemas, StudioValidationError } from "@/core/schemas";
import type { AiPlanRequest } from "./contracts";

const safeGeneratedToken = /^[A-Za-z0-9_-]{1,60}$/;

const modelOperationDraftSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("addNode"),
    pageId: z.string().min(1),
    parentId: z.string().min(1),
    node: appNodeSchema,
    position: z.number().int().min(0).optional(),
  }).strict(),
  z.object({
    type: z.literal("updateNodeProps"),
    pageId: z.string().min(1),
    nodeId: z.string().min(1),
    props: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    type: z.literal("removeNode"),
    pageId: z.string().min(1),
    nodeId: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal("moveNode"),
    pageId: z.string().min(1),
    nodeId: z.string().min(1),
    parentId: z.string().min(1),
    position: z.number().int().min(0),
  }).strict(),
  z.object({
    type: z.literal("updatePage"),
    pageId: z.string().min(1),
    title: z.string().optional(),
    route: z.string().startsWith("/").optional(),
  }).strict(),
]);

export const modelPlanDraftSchema = z.object({
  message: z.string().trim().min(1).max(2_000),
  operations: z.array(modelOperationDraftSchema).min(1).max(20),
}).strict();

export type ModelPlanDraft = z.infer<typeof modelPlanDraftSchema>;
export type ModelOperationDraft = ModelPlanDraft["operations"][number];

export type AiOutputTransport = "responses_json_schema" | "chat_function" | "chat_json_object";
export type AiValidationStage = "json_parse" | "draft_schema" | "compile" | "changeset_validation";

export interface SanitizedAiValidationIssue {
  stage: AiValidationStage;
  path: string;
  code: string;
  operationType?: ChangeOperation["type"];
}

type JsonSchema = Record<string, unknown>;

function nodes(node: AppNode): AppNode[] {
  return [node, ...(node.children?.flatMap(nodes) ?? [])];
}

function stringEnum(values: string[]): JsonSchema {
  return { type: "string", enum: [...new Set(values)] };
}

function strictObject(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function cloneSchema(schema: unknown): JsonSchema {
  return structuredClone(schema) as JsonSchema;
}

function restrictCatalogReferences(schema: JsonSchema, request: AiPlanRequest): JsonSchema {
  const sourceIds = request.appSpec.dataSources.map((source) => source.id);
  const fieldNames = request.appSpec.dataSources.flatMap((source) => source.fields.map((field) => field.name));

  function visit(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(object)) next[key] = visit(child);
    const properties = next.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      const props = properties as Record<string, unknown>;
      if ("id" in props) props.id = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,119}$" };
      if ("dataSourceId" in props) props.dataSourceId = stringEnum(sourceIds);
      for (const fieldKey of ["field", "groupBy"]) {
        if (!(fieldKey in props)) continue;
        props[fieldKey] = fieldKey === "groupBy"
          ? { anyOf: [stringEnum(fieldNames), { type: "null" }] }
          : stringEnum(fieldNames);
      }
    }
    return next;
  }

  return visit(schema) as JsonSchema;
}

function partialPropsSchema(type: AppNodeType, request: AiPlanRequest): JsonSchema {
  const schema = restrictCatalogReferences(cloneSchema(z.toJSONSchema(componentPropsSchemas[type])), request);
  delete schema.required;
  return schema;
}

function updatePropsVariants(request: AiPlanRequest): JsonSchema[] {
  return request.appSpec.pages.flatMap((page) => nodes(page.root).map((node) => strictObject({
    type: stringEnum(["updateNodeProps"]),
    pageId: stringEnum([page.id]),
    nodeId: stringEnum([node.id]),
    props: partialPropsSchema(node.type, request),
  }, ["type", "pageId", "nodeId", "props"])));
}

function pageScopedVariants(
  request: AiPlanRequest,
  type: "removeNode" | "moveNode",
): JsonSchema[] {
  return request.appSpec.pages.map((page) => {
    const pageNodes = nodes(page.root);
    const movableIds = pageNodes.filter((node) => node.id !== page.root.id).map((node) => node.id);
    const properties: Record<string, JsonSchema> = {
      type: stringEnum([type]),
      pageId: stringEnum([page.id]),
      nodeId: stringEnum(movableIds),
    };
    const required = ["type", "pageId", "nodeId"];
    if (type === "moveNode") {
      properties.parentId = stringEnum(pageNodes.map((node) => node.id));
      properties.position = { type: "integer", minimum: 0 };
      required.push("parentId", "position");
    }
    return strictObject(properties, required);
  });
}

function addNodeVariants(request: AiPlanRequest): JsonSchema[] {
  const nodeSchema = restrictCatalogReferences(cloneSchema(z.toJSONSchema(appNodeSchema)), request);
  return request.appSpec.pages.map((page) => strictObject({
    type: stringEnum(["addNode"]),
    pageId: stringEnum([page.id]),
    parentId: stringEnum(nodes(page.root).map((node) => node.id)),
    node: nodeSchema,
    position: { type: "integer", minimum: 0 },
  }, ["type", "pageId", "parentId", "node"]));
}

function updatePageVariants(request: AiPlanRequest): JsonSchema[] {
  return request.appSpec.pages.map((page) => strictObject({
    type: stringEnum(["updatePage"]),
    pageId: stringEnum([page.id]),
    title: { type: "string" },
    route: { type: "string", pattern: "^/" },
  }, ["type", "pageId"]));
}

export function buildModelPlanJsonSchema(request: AiPlanRequest): JsonSchema {
  const capabilities = studioCapabilities[request.role];
  const variants: JsonSchema[] = [];
  if (capabilities.addNode) variants.push(...addNodeVariants(request));
  if (capabilities.updateNodeProps) variants.push(...updatePropsVariants(request));
  if (capabilities.removeNode) variants.push(...pageScopedVariants(request, "removeNode"));
  if (capabilities.moveNode) variants.push(...pageScopedVariants(request, "moveNode"));
  if (capabilities.updatePage) variants.push(...updatePageVariants(request));

  return strictObject({
    message: { type: "string", minLength: 1, maxLength: 2_000 },
    operations: { type: "array", minItems: 1, maxItems: 20, items: { oneOf: variants } },
  }, ["message", "operations"]);
}

function operationLabel(operation: ModelOperationDraft): string {
  const labels: Record<ModelOperationDraft["type"], string> = {
    addNode: "添加组件",
    updateNodeProps: "修改组件属性",
    removeNode: "删除组件",
    moveNode: "调整组件顺序",
    updatePage: "修改页面",
  };
  return labels[operation.type];
}

function operationDescription(operation: ModelOperationDraft): string {
  if (operation.type === "updatePage") return `更新页面 ${operation.pageId}`;
  if (operation.type === "addNode") return `向 ${operation.parentId} 添加 ${operation.node.type}`;
  if (operation.type === "moveNode") return `移动 ${operation.nodeId} 到 ${operation.parentId}`;
  return `${operationLabel(operation)} ${operation.nodeId}`;
}

function compileOperation(operation: ModelOperationDraft, id: string): ChangeOperation {
  const common = {
    id,
    label: operationLabel(operation),
    description: operationDescription(operation),
    pageId: operation.pageId,
  };
  switch (operation.type) {
    case "addNode":
      return { ...common, type: operation.type, parentId: operation.parentId, node: operation.node, ...(operation.position === undefined ? {} : { position: operation.position }) };
    case "updateNodeProps":
      return { ...common, type: operation.type, nodeId: operation.nodeId, props: operation.props };
    case "removeNode":
      return { ...common, type: operation.type, nodeId: operation.nodeId };
    case "moveNode":
      return { ...common, type: operation.type, nodeId: operation.nodeId, parentId: operation.parentId, position: operation.position };
    case "updatePage":
      return { ...common, type: operation.type, ...(operation.title === undefined ? {} : { title: operation.title }), ...(operation.route === undefined ? {} : { route: operation.route }) };
  }
}

export interface CompileModelPlanOptions {
  now?: () => number;
  idFactory?: () => string;
}

export function compileModelPlanDraft(
  draft: ModelPlanDraft,
  instruction: string,
  options: CompileModelPlanOptions = {},
): ChangeSet {
  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? (() => crypto.randomUUID().replaceAll("-", ""));
  const token = idFactory();
  if (!safeGeneratedToken.test(token)) {
    throw new StudioValidationError("AI 变更编译失败", ["服务端生成的变更标识不合法"]);
  }
  const operations = draft.operations.map((operation, index) => (
    compileOperation(operation, `operation_ai_${index + 1}_${token}`)
  ));

  return {
    id: `changeset_ai_${now()}_${token}`,
    title: `AI 规划：${instruction.trim().slice(0, 60)}`,
    status: "ready",
    operations,
  };
}

export function sanitizedZodIssues(error: z.ZodError, raw: unknown): SanitizedAiValidationIssue[] {
  const rawOperations = raw && typeof raw === "object" && "operations" in raw && Array.isArray(raw.operations)
    ? raw.operations
    : [];
  return error.issues.slice(0, 12).map((issue) => {
    const operationIndex = typeof issue.path[1] === "number" ? issue.path[1] : undefined;
    const candidateType = operationIndex === undefined ? undefined : rawOperations[operationIndex]?.type;
    const operationType = operationTypeFromUnknown(candidateType);
    return {
      stage: "draft_schema" as const,
      path: issue.path.join(".") || "root",
      code: issue.code,
      ...(operationType ? { operationType } : {}),
    };
  });
}

function operationTypeFromUnknown(value: unknown): ChangeOperation["type"] | undefined {
  switch (value) {
    case "addNode":
    case "updateNodeProps":
    case "removeNode":
    case "moveNode":
    case "updatePage":
      return value;
    default:
      return undefined;
  }
}

export function sanitizedStudioIssues(
  error: StudioValidationError,
  operations: ModelOperationDraft[],
  operationOffset = 0,
): SanitizedAiValidationIssue[] {
  return error.issues.slice(0, 12).map((_, index) => ({
    stage: "changeset_validation",
    path: `operations.${operationOffset + Math.min(index, Math.max(operations.length - 1, 0))}`,
    code: "semantic_validation_failed",
    ...(operations[Math.min(index, Math.max(operations.length - 1, 0))]?.type
      ? { operationType: operations[Math.min(index, Math.max(operations.length - 1, 0))].type }
      : {}),
  }));
}
