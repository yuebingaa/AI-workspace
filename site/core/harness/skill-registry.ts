import type { HarnessRequest, HarnessSemanticIntentDecision } from "./contracts";

export interface HarnessSkillContext {
  id: string;
  name: string;
  version: string;
  description: string;
  instructions: string[];
}

export interface HarnessSkillRuntimeModule {
  loadInstructions(request: HarnessRequest): string[] | Promise<string[]>;
}

interface HarnessSkillDefinition extends Omit<HarnessSkillContext, "instructions"> {
  matches: (text: string, request: HarnessRequest) => number;
  load: () => Promise<HarnessSkillRuntimeModule>;
}

function termScore(text: string, terms: string[]): number {
  return terms.reduce((score, term) => score + (text.includes(term) ? (term.length >= 3 ? 3 : 2) : 0), 0);
}

const visualizationTerms = [
  "图表", "可视化", "柱状", "柱形", "条形", "分栏图", "折线", "曲线", "面积图", "饼图", "饼状图", "环形图", "圆环图", "趋势图", "占比图",
  "chart", "graph", "plot", "visualization", "bar", "line chart", "area chart", "pie", "donut",
];

const dataVisualizationSkill: HarnessSkillDefinition = {
  id: "data-visualization",
  name: "数据可视化",
  version: "1.0.0",
  description: "为数据分析任务选择、生成、修改并校验图表；适用于看板、趋势、分类比较、占比和图表样式请求。",
  load: () => import("./skills/data-visualization/runtime"),
  matches: (text) => termScore(text, visualizationTerms),
};

const edsAnalysisTerms = [
  "eds", "飞达", "线体", "班次", "白班", "夜班", "异常分类", "异常类型", "命中率", "异常次数", "异常分钟", "派生汇总",
];

const edsAnalysisSkill: HarnessSkillDefinition = {
  id: "eds-analysis",
  name: "EDS 异常分析",
  version: "1.0.0",
  description: "识别 EDS 报告、班次、线体、全局异常分类和单线体异常分类的数据层级，并基于真实汇总给出诊断。",
  load: () => import("./skills/eds-analysis/runtime"),
  matches: (text, request) => {
    const hasEdsContext = Boolean(request.edsWorkspace)
      || request.appSpec.dataSources.some((source) => source.id.startsWith("dataset_eds_"));
    if (!hasEdsContext) return 0;
    const score = termScore(text, edsAnalysisTerms);
    if (score > 0) return score;
    return /分析|检查|比较|诊断|总结|详细|为什么|哪些|哪个|统计|读取|查询|图|表|排序|修改|增加|生成/iu.test(text) ? 2 : 0;
  },
};

const dashboardTargetTerms = [
  "组件", "看板", "表格", "明细表", "数据表", "图表", "柱状", "分栏图", "折线", "面积图", "饼图", "饼状图", "环形图", "样式", "颜色", "字段", "排序", "布局",
];
const dashboardMutationPattern = /修改|改为|改成|更名|更新|新增|增加|添加|生成|创建|删除|移除|移动|排序|换成|显示|隐藏|紧凑|斑马纹|change|update|add|create|remove|sort/iu;

const dashboardEditingSkill: HarnessSkillDefinition = {
  id: "dashboard-editing",
  name: "看板组件编辑",
  version: "1.0.0",
  description: "把标题、样式、图表类型、表格字段、多级排序和组件增删要求转换为最小的待确认页面变更。",
  load: () => import("./skills/dashboard-editing/runtime"),
  matches: (text) => {
    const actionableText = text
      .replace(/不要修改页面|不修改页面|无需修改页面/giu, "")
      .replace(/不要创建\s*changeset/giu, "")
      .replace(/不要(?:修改|创建|新增|增加|添加|生成)[^，。；\n]*/giu, "");
    return dashboardMutationPattern.test(actionableText) ? termScore(actionableText, dashboardTargetTerms) : 0;
  },
};

const workbookTerms = [
  "原始工作簿", "原始数据", "原始行", "单元格", "工作表", "整份表格", "整表", "完整扫描", "跨表", "字段画像", "全部匹配行",
];

const workbookAnalysisSkill: HarnessSkillDefinition = {
  id: "workbook-analysis",
  name: "原始工作簿分析",
  version: "1.0.0",
  description: "完整扫描已授权工作簿，并用结构化筛选、聚合和来源行回答原始数据问题。",
  load: () => import("./skills/workbook-analysis/runtime"),
  matches: (text) => termScore(text, workbookTerms),
};

export const harnessSkillRegistry = [
  dataVisualizationSkill,
  edsAnalysisSkill,
  dashboardEditingSkill,
  workbookAnalysisSkill,
] as const;

function normalizedSkillSearchText(request: HarnessRequest): string {
  return [
    request.instruction,
    request.conversationContext?.previousInstruction,
    request.conversationContext?.previousAssistantMessage,
  ].filter(Boolean).join("\n").toLocaleLowerCase("zh-CN");
}

function selectedHarnessSkillDefinitions(request: HarnessRequest, semanticIntent?: HarnessSemanticIntentDecision) {
  const text = normalizedSkillSearchText(request);
  const semanticSkillIds = new Set<string>(semanticIntent?.skillIds ?? []);
  return harnessSkillRegistry
    .map((skill) => ({ skill, score: skill.matches(text, request) + (semanticSkillIds.has(skill.id) ? 100 : 0) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.skill.id.localeCompare(right.skill.id))
    .slice(0, 3)
    .map(({ skill }) => skill);
}

function validatedInstructions(skillId: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new Error(`Harness Skill ${skillId} 返回了无效的 instructions。`);
  }
  const instructions = value.map((instruction) => typeof instruction === "string" ? instruction.trim() : "");
  if (instructions.some((instruction) => instruction.length === 0 || instruction.length > 600)) {
    throw new Error(`Harness Skill ${skillId} 的 instruction 必须是 1–600 字符的文本。`);
  }
  if (instructions.join("\n").length > 6_000) {
    throw new Error(`Harness Skill ${skillId} 的正文超过 6000 字符限制。`);
  }
  return instructions;
}

export async function selectHarnessSkills(
  request: HarnessRequest,
  compacted = false,
  semanticIntent?: HarnessSemanticIntentDecision,
): Promise<HarnessSkillContext[]> {
  return Promise.all(selectedHarnessSkillDefinitions(request, semanticIntent).map(async (skill) => {
    const runtime = await skill.load();
    const instructions = validatedInstructions(skill.id, await runtime.loadInstructions(request));
    return {
      id: skill.id,
      name: skill.name,
      version: skill.version,
      description: skill.description,
      instructions: compacted ? instructions.slice(0, 4) : instructions,
    };
  }));
}

export function selectedHarnessSkillSummaries(request: HarnessRequest, semanticIntent?: HarnessSemanticIntentDecision) {
  return selectedHarnessSkillDefinitions(request, semanticIntent).map(({ id, name, version }) => ({ id, name, version }));
}
