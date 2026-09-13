import type { AppNode, AppSpec, DataBinding } from "@/core/models";
import { StudioValidationError } from "@/core/schemas/errors";
import type { SemanticModel } from "./contracts";

function nodes(node: AppNode): AppNode[] { return [node, ...(node.children?.flatMap(nodes) ?? [])]; }

export function assertSemanticBinding(model: SemanticModel, binding: DataBinding) {
  const fail = (message: string): never => { throw new StudioValidationError("语义模型口径校验失败", [message]); };
  if (binding.dataSourceId !== model.sourceDatasetId) fail("新数据绑定必须使用选中模型的来源表；如需其他数据，请先取消模型选择。");
  const dimensions = new Set(model.dimensions.map((item) => item.field));
  if (binding.groupBy && !dimensions.has(binding.groupBy)) fail(`模型未定义分组维度：${binding.groupBy}`);
  for (const member of [binding, ...(binding.columns ?? [])]) {
    if (member.aggregation === "none" && dimensions.has(member.field)) continue;
    if (!model.measures.some((item) => item.field === member.field && item.aggregation === member.aggregation)) {
      fail(`字段 ${member.field} 的 ${member.aggregation} 不符合模型指标定义，请使用已定义的计算方式。`);
    }
  }
  const declared = new Set([...dimensions, ...model.measures.map((item) => item.field)]);
  for (const item of [...binding.filters, ...binding.sort]) if (!declared.has(item.field)) fail(`模型未定义筛选或排序字段：${item.field}`);
}

// Check only new/changed bindings; style edits and existing charts stay untouched.
export function assertSemanticPreviewBindings(model: SemanticModel, before: AppSpec, after: AppSpec) {
  const original = new Map(before.pages.flatMap((page) => nodes(page.root)).map((node) => [node.id, node]));
  for (const node of after.pages.flatMap((page) => nodes(page.root))) {
    if (!("binding" in node.props)) continue;
    const previous = original.get(node.id);
    if (previous && "binding" in previous.props && JSON.stringify(previous.props.binding) === JSON.stringify(node.props.binding)) continue;
    assertSemanticBinding(model, node.props.binding);
  }
}
