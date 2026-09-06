import type { HarnessRequest } from "../../contracts";

const coreInstructions = [
  "先确定用户要回答的数据问题，再选择最简单且不会误导的图表。",
  "当前交互看板只支持 bar、line、area、pie、donut；禁止声称已经生成未受工具 Schema 支持的类型。",
  "EDS 请求优先使用专用 EDS 制图工具，由服务端生成日期、班次、视图、线体与排序绑定；不要手写不存在的字段。",
  "页面修改只能生成待确认 ChangeSet；使用已有工具返回的真实数据，不编造字段、数值、筛选条件或组件能力。",
  "检查标题、单位、排序、颜色语义、标签可读性和窄屏表现；长分类标签应在卡片内部滚动。",
];

export async function loadInstructions(request: HarnessRequest): Promise<string[]> {
  const text = `${request.instruction}\n${request.conversationContext?.previousInstruction ?? ""}`;
  if (!/柱状|柱形|条形|折线|曲线|面积|饼图|饼状|环形|圆环|趋势|占比|chart|graph|plot|bar|line|area|pie|donut/iu.test(text)) {
    return coreInstructions;
  }
  const { chartSelectionInstructions } = await import("./references/runtime");
  return [...coreInstructions, ...chartSelectionInstructions];
}
