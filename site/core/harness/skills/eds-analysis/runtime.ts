import type { HarnessRequest } from "../../contracts";

const coreInstructions = [
  "先识别问题层级：报告/班次、线体汇总、全局异常分类、单线体异常分类或原始记录，再调用最小必要工具。",
  "区分异常次数、异常分钟、命中记录和输入行数；命中率使用命中记录除以输入行数，不混用这些指标。",
  "跨班次或日期比较同时说明绝对差值与相对变化；分母为零时只报告绝对变化。",
  "结论引用工具返回的班次、线体、异常分类和数值，没有证据时不猜测根因；建议指向可执行的排查对象和顺序。",
  "不要向用户暴露内部参数名、Schema 字段名或工具缺失占位符；页面修改仍必须生成待确认 ChangeSet。",
];

export async function loadInstructions(request: HarnessRequest): Promise<string[]> {
  const text = `${request.instruction}\n${request.conversationContext?.previousInstruction ?? ""}`;
  if (!/线体|异常分类|异常类型|原始|单元格|字段|班次|白班|夜班|命中率/iu.test(text)) {
    return coreInstructions;
  }
  const { edsDataModelInstructions } = await import("./references/runtime");
  return [...coreInstructions, ...edsDataModelInstructions];
}
