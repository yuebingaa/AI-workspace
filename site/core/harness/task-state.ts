import type { ChangeSet } from "@/core/models";
import type { StudioRole } from "@/core/permissions";
import {
  MAX_HARNESS_EVENTS,
  MAX_HARNESS_TASKS,
  harnessTaskSummarySchema,
  type HarnessEvent,
  type HarnessExecutionTiming,
  type HarnessState,
  type HarnessTaskSummary,
} from "./contracts";

export interface HarnessTaskClock {
  now(): Date;
  id(): string;
}

export function createHarnessTask(
  idempotencyKey: string,
  instruction: string,
  pageId: string,
  role: StudioRole,
  clock: HarnessTaskClock,
  options: {
    executionTiming?: HarnessExecutionTiming;
    retryOfTaskId?: string;
    contextUsage?: HarnessTaskSummary["contextUsage"];
  } = {},
): HarnessTaskSummary {
  const timestamp = clock.now().toISOString();
  return harnessTaskSummarySchema.parse({
    id: `harness_${idempotencyKey}`,
    idempotencyKey,
    instruction,
    pageId,
    role,
    state: "planning",
    createdAt: timestamp,
    updatedAt: timestamp,
    counters: { loopCount: 0, modelCallCount: 0, toolCallCount: 0 },
    events: [{ id: clock.id(), type: "state", state: "planning", timestamp, message: "Harness 开始规划任务。" }],
    ...(options.executionTiming ? { executionTiming: options.executionTiming } : {}),
    ...(options.retryOfTaskId ? { retryOfTaskId: options.retryOfTaskId } : {}),
    ...(options.contextUsage ? { contextUsage: options.contextUsage } : {}),
  });
}

export function appendHarnessEvent(
  task: HarnessTaskSummary,
  event: Omit<HarnessEvent, "id" | "timestamp">,
  clock: HarnessTaskClock,
  patch: Partial<Omit<HarnessTaskSummary, "id" | "events" | "createdAt">> = {},
): HarnessTaskSummary {
  const timestamp = clock.now().toISOString();
  return harnessTaskSummarySchema.parse({
    ...task,
    ...patch,
    state: event.state,
    updatedAt: timestamp,
    events: [...task.events, { ...event, id: clock.id(), timestamp }].slice(-MAX_HARNESS_EVENTS),
  });
}

export function appendHarnessTask(tasks: HarnessTaskSummary[], task: HarnessTaskSummary): HarnessTaskSummary[] {
  return [task, ...tasks.filter((candidate) => candidate.id !== task.id)].slice(0, MAX_HARNESS_TASKS);
}

function executionTimingWithPhase(task: HarnessTaskSummary, phase: HarnessExecutionTiming["phase"]) {
  return task.executionTiming ? { ...task.executionTiming, phase } : undefined;
}

export function settleHarnessConfirmation(
  task: HarnessTaskSummary,
  accepted: boolean,
  clock: HarnessTaskClock,
): HarnessTaskSummary {
  if (task.state !== "awaitingConfirmation") return task;
  return appendHarnessEvent(task, {
    type: "confirmation",
    state: accepted ? "completed" : "cancelled",
    message: accepted ? "用户确认并应用了待确认 ChangeSet。" : "用户拒绝了待确认 ChangeSet，正式 AppSpec 未修改。",
  }, clock, {
    resultMessage: accepted ? "待确认变更已由用户正式应用。" : "用户已拒绝本次变更。",
    terminationCode: accepted ? "completed" : "cancelled",
    ...(task.executionTiming ? { executionTiming: executionTimingWithPhase(task, accepted ? "completed" : "cancelled") } : {}),
    ...(accepted ? {} : { pendingChangeSet: undefined }),
  });
}

export function recoverHarnessTasksAfterRefresh(
  tasks: HarnessTaskSummary[],
  clock: HarnessTaskClock,
): HarnessTaskSummary[] {
  const interrupted = new Set<HarnessState>(["planning", "executingTool", "observing"]);
  return tasks.map((task) => {
    if (task.state === "completed" && task.counters.toolCallCount === 0 && /数据|销售|订单|字段|异常|复购/.test(task.instruction)) {
      return appendHarnessEvent(task, {
        type: "state",
        state: "blocked",
        message: "历史数据任务未执行任何工具却被标记为完成，已安全改为阻塞；请重新运行任务。",
      }, clock, {
        error: "历史任务缺少必要的数据工具执行记录。",
        resultMessage: "任务已阻塞，正式 AppSpec 未修改。",
        terminationCode: "missingContext",
        ...(task.executionTiming ? { executionTiming: executionTimingWithPhase(task, "blocked") } : {}),
      });
    }
    return interrupted.has(task.state) ? appendHarnessEvent(task, {
      type: "error",
      state: "cancelled",
      message: "页面刷新后已安全终止未完成任务，不会自动继续执行。",
    }, clock, {
      error: "任务因页面刷新而终止。",
      terminationCode: "cancelled",
      ...(task.executionTiming ? { executionTiming: executionTimingWithPhase(task, "cancelled") } : {}),
    })
      : task;
  });
}

export function taskWithPendingChangeSet(task: HarnessTaskSummary, changeSet: ChangeSet): HarnessTaskSummary {
  return harnessTaskSummarySchema.parse({ ...task, pendingChangeSet: changeSet });
}
