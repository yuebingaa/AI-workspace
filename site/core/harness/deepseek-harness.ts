import { z } from "zod";
import { DEFAULT_DEEPSEEK_MODEL } from "@/core/ai/contracts";
import { DEEPSEEK_CHAT_COMPLETIONS_URL, MAX_DEEPSEEK_RESPONSE_BYTES } from "@/core/ai/server/deepseek-planner";
import { readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import type { LocalDataRuntime } from "@/core/models";
import { StudioValidationError } from "@/core/schemas";
import { toProjectIsoDateTime } from "@/core/time/project-iso";
import {
  DEFAULT_HARNESS_LIMITS,
  harnessRequestSchema,
  harnessSemanticIntentDecisionSchema,
  harnessToolNameSchema,
  type HarnessExecutionPhase,
  type HarnessExecutionPlan,
  type HarnessExecutionTiming,
  type HarnessModel,
  type HarnessModelInput,
  type HarnessModelResult,
  type HarnessObservation,
  type HarnessRequest,
  type HarnessSemanticIntentDecision,
  type HarnessSemanticIntentInput,
  type HarnessSemanticIntentResult,
  type HarnessTaskSummary,
  type HarnessTaskVerification,
  type HarnessTerminationCode,
  type HarnessToolName,
  type HarnessWorkingMemory,
} from "./contracts";
import { normalizeHarnessModelTurn } from "./action-normalizer";
import { sanitizeHarnessText } from "./security";
import {
  buildHarnessContextSelection,
  buildHarnessWorkingMemory,
  classifyHarnessTask,
  estimateHarnessModelInputChars,
  harnessSystemPrompt,
  resolveHarnessPageDataSourceIds,
  resolveHarnessContextBudget,
  type HarnessContextBudget,
  type HarnessContextSelection,
  type HarnessRecoveryContext,
  type HarnessToolCorrection,
} from "./context-selector";
import {
  createHarnessExecutionPlan,
  finishHarnessExecutionPlan,
  harnessExecutionPlanContext,
  replanHarnessExecutionPlanAfterVerification,
  syncHarnessExecutionPlan,
} from "./execution-planner";
import {
  failHarnessTaskVerification,
  pendingHarnessTaskVerification,
  requiresHarnessVisualVerification,
  verifyHarnessTask,
  type HarnessVerificationCandidate,
} from "./task-verifier";
import {
  DEFAULT_HARNESS_VISUAL_TIMEOUT_MS,
  deferredHarnessVisualEvidence,
  unavailableHarnessVisualEvidence,
  type HarnessVisualVerifier,
} from "./visual-verifier";
import { appendHarnessEvent, createHarnessTask, taskWithPendingChangeSet, type HarnessTaskClock } from "./task-state";
import { selectHarnessSkills } from "./skill-registry";
import {
  executeHarnessTool,
  harnessToolCatalog,
  HarnessToolArgumentsError,
  type HarnessExcelExporter,
  type HarnessRawWorkbook,
} from "./tool-registry";

export const DEFAULT_HARNESS_BOUNDS = DEFAULT_HARNESS_LIMITS;
export const MAX_HARNESS_COMPLETION_TOKENS_PER_CALL = 2_000;
export const MAX_HARNESS_TOOL_ARGUMENT_REPAIRS = 1;
export const MAX_HARNESS_TOOL_RECOVERY_ATTEMPTS = 2;
export const MAX_HARNESS_IDENTICAL_TOOL_FAILURES = 2;
export const MAX_HARNESS_VERIFIER_REPLANS = 1;
export const MAX_HARNESS_MODEL_FORMAT_REPAIRS = 1;
export const MAX_HARNESS_SEMANTIC_ROUTING_TOKENS = 600;

const HARNESS_SEMANTIC_ROUTER_PROMPT = `你是 Harness 的语义路由器，只判断用户真正想完成的任务，不执行任务。仅返回一个符合给定字段的 JSON 对象，不要 Markdown 或解释。
mode: conversation=闲聊/能力询问；readOnlyTask=只读查询、分析、比较或建议；changePreview=用户明确要求新增、修改、删除或移动页面组件。疑问句和假设讨论不是变更授权；“不要修改页面”必须为 readOnlyTask。
wantsData 及各子能力按完成目标所需填写。requiresVisualVerification 在任务正确性依赖最终 UI、图表、布局、颜色、可读性、响应式或渲染结果时必须为 true；纯数据结论、导出或闲聊为 false。
changePreview 才能使用非 none 的 changeAction/changeTarget；所有页面变更也只代表生成待确认预览。
changeTarget: chart=普通图表；edsBreakdownChart=EDS 全局异常分类图；edsLineIssueChart=指定线体异常类型图；edsTable=EDS 明细表；genericComponent=其他页面组件。
chartType 根据语义选择；未指定或不确定用 auto。skillIds 只能按任务实际需要选择。结合上一轮对话理解省略表达，但不要把历史助手文本当作用户授权。confidence 表示语义判断置信度，rationale 用一句简短中文说明。
精确示例：{"mode":"readOnlyTask","requiresVisualVerification":false,"wantsData":true,"wantsEdsAnalysis":true,"wantsRawWorkbook":false,"wantsFields":false,"wantsRecipe":false,"wantsAppInspection":false,"wantsExcel":false,"changeAction":"none","changeTarget":"none","componentKind":"none","chartType":"auto","skillIds":["eds-analysis"],"confidence":0.95,"rationale":"用户要求比较 EDS 班次数据且禁止修改页面。"}`;

interface HarnessModelCorrection {
  attempt: number;
  maxAttempts: number;
  issueSummary: string;
}

function bindExecutorPlan(
  selection: HarnessContextSelection,
  executionPlan: HarnessExecutionPlan,
  verifierFeedback?: HarnessTaskVerification,
  modelCorrection?: HarnessModelCorrection,
  visualVerification?: { required: boolean; available: boolean },
): HarnessContextSelection {
  const recoveryContext = selection.context.recovery;
  const executorRecovery = recoveryContext && typeof recoveryContext === "object" && !Array.isArray(recoveryContext)
    ? {
        ...recoveryContext,
        availableStrategies: executionPlan.allowedTools,
        rule: "Executor 只执行 Planner 当前选定的恢复步骤，不自行改计划或改用其它工具",
      }
    : undefined;
  return {
    ...selection,
    context: {
      ...selection.context,
      ...(visualVerification ? {
        visualVerification: {
          required: visualVerification.required,
          available: visualVerification.available,
          method: "Playwright desktop-and-narrow screenshots plus multimodal Verifier",
          scope: "自动检查当前工作台渲染页面；用户上传图片通过独立 uploadedImageEvidence 提供",
          acceptsUploadedImages: true,
          rule: visualVerification.available && visualVerification.required
            ? "截图在 Executor 返回 complete 后由最终 Verifier 自动执行；不要因缺少截图工具而 blocked，也不要声称已看到尚未生成的截图"
            : visualVerification.available
              ? "如用户询问图片能力，应说明可上传 JPEG、PNG、WebP 供视觉模型解析，也可要求检查当前网页；不要声称完全不能查看图片"
            : "当前未配置视觉 Verifier，不得仅凭代码测试宣告视觉任务完成",
        },
      } : {}),
      ...(executorRecovery ? { recovery: executorRecovery } : {}),
      executionPlan: harnessExecutionPlanContext(executionPlan),
      ...(verifierFeedback?.status === "replan" ? {
        verifier: {
          phase: "repairAfterTaskVerification",
          attempt: verifierFeedback.attempt,
          issues: verifierFeedback.issues,
          rule: "根据 Verifier 缺口修正最终答案；不得删除证据、伪造工具结果或绕过 ChangeSet",
        },
      } : {}),
      ...(modelCorrection ? {
        modelCorrection: {
          phase: "repairMalformedAction",
          ...modelCorrection,
          rule: "上一轮模型动作格式未通过校验；保留当前 Planner 步骤和工具证据，只返回一个符合系统示例与当前工具 Schema 的 JSON 对象，不要代码围栏或额外说明",
        },
      } : {}),
    },
  };
}

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
  rawWorkbook?: HarnessRawWorkbook;
  contextBudget?: Partial<HarnessContextBudget>;
  modelMaxCompletionTokens?: number;
  requireProviderUsage?: boolean;
  providerPromptTokenLimit?: number;
  visualVerifier?: HarnessVisualVerifier;
  visualVerificationTimeoutMs?: number;
  /** Synchronous authorization check run at the final boundary before every model request. */
  authorizeModelCall?: () => void;
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

export const HARNESS_HARD_BOUNDS: HarnessBounds = {
  ...DEFAULT_HARNESS_LIMITS,
  totalExecutionTimeoutMs: 180_000,
};

export class HarnessIdempotencyCapacityError extends Error {
  constructor() {
    super("Harness 当前执行中的请求已达到容量上限，请稍后重试。");
    this.name = "HarnessIdempotencyCapacityError";
  }
}

export class DeepSeekProviderProtocolError extends Error {
  readonly code = "provider_model_mismatch" as const;

  constructor() {
    super("DeepSeek 返回的模型标识与本次服务端配置不一致。");
    this.name = "DeepSeekProviderProtocolError";
  }
}

export class HarnessModelFormatError extends Error {
  constructor(
    message: string,
    readonly model: string,
    readonly usage: HarnessModelResult["usage"],
  ) {
    super(message);
    this.name = "HarnessModelFormatError";
  }
}

function parseHarnessJsonContent(content: string): unknown {
  const trimmed = content.trim().replace(/^\uFEFF/u, "");
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(candidate) as unknown;
  } catch (error) {
    const first = candidate.at(0) === "{" ? "对象开头" : "非对象开头";
    const last = candidate.at(-1) === "}" ? "对象结尾" : "非对象结尾";
    const positionMatch = error instanceof SyntaxError ? /position\s+(\d+)/iu.exec(error.message) : null;
    const position = positionMatch ? Number(positionMatch[1]) : undefined;
    const codePoint = position !== undefined ? candidate.codePointAt(position) : undefined;
    const location = position !== undefined && codePoint !== undefined
      ? `，错误位置 ${position}（U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}）`
      : "";
    throw new Error(`DeepSeek Harness 动作不是有效 JSON（${candidate.length} 字符，${first}、${last}${location}）。`);
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
  }) {
    if (options.requireProviderUsage === false) {
      throw new Error("DeepSeek token 用量校验不能关闭。");
    }
    const maxCompletionTokens = options.maxCompletionTokens ?? MAX_HARNESS_COMPLETION_TOKENS_PER_CALL;
    if (
      !Number.isSafeInteger(maxCompletionTokens)
      || maxCompletionTokens < 1
      || maxCompletionTokens > MAX_HARNESS_COMPLETION_TOKENS_PER_CALL
    ) {
      throw new Error(`DeepSeek 输出 token 上限必须是 1–${MAX_HARNESS_COMPLETION_TOKENS_PER_CALL} 的整数。`);
    }
    if (
      options.promptTokenLimit !== undefined
      && (!Number.isSafeInteger(options.promptTokenLimit) || options.promptTokenLimit < 1 || options.promptTokenLimit > 12_000)
    ) {
      throw new Error("DeepSeek 输入 token 上限必须是 1–12000 的整数。");
    }
  }

  async classifyIntent(input: HarnessSemanticIntentInput): Promise<HarnessSemanticIntentResult> {
    const maxCompletionTokens = Math.min(
      this.options.maxCompletionTokens ?? MAX_HARNESS_COMPLETION_TOKENS_PER_CALL,
      MAX_HARNESS_SEMANTIC_ROUTING_TOKENS,
    );
    const payload = {
      instruction: input.instruction,
      ...(input.previousInstruction ? { previousInstruction: input.previousInstruction } : {}),
      ...(input.previousAssistantMessage ? { previousAssistantMessage: input.previousAssistantMessage } : {}),
      page: input.page,
      dataSources: input.dataSources,
      capabilities: {
        hasEdsWorkspace: input.hasEdsWorkspace,
        hasRawWorkbookAccess: input.hasRawWorkbookAccess,
        hasVisualVerification: input.hasVisualVerification,
        hasUploadedImageEvidence: Boolean(input.userImageEvidence),
        role: input.role,
        pageChangesRequireConfirmation: true,
      },
      outputSchema: {
        mode: ["conversation", "readOnlyTask", "changePreview"],
        requiresVisualVerification: "boolean",
        booleans: ["wantsData", "wantsEdsAnalysis", "wantsRawWorkbook", "wantsFields", "wantsRecipe", "wantsAppInspection", "wantsExcel"],
        changeAction: ["none", "add", "update", "remove", "move"],
        changeTarget: ["none", "genericComponent", "chart", "edsBreakdownChart", "edsLineIssueChart", "edsTable"],
        componentKind: ["none", "chart", "metric", "table", "text", "generic"],
        chartType: ["auto", "bar", "line", "area", "pie", "donut"],
        skillIds: ["data-visualization", "eds-analysis", "dashboard-editing", "workbook-analysis"],
      },
      ...(input.userImageEvidence ? { uploadedImageEvidence: input.userImageEvidence } : {}),
    };
    const inputChars = HARNESS_SEMANTIC_ROUTER_PROMPT.length + JSON.stringify(payload).length;
    const response = await (this.options.fetchImpl ?? fetch)(DEEPSEEK_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({
        model: this.options.model,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        stream: false,
        temperature: 0,
        max_tokens: maxCompletionTokens,
        messages: [
          { role: "system", content: HARNESS_SEMANTIC_ROUTER_PROMPT },
          { role: "user", content: JSON.stringify(payload) },
        ],
      }),
      signal: input.signal,
    });
    if (!response.ok) throw new Error(response.status === 401 ? "DeepSeek 认证失败。" : response.status === 429 ? "DeepSeek 请求过于频繁。" : "DeepSeek 服务暂时不可用。");
    const raw = await readBoundedUtf8Body(response, MAX_DEEPSEEK_RESPONSE_BYTES)
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => null);
    const provider = providerResponseSchema.safeParse(raw);
    if (!provider.success) throw new Error("DeepSeek 返回了无法识别的语义路由响应。");
    if (provider.data.model !== undefined && provider.data.model !== this.options.model) {
      throw new DeepSeekProviderProtocolError();
    }
    const content = provider.data.choices[0].message.content;
    if (!content) throw new Error("DeepSeek 未返回语义路由结果。");
    const rawUsage = provider.data.usage;
    const promptTokens = rawUsage?.prompt_tokens;
    const completionTokens = rawUsage?.completion_tokens;
    const totalTokens = rawUsage?.total_tokens;
    const promptLimit = this.options.promptTokenLimit ?? 12_000;
    if (
      promptTokens === undefined
      || completionTokens === undefined
      || totalTokens === undefined
      || totalTokens !== promptTokens + completionTokens
      || completionTokens > maxCompletionTokens
      || promptTokens > promptLimit
    ) {
      throw new Error("DeepSeek 语义路由未返回可信的 token 用量，已降级为安全规则。");
    }
    const decision = harnessSemanticIntentDecisionSchema.safeParse(parseHarnessJsonContent(content));
    if (!decision.success) throw new Error("DeepSeek 语义路由结果未通过 Schema 校验。");
    return {
      decision: decision.data,
      model: this.options.model,
      usage: { promptTokens, completionTokens, totalTokens },
      inputChars,
    };
  }

  async next(input: HarnessModelInput): Promise<HarnessModelResult> {
    const maxCompletionTokens = this.options.maxCompletionTokens ?? MAX_HARNESS_COMPLETION_TOKENS_PER_CALL;
    const response = await (this.options.fetchImpl ?? fetch)(DEEPSEEK_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({
        model: this.options.model,
        thinking: { type: "disabled" },
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
    const raw = await readBoundedUtf8Body(response, MAX_DEEPSEEK_RESPONSE_BYTES)
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => null);
    const provider = providerResponseSchema.safeParse(raw);
    if (!provider.success) throw new Error("DeepSeek 返回了无法识别的响应。");
    if (
      provider.data.model !== undefined
      && provider.data.model !== this.options.model
    ) {
      throw new DeepSeekProviderProtocolError();
    }
    const content = provider.data.choices[0].message.content;
    if (!content) throw new Error("DeepSeek 未返回 Harness 动作。");
    const rawUsage = provider.data.usage;
    const promptTokens = rawUsage?.prompt_tokens;
    const completionTokens = rawUsage?.completion_tokens;
    const totalTokens = rawUsage?.total_tokens;
    const promptLimit = this.options.promptTokenLimit ?? 12_000;
    const invalidUsage = promptTokens === undefined
      || completionTokens === undefined
      || totalTokens === undefined
      || totalTokens !== promptTokens + completionTokens
      || completionTokens > maxCompletionTokens
      || promptTokens > promptLimit;
    if (invalidUsage) throw new Error("DeepSeek 未返回可信的 token 用量，已安全停止。");
    const usage = { promptTokens, completionTokens, totalTokens };
    let turn: ReturnType<typeof normalizeHarnessModelTurn>;
    try {
      const candidate = parseHarnessJsonContent(content);
      const readonlyTask = input.context.taskMode === "readOnly";
      const readonlyResultComplete = readonlyTask
        && input.context.phase === "followUp"
        && input.tools.length === 0
        && (input.context.latestObservation !== undefined || input.context.lastObservation !== undefined);
      const targetPageId = typeof input.context.targetPageId === "string" ? input.context.targetPageId : undefined;
      turn = normalizeHarnessModelTurn(candidate, {
        readonlyTask,
        readonlyResultComplete,
        ...(targetPageId ? { expectedPageId: targetPageId } : {}),
      });
    } catch (error) {
      throw new HarnessModelFormatError(
        sanitizeHarnessText(error, "DeepSeek Harness 动作格式未通过校验。"),
        this.options.model,
        usage,
      );
    }
    return {
      turn: turn.turn,
      model: this.options.model,
      usage,
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

function semanticIntentInput(
  request: HarnessRequest,
  signal: AbortSignal,
  hasVisualVerification: boolean,
): HarnessSemanticIntentInput {
  const page = request.appSpec.pages.find((candidate) => candidate.id === request.pageId);
  if (!page) throw new HarnessRequestError("Harness 当前页面不存在。");
  const componentTypes = new Set<string>();
  const visit = (node: typeof page.root) => {
    componentTypes.add(node.type);
    node.children?.forEach((child) => visit(child as typeof page.root));
  };
  visit(page.root);
  return {
    instruction: sanitizeHarnessText(request.instruction).slice(0, 1_000),
    ...(request.conversationContext?.previousInstruction ? {
      previousInstruction: sanitizeHarnessText(request.conversationContext.previousInstruction).slice(0, 1_000),
    } : {}),
    ...(request.conversationContext?.previousAssistantMessage ? {
      previousAssistantMessage: sanitizeHarnessText(request.conversationContext.previousAssistantMessage).slice(0, 1_200),
    } : {}),
    page: {
      id: page.id,
      title: page.title,
      componentTypes: [...componentTypes].slice(0, 30),
    },
    dataSources: request.appSpec.dataSources.slice(0, 20).map((source) => ({
      id: source.id,
      name: source.name,
      sourceType: source.sourceType,
    })),
    hasEdsWorkspace: Boolean(request.edsWorkspace),
    hasRawWorkbookAccess: Boolean(request.rawWorkbookManifest),
    hasVisualVerification,
    ...(request.userImageEvidence ? {
      userImageEvidence: {
        summary: request.userImageEvidence.summary,
        visibleText: request.userImageEvidence.visibleText,
        findings: request.userImageEvidence.findings,
        uncertainties: request.userImageEvidence.uncertainties,
      },
    } : {}),
    role: request.role,
    signal,
  };
}

function resilientTaskClock(source: HarnessTaskClock): {
  clock: HarnessTaskClock;
  throwIfFault(): void;
} {
  let lastValidTime: number | null = null;
  let fault: HarnessRequestError | null = null;
  const clock: HarnessTaskClock = {
    now: () => {
      if (fault) return new Date(lastValidTime ?? 0);
      try {
        const candidate = source.now();
        const serialized = toProjectIsoDateTime(candidate);
        const timestamp = candidate instanceof Date ? candidate.getTime() : Number.NaN;
        if (serialized && Number.isSafeInteger(timestamp)) {
          lastValidTime = timestamp;
          return new Date(timestamp);
        }
      } catch {
        // A prior valid wall-clock value keeps error reporting available.
      }
      fault = new HarnessRequestError("Harness 时钟必须返回有效 Date。");
      if (lastValidTime === null) {
        const fallback = Date.now();
        lastValidTime = toProjectIsoDateTime(new Date(fallback)) ? fallback : 0;
      }
      return new Date(lastValidTime);
    },
    id: () => source.id(),
  };
  return {
    clock,
    throwIfFault: () => {
      if (fault) throw fault;
    },
  };
}

function resolvedBounds(input?: Partial<HarnessBounds>): HarnessBounds {
  const bounds = { ...DEFAULT_HARNESS_BOUNDS, ...input };
  for (const [name, value] of Object.entries(bounds)) {
    const maximum = HARNESS_HARD_BOUNDS[name as keyof HarnessBounds];
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new HarnessRequestError(`Harness 执行边界不合法：${name} 必须是 1–${maximum} 的整数`);
    }
  }
  return bounds;
}

function estimatedPromptTokens(inputChars: number): number {
  return Math.ceil(inputChars / 4);
}

function abortError(signal: AbortSignal): Error {
  return new Error(signal.reason instanceof Error ? signal.reason.message : "Harness 任务已取消。");
}

function userFacingMissingRequirement(value: string): string {
  const sanitized = sanitizeHarnessText(value);
  return /^(?:goal_?summary|tools?|datasets?|data_?sources?|context)$/iu.test(sanitized)
    ? "请具体说明想了解的数据、现象或业务问题"
    : sanitized;
}

function canonicalToolValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalToolValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalToolValue(item)]));
  }
  return value;
}

