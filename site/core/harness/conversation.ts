import { z } from "zod";
import type { HarnessTaskSummary } from "./contracts";

export const MAX_ASSISTANT_CONVERSATION_TURNS = 20;

export const assistantConversationTurnSchema = z.object({
  id: z.string().min(1).max(180),
  instruction: z.string().trim().min(1).max(1_000),
  response: z.string().trim().min(1).max(2_000),
  createdAt: z.iso.datetime(),
  state: z.enum(["success", "blocked", "failed", "cancelled"]),
  taskId: z.string().min(1).max(160).optional(),
  pageId: z.string().min(1).max(120).optional(),
}).strict();

export type AssistantConversationTurn = z.infer<typeof assistantConversationTurnSchema>;

export function appendAssistantConversationTurn(
  turns: AssistantConversationTurn[],
  turn: AssistantConversationTurn,
): AssistantConversationTurn[] {
  return [...turns.filter((candidate) => candidate.id !== turn.id), turn]
    .slice(-MAX_ASSISTANT_CONVERSATION_TURNS);
}

function taskConversationState(task: HarnessTaskSummary): AssistantConversationTurn["state"] {
  if (task.state === "blocked") return "blocked";
  if (task.state === "failed") return "failed";
  if (task.state === "cancelled") return "cancelled";
  return "success";
}

export function assistantConversationFromHarnessTasks(
  tasks: HarnessTaskSummary[],
): AssistantConversationTurn[] {
  return tasks
    .filter((task) => Boolean(task.resultMessage || task.error || task.events.at(-1)?.message))
    .slice(0, MAX_ASSISTANT_CONVERSATION_TURNS)
    .reverse()
    .map((task) => ({
      id: `harness_conversation_${task.id}`,
      instruction: task.instruction,
      response: task.resultMessage ?? task.error ?? task.events.at(-1)?.message ?? "Harness 任务已结束。",
      createdAt: task.updatedAt,
      state: taskConversationState(task),
      taskId: task.id,
      pageId: task.pageId,
    }));
}

const lightweightConversationPattern = /^(?:嗯+|唔+|额+|呃+|哦+|噢+|啊+|好的?|好吧|行|知道了|明白了|收到|谢谢(?:你)?|多谢|你好|您好|嗨|在吗|hi|hello)[。！!？?…~～\s]*$/iu;

const capabilityModalPattern = /能否|是否|可否|可不可以|能不能|可以|能|会不会|会|支持/iu;
const uiMutationActionPattern = /增加|新增|添加|创建|生成|修改|改|编辑|调整|设置|设为|更换|换|移动|删除|移除|控制|操作/iu;
const uiMutationTargetPattern = /组件|图表|指标卡|页面|网页|看板|标题|表格|文字|字体|字号|字色|颜色|样式|布局/iu;
const questionEndingPattern = /(?:(?:吗|么|嘛|没有|了吗|了么)[？?。！!\s]*|[？?][。！!\s]*)$/u;
const capabilityOptionsPattern = /(?:什么|哪些|哪几种|哪一种|哪类|哪种).*(?:组件|图表|指标卡|页面|网页|看板|标题|表格|文字|字体|字号|字色|颜色|样式|布局)/iu;
const explicitMutationRequestPattern = /(?:帮我|请|替我|给我|把|将)/u;
const typographyMutationTargetPattern = /字体|字号|字色|文字颜色|文字样式|字重|粗细|加粗|粗体|半粗|斜体|下划线/iu;
const dataDependentStylePattern = /(?:根据|基于|按照|依照).*(?:数据|字段|数值|大小|高低|排名)|随.*(?:数据|数值).*(?:变化|改变)/iu;

export function isLightweightConversation(instruction: string): boolean {
  return lightweightConversationPattern.test(instruction.trim());
}

export function isUiMutationCapabilityQuestion(instruction: string): boolean {
  const normalized = instruction.trim();
  const asksForOptions = capabilityOptionsPattern.test(normalized);
  return !explicitMutationRequestPattern.test(normalized)
    && capabilityModalPattern.test(normalized)
    && (uiMutationActionPattern.test(normalized) || asksForOptions)
    && uiMutationTargetPattern.test(normalized)
    && (questionEndingPattern.test(normalized) || asksForOptions);
}

export function isDataIndependentUiStyleMutation(instruction: string): boolean {
  const normalized = instruction.trim();
  return !isUiMutationCapabilityQuestion(normalized)
    && uiMutationActionPattern.test(normalized)
    && typographyMutationTargetPattern.test(normalized)
    && !dataDependentStylePattern.test(normalized);
}

export function uiMutationCapabilityReply(hasEdsContext: boolean): string {
  return hasEdsContext
    ? "可以。目前支持系统默认、微软雅黑、Arial、宋体和等宽字体，字号可设为 8–72 px；也能调整颜色、粗细、斜体和下划线。EDS 看板还可以新增受支持的图表组件。请直接说明目标组件和期望样式，我会先生成待确认预览，不会直接修改正式页面。"
    : "可以。目前支持系统默认、微软雅黑、Arial、宋体和等宽字体，字号可设为 8–72 px；也能调整颜色、粗细、斜体和下划线，还能新增受支持的指标卡、图表等组件。请说明目标组件和期望样式；我会先生成待确认预览，不会直接修改正式页面。";
}

export function lightweightConversationReply(instruction: string, hasEdsContext: boolean): string {
  const normalized = instruction.trim();
  const guidance = hasEdsContext
    ? "当前 EDS 汇总已经就绪。你可以继续问“为什么夜班异常更多”“详细展开 A5FSL05”或“给出前三项改善建议”。"
    : "你可以直接告诉我想检查的数据、指标或页面。";

  if (/^(?:谢谢(?:你)?|多谢)/u.test(normalized)) return `不客气。${guidance}`;
  if (/^(?:你好|您好|嗨|在吗|hi|hello)/iu.test(normalized)) return `你好，我在。${guidance}`;
  return `我在。${guidance}`;
}
