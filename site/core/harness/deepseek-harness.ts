import { z } from "zod";
import { DEFAULT_DEEPSEEK_MODEL } from "@/core/ai/contracts";
import { DEEPSEEK_CHAT_COMPLETIONS_URL } from "@/core/ai/server/deepseek-planner";
import type { LocalDataRuntime } from "@/core/models";
import { StudioValidationError } from "@/core/schemas";
import {
  harnessModelTurnSchema,
  harnessRequestSchema,
  harnessToolNameSchema,
  type HarnessModel,
  type HarnessModelInput,
  type HarnessModelResult,
  type HarnessObservation,
  type HarnessRequest,
  type HarnessTaskSummary,
} from "./contracts";
import { sanitizeHarnessText } from "./security";
import {
  buildHarnessContextSelection,
  estimateHarnessModelInputChars,
  harnessSystemPrompt,
  resolveHarnessContextBudget,
  type HarnessContextBudget,
} from "./context-selector";
import { appendHarnessEvent, createHarnessTask, taskWithPendingChangeSet, type HarnessTaskClock } from "./task-state";
import { executeHarnessTool, harnessToolCatalog } from "./tool-registry";

export const DEFAULT_HARNESS_BOUNDS = {
  maxLoops: 8,
  maxModelCalls: 2,
  maxToolCalls: 6,
  totalTimeoutMs: 25_000,
  toolTimeoutMs: 4_000,
} as const;

export interface HarnessBounds {
  maxLoops: number;
  maxModelCalls: number;
  maxToolCalls: number;
  totalTimeoutMs: number;
  toolTimeoutMs: number;
}

export interface DeepSeekHarnessOptions {
  dataRuntime: LocalDataRuntime;
  modelClient?: HarnessModel;
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  bounds?: Partial<HarnessBounds>;
  clock?: HarnessTaskClock & { elapsed(): number };
  toolExecutor?: typeof executeHarnessTool;
  contextBudget?: Partial<HarnessContextBudget>;
}

const providerResponseSchema = z.object({
  model: z.string().min(1).optional(),
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable().optional() }).strip(),
  }).strip()).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
  }).strip().optional(),
}).strip();

export class HarnessRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "HarnessRequestError";
  }
}

export class HarnessIdempotencyConflictError extends Error {
  constructor() {
    super("幂等键已用于不同的 Harness 请求，请生成新的请求标识。");
    this.name = "HarnessIdempotencyConflictError";
  }
}

export class DeepSeekHarnessModel implements HarnessModel {
  constructor(private readonly options: { apiKey: string; model: string; fetchImpl?: typeof fetch }) {}

  async next(input: HarnessModelInput): Promise<HarnessModelResult> {
    const response = await (this.options.fetchImpl ?? fetch)(DEEPSEEK_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({
        model: this.options.model,
        response_format: { type: "json_object" },
        stream: false,
        temperature: 0.1,
        max_tokens: 2_000,
        messages: [
          {
            role: "system",
            content: harnessSystemPrompt(input.iteration),
          },
          {
            role: "user",
            content: JSON.stringify({ ...input.context, tools: input.tools }),
          },
        ],
      }),
      signal: input.signal,
    });
    if (!response.ok) throw new Error(response.status === 401 ? "DeepSeek 认证失败。" : response.status === 429 ? "DeepSeek 请求过于频繁。" : "DeepSeek 服务暂时不可用。");
    const raw = await response.json().catch(() => null) as unknown;
    const provider = providerResponseSchema.safeParse(raw);
    if (!provider.success) throw new Error("DeepSeek 返回了无法识别的响应。");
    const content = provider.data.choices[0].message.content;
    if (!content) throw new Error("DeepSeek 未返回 Harness 动作。");
    let candidate: unknown;
    try {
      candidate = JSON.parse(content) as unknown;
    } catch {
      throw new Error("DeepSeek Harness 动作不是有效 JSON。");
    }
    const turn = harnessModelTurnSchema.safeParse(candidate);
    if (!turn.success) throw new Error("DeepSeek Harness 动作未通过 Schema 校验。");
    return {
      turn: turn.data,
      model: provider.data.model ?? this.options.model,
      usage: {
        promptTokens: provider.data.usage?.prompt_tokens ?? 0,
        completionTokens: provider.data.usage?.completion_tokens ?? 0,
        totalTokens: provider.data.usage?.total_tokens ?? 0,
      },
    };
  }
}

function defaultClock(): HarnessTaskClock & { elapsed(): number } {
  const started = performance.now();
  let sequence = 0;
  return {
    now: () => new Date(),
    id: () => `harness_event_${Date.now()}_${++sequence}`,
    elapsed: () => performance.now() - started,
  };
}

function resolvedBounds(input?: Partial<HarnessBounds>): HarnessBounds {
  const bounds = { ...DEFAULT_HARNESS_BOUNDS, ...input };
  for (const [name, value] of Object.entries(bounds)) {
    if (!Number.isInteger(value) || value <= 0) throw new HarnessRequestError(`Harness 执行边界不合法：${name}`);
  }
  return bounds;
}