function toolCallFingerprint(toolName: HarnessToolName, toolArguments: Record<string, unknown>): string {
  return `${toolName}:${JSON.stringify(canonicalToolValue(toolArguments))}`;
}

function toolFailureKind(error: unknown): HarnessRecoveryContext["failureKind"] {
  if (error instanceof HarnessToolArgumentsError) return "argumentValidation";
  const message = sanitizeHarnessText(error);
  if (/超时|超过.*(?:ms|毫秒)|时间预算/u.test(message)) return "timeout";
  if (error instanceof StudioValidationError) return "precondition";
  return "execution";
}

function toolFailureIssues(error: unknown): string[] {
  if (error instanceof HarnessToolArgumentsError) {
    return error.issueSummary.map((issue) => sanitizeHarnessText(issue).slice(0, 240)).slice(0, 6);
  }
  if (error instanceof StudioValidationError) {
    return error.issues.map((issue) => sanitizeHarnessText(issue).slice(0, 240)).slice(0, 6);
  }
  return [sanitizeHarnessText(error).slice(0, 240)];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatVerifiedNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1");
}

function verifiedEdsAggregateAnswer(
  request: HarnessRequest,
  observations: HarnessObservation[],
): string | undefined {
  const instruction = request.instruction.trim();
  const requestsAggregateAnalysis = /分析|检查|总结|诊断|主要问题|异常次数最多|累计时间最长|主要异常|班次差异|对比|改善建议/u.test(instruction);
  const requestsRawRows = /原始(?:行|数据|明细)|逐行|每一行|全部明细行|导出.*原始/u.test(instruction);
  const mentionedLine = request.edsWorkspace?.lineSummary.some((item) => (
    instruction.toLocaleLowerCase("zh-CN").includes(item.label.toLocaleLowerCase("zh-CN"))
  )) ?? false;
  const requestsLineBreakdown = mentionedLine && /异常(?:类型|分类)|图|柱状|柱形|条形/u.test(instruction);
  if (!requestsAggregateAnalysis || requestsRawRows || requestsLineBreakdown) return undefined;

  const observation = [...observations].reverse().find((item) => item.toolName === "analyzeEdsReports");
  const data = objectValue(observation?.data);
  const reports = Array.isArray(data.reports) ? data.reports.map(objectValue) : [];
  const summaries = reports.slice(0, 4).flatMap((report) => {
    const topLine = Array.isArray(report.topLines) ? objectValue(report.topLines[0]) : {};
    const topIssue = Array.isArray(report.topIssues) ? objectValue(report.topIssues[0]) : {};
    const lineLabel = typeof topLine.label === "string" ? sanitizeHarnessText(topLine.label) : "";
    const lineOccurrences = finiteValue(topLine.occurrences);
    const lineMinutes = finiteValue(topLine.minutes);
    const issueLabel = typeof topIssue.label === "string" ? sanitizeHarnessText(topIssue.label) : "";
    const issueOccurrences = finiteValue(topIssue.occurrences);
    const issueMinutes = finiteValue(topIssue.minutes);
    if (!lineLabel || lineOccurrences === undefined || !issueLabel || issueMinutes === undefined) return [];
    const date = typeof report.date === "string" ? sanitizeHarnessText(report.date) : "当前报告";
    const shift = typeof report.shift === "string" ? sanitizeHarnessText(report.shift) : "";
    const current = report.current === true ? "（当前）" : "";
    return [`${date}${shift ? ` · ${shift}` : ""}${current}：异常次数最多的线体是 ${lineLabel}（${formatVerifiedNumber(lineOccurrences)} 次${lineMinutes === undefined ? "" : `，${formatVerifiedNumber(lineMinutes)} 分钟`}）；累计时间最长的异常类型是 ${issueLabel}（${formatVerifiedNumber(issueMinutes)} 分钟${issueOccurrences === undefined ? "" : `，${formatVerifiedNumber(issueOccurrences)} 次`}）`];
  });
  if (summaries.length === 0) return undefined;

  const scopeNote = data.lineIssueBreakdownAvailable === false
    ? "当前旧快照仅缺少“指定线体×异常类型”的交叉维度，这不影响以上汇总排名；如需生成单条线体的异常分类图，请重新导入工作簿。"
    : "以上结论来自已校验的 EDS 派生汇总，不需要读取原始逐行数据。";
  return `已根据现有 EDS 汇总完成分析。${summaries.join("；")}。${scopeNote}`;
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
  if (outerSignal.aborted) abortOuter();
  else outerSignal.addEventListener("abort", abortOuter, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    if (controller.signal.aborted) throw outerAbortError();
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
    const formalAppSpecSnapshot = JSON.stringify(request.appSpec);
    let semanticIntent: HarnessSemanticIntentDecision | undefined;
    let taskProfile = classifyHarnessTask(request);
    const configuredBounds = resolvedBounds(options.bounds);
    let bounds = {
      ...configuredBounds,
      maxModelCalls: Math.min(configuredBounds.maxModelCalls, taskProfile.maxModelCalls + MAX_HARNESS_VERIFIER_REPLANS),
      maxToolCalls: Math.min(configuredBounds.maxToolCalls, taskProfile.maxToolCalls),
    };
    let contextBudget = resolveHarnessContextBudget(options.contextBudget, taskProfile.complexity);
    const wallClock = resilientTaskClock(options.clock ?? defaultClock());
    const clock = wallClock.clock;
    const monotonicSource = options.monotonicNow ?? (() => performance.now());
    const monotonicNow = () => {
      let value: number;
      try { value = monotonicSource(); } catch { throw new HarnessRequestError("Harness 单调时钟必须返回有限数值。"); }
      if (!Number.isFinite(value)) throw new HarnessRequestError("Harness 单调时钟必须返回有限数值。");
      return value;
    };
    const phaseDuration = (startedAt: number) => {
      try {
        const elapsed = monotonicNow() - startedAt;
        const durationMs = Math.round(elapsed);
        if (elapsed < 0 || !Number.isSafeInteger(durationMs) || durationMs < 0) throw new Error("invalid duration");
        return { durationMs };
      } catch {
        return { durationMs: 0, error: new HarnessRequestError("Harness 单调时钟必须生成非负安全整数毫秒耗时。") };
      }
    };
    let modelDurationMs = 0;
    let toolDurationMs = 0;
    let verificationDurationMs = 0;
    const observations: HarnessObservation[] = [];
    let toolCorrection: HarnessToolCorrection | undefined;
    let recovery: HarnessRecoveryContext | undefined;
    let failedAttempts: HarnessWorkingMemory["failedAttempts"] = [];
    let executionPlan: HarnessExecutionPlan = createHarnessExecutionPlan(request);
    let verification = pendingHarnessTaskVerification();
    let verifierReplanCount = 0;
    let modelFormatRepairCount = 0;
    let modelCorrection: HarnessModelCorrection | undefined;
    let toolArgumentRepairCount = 0;
    let toolRecoveryCount = 0;
    const failedToolCalls = new Map<string, number>();
    const elapsedMs = () => Math.max(0, Math.round(modelDurationMs + toolDurationMs + verificationDurationMs));
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
        otherDurationMs: Math.max(0, Math.round(verificationDurationMs)),
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
    const verifyCandidate = async (candidate: Omit<HarnessVerificationCandidate, "formalAppSpecUnchanged">) => {
      const visualRequired = requiresHarnessVisualVerification(request, semanticIntent);
      let visualEvidence;
      if (visualRequired && candidate.outcome === "awaitingConfirmation") {
        visualEvidence = deferredHarnessVisualEvidence();
      } else if (visualRequired && !options.visualVerifier) {
        visualEvidence = unavailableHarnessVisualEvidence("未配置 Playwright 多模态视觉验证器，不能仅凭代码或工具测试判定视觉任务完成。");
      } else if (visualRequired && options.visualVerifier) {
        const visualStarted = monotonicNow();
        try {
          options.authorizeModelCall?.();
          const configuredVisualTimeout = options.visualVerificationTimeoutMs ?? DEFAULT_HARNESS_VISUAL_TIMEOUT_MS;
          const visualBudgetMs = phaseBudget("视觉验证", configuredVisualTimeout);
          visualEvidence = await withPhaseTimeout(
            (signal) => options.visualVerifier!.verify({
              request,
              outcome: candidate.outcome,
              candidateMessage: candidate.message,
              signal,
            }),
            visualBudgetMs,
            controller.signal,
            visualBudgetMs < configuredVisualTimeout
              ? "Harness 总执行时间预算已在视觉验证期间用尽。"
              : `Harness 视觉验证已超过 ${configuredVisualTimeout} ms 限制。`,
            () => abortError(controller.signal),
          );
        } catch (error) {
          visualEvidence = unavailableHarnessVisualEvidence(sanitizeHarnessText(error, "Playwright 多模态视觉验证失败。"));
        } finally {
          const measured = phaseDuration(visualStarted);
          verificationDurationMs += measured.durationMs;
        }
      }
      verification = verifyHarnessTask({
        request,
        semanticIntent,
        plan: executionPlan,
        observations,
        candidate: {
          ...candidate,
          formalAppSpecUnchanged: JSON.stringify(request.appSpec) === formalAppSpecSnapshot,
        },
        attempt: verification.attempt + 1,
        ...(visualEvidence ? { visualEvidence } : {}),
      });
      return verification;
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
    task = {
      ...task,
      workingMemory: buildHarnessWorkingMemory(request, observations, 1, failedAttempts, semanticIntent),
      executionPlan,
    };
    let loadedSkills: Awaited<ReturnType<typeof selectHarnessSkills>> = [];
    let failureTerminationCode: HarnessTerminationCode = "executionFailed";
    const controller = new AbortController();
    const abortOuter = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abortOuter();
    else options.signal?.addEventListener("abort", abortOuter, { once: true });

    try {
      wallClock.throwIfFault();
      if (!modelClient) throw new Error("AI 服务尚未配置。");
      if (modelClient.classifyIntent && task.counters.modelCallCount < bounds.maxModelCalls) {
        const semanticInput = semanticIntentInput(request, controller.signal, Boolean(options.visualVerifier));
        const semanticInputChars = HARNESS_SEMANTIC_ROUTER_PROMPT.length + JSON.stringify({ ...semanticInput, signal: undefined }).length;
        const semanticStarted = monotonicNow();
        task = appendHarnessEvent(task, {
          type: "state",
          state: "planning",
          message: "Planner 正在让模型进行结构化语义路由。",
          timing: eventTiming("modelRequest"),
        }, clock, {
          counters: { ...task.counters, modelCallCount: task.counters.modelCallCount + 1 },
          contextUsage: {
            ...(task.contextUsage ?? {
              totalInputChars: 0,
              totalPromptTokens: 0,
              complexity: taskProfile.complexity,
              limits: contextBudget,
              requests: [],
            }),
            totalInputChars: (task.contextUsage?.totalInputChars ?? 0) + semanticInputChars,
            requests: [...(task.contextUsage?.requests ?? []), {
              iteration: 1,
              phase: "semanticRouting",
              inputChars: semanticInputChars,
              estimatedPromptTokens: estimatedPromptTokens(semanticInputChars),
              toolObservationChars: 0,
              toolObservationEntries: 0,
              budgetCheck: "beforeModel",
              compacted: false,
            }],
          },
          executionTiming: executionTiming("modelRequest"),
        });
        let semanticDurationMs = 0;
        try {
          const semanticBudgetMs = phaseBudget("语义路由", bounds.modelRequestTimeoutMs);
          const semanticResult = await withPhaseTimeout(
            (signal) => {
              options.authorizeModelCall?.();
              return modelClient.classifyIntent!({ ...semanticInput, signal });
            },
            semanticBudgetMs,
            controller.signal,
            semanticBudgetMs < bounds.modelRequestTimeoutMs
              ? "Harness 总执行时间预算已在语义路由期间用尽。"
              : `Harness 语义路由已超过 ${bounds.modelRequestTimeoutMs} ms 限制。`,
            () => abortError(controller.signal),
          );
          const measured = phaseDuration(semanticStarted);
          semanticDurationMs = measured.durationMs;
          modelDurationMs += semanticDurationMs;
          if (measured.error) throw measured.error;
          semanticIntent = semanticResult.decision;
          taskProfile = classifyHarnessTask(request, semanticIntent);
          bounds = {
            ...configuredBounds,
            maxModelCalls: Math.min(configuredBounds.maxModelCalls, taskProfile.maxModelCalls + MAX_HARNESS_VERIFIER_REPLANS),
            maxToolCalls: Math.min(configuredBounds.maxToolCalls, taskProfile.maxToolCalls),
          };
          contextBudget = resolveHarnessContextBudget(options.contextBudget, taskProfile.complexity);
          executionPlan = createHarnessExecutionPlan(request, semanticIntent);
          const semanticRequests = task.contextUsage?.requests.map((entry) => entry.phase === "semanticRouting"
            ? { ...entry, inputChars: semanticResult.inputChars, estimatedPromptTokens: estimatedPromptTokens(semanticResult.inputChars), promptTokens: semanticResult.usage.promptTokens }
            : entry) ?? [];
          task = appendHarnessEvent(task, {
            type: "state",
            state: "planning",
            message: `模型语义路由完成：${semanticIntent.mode === "changePreview" ? "页面变更预览" : semanticIntent.mode === "readOnlyTask" ? "只读任务" : "对话"}（置信度 ${Math.round(semanticIntent.confidence * 100)}%）。`,
            timing: eventTiming("planning", semanticDurationMs),
          }, clock, {
            model: semanticResult.model,
            semanticIntent,
            usage: addUsage(task.usage, semanticResult.usage),
            contextUsage: {
              totalInputChars: semanticRequests.reduce((total, entry) => total + entry.inputChars, 0),
              totalPromptTokens: semanticResult.usage.promptTokens,
              complexity: taskProfile.complexity,
              limits: contextBudget,
              requests: semanticRequests,
            },
            executionPlan,
            executionTiming: executionTiming("planning"),
          });
        } catch (error) {
          const measured = phaseDuration(semanticStarted);
          if (semanticDurationMs === 0) {
            semanticDurationMs = measured.durationMs;
            modelDurationMs += semanticDurationMs;
          }
          if (error instanceof DeepSeekProviderProtocolError) failureTerminationCode = "protocolViolation";
          if (controller.signal.aborted || error instanceof DeepSeekProviderProtocolError) throw error;
          task = appendHarnessEvent(task, {
            type: "state",
            state: "planning",
            message: "模型语义路由暂时不可用，Planner 已切换到受限规则兜底；页面变更仍需 ChangeSet 确认。",
            timing: eventTiming("planning", semanticDurationMs),
          }, clock, { executionTiming: executionTiming("planning") });
        }
      }
      loadedSkills = await selectHarnessSkills(request, false, semanticIntent);
      if (loadedSkills.length > 0) {
        task = {
          ...task,
          skills: loadedSkills.map(({ id, name, version }) => ({ id, name, version })),
        };
      }
      while (task.counters.loopCount < bounds.maxLoops) {
        if (controller.signal.aborted) throw abortError(controller.signal);
        if (task.counters.modelCallCount >= bounds.maxModelCalls) throw new Error("Harness 已达到最大模型调用次数。");
        const iteration = task.counters.loopCount + 1;
        let selection = buildHarnessContextSelection(request, observations, iteration, false, toolCorrection, recovery, loadedSkills, failedAttempts, semanticIntent);
        executionPlan = syncHarnessExecutionPlan(executionPlan, observations, selection.toolNames, failedAttempts, recovery);
        selection = bindExecutorPlan(selection, executionPlan, verification, modelCorrection, {
          required: requiresHarnessVisualVerification(request, semanticIntent),
          available: Boolean(options.visualVerifier),
        });
        task = { ...task, workingMemory: selection.workingMemory, executionPlan };
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
            executionPlan: finishHarnessExecutionPlan(executionPlan, "blocked"),
            executionTiming: executionTiming("blocked"),
          });
          wallClock.throwIfFault();
          return task;
        }
        let tools = harnessToolCatalog({ names: executionPlan.allowedTools, editableNodes: selection.editableNodes, instruction: request.instruction, request, semanticIntent });
        let inputChars = estimateHarnessModelInputChars(selection.context, tools, iteration);
        const previousInputChars = task.contextUsage?.totalInputChars ?? 0;
        const previousPromptTokens = task.contextUsage?.totalPromptTokens ?? task.usage?.promptTokens ?? 0;
        const needsCompaction = () => inputChars > contextBudget.maxRequestInputChars
          || previousInputChars + inputChars > contextBudget.maxTotalInputChars
          || previousPromptTokens + estimatedPromptTokens(inputChars) > contextBudget.maxTotalPromptTokens;
        if (needsCompaction()) {
          selection = buildHarnessContextSelection(request, observations, iteration, true, toolCorrection, recovery, loadedSkills, failedAttempts, semanticIntent);
          executionPlan = syncHarnessExecutionPlan(executionPlan, observations, selection.toolNames, failedAttempts, recovery);
          selection = bindExecutorPlan(selection, executionPlan, verification, modelCorrection, {
            required: requiresHarnessVisualVerification(request, semanticIntent),
            available: Boolean(options.visualVerifier),
          });
          task = { ...task, workingMemory: selection.workingMemory, executionPlan };
          tools = harnessToolCatalog({ names: executionPlan.allowedTools, editableNodes: selection.editableNodes, instruction: request.instruction, request, semanticIntent });
          inputChars = estimateHarnessModelInputChars(selection.context, tools, iteration);
        }
        const failContextBudget = (limitReached: "singleRequestChars" | "taskInputChars" | "taskPromptTokens", message: string): never => {
          executionPlan = finishHarnessExecutionPlan(executionPlan, "failed");
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
            executionPlan,
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
          message: `Executor 按 Planner 计划开始第 ${iteration} 次模型请求，剩余执行预算 ${remainingMs()} ms。`,
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
              phase: "execution",
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
        wallClock.throwIfFault();
        const modelStarted = monotonicNow();
        let modelCallDurationMs = 0;
        let modelResult: HarnessModelResult | undefined;
        let modelError: unknown;
        try {
          modelResult = await withPhaseTimeout(
            (signal) => {
              options.authorizeModelCall?.();
              return modelClient.next({
                tools,
                context: selection.context,
                estimatedInputChars: inputChars,
                iteration,
                signal,
              });
            },
            modelBudgetMs,
            controller.signal,
            modelBudgetMs < bounds.modelRequestTimeoutMs
              ? "Harness 总执行时间预算已在模型请求期间用尽。"
              : `Harness 单次模型请求已超过 ${bounds.modelRequestTimeoutMs} ms 限制。`,
            () => abortError(controller.signal),
          );
        } catch (error) {
          if (error instanceof DeepSeekProviderProtocolError) failureTerminationCode = "protocolViolation";
          modelError = error;
        } finally {
          const measured = phaseDuration(modelStarted);
          modelCallDurationMs = measured.durationMs;
          modelDurationMs += modelCallDurationMs;
          if (measured.error && modelError === undefined) throw measured.error;
        }
        if (modelError instanceof HarnessModelFormatError) {
          const formatPromptTokens = previousPromptTokens + modelError.usage.promptTokens;
          const formatRequestUsage = task.contextUsage?.requests.map((entry) => entry.iteration === iteration && entry.phase !== "semanticRouting"
            ? { ...entry, promptTokens: modelError.usage.promptTokens }
            : entry) ?? [];
          task = {
            ...task,
            model: modelError.model,
            usage: addUsage(task.usage, modelError.usage),
            contextUsage: {
              totalInputChars: task.contextUsage?.totalInputChars ?? inputChars,
              totalPromptTokens: formatPromptTokens,
              complexity: taskProfile.complexity,
              limits: contextBudget,
              requests: formatRequestUsage,
            },
            executionTiming: executionTiming("planning"),
          };
          if (formatPromptTokens > contextBudget.maxTotalPromptTokens) {
            failContextBudget("taskPromptTokens", `DeepSeek 实际累计输入 token 已超过 ${contextBudget.maxTotalPromptTokens} 限制，已停止格式修正重试。`);
          }
          const canRepairModelFormat = modelFormatRepairCount < MAX_HARNESS_MODEL_FORMAT_REPAIRS
            && task.counters.modelCallCount < bounds.maxModelCalls
            && task.counters.loopCount < bounds.maxLoops
            && remainingMs() > 0;
          if (canRepairModelFormat) {
            modelFormatRepairCount += 1;
            modelCorrection = {
              attempt: modelFormatRepairCount,
              maxAttempts: MAX_HARNESS_MODEL_FORMAT_REPAIRS,
              issueSummary: sanitizeHarnessText(modelError.message).slice(0, 240),
            };
            task = appendHarnessEvent(task, {
              type: "error",
              state: "planning",
              message: `模型动作格式未通过校验，Harness 已保留 Planner 状态和工具证据，正在自动修正重试（${modelFormatRepairCount}/${MAX_HARNESS_MODEL_FORMAT_REPAIRS}）。`,
              timing: eventTiming("planning", modelCallDurationMs),
            }, clock, { executionTiming: executionTiming("planning") });
            wallClock.throwIfFault();
            continue;
          }
          failureTerminationCode = "protocolViolation";
        }
        if (modelError !== undefined) throw modelError;
        if (!modelResult) throw new Error("Harness 模型请求未返回结果。");
        modelCorrection = undefined;
        const totalPromptTokens = previousPromptTokens + modelResult.usage.promptTokens;
        const requestUsage = task.contextUsage?.requests.map((entry) => entry.iteration === iteration && entry.phase !== "semanticRouting"
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
        wallClock.throwIfFault();
        if (totalPromptTokens > contextBudget.maxTotalPromptTokens) {
          failContextBudget("taskPromptTokens", `DeepSeek 实际累计输入 token 已超过 ${contextBudget.maxTotalPromptTokens} 限制，已停止后续工具和写操作。`);
        }
        const { turn } = modelResult;
        if (turn.type === "complete") {
          if (selection.toolNames.length > 0) {
            failureTerminationCode = "protocolViolation";
            throw new StudioValidationError("Harness 模型协议失败", ["仍有可用工具时模型提前结束，未接受其‘没有工具或数据’的结论。"]);
          }
          const resultMessage = sanitizeHarnessText(turn.message);
          const verificationResult = await verifyCandidate({ outcome: "completed", message: resultMessage });
          if (verificationResult.status !== "passed") {
            const canReplanAfterVerification = verifierReplanCount < MAX_HARNESS_VERIFIER_REPLANS
              && task.counters.modelCallCount < bounds.maxModelCalls
              && task.counters.loopCount < bounds.maxLoops
              && remainingMs() > 0;
            if (canReplanAfterVerification) {
              verifierReplanCount += 1;
              executionPlan = replanHarnessExecutionPlanAfterVerification(executionPlan, verificationResult.issues);
              task = appendHarnessEvent(task, {
                type: "state",
                state: "planning",
                message: `Verifier 未通过任务验收：${verificationResult.issues.join("；")}。已返回 Planner 重新规划收尾步骤。`,
                timing: eventTiming("planning"),
              }, clock, {
                verification: verificationResult,
                executionPlan,
                executionTiming: executionTiming("planning"),
              });
              wallClock.throwIfFault();
              continue;
            }
            verification = failHarnessTaskVerification(verificationResult);
            executionPlan = finishHarnessExecutionPlan(executionPlan, "failed");
            const verificationMessage = `Verifier 未通过任务验收：${verification.issues.join("；")}。正式 AppSpec 未修改。`;
            task = appendHarnessEvent(task, {
              type: "error",
              state: "failed",
              message: verificationMessage,
            }, clock, {
              error: verificationMessage,
              resultMessage: verificationMessage,
              verification,
              executionPlan,
              terminationCode: "verificationFailed",
              totalDurationMs: elapsedMs(),
              executionTiming: executionTiming("failed"),
            });
            wallClock.throwIfFault();
            return task;
          }
          executionPlan = finishHarnessExecutionPlan(executionPlan, "completed");
          task = appendHarnessEvent(task, {
            type: "state",
            state: "completed",
            message: `Verifier 已通过任务验收。${resultMessage}`,
          }, clock, {
            resultMessage,
            workingMemory: selection.workingMemory,
            executionPlan,
            verification,
            terminationCode: "completed",
            totalDurationMs: elapsedMs(),
            executionTiming: executionTiming("completed"),
          });
          wallClock.throwIfFault();
          return task;
        }
        if (turn.type === "blocked") {
          const recoveryMayBlock = recovery
            && (recovery.failureKind === "precondition"
              || recovery.sameCallFailureCount >= MAX_HARNESS_IDENTICAL_TOOL_FAILURES
              || recovery.attempt >= recovery.maxAttempts);
          if (selection.toolNames.length > 0 && !recoveryMayBlock) {
            failureTerminationCode = "protocolViolation";
            throw new StudioValidationError("Harness 模型协议失败", ["仍有可用工具时模型不得跳过检查并宣告缺少条件。"]);
          }
          const verifiedAggregateAnswer = verifiedEdsAggregateAnswer(request, observations);
          if (verifiedAggregateAnswer) {
            const verificationResult = await verifyCandidate({ outcome: "completed", message: verifiedAggregateAnswer });
            if (verificationResult.status !== "passed") {
              verification = failHarnessTaskVerification(verificationResult);
              failureTerminationCode = "verificationFailed";
              throw new StudioValidationError("Harness Verifier 未通过任务验收", verification.issues);
            }
            failedAttempts = failedAttempts.map((attempt) => attempt.status === "recovering"
              ? { ...attempt, status: "recovered" as const }
              : attempt);
            executionPlan = finishHarnessExecutionPlan(executionPlan, "completed");
            task = appendHarnessEvent(task, {
              type: "state",
              state: "completed",
              message: `Verifier 已通过任务验收。${verifiedAggregateAnswer}`,
            }, clock, {
              resultMessage: verifiedAggregateAnswer,
              workingMemory: buildHarnessWorkingMemory(request, observations, iteration, failedAttempts, semanticIntent),
              executionPlan,
              verification,
              terminationCode: "completed",
              totalDurationMs: elapsedMs(),
              executionTiming: executionTiming("completed"),
            });
            wallClock.throwIfFault();
            return task;
          }
          if (recoveryMayBlock) {
            failedAttempts = failedAttempts.map((attempt) => attempt.status === "recovering"
              ? { ...attempt, status: "exhausted" as const }
              : attempt);
          }
          const missing = turn.missingRequirements.map(userFacingMissingRequirement).join("、");
          const blockedMessage = `${sanitizeHarnessText(turn.message)} 缺少：${missing}。正式 AppSpec 未修改。`;
          executionPlan = finishHarnessExecutionPlan(executionPlan, "blocked");
          task = appendHarnessEvent(task, {
            type: "state",
            state: "blocked",
            message: blockedMessage,
          }, clock, {
            error: blockedMessage,
            resultMessage: blockedMessage,
            workingMemory: buildHarnessWorkingMemory(request, observations, iteration, failedAttempts, semanticIntent),
            executionPlan,
            terminationCode: "missingRequirements",
            totalDurationMs: elapsedMs(),
            executionTiming: executionTiming("blocked"),
          });
          wallClock.throwIfFault();
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
        if (!selection.toolNames.includes(toolName) || !executionPlan.allowedTools.includes(toolName)) {
          failureTerminationCode = "invalidTool";
          throw new StudioValidationError("Harness Executor 工具状态校验失败", [
            `当前规划状态不允许调用工具：${toolName}；Executor 不得越过 Planner 步骤`,
          ]);
        }
        const callFingerprint = toolCallFingerprint(toolName, toolAction.arguments);
        const priorSameCallFailures = failedToolCalls.get(callFingerprint) ?? 0;
        if (priorSameCallFailures >= MAX_HARNESS_IDENTICAL_TOOL_FAILURES) {
          failedAttempts = failedAttempts.map((attempt) => attempt.toolName === toolName && attempt.status === "recovering"
              ? { ...attempt, status: "exhausted" as const }
              : attempt);
          executionPlan = syncHarnessExecutionPlan(executionPlan, observations, [], failedAttempts, {
            failedTool: toolName,
            failureKind: "repeatedCall",
            attempt: MAX_HARNESS_TOOL_RECOVERY_ATTEMPTS,
            maxAttempts: MAX_HARNESS_TOOL_RECOVERY_ATTEMPTS,
            sameCallFailureCount: priorSameCallFailures,
            issueSummary: [`相同参数已经失败 ${priorSameCallFailures} 次`],
          });
          task = {
            ...task,
            workingMemory: buildHarnessWorkingMemory(request, observations, iteration, failedAttempts, semanticIntent),
            executionPlan,
          };
          failureTerminationCode = "toolExecutionFailed";
          throw new StudioValidationError("Harness 恢复规划已停止重复调用", [
            `工具 ${toolName} 使用相同参数在本任务中已经失败 ${priorSameCallFailures} 次`,
            "请更换参数、改用替代工具，或补充缺失的外部条件",
          ]);
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
        wallClock.throwIfFault();
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
              ...(options.rawWorkbook ? { rawWorkbook: options.rawWorkbook } : {}),
            }),
            toolBudgetMs,
            controller.signal,
            toolBudgetMs < bounds.toolCallTimeoutMs
              ? "Harness 总执行时间预算已在工具调用期间用尽。"
              : `Harness 单次工具调用已超过 ${bounds.toolCallTimeoutMs} ms 限制。`,
            () => abortError(controller.signal),
          );
        } catch (toolError) {
          const failedMeasurement = phaseDuration(toolStarted);
          const failedDurationMs = failedMeasurement.durationMs;
          toolDurationMs += failedDurationMs;
          const sameCallFailureCount = priorSameCallFailures + 1;
          failedToolCalls.set(callFingerprint, sameCallFailureCount);
          const failureKind = toolFailureKind(toolError);
          const issueSummary = toolFailureIssues(toolError);
          const canRepairArguments = toolError instanceof HarnessToolArgumentsError
            && !controller.signal.aborted
            && !failedMeasurement.error
            && toolArgumentRepairCount < MAX_HARNESS_TOOL_ARGUMENT_REPAIRS
            && toolRecoveryCount < MAX_HARNESS_TOOL_RECOVERY_ATTEMPTS
            && task.counters.modelCallCount < bounds.maxModelCalls
            && task.counters.toolCallCount < bounds.maxToolCalls
            && remainingMs() > 0;
          if (canRepairArguments) {
            toolArgumentRepairCount += 1;
            toolRecoveryCount += 1;
            toolCorrection = {
              toolName,
              attempt: toolArgumentRepairCount,
              maxAttempts: MAX_HARNESS_TOOL_ARGUMENT_REPAIRS,
              issueSummary,
            };
            recovery = {
              failedTool: toolName,
              failureKind,
              attempt: toolRecoveryCount,
              maxAttempts: MAX_HARNESS_TOOL_RECOVERY_ATTEMPTS,
              sameCallFailureCount,
              issueSummary,
            };
            failedAttempts = [...failedAttempts, {
              toolName,
              failureKind,
              attempt: sameCallFailureCount,
              issueSummary,
              status: "recovering" as const,
            }].slice(-6);
            executionPlan = syncHarnessExecutionPlan(executionPlan, observations, selection.toolNames, failedAttempts, recovery);
            task = appendHarnessEvent(task, {
              type: "toolCall",
              state: "observing",
              message: `工具 ${toolName} 的参数未通过校验，Harness 将按当前 Schema 自动修正一次，并重新规划（${toolRecoveryCount}/${MAX_HARNESS_TOOL_RECOVERY_ATTEMPTS}）。`,
              toolCall: {
                id: toolAction.toolCallId,
                name: toolName,
                status: "failure",
                durationMs: failedDurationMs,
              },
              timing: eventTiming("planning", failedDurationMs),
            }, clock, {
              workingMemory: buildHarnessWorkingMemory(request, observations, iteration, failedAttempts, semanticIntent),
              executionPlan,
              executionTiming: executionTiming("planning"),
            });
            wallClock.throwIfFault();
            continue;
          }
          const canRecoverExecution = !(toolError instanceof HarnessToolArgumentsError)
            && !controller.signal.aborted
            && !failedMeasurement.error
            && toolRecoveryCount < MAX_HARNESS_TOOL_RECOVERY_ATTEMPTS
            && task.counters.modelCallCount < bounds.maxModelCalls
            && task.counters.toolCallCount < bounds.maxToolCalls
            && remainingMs() > 0;
          if (canRecoverExecution) {
            toolRecoveryCount += 1;
            toolCorrection = undefined;
            recovery = {
              failedTool: toolName,
              failureKind,
              attempt: toolRecoveryCount,
              maxAttempts: MAX_HARNESS_TOOL_RECOVERY_ATTEMPTS,
              sameCallFailureCount,
              issueSummary,
            };
            failedAttempts = [...failedAttempts, {
              toolName,
              failureKind,
              attempt: sameCallFailureCount,
              issueSummary,
              status: "recovering" as const,
            }].slice(-6);
            executionPlan = syncHarnessExecutionPlan(executionPlan, observations, selection.toolNames, failedAttempts, recovery);
            failureTerminationCode = "toolExecutionFailed";
            task = appendHarnessEvent(task, {
              type: "toolCall",
              state: "observing",
              message: `工具 ${toolName} 执行失败：${issueSummary.join("；")}。Harness 正在恢复并重新规划（${toolRecoveryCount}/${MAX_HARNESS_TOOL_RECOVERY_ATTEMPTS}）。`,
              toolCall: {
                id: toolAction.toolCallId,
                name: toolName,
                status: "failure",
                durationMs: failedDurationMs,
              },
              timing: eventTiming("planning", failedDurationMs),
            }, clock, {
              workingMemory: buildHarnessWorkingMemory(request, observations, iteration, failedAttempts, semanticIntent),
              executionPlan,
              executionTiming: executionTiming("planning"),
            });
            wallClock.throwIfFault();
            continue;
          }
          failedAttempts = [...failedAttempts, {
            toolName,
            failureKind,
            attempt: sameCallFailureCount,
            issueSummary,
            status: "exhausted" as const,
          }].slice(-6);
          executionPlan = syncHarnessExecutionPlan(executionPlan, observations, [], failedAttempts, {
            failedTool: toolName,
            failureKind,
            attempt: Math.max(1, toolRecoveryCount),
            maxAttempts: MAX_HARNESS_TOOL_RECOVERY_ATTEMPTS,
            sameCallFailureCount,
            issueSummary,
          });
          failureTerminationCode = controller.signal.aborted ? "cancelled" : "toolExecutionFailed";
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
          }, clock, {
            workingMemory: buildHarnessWorkingMemory(request, observations, iteration, failedAttempts, semanticIntent),
            executionPlan,
            executionTiming: executionTiming("failed"),
          });
          throw toolError;
        }
        const measured = phaseDuration(toolStarted);
        if (measured.error) throw measured.error;
        const durationMs = measured.durationMs;
        toolDurationMs += durationMs;
        toolCorrection = undefined;
        if (recovery) {
          const recoveringIndex = failedAttempts.findLastIndex((attempt) => attempt.status === "recovering");
          if (recoveringIndex >= 0) {
            failedAttempts = failedAttempts.map((attempt, index) => index === recoveringIndex
              ? { ...attempt, status: "recovered" as const }
              : attempt);
          }
        }
        recovery = undefined;
        observations.push({ toolCallId: toolAction.toolCallId, toolName, summary: result.summary, data: result.data });
        const observedTools = new Set(observations.map((observation) => observation.toolName));
        const nextPlannedTools = executionPlan.steps
          .flatMap((step) => step.kind === "tool" && step.toolName && !observedTools.has(step.toolName) ? [step.toolName] : [])
          .slice(0, 1);
        executionPlan = syncHarnessExecutionPlan(executionPlan, observations, nextPlannedTools, failedAttempts);
        task = appendHarnessEvent(task, {
          type: "observation",
          state: "observing",
          message: result.summary,
          toolCall: { id: toolAction.toolCallId, name: toolName, status: "success", durationMs },
          timing: eventTiming("planning", durationMs),
        }, clock, {
          workingMemory: buildHarnessWorkingMemory(request, observations, iteration, failedAttempts, semanticIntent),
          executionPlan,
          executionTiming: executionTiming("planning"),
        });
        wallClock.throwIfFault();
        if (toolName === "inspectFields") {
          const blockingReason = requiredDataFieldsBlockingReason(request);
          if (blockingReason) {
            executionPlan = finishHarnessExecutionPlan(executionPlan, "blocked");
            task = appendHarnessEvent(task, {
              type: "state",
              state: "blocked",
              message: blockingReason,
            }, clock, {
              error: blockingReason,
              resultMessage: blockingReason,
              executionPlan,
              terminationCode: "missingDataFields",
              totalDurationMs: elapsedMs(),
              executionTiming: executionTiming("blocked"),
            });
            wallClock.throwIfFault();
            return task;
          }
        }
        if (result.pendingChangeSet) {
          const resultMessage = sanitizeHarnessText(turn.message);
          const verificationResult = await verifyCandidate({
            outcome: "awaitingConfirmation",
            message: resultMessage,
            pendingChangeSet: result.pendingChangeSet,
          });
          if (verificationResult.status !== "passed") {
            verification = failHarnessTaskVerification(verificationResult);
            failureTerminationCode = "verificationFailed";
            throw new StudioValidationError("Harness Verifier 未通过 ChangeSet 验收", verification.issues);
          }
          task = taskWithPendingChangeSet(task, result.pendingChangeSet);
          executionPlan = finishHarnessExecutionPlan(executionPlan, "awaitingConfirmation");
          task = appendHarnessEvent(task, {
            type: "confirmation",
            state: "awaitingConfirmation",
            message: "Verifier 已通过任务验收；ChangeSet 已生成，Harness 已暂停并等待用户预览确认。",
          }, clock, {
            resultMessage,
            executionPlan,
            verification,
            terminationCode: "awaitingConfirmation",
            totalDurationMs: elapsedMs(),
            executionTiming: executionTiming("awaitingConfirmation"),
          });
          wallClock.throwIfFault();
          return task;
        }
        if (result.exportArtifact) {
          const resultMessage = `分析已完成，Excel“${result.exportArtifact.fileName}”可以下载。正式 AppSpec 未修改。`;
          const verificationResult = await verifyCandidate({
            outcome: "completed",
            message: resultMessage,
            exportArtifact: result.exportArtifact,
          });
          if (verificationResult.status !== "passed") {
            verification = failHarnessTaskVerification(verificationResult);
            failureTerminationCode = "verificationFailed";
            throw new StudioValidationError("Harness Verifier 未通过导出物验收", verification.issues);
          }
          executionPlan = finishHarnessExecutionPlan(executionPlan, "completed");
          task = appendHarnessEvent(task, {
            type: "state",
            state: "completed",
            message: `Verifier 已通过任务验收。Excel 已生成：${result.exportArtifact.fileName}（${result.exportArtifact.rowCount} 行、${result.exportArtifact.fieldCount} 个字段）。`,
          }, clock, {
            exportArtifact: result.exportArtifact,
            resultMessage,
            executionPlan,
            verification,
            terminationCode: "completed",
            totalDurationMs: elapsedMs(),
            executionTiming: executionTiming("completed"),
          });
          wallClock.throwIfFault();
          return task;
        }
        task = appendHarnessEvent(task, {
          type: "state",
          state: "planning",
          message: "已接收工具观察结果，继续规划下一步。",
          timing: eventTiming("planning"),
        }, clock, { executionTiming: executionTiming("planning") });
        wallClock.throwIfFault();
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
      executionPlan = finishHarnessExecutionPlan(executionPlan, cancelled ? "cancelled" : "failed");
      task = appendHarnessEvent(task, {
        type: cancelled ? "state" : "error",
        state: cancelled ? "cancelled" : "failed",
        message,
      }, clock, {
        error: message,
        resultMessage: cancelled ? "任务已取消，正式 AppSpec 未修改。" : "任务失败，正式 AppSpec 未修改。",
        executionPlan,
        ...(verification.attempt > 0 ? { verification } : {}),
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
  settled: boolean;
}

export class HarnessIdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();

  constructor(
    private readonly maxEntries = 100,
    private readonly ttlMs = 10 * 60_000,
    private readonly clock: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new HarnessRequestError("Harness 幂等存储边界不合法。");
    }
  }

  private currentTime(): number {
    let now: number;
    try {
      now = this.clock();
    } catch {
      throw new HarnessRequestError("Harness 幂等存储时钟必须返回非负安全整数毫秒时间戳。");
    }
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new HarnessRequestError("Harness 幂等存储时钟必须返回非负安全整数毫秒时间戳。");
    }
    return now;
  }

  execute(request: HarnessRequest, factory: () => Promise<HarnessTaskSummary>, namespace = "default"): Promise<HarnessTaskSummary> {
    const fingerprint = JSON.stringify({ ...request, idempotencyKey: undefined });
    const now = this.currentTime();
    for (const [key, entry] of this.entries) {
      if (entry.settled && now - entry.createdAt >= this.ttlMs) this.entries.delete(key);
    }
    const storageKey = `${namespace}:${request.idempotencyKey}`;
    const existing = this.entries.get(storageKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new HarnessIdempotencyConflictError();
      return existing.task;
    }
    if (this.entries.size >= this.maxEntries) {
      const settledKey = [...this.entries].find(([, entry]) => entry.settled)?.[0];
      if (!settledKey) throw new HarnessIdempotencyCapacityError();
      this.entries.delete(settledKey);
    }
    const task = factory();
    const entry: IdempotencyEntry = { fingerprint, task, createdAt: now, settled: false };
    this.entries.set(storageKey, entry);
    void task.then(
      () => { entry.settled = true; },
      () => { entry.settled = true; },
    );
    return task;
  }

  clear() {
    this.entries.clear();
  }
}
