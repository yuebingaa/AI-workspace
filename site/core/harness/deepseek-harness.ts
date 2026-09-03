import { z } from "zod";
import { DEFAULT_DEEPSEEK_MODEL } from "@/core/ai/contracts";
import { DEEPSEEK_CHAT_COMPLETIONS_URL } from "@/core/ai/server/deepseek-planner";
import type { LocalDataRuntime } from "@/core/models";
import { StudioValidationError } from "@/core/schemas";
import {
  DEFAULT_HARNESS_LIMITS,
  harnessRequestSchema,
  harnessToolNameSchema,
  type HarnessExecutionPhase,
  type HarnessExecutionTiming,
  type HarnessModel,
  type HarnessModelInput,
  type HarnessModelResult,
  type HarnessObservation,
  type HarnessRequest,
  type HarnessTaskSummary,
  type HarnessTerminationCode,
} from "./contracts";
import { normalizeHarnessModelTurn } from "./action-normalizer";
import { sanitizeHarnessText } from "./security";
import {
  buildHarnessContextSelection,
  classifyHarnessTask,
  estimateHarnessModelInputChars,
  harnessSystemPrompt,
  resolveHarnessPageDataSourceIds,
  resolveHarnessContextBudget,
  type HarnessContextBudget,
} from "./context-selector";
import { appendHarnessEvent, createHarnessTask, taskWithPendingChangeSet, type HarnessTaskClock } from "./task-state";
import { executeHarnessTool, harnessToolCatalog, type HarnessExcelExporter } from "./tool-registry";

export const DEFAULT_HARNESS_BOUNDS = DEFAULT_HARNESS_LIMITS;

export interface HarnessBounds {
  maxLoops: number;
  maxModelCalls: number;
  maxToolCalls: number;
  modelRequestTimeoutMs: number;
  toolCallTimeoutMs: number;
  totalExecutionTimeoutMs: number;
}

export interface DeepSeekHarnessOptions {
  dataRuntime: LocalDataRuntime;
  modelClient?: HarnessModel;
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  bounds?: Partial<HarnessBounds>;
  clock?: HarnessTaskClock;
  monotonicNow?: () => number;
  toolExecutor?: typeof executeHarnessTool;
  excelExporter?: HarnessExcelExporter;
  contextBudget?: Partial<HarnessContextBudget>;
  modelMaxCompletionTokens?: number;
  requireProviderUsage?: boolean;
  providerPromptTokenLimit?: number;
}

