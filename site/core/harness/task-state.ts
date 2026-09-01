import type { ChangeSet } from "@/core/models";
import type { StudioRole } from "@/core/permissions";
import {
  MAX_HARNESS_EVENTS,
  MAX_HARNESS_TASKS,
  harnessTaskSummarySchema,
  type HarnessEvent,
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
    ...(accepted ? {} : { pendingChangeSet: undefined }),
  });
}

export function recoverHarnessTasksAfterRefresh(
  tasks: HarnessTaskSummary[],
  clock: HarnessTaskClock,
): HarnessTaskSummary[] {
  const interrupted = new Set<HarnessState>(["planning", "executingTool", "observing"]);
  return tasks.map((task) => interrupted.has(task.state)
    ? appendHarnessEvent(task, {
      type: "error",
      state: "cancelled",
      message: "页面刷新后已安全终止未完成任务，不会自动继续执行。",
    }, clock, { error: "任务因页面刷新而终止。" })
    : task);
}

export function taskWithPendingChangeSet(task: HarnessTaskSummary, changeSet: ChangeSet): HarnessTaskSummary {
  return harnessTaskSummarySchema.parse({ ...task, pendingChangeSet: changeSet });
}