function abortError(signal: AbortSignal, timedOut: boolean): Error {
  return new Error(timedOut ? "Harness 总执行时间已超出限制。" : signal.reason instanceof Error ? signal.reason.message : "Harness 任务已取消。");
}

function addUsage(
  current: HarnessTaskSummary["usage"],
  next: HarnessModelResult["usage"],
): NonNullable<HarnessTaskSummary["usage"]> {
  return {
    promptTokens: (current?.promptTokens ?? 0) + next.promptTokens,
    completionTokens: (current?.completionTokens ?? 0) + next.completionTokens,
    totalTokens: (current?.totalTokens ?? 0) + next.totalTokens,
  };
}

async function withToolTimeout<T>(factory: (signal: AbortSignal) => Promise<T>, timeoutMs: number, outerSignal: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abortOuter = () => controller.abort(outerSignal.reason);
  outerSignal.addEventListener("abort", abortOuter, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await Promise.race([
      factory(controller.signal),
      new Promise<T>((_, reject) => controller.signal.addEventListener("abort", () => reject(abortError(controller.signal, timedOut)), { once: true })),
    ]);
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener("abort", abortOuter);
  }
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal, timedOut: () => boolean): Promise<T> {
  if (signal.aborted) throw abortError(signal, timedOut());
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        abortListener = () => reject(abortError(signal, timedOut()));
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

export class DeepSeekHarness {
  async run(rawRequest: unknown, options: DeepSeekHarnessOptions): Promise<HarnessTaskSummary> {
    const parsed = harnessRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new HarnessRequestError("Harness 请求格式不正确，请检查指令、页面和配方上下文。");
    const request = parsed.data;
    if (!request.appSpec.pages.some((page) => page.id === request.pageId)) throw new HarnessRequestError("Harness 当前页面不存在。");
    const bounds = resolvedBounds(options.bounds);
    const contextBudget = resolveHarnessContextBudget(options.contextBudget);
    const clock = options.clock ?? defaultClock();
    const apiKey = options.apiKey?.trim();
    const modelClient = options.modelClient ?? (apiKey
      ? new DeepSeekHarnessModel({ apiKey, model: options.model?.trim() || DEFAULT_DEEPSEEK_MODEL, fetchImpl: options.fetchImpl })
      : null);
    let task = createHarnessTask(request.idempotencyKey, request.instruction, request.pageId, request.role, clock);
    const controller = new AbortController();
    let totalTimedOut = false;
    const abortOuter = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abortOuter, { once: true });
    const totalTimer = setTimeout(() => { totalTimedOut = true; controller.abort(); }, bounds.totalTimeoutMs);
    const observations: HarnessObservation[] = [];

    try {
      if (!modelClient) throw new Error("AI 服务尚未配置。");
      while (task.counters.loopCount < bounds.maxLoops) {
        if (controller.signal.aborted) throw abortError(controller.signal, totalTimedOut);
        if (task.counters.modelCallCount >= bounds.maxModelCalls) throw new Error("Harness 已达到最大模型调用次数。");
        const iteration = task.counters.loopCount + 1;
        let selection = buildHarnessContextSelection(request, observations, iteration);
        let tools = harnessToolCatalog({ names: selection.toolNames, editableNodes: selection.editableNodes, instruction: request.instruction });
        let inputChars = estimateHarnessModelInputChars(selection.context, tools, iteration);
        if (inputChars > contextBudget.maxRequestInputChars) {
          selection = buildHarnessContextSelection(request, observations, iteration, true);
          tools = harnessToolCatalog({ names: selection.toolNames, editableNodes: selection.editableNodes, instruction: request.instruction });
          inputChars = estimateHarnessModelInputChars(selection.context, tools, iteration);
        }
        const previousInputChars = task.contextUsage?.totalInputChars ?? 0;
        if (inputChars > contextBudget.maxRequestInputChars) {
          throw new Error("Harness 单次模型上下文压缩后仍超过预算，未调用模型。");
        }
        if (previousInputChars + inputChars > contextBudget.maxTotalInputChars) {
          throw new Error("Harness 任务累计模型上下文超过预算，未继续调用模型。");
        }
        task = {
          ...task,
          counters: { ...task.counters, loopCount: iteration, modelCallCount: task.counters.modelCallCount + 1 },
          contextUsage: {
            totalInputChars: previousInputChars + inputChars,
            requests: [...(task.contextUsage?.requests ?? []), { iteration, inputChars, compacted: selection.compacted }],
          },
        };
        const modelResult = await withAbort(modelClient.next({
          tools,
          context: selection.context,
          estimatedInputChars: inputChars,
          iteration,
          signal: controller.signal,
        }), controller.signal, () => totalTimedOut);
        task = { ...task, model: modelResult.model, usage: addUsage(task.usage, modelResult.usage) };
        const { turn } = modelResult;
        if (turn.action.type === "complete") {
          task = appendHarnessEvent(task, {
            type: "state",
            state: "completed",
            message: sanitizeHarnessText(turn.message),
          }, clock, { resultMessage: sanitizeHarnessText(turn.message), totalDurationMs: Math.round(clock.elapsed()) });
          return task;
        }
        const toolAction = turn.action;
        if (task.counters.toolCallCount >= bounds.maxToolCalls) throw new Error("Harness 已达到最大工具调用次数。");
        const parsedToolName = harnessToolNameSchema.safeParse(toolAction.name);
        if (!parsedToolName.success) throw new StudioValidationError("Harness 工具校验失败", [`不允许调用工具：${sanitizeHarnessText(toolAction.name, "未知工具")}`]);
        const toolName = parsedToolName.data;
        if (!selection.toolNames.includes(toolName)) {
          throw new StudioValidationError("Harness 工具状态校验失败", [`当前规划状态不允许调用工具：${toolName}`]);
        }
        task = appendHarnessEvent(task, {
          type: "toolCall",
          state: "executingTool",
          message: `${sanitizeHarnessText(turn.message)}（执行工具：${toolName}）`,
          toolCall: { id: toolAction.toolCallId, name: toolName, status: "running", durationMs: 0 },
        }, clock, { counters: { ...task.counters, toolCallCount: task.counters.toolCallCount + 1 } });
        const toolStarted = clock.elapsed();
        let result: Awaited<ReturnType<typeof executeHarnessTool>>;
        try {
          result = await withToolTimeout(
            () => (options.toolExecutor ?? executeHarnessTool)(toolAction.name, toolAction.arguments, {
              request,
              dataRuntime: options.dataRuntime,
              now: () => clock.now().getTime(),
              id: () => clock.id().replaceAll("harness_event_", "tool_"),
              resultBudgetChars: contextBudget.maxToolResultChars,
              resultBudgetEntries: contextBudget.maxToolResultEntries,
            }),
            bounds.toolTimeoutMs,
            controller.signal,
          );
        } catch (toolError) {
          task = appendHarnessEvent(task, {
            type: "toolCall",
            state: controller.signal.aborted && !totalTimedOut ? "cancelled" : "failed",
            message: sanitizeHarnessText(toolError),
            toolCall: {
              id: toolAction.toolCallId,
              name: toolName,
              status: "failure",
              durationMs: Math.max(0, Math.round(clock.elapsed() - toolStarted)),
            },
          }, clock);
          throw toolError;
        }
        const durationMs = Math.max(0, Math.round(clock.elapsed() - toolStarted));
        observations.push({ toolCallId: toolAction.toolCallId, toolName, summary: result.summary, data: result.data });
        task = appendHarnessEvent(task, {
          type: "observation",
          state: "observing",
          message: result.summary,
          toolCall: { id: toolAction.toolCallId, name: toolName, status: "success", durationMs },
        }, clock);
        if (result.pendingChangeSet) {
          task = taskWithPendingChangeSet(task, result.pendingChangeSet);
          task = appendHarnessEvent(task, {
            type: "confirmation",
            state: "awaitingConfirmation",
            message: "已生成待确认 ChangeSet，Harness 已暂停，等待用户预览和确认。",
          }, clock, { resultMessage: sanitizeHarnessText(turn.message), totalDurationMs: Math.round(clock.elapsed()) });
          return task;
        }
        task = appendHarnessEvent(task, {
          type: "state",
          state: "planning",
          message: "已接收工具观察结果，继续规划下一步。",
        }, clock);
      }
      throw new Error("Harness 已达到最大循环次数。");
    } catch (error) {
      const cancelled = controller.signal.aborted && !totalTimedOut;
      const message = sanitizeHarnessText(error, cancelled ? "Harness 任务已取消。" : "Harness 执行失败。");
      task = appendHarnessEvent(task, {
        type: cancelled ? "state" : "error",
        state: cancelled ? "cancelled" : "failed",
        message,
      }, clock, {
        error: message,
        resultMessage: cancelled ? "任务已取消，正式 AppSpec 未修改。" : "任务失败，正式 AppSpec 未修改。",
        totalDurationMs: Math.round(clock.elapsed()),
      });
      return task;
    } finally {
      clearTimeout(totalTimer);
      options.signal?.removeEventListener("abort", abortOuter);
    }
  }
}

interface IdempotencyEntry {
  fingerprint: string;
  task: Promise<HarnessTaskSummary>;
  createdAt: number;
}

export class HarnessIdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();

  constructor(private readonly maxEntries = 100, private readonly ttlMs = 10 * 60_000) {}

  execute(request: HarnessRequest, factory: () => Promise<HarnessTaskSummary>): Promise<HarnessTaskSummary> {
    const fingerprint = JSON.stringify({ ...request, idempotencyKey: undefined });
    const now = Date.now();
    for (const [key, entry] of this.entries) if (now - entry.createdAt > this.ttlMs) this.entries.delete(key);
    const existing = this.entries.get(request.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new HarnessIdempotencyConflictError();
      return existing.task;
    }
    const task = factory();
    this.entries.set(request.idempotencyKey, { fingerprint, task, createdAt: now });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    return task;
  }

  clear() {
    this.entries.clear();
  }
}
