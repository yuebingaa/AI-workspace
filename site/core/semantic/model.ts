import type { DataProduct } from "@/core/models/data-product";
import type { DataSourceDefinition } from "@/core/models/data-binding";
import type { DataRecipe } from "@/core/models/data-recipe";
import type { StudioRole } from "@/core/permissions/roles";
import { StudioValidationError } from "@/core/schemas/errors";
import { semanticLayerSchema, semanticModelSchema, semanticQuerySchema, type SemanticModel, type SemanticQuery } from "./contracts";

export function validateSemanticModel(model: SemanticModel, source: DataSourceDefinition | undefined): SemanticModel {
  const parsed = semanticModelSchema.parse(model);
  if (!source || source.id !== parsed.sourceDatasetId) throw new Error("模型的数据源不存在，请重新绑定可用表格。");
  for (const item of [...parsed.dimensions, ...parsed.measures]) {
    const field = source.fields.find((field) => field.name === item.field);
    if (!field) throw new Error(`模型成员“${item.label}”的字段 ${item.field} 已不存在，请编辑模型。`);
  }
  for (const item of parsed.measures) {
    const field = source.fields.find((field) => field.name === item.field)!;
    if (!field.supportedAggregations.includes(item.aggregation)
      || (["sum", "average"].includes(item.aggregation) && field.type !== "number")) {
      throw new Error(`字段“${field.label}”不支持指标“${item.label}”的 ${item.aggregation} 计算。`);
    }
  }
  return parsed;
}

export function semanticModelsForWorkspace(product: DataProduct, pageId: string): SemanticModel[] {
  const sources = new Set(product.datasets.filter((dataset) => dataset.shared || dataset.workspaceId === pageId).map((dataset) => dataset.id));
  return product.semanticLayer?.models.filter((model) => sources.has(model.sourceDatasetId)) ?? [];
}

export function selectedSemanticModel(product: DataProduct, pageId: string, dataSourceId?: string): SemanticModel | undefined {
  const id = product.semanticLayer?.selectedByWorkspace[pageId];
  return semanticModelsForWorkspace(product, pageId).find((model) => model.id === id
    && (dataSourceId === undefined || model.sourceDatasetId === dataSourceId));
}

function assertCanManage(role: StudioRole) {
  if (role === "viewer") throw new Error("查看者无权创建、编辑或删除语义模型。");
}

export function saveSemanticModel(product: DataProduct, model: SemanticModel, pageId: string, role: StudioRole): DataProduct {
  assertCanManage(role);
  const existing = product.semanticLayer?.models.find((item) => item.id === model.id);
  if (existing && !semanticModelsForWorkspace(product, pageId).some((item) => item.id === existing.id)) throw new Error("不能编辑其他工作界面的语义模型。");
  if (!product.datasets.some((dataset) => dataset.workspaceId === pageId && dataset.id === model.sourceDatasetId)) throw new Error("请选择当前工作界面的数据表。");
  if ((existing && model.version !== existing.version) || (!existing && model.version !== 1)) throw new Error("模型版本已更新，请重新打开编辑器。");
  const parsed = validateSemanticModel(model, product.appSpec.dataSources.find((source) => source.id === model.sourceDatasetId));
  if (semanticModelsForWorkspace(product, pageId).some((item) => item.id !== parsed.id && item.name.toLocaleLowerCase() === parsed.name.toLocaleLowerCase())) throw new Error("当前工作界面已存在同名语义模型。");
  const saved = { ...parsed, version: existing ? existing.version + 1 : 1 };
  const layer = semanticLayerSchema.parse({
    models: [...(product.semanticLayer?.models.filter((item) => item.id !== saved.id) ?? []), saved],
    selectedByWorkspace: { ...product.semanticLayer?.selectedByWorkspace, [pageId]: saved.id },
  });
  return { ...product, semanticLayer: layer };
}

