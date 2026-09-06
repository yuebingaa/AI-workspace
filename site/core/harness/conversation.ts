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
    }));
}

const lightweightConversationPattern = /^(?:嗯+|唔+|额+|呃+|哦+|噢+|啊+|好的?|好吧|行|知道了|明白了|收到|谢谢(?:你)?|多谢|你好|您好|嗨|在吗|hi|hello)[。！!？?…~～\s]*$/iu;

const capabilityModalPattern = /能否|是否|可否|可不可以|能不能|可以|能|会不会|会|支持/iu;
const uiMutationActionPattern = /增加|新增|添加|创建|生成|修改|编辑|调整|移动|删除|移除|控制|操作/iu;
const uiMutationTargetPattern = /组件|图表|指标卡|页面|网页|看板|标题|表格/iu;
const questionEndingPattern = /(?:(?:吗|么|嘛|没有|了吗|了么)[？?。！!\s]*|[？?][。！!\s]*)$/u;
const explicitMutationRequestPattern = /(?:帮我|请|替我|给我|把|将)/u;

export function isLightweightConversation(instruction: string): boolean {
  return lightweightConversationPattern.test(instruction.trim());
}

export function isUiMutationCapabilityQuestion(instruction: string): boolean {
  const normalized = instruction.trim();
  return !explicitMutationRequestPattern.test(normalized)
    && capabilityModalPattern.test(normalized)
    && uiMutationActionPattern.test(normalized)
    && uiMutationTargetPattern.test(normalized)
    && questionEndingPattern.test(normalized);
}

export function uiMutationCapabilityReply(hasEdsContext: boolean): string {
  return hasEdsContext
    ? "可以。目前能在 EDS 看板新增受支持的图表组件，例如指定线体的异常类型柱状图；也能调整现有组件的标题等属性。请直接说“增加 B5FSL01 异常类型柱状图”，我会先生成待确认预览，不会直接修改正式页面。"
    : "可以。目前能新增受支持的指标卡、柱状图等组件，也能修改现有组件的标题等属性。请说明页面、组件类型和数据指标；我会先生成待确认预览，不会直接修改正式页面。";
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