const providerResponseSchema = z.object({
  model: z.string().min(1).max(160).optional(),
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

export class DeepSeekProviderProtocolError extends Error {
  readonly code = "provider_model_mismatch" as const;

  constructor() {
    super("DeepSeek 返回的模型标识与本次服务端配置不一致。");
    this.name = "DeepSeekProviderProtocolError";
  }
}

export class DeepSeekHarnessModel implements HarnessModel {
  constructor(private readonly options: {
    apiKey: string;
    model: string;
    fetchImpl?: typeof fetch;
    maxCompletionTokens?: number;
    requireProviderUsage?: boolean;
    promptTokenLimit?: number;
  }) {}

  async next(input: HarnessModelInput): Promise<HarnessModelResult> {
    const maxCompletionTokens = this.options.maxCompletionTokens ?? 2_000;
    if (!Number.isInteger(maxCompletionTokens) || maxCompletionTokens <= 0) {
      throw new Error("DeepSeek 输出 token 上限配置无效。");
    }
    const response = await (this.options.fetchImpl ?? fetch)(DEEPSEEK_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({
        model: this.options.model,
        response_format: { type: "json_object" },
        stream: false,
        temperature: 0.1,
        max_tokens: maxCompletionTokens,
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
    if (
      this.options.requireProviderUsage
      && provider.data.model !== undefined
      && provider.data.model !== this.options.model
    ) {
      throw new DeepSeekProviderProtocolError();
    }
    const content = provider.data.choices[0].message.content;
    if (!content) throw new Error("DeepSeek 未返回 Harness 动作。");
    let candidate: unknown;
    try {
      candidate = JSON.parse(content) as unknown;
    } catch {
      throw new Error("DeepSeek Harness 动作不是有效 JSON。");
    }
    const readonlyTask = input.context.taskMode === "readOnly";
    const readonlyResultComplete = readonlyTask
      && input.context.phase === "followUp"
      && input.tools.length === 0
      && (input.context.latestObservation !== undefined || input.context.lastObservation !== undefined);
    const turn = normalizeHarnessModelTurn(candidate, { readonlyTask, readonlyResultComplete });
    const rawUsage = provider.data.usage;
    if (this.options.requireProviderUsage) {
      const promptTokens = rawUsage?.prompt_tokens;
      const completionTokens = rawUsage?.completion_tokens;
      const totalTokens = rawUsage?.total_tokens;
      const promptLimit = this.options.promptTokenLimit;
      const invalidUsage = promptTokens === undefined
        || completionTokens === undefined
        || totalTokens === undefined
        || totalTokens !== promptTokens + completionTokens
        || completionTokens > maxCompletionTokens
        || (promptLimit !== undefined && promptTokens > promptLimit);
      if (invalidUsage) throw new Error("DeepSeek 未返回可信的 token 用量，Live 评测已安全停止。");
    }
    return {
      turn: turn.turn,
      model: this.options.model,
      usage: {
        promptTokens: rawUsage?.prompt_tokens ?? 0,
        completionTokens: rawUsage?.completion_tokens ?? 0,
        totalTokens: rawUsage?.total_tokens ?? 0,
      },
    };
  }
}

function defaultClock(): HarnessTaskClock {
  let sequence = 0;
  return {
    now: () => new Date(),
    id: () => `harness_event_${Date.now()}_${++sequence}`,
  };
}

function resolvedBounds(input?: Partial<HarnessBounds>): HarnessBounds {
  const bounds = { ...DEFAULT_HARNESS_BOUNDS, ...input };
  for (const [name, value] of Object.entries(bounds)) {
    if (!Number.isInteger(value) || value <= 0) throw new HarnessRequestError(`Harness 执行边界不合法：${name}`);
  }
  return bounds;
}

function estimatedPromptTokens(inputChars: number): number {
  return Math.ceil(inputChars / 4);
}

function abortError(signal: AbortSignal): Error {
  return new Error(signal.reason instanceof Error ? signal.reason.message : "Harness 任务已取消。");
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

function requiredDataFieldsBlockingReason(request: HarnessRequest): string | undefined {
  const sourceIds = resolveHarnessPageDataSourceIds(request);
  const fields = new Set(request.appSpec.dataSources
    .filter((source) => sourceIds.includes(source.id))
    .flatMap((source) => source.fields.map((field) => field.name)));
  const missingCapabilities: string[] = [];
  if (/异常订单/.test(request.instruction) && !fields.has("anomaly_count") && !fields.has("refunded")) {
    missingCapabilities.push("异常识别字段 anomaly_count 或 refunded");
  }
  if (/复购/.test(request.instruction) && !fields.has("repurchase_rate")) {
    const missingRawFields = ["customer_id", "order_id"].filter((field) => !fields.has(field));
    if (missingRawFields.length > 0) {
      missingCapabilities.push(`复购率字段 repurchase_rate，或原始计算字段 ${missingRawFields.join("、")}`);
    }
  }
  return missingCapabilities.length > 0
    ? `数据字段不足，缺少：${missingCapabilities.join("；")}。正式 AppSpec 未修改。`
    : undefined;
}

async function withPhaseTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outerSignal: AbortSignal,
  timeoutMessage: string,
  outerAbortError: () => Error,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abortOuter = () => controller.abort(outerSignal.reason);
  outerSignal.addEventListener("abort", abortOuter, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await Promise.race([
      factory(controller.signal),
      new Promise<T>((_, reject) => controller.signal.addEventListener("abort", () => reject(
        timedOut ? new Error(timeoutMessage) : outerAbortError(),
      ), { once: true })),
    ]);
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener("abort", abortOuter);
  }
}

export class DeepSeekHarness {
  async run(rawRequest: unknown, options: DeepSeekHarnessOptions): Promise<HarnessTaskSummary> {
    const parsed = harnessRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new HarnessRequestError("Harness 请求格式不正确，请检查指令、页面和配方上下文。");
    const request = parsed.data;
    if (!request.appSpec.pages.some((page) => page.id === request.pageId)) throw new HarnessRequestError("Harness 当前页面不存在。");
    const taskProfile = classifyHarnessTask(request);
    const configuredBounds = resolvedBounds(options.bounds);
    const bounds = {
      ...configuredBounds,
      maxModelCalls: Math.min(configuredBounds.maxModelCalls, taskProfile.maxModelCalls),
      maxToolCalls: Math.min(configuredBounds.maxToolCalls, taskProfile.maxToolCalls),
    };
    const contextBudget = resolveHarnessContextBudget(options.contextBudget, taskProfile.complexity);
    const clock = options.clock ?? defaultClock();
    const monotonicNow = options.monotonicNow ?? (() => performance.now());
    let modelDurationMs = 0;
    let toolDurationMs = 0;
    const observations: HarnessObservation[] = [];
    const elapsedMs = () => Math.max(0, Math.round(modelDurationMs + toolDurationMs));
    const remainingMs = () => Math.max(0, bounds.totalExecutionTimeoutMs - elapsedMs());
    const executionTiming = (phase: HarnessExecutionPhase): HarnessExecutionTiming => {
      const activeElapsedMs = elapsedMs();
      return {
        phase,
        activeElapsedMs,
        remainingMs: Math.max(0, bounds.totalExecutionTimeoutMs - activeElapsedMs),
        totalBudgetMs: bounds.totalExecutionTimeoutMs,
        modelRequestTimeoutMs: bounds.modelRequestTimeoutMs,
        toolCallTimeoutMs: bounds.toolCallTimeoutMs,
        modelDurationMs: Math.max(0, Math.round(modelDurationMs)),
        toolDurationMs: Math.max(0, Math.round(toolDurationMs)),
        otherDurationMs: 0,
        retainedObservationCount: observations.length,
      };
    };
    const eventTiming = (phase: HarnessExecutionPhase, durationMs = 0) => ({
      phase,
      durationMs: Math.max(0, Math.round(durationMs)),
      elapsedMs: elapsedMs(),
      remainingMs: remainingMs(),
    });
    const phaseBudget = (phaseLabel: string, phaseLimitMs: number) => {
      const remaining = remainingMs();
      if (remaining <= 0) throw new Error(`Harness 总执行时间预算已用尽，未启动下一次${phaseLabel}。`);
      return Math.min(phaseLimitMs, remaining);
    };
    const apiKey = options.apiKey?.trim();
    const modelClient = options.modelClient ?? (apiKey
      ? new DeepSeekHarnessModel({
          apiKey,
          model: options.model?.trim() || DEFAULT_DEEPSEEK_MODEL,
          fetchImpl: options.fetchImpl,
          maxCompletionTokens: options.modelMaxCompletionTokens,
          requireProviderUsage: options.requireProviderUsage,
          promptTokenLimit: options.providerPromptTokenLimit,
        })
      : null);
    let task = createHarnessTask(request.idempotencyKey, request.instruction, request.pageId, request.role, clock, {
      executionTiming: executionTiming("planning"),
      contextUsage: {
        totalInputChars: 0,
        totalPromptTokens: 0,
        complexity: taskProfile.complexity,
        limits: contextBudget,
        requests: [],
      },
      ...(request.retryOfTaskId ? { retryOfTaskId: request.retryOfTaskId } : {}),
    });
    let failureTerminationCode: HarnessTerminationCode = "executionFailed";
    const controller = new AbortController();
    const abortOuter = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abortOuter, { once: true });

    try {
      if (!modelClient) throw new Error("AI 服务尚未配置。");
      while (task.counters.loopCount < bounds.maxLoops) {
        if (controller.signal.aborted) throw abortError(controller.signal);
        if (task.counters.modelCallCount >= bounds.maxModelCalls) throw new Error("Harness 已达到最大模型调用次数。");
        const iteration = task.counters.loopCount + 1;
        let selection = buildHarnessContextSelection(request, observations, iteration);
        if (selection.blockingReason) {
          task = appendHarnessEvent(task, {
            type: "state",
            state: "blocked",
            message: selection.blockingReason,
          }, clock, {
            error: selection.blockingReason,
            resultMessage: selection.blockingReason,
            terminationCode: "missingContext",
            totalDurationMs: elapsedMs(),
            executionTiming: executionTiming("blocked"),
          });
          return task;
        }
        let tools = harnessToolCatalog({ names: selection.toolNames, editableNodes: selection.editableNodes, instruction: request.instruction, request });
        let inputChars = estimateHarnessModelInputChars(selection.context, tools, iteration);
        const previousInputChars = task.contextUsage?.totalInputChars ?? 0;
        const previousPromptTokens = task.contextUsage?.totalPromptTokens ?? task.usage?.promptTokens ?? 0;
        const needsCompaction = () => inputChars > contextBudget.maxRequestInputChars
          || previousInputChars + inputChars > contextBudget.maxTotalInputChars
          || previousPromptTokens + estimatedPromptTokens(inputChars) > contextBudget.maxTotalPromptTokens;
        if (needsCompaction()) {
          selection = buildHarnessContextSelection(request, observations, iteration, true);
          tools = harnessToolCatalog({ names: selection.toolNames, editableNodes: selection.editableNodes, instruction: request.instruction, request });
          inputChars = estimateHarnessModelInputChars(selection.context, tools, iteration);
        }
        const failContextBudget = (limitReached: "singleRequestChars" | "taskInputChars" | "taskPromptTokens", message: string): never => {
          task = appendHarnessEvent(task, {
            type: "error",
            state: "failed",
            message,
          }, clock, {
            error: message,
            resultMessage: `${message} 正式 AppSpec 未修改。`,
            contextUsage: {
              ...(task.contextUsage ?? {
                totalInputChars: previousInputChars,
                totalPromptTokens: previousPromptTokens,
                complexity: taskProfile.complexity,
                requests: [],
              }),
              limits: contextBudget,
              limitReached,
            },
            terminationCode: "contextBudgetExceeded",
            executionTiming: executionTiming("failed"),
          });
          throw new Error(message);
        };
        if (inputChars > contextBudget.maxRequestInputChars) {
          failContextBudget("singleRequestChars", `Harness 单次模型输入超过 ${contextBudget.maxRequestInputChars} 字符限制，压缩后仍无法安全调用模型。`);
        }
        if (previousInputChars + inputChars > contextBudget.maxTotalInputChars) {
          failContextBudget("taskInputChars", `Harness 任务累计模型输入超过 ${contextBudget.maxTotalInputChars} 字符限制，未继续调用模型。`);
        }
        const estimatedTokens = estimatedPromptTokens(inputChars);
        if (previousPromptTokens + estimatedTokens > contextBudget.maxTotalPromptTokens) {
          failContextBudget("taskPromptTokens", `Harness 任务预计输入 token 将超过 ${contextBudget.maxTotalPromptTokens} 限制，未继续调用模型。`);
        }
        const modelBudgetMs = phaseBudget("模型请求", bounds.modelRequestTimeoutMs);
        task = appendHarnessEvent(task, {
          type: "state",
          state: "planning",
          message: `开始第 ${iteration} 次模型请求，剩余执行预算 ${remainingMs()} ms。`,
          timing: eventTiming("modelRequest"),
        }, clock, {
          counters: { ...task.counters, loopCount: iteration, modelCallCount: task.counters.modelCallCount + 1 },
          contextUsage: {
            totalInputChars: previousInputChars + inputChars,
            totalPromptTokens: previousPromptTokens,
            complexity: taskProfile.complexity,
            limits: contextBudget,
            requests: [...(task.contextUsage?.requests ?? []), {
              iteration,
              inputChars,
              estimatedPromptTokens: estimatedTokens,
              toolObservationChars: selection.toolObservationChars,
              toolObservationEntries: selection.toolObservationEntries,
              budgetCheck: "beforeModel",
              compacted: selection.compacted,
            }],
          },
          executionTiming: executionTiming("modelRequest"),
        });
        const modelStarted = monotonicNow();
        let modelResult: HarnessModelResult;
        try {
          modelResult = await withPhaseTimeout(
            (signal) => modelClient.next({
              tools,
              context: selection.context,
              estimatedInputChars: inputChars,
              iteration,
              signal,
            }),
            modelBudgetMs,
            controller.signal,
            modelBudgetMs < bounds.modelRequestTimeoutMs
              ? "Harness 总执行时间预算已在模型请求期间用尽。"
              : `Harness 单次模型请求已超过 ${bounds.modelRequestTimeoutMs} ms 限制。`,
            () => abortError(controller.signal),
          );
        } catch (modelError) {
          if (modelError instanceof DeepSeekProviderProtocolError) failureTerminationCode = "protocolViolation";
          throw modelError;
        } finally {
          modelDurationMs += Math.max(0, monotonicNow() - modelStarted);
        }
        const modelCallDurationMs = Math.max(0, Math.round(monotonicNow() - modelStarted));
        const totalPromptTokens = previousPromptTokens + modelResult.usage.promptTokens;
        const requestUsage = task.contextUsage?.requests.map((entry) => entry.iteration === iteration
          ? { ...entry, promptTokens: modelResult.usage.promptTokens }
          : entry) ?? [];
        task = appendHarnessEvent(task, {
          type: "state",
          state: "planning",
          message: `第 ${iteration} 次模型请求完成，耗时 ${modelCallDurationMs} ms。`,
          timing: eventTiming("planning", modelCallDurationMs),
        }, clock, {
          model: modelResult.model,
          usage: addUsage(task.usage, modelResult.usage),
          contextUsage: {
            totalInputChars: task.contextUsage?.totalInputChars ?? inputChars,
            totalPromptTokens,
            complexity: taskProfile.complexity,
            limits: contextBudget,
            requests: requestUsage,
          },
          executionTiming: executionTiming("planning"),
        });
        if (totalPromptTokens > contextBudget.maxTotalPromptTokens) {
          failContextBudget("taskPromptTokens", `DeepSeek 实际累计输入 token 已超过 ${contextBudget.maxTotalPromptTokens} 限制，已停止后续工具和写操作。`);
        }
        const { turn } = modelResult;
        if (turn.type === "complete") {
          if (selection.toolNames.length > 0) {
            failureTerminationCode = "protocolViolation";
            throw new StudioValidationError("Harness 模型协议失败", ["仍有可用工具时模型提前结束，未接受其‘没有工具或数据’的结论。"]);
          }
          task = appendHarnessEvent(task, {
            type: "state",
            state: "completed",
            message: sanitizeHarnessText(turn.message),
          }, clock, {
            resultMessage: sanitizeHarnessText(turn.message),
            terminationCode: "completed",
            totalDurationMs: elapsedMs(),
            executionTiming: executionTiming("completed"),
          });
          return task;
        }
        if (turn.type === "blocked") {
          if (selection.toolNames.length > 0) {
            failureTerminationCode = "protocolViolation";
            throw new StudioValidationError("Harness 模型协议失败", ["仍有可用工具时模型不得跳过检查并宣告缺少条件。"]);
          }
          const missing = turn.missingRequirements.map((item) => sanitizeHarnessText(item)).join("、");
          const blockedMessage = `${sanitizeHarnessText(turn.message)} 缺少：${missing}。正式 AppSpec 未修改。`;
          task = appendHarnessEvent(task, {
            type: "state",
            state: "blocked",
            message: blockedMessage,
          }, clock, {
            error: blockedMessage,
            resultMessage: blockedMessage,
            terminationCode: "missingRequirements",
            totalDurationMs: elapsedMs(),
            executionTiming: executionTiming("blocked"),
          });
          return task;
        }
        const toolAction = turn;
        if (task.counters.toolCallCount >= bounds.maxToolCalls) throw new Error("Harness 已达到最大工具调用次数。");
        const parsedToolName = harnessToolNameSchema.safeParse(toolAction.name);
        if (!parsedToolName.success) {
          failureTerminationCode = "invalidTool";
          throw new StudioValidationError("Harness 工具校验失败", [`不允许调用工具：${sanitizeHarnessText(toolAction.name, "未知工具")}`]);
        }
        const toolName = parsedToolName.data;
        if (!selection.toolNames.includes(toolName)) {
          failureTerminationCode = "invalidTool";
          throw new StudioValidationError("Harness 工具状态校验失败", [`当前规划状态不允许调用工具：${toolName}`]);
        }
        const toolBudgetMs = phaseBudget("工具调用", bounds.toolCallTimeoutMs);
        task = appendHarnessEvent(task, {
          type: "toolCall",
          state: "executingTool",
          message: `${sanitizeHarnessText(turn.message)}（执行工具：${toolName}）`,
          toolCall: { id: toolAction.toolCallId, name: toolName, status: "running", durationMs: 0 },
          timing: eventTiming("toolExecution"),
        }, clock, {
          counters: { ...task.counters, toolCallCount: task.counters.toolCallCount + 1 },
          executionTiming: executionTiming("toolExecution"),
        });
        const toolStarted = monotonicNow();
        let result: Awaited<ReturnType<typeof executeHarnessTool>>;
        try {
          result = await withPhaseTimeout(
            () => (options.toolExecutor ?? executeHarnessTool)(toolAction.name, toolAction.arguments, {
              request,
              dataRuntime: options.dataRuntime,
              now: () => clock.now().getTime(),
              id: () => clock.id().replaceAll("harness_event_", "tool_"),
              resultBudgetChars: contextBudget.maxToolResultChars,
              resultBudgetEntries: contextBudget.maxToolResultEntries,
              ...(options.excelExporter ? { excelExporter: options.excelExporter } : {}),
            }),
            toolBudgetMs,
            controller.signal,
            toolBudgetMs < bounds.toolCallTimeoutMs
              ? "Harness 总执行时间预算已在工具调用期间用尽。"
              : `Harness 单次工具调用已超过 ${bounds.toolCallTimeoutMs} ms 限制。`,
            () => abortError(controller.signal),
          );
        } catch (toolError) {
          failureTerminationCode = controller.signal.aborted ? "cancelled" : "toolExecutionFailed";
          const failedDurationMs = Math.max(0, Math.round(monotonicNow() - toolStarted));
          toolDurationMs += failedDurationMs;
          task = appendHarnessEvent(task, {
            type: "toolCall",
            state: controller.signal.aborted ? "cancelled" : "failed",
            message: sanitizeHarnessText(toolError),
            toolCall: {
              id: toolAction.toolCallId,
              name: toolName,
              status: "failure",
              durationMs: failedDurationMs,
            },
            timing: eventTiming("failed", failedDurationMs),
          }, clock, { executionTiming: executionTiming("failed") });
          throw toolError;
        }
        const durationMs = Math.max(0, Math.round(monotonicNow() - toolStarted));
        toolDurationMs += durationMs;
        observations.push({ toolCallId: toolAction.toolCallId, toolName, summary: result.summary, data: result.data });
        task = appendHarnessEvent(task, {
          type: "observation",
          state: "observing",
          message: result.summary,
          toolCall: { id: toolAction.toolCallId, name: toolName, status: "success", durationMs },
          timing: eventTiming("planning", durationMs),
        }, clock, { executionTiming: executionTiming("planning") });
        if (toolName === "inspectFields") {
          const blockingReason = requiredDataFieldsBlockingReason(request);
          if (blockingReason) {
            task = appendHarnessEvent(task, {
              type: "state",
              state: "blocked",
              message: blockingReason,
            }, clock, {
              error: blockingReason,
              resultMessage: blockingReason,
              terminationCode: "missingDataFields",
              totalDurationMs: elapsedMs(),
              executionTiming: executionTiming("blocked"),
            });
            return task;
          }
        }
        if (result.pendingChangeSet) {
          task = taskWithPendingChangeSet(task, result.pendingChangeSet);
          task = appendHarnessEvent(task, {
            type: "confirmation",
            state: "awaitingConfirmation",
            message: "已生成待确认 ChangeSet，Harness 已暂停，等待用户预览和确认。",
          }, clock, {
            resultMessage: sanitizeHarnessText(turn.message),
            terminationCode: "awaitingConfirmation",
            totalDurationMs: elapsedMs(),
            executionTiming: executionTiming("awaitingConfirmation"),
          });
          return task;
        }
        if (result.exportArtifact) {
          task = appendHarnessEvent(task, {
            type: "state",
            state: "completed",
            message: `Excel 已生成：${result.exportArtifact.fileName}（${result.exportArtifact.rowCount} 行、${result.exportArtifact.fieldCount} 个字段）。`,
          }, clock, {
            exportArtifact: result.exportArtifact,
            resultMessage: `分析已完成，Excel“${result.exportArtifact.fileName}”可以下载。正式 AppSpec 未修改。`,
            terminationCode: "completed",
            totalDurationMs: elapsedMs(),
            executionTiming: executionTiming("completed"),
          });
          return task;
        }
        task = appendHarnessEvent(task, {
          type: "state",
          state: "planning",
          message: "已接收工具观察结果，继续规划下一步。",
          timing: eventTiming("planning"),
        }, clock, { executionTiming: executionTiming("planning") });
      }
      throw new Error("Harness 已达到最大循环次数。");
    } catch (error) {
      if (task.state === "failed" && task.contextUsage?.limitReached) {
        return {
          ...task,
          totalDurationMs: elapsedMs(),
          executionTiming: executionTiming("failed"),
        };
      }
      const cancelled = controller.signal.aborted;
      const message = sanitizeHarnessText(error, cancelled ? "Harness 任务已取消。" : "Harness 执行失败。");
      task = appendHarnessEvent(task, {
        type: cancelled ? "state" : "error",
        state: cancelled ? "cancelled" : "failed",
        message,
      }, clock, {
        error: message,
        resultMessage: cancelled ? "任务已取消，正式 AppSpec 未修改。" : "任务失败，正式 AppSpec 未修改。",
        terminationCode: cancelled ? "cancelled" : failureTerminationCode,
        totalDurationMs: elapsedMs(),
        executionTiming: executionTiming(cancelled ? "cancelled" : "failed"),
      });
      return task;
    } finally {
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

  execute(request: HarnessRequest, factory: () => Promise<HarnessTaskSummary>, namespace = "default"): Promise<HarnessTaskSummary> {
    const fingerprint = JSON.stringify({ ...request, idempotencyKey: undefined });
    const now = Date.now();
    for (const [key, entry] of this.entries) if (now - entry.createdAt > this.ttlMs) this.entries.delete(key);
    const storageKey = `${namespace}:${request.idempotencyKey}`;
    const existing = this.entries.get(storageKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new HarnessIdempotencyConflictError();
      return existing.task;
    }
    const task = factory();
    this.entries.set(storageKey, { fingerprint, task, createdAt: now });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    return task;
  }

  clear() {
    this.entries.clear();
  }
}