export function selectSemanticModel(product: DataProduct, pageId: string, modelId: string | null): DataProduct {
  const selectedByWorkspace = { ...product.semanticLayer?.selectedByWorkspace };
  if (modelId) {
    const model = semanticModelsForWorkspace(product, pageId).find((item) => item.id === modelId);
    if (!model) throw new Error("当前工作界面没有这个语义模型。");
    validateSemanticModel(model, product.appSpec.dataSources.find((source) => source.id === model.sourceDatasetId));
    selectedByWorkspace[pageId] = modelId;
  } else delete selectedByWorkspace[pageId];
  return { ...product, semanticLayer: { models: product.semanticLayer?.models ?? [], selectedByWorkspace } };
}

export function deleteSemanticModel(product: DataProduct, modelId: string, role: StudioRole): DataProduct {
  assertCanManage(role);
  if (!product.semanticLayer?.models.some((item) => item.id === modelId)) throw new Error("语义模型不存在或已经删除。");
  return { ...product, semanticLayer: {
    models: product.semanticLayer.models.filter((item) => item.id !== modelId),
    selectedByWorkspace: Object.fromEntries(Object.entries(product.semanticLayer.selectedByWorkspace).filter(([, id]) => id !== modelId)),
  } };
}

// Compile only declared members; the model cannot supply SQL, expressions or a second aggregation.
export function compileSemanticQuery(model: SemanticModel, source: DataSourceDefinition, input: SemanticQuery): DataRecipe {
  validateSemanticModel(model, source);
  const query = semanticQuerySchema.parse(input);
  const dimensions = query.dimensions.map((key) => {
    const member = model.dimensions.find((item) => item.key === key);
    if (!member) throw new Error(`模型未定义维度：${key}`);
    return member;
  });
  const measures = query.measures.map((key) => {
    const member = model.measures.find((item) => item.key === key);
    if (!member) throw new Error(`模型未定义指标：${key}`);
    return member;
  });
  const usedFields = [...new Set([...dimensions, ...measures].map((item) => item.field))];
  const occupied = new Set([...source.fields.map((item) => item.name), ...dimensions.map((item) => item.key), ...measures.map((item) => item.key)]);
  let next = 0;
  const temporary = () => { let key: string; do { key = `semantic_internal_${next++}`; } while (occupied.has(key)); occupied.add(key); return key; };
  const fields = new Map(usedFields.map((field) => [field, temporary()]));
  const steps: DataRecipe["steps"] = [{ id: "select_source", type: "selectFields", fields: usedFields }];
  for (const [field, newName] of fields) steps.push({ id: `rename_${steps.length}`, type: "renameField", field, newName });
  const groupBy = dimensions.map((item) => fields.get(item.field)!);
  if (groupBy.length === 0) {
    const field = temporary();
    steps.push({ id: "total_group", type: "deriveField", field, label: "整体汇总", operator: "add", left: { kind: "literal", value: 0 }, right: { kind: "literal", value: 0 } });
    groupBy.push(field);
  }
  steps.push({ id: "aggregate", type: "groupAggregate", groupBy, aggregations: measures.map((item) => ({ field: fields.get(item.field)!, aggregation: item.aggregation, as: item.key, label: item.label })) });
  for (const item of dimensions) steps.push({ id: `label_${steps.length}`, type: "renameField", field: fields.get(item.field)!, newName: item.key, newLabel: item.label });
  steps.push({ id: "output", type: "selectFields", fields: [...dimensions, ...measures].map((item) => item.key) });
  steps.push({ id: "limit", type: "limit", count: query.limit });
  if (steps.length > 50) throw new StudioValidationError("语义查询过大", ["请减少同时查询的维度和指标"]);
  return { id: `recipe_semantic_${model.id}`.slice(0, 120), name: `${model.name} · 语义查询`.slice(0, 160), sourceDatasetId: source.id,
    outputDatasetId: `dataset_semantic_${model.id}`.slice(0, 120), status: "ready", steps };
}
