import { z } from "zod";
import { validateChangeSetAgainstAppSpec } from "@/core/changesets";
import { StudioValidationError } from "@/core/schemas";
import { readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import {
  aiPlanRequestSchema,
  DEFAULT_DEEPSEEK_MODEL,
  type AiPlanMetadata,
  type AiPlanRequest,
  type AiPlanSuccess,
  type AiTokenUsage,
} from "../contracts";
import {
  buildModelPlanJsonSchema,
  compileModelPlanDraft,
  modelPlanDraftSchema,
  sanitizedStudioIssues,
  sanitizedZodIssues,
  type SanitizedAiValidationIssue,
} from "../operation-output";
import { buildPlannerContext, DEEPSEEK_CHANGESET_SYSTEM_PROMPT } from "../planner-context";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_CHAT_COMPLETIONS_URL = `${DEEPSEEK_BASE_URL}/chat/completions`;
export const DEFAULT_DEEPSEEK_TIMEOUT_MS = 20_000;
export const MAX_DEEPSEEK_RESPONSE_BYTES = 512 * 1024;
export const DEEPSEEK_PLANNER_TOKEN_BUDGET = {
  maxPromptTokens: 12_000,
  maxCompletionTokens: 3_000,
} as const;

export type AiPlannerErrorCode =
  | "not_configured"
  | "invalid_request"
  | "permission_denied"
  | "invalid_output"
  | "cancelled"
  | "timeout"
  | "authentication_failed"
  | "insufficient_balance"
  | "rate_limited"
  | "service_unavailable";

export class AiPlannerError extends Error {
  constructor(
    readonly code: AiPlannerErrorCode,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly metadata?: AiPlanMetadata,
  ) {
    super(message);
    this.name = "AiPlannerError";
  }
}

const deepSeekUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
}).strip();

const deepSeekChatResponseSchema = z.object({
  model: z.string().min(1).optional(),
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable().optional() }).strip(),
  }).strip()).min(1),
  usage: deepSeekUsageSchema.optional(),
}).strip();

interface CompletionResult {
  content: string;
  model: string;
  usage: AiTokenUsage;
}

export interface DeepSeekPlannerOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  clock?: () => number;
  idFactory?: () => string;
}

class UnparseableCandidateError extends Error {
  readonly issues: SanitizedAiValidationIssue[] = [{ stage: "json_parse", path: "root", code: "invalid_json" }];

  constructor() {
    super("Model candidate is not valid JSON");
    this.name = "UnparseableCandidateError";
  }
}

class CandidateValidationError extends Error {
  constructor(readonly issues: SanitizedAiValidationIssue[]) {
    super("Parsed model candidate did not pass validation");
    this.name = "CandidateValidationError";
  }
}

function emptyUsage(): AiTokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function addUsage(left: AiTokenUsage, right: AiTokenUsage): AiTokenUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function usageFromProvider(
  value: z.infer<typeof deepSeekUsageSchema> | undefined,
  requestedCompletionTokens: number,
): AiTokenUsage {
  const promptTokens = value?.prompt_tokens;
  const completionTokens = value?.completion_tokens;
  const totalTokens = value?.total_tokens;
  if (
    promptTokens === undefined
    || completionTokens === undefined
    || totalTokens === undefined
    || totalTokens !== promptTokens + completionTokens
    || promptTokens > DEEPSEEK_PLANNER_TOKEN_BUDGET.maxPromptTokens
    || completionTokens > requestedCompletionTokens
  ) {
    throw new AiPlannerError("service_unavailable", "DeepSeek 未返回可信的 token 用量，已安全停止。", 503, false);
  }
  return { promptTokens, completionTokens, totalTokens };
}

function assertPlannerUsageBudget(usage: AiTokenUsage): void {
  if (
    usage.promptTokens > DEEPSEEK_PLANNER_TOKEN_BUDGET.maxPromptTokens
    || usage.completionTokens > DEEPSEEK_PLANNER_TOKEN_BUDGET.maxCompletionTokens
  ) {
    throw new AiPlannerError("service_unavailable", "DeepSeek token 用量已达到本次规划硬上限，已安全停止。", 503, false);
  }
}

function mapUpstreamStatus(status: number): AiPlannerError {
  if (status === 401) return new AiPlannerError("authentication_failed", "DeepSeek 密钥无效，请联系管理员检查配置。", 502, false);
  if (status === 402) return new AiPlannerError("insufficient_balance", "DeepSeek 账户余额不足，请联系管理员。", 503, false);
  if (status === 429) return new AiPlannerError("rate_limited", "AI 请求过于频繁，请稍后重试。", 429, true);
  if (status >= 400 && status < 500) {
    return new AiPlannerError("service_unavailable", "DeepSeek 接口拒绝了本次请求，请联系管理员检查模型或接口配置。", 502, false);
  }
  return new AiPlannerError("service_unavailable", "DeepSeek 服务暂时不可用，请稍后重试。", 503, true);
}

async function requestJsonObject(
  messages: Array<{ role: "system" | "user"; content: string }>,
  apiKey: string,
  model: string,
  options: DeepSeekPlannerOptions,
  maxCompletionTokens: number = DEEPSEEK_PLANNER_TOKEN_BUDGET.maxCompletionTokens,
): Promise<CompletionResult> {
  if (options.signal?.aborted) {
    throw new AiPlannerError("cancelled", "AI 请求已取消。", 408, true);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_DEEPSEEK_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_DEEPSEEK_TIMEOUT_MS) {
    throw new AiPlannerError("invalid_request", `DeepSeek 单次超时必须是 1–${DEFAULT_DEEPSEEK_TIMEOUT_MS} 毫秒的整数。`, 400, false);
  }
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await (options.fetchImpl ?? fetch)(DEEPSEEK_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        response_format: { type: "json_object" },
        stream: false,
        temperature: 0.1,
        max_tokens: maxCompletionTokens,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw mapUpstreamStatus(response.status);
    const providerBody = await readBoundedUtf8Body(response, MAX_DEEPSEEK_RESPONSE_BYTES)
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => null);
    const parsed = deepSeekChatResponseSchema.safeParse(providerBody);
    if (!parsed.success) {
      throw new AiPlannerError("service_unavailable", "DeepSeek 返回了无法识别的响应。", 503, true);
    }
    const content = parsed.data.choices[0].message.content?.trim();
    if (!content) throw new AiPlannerError("service_unavailable", "DeepSeek 没有返回可解析的内容。", 503, true);
    return {
      content,
      model: parsed.data.model ?? model,
      usage: usageFromProvider(parsed.data.usage, maxCompletionTokens),
    };
  } catch (error) {
    if (error instanceof AiPlannerError) throw error;
    if (timedOut) throw new AiPlannerError("timeout", "DeepSeek 请求超时，请稍后重试。", 504, true);
    if (options.signal?.aborted || controller.signal.aborted) {
      throw new AiPlannerError("cancelled", "AI 请求已取消。", 408, true);
    }
    throw new AiPlannerError("service_unavailable", "无法连接 DeepSeek 服务，请稍后重试。", 503, true);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function parseAndCompileCandidate(
  content: string,
  request: AiPlanRequest,
  compiledAt: number,
  idFactory: () => string,
): { message: string; changeSet: AiPlanSuccess["changeSet"] } {
  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch {
    throw new UnparseableCandidateError();
  }
  const parsed = modelPlanDraftSchema.safeParse(raw);
  if (!parsed.success) throw new CandidateValidationError(sanitizedZodIssues(parsed.error, raw));

  let changeSet: AiPlanSuccess["changeSet"];
  try {
    changeSet = compileModelPlanDraft(parsed.data, request.instruction, {
      now: () => compiledAt,
      idFactory,
    });
  } catch {
    throw new CandidateValidationError([{ stage: "compile", path: "operations", code: "trusted_field_compilation_failed" }]);
  }

  let workingSpec = request.appSpec;
  for (let index = 0; index < changeSet.operations.length; index += 1) {
    try {
      workingSpec = validateChangeSetAgainstAppSpec(workingSpec, {
        ...changeSet,
        operations: [changeSet.operations[index]],
      }, { role: request.role, intent: "apply" });
    } catch (error) {
      if (error instanceof StudioValidationError) {
        throw new CandidateValidationError(sanitizedStudioIssues(error, [parsed.data.operations[index]], index));
      }
      throw error;
    }
  }
  return { message: parsed.data.message, changeSet };
}

function repairMessages(
  request: AiPlanRequest,
  outputSchema: Record<string, unknown>,
  issues: SanitizedAiValidationIssue[],
) {
  return [
    { role: "system" as const, content: `${DEEPSEEK_CHANGESET_SYSTEM_PROMPT}\n这是唯一一次受控修复机会。` },
    {
      role: "user" as const,
      content: JSON.stringify({
        instruction: request.instruction,
        validationIssueSummary: issues,
        allowedStructure: outputSchema,
      }),
    },
  ];
}

function metadata(
  model: string,
  startedAt: number,
  clock: () => number,
  usage: AiTokenUsage,
  repairAttempted: boolean,
  validationIssues?: SanitizedAiValidationIssue[],
  preservePrimaryError = false,
): AiPlanMetadata {
  return {
    model,
    durationMs: plannerDurationMs(startedAt, clock, preservePrimaryError),
    usage,
    repairAttempted,
    transport: "chat_json_object",
    ...(validationIssues ? { validationIssues } : {}),
  };
}

function readPlannerClock(clock: () => number): number {
  let value: number;
  try {
    value = clock();
  } catch {
    throw new AiPlannerError("service_unavailable", "AI 规划计时时钟必须返回安全整数毫秒时间戳。", 503, false);
  }
  if (!Number.isSafeInteger(value)) {
    throw new AiPlannerError("service_unavailable", "AI 规划计时时钟必须返回安全整数毫秒时间戳。", 503, false);
  }
  return value;
}

function plannerDurationMs(startedAt: number, clock: () => number, preservePrimaryError: boolean): number {
  try {
    const elapsed = readPlannerClock(clock) - startedAt;
    const durationMs = Math.round(elapsed);
    if (elapsed < 0 || !Number.isSafeInteger(durationMs) || durationMs < 0) {
      throw new AiPlannerError("service_unavailable", "AI 规划计时时钟无法生成非负安全整数毫秒耗时。", 503, false);
    }
    return durationMs;
  } catch (error) {
    if (preservePrimaryError) return 0;
    throw error;
  }
}

export async function planChangeSetWithDeepSeek(
  rawRequest: unknown,
  options: DeepSeekPlannerOptions = {},
): Promise<AiPlanSuccess> {
  const requestResult = aiPlanRequestSchema.safeParse(rawRequest);
  if (!requestResult.success) {
    throw new AiPlannerError("invalid_request", "AI 规划请求格式不正确，请检查指令和页面上下文。", 400, false);
  }
  const request = requestResult.data;
  if (request.role === "viewer") {
    throw new AiPlannerError("permission_denied", "查看者只能查看和预览，不能生成可编辑 ChangeSet。", 403, false);
  }
  const apiKey = options.apiKey?.trim();
  if (!apiKey) throw new AiPlannerError("not_configured", "AI 服务尚未配置。", 503, false);

  const model = options.model?.trim() || DEFAULT_DEEPSEEK_MODEL;
  const clock = options.clock ?? Date.now;
  const startedAt = readPlannerClock(clock);
  const idFactory = options.idFactory ?? (() => crypto.randomUUID().replaceAll("-", ""));
  const outputSchema = buildModelPlanJsonSchema(request);
  const context = buildPlannerContext(request);
  const initialMessages = [
    { role: "system" as const, content: DEEPSEEK_CHANGESET_SYSTEM_PROMPT },
    { role: "user" as const, content: JSON.stringify(context) },
  ];

  const first = await requestJsonObject(initialMessages, apiKey, model, options);
  let usage = addUsage(emptyUsage(), first.usage);
  try {
    assertPlannerUsageBudget(usage);
  } catch (error) {
    if (error instanceof AiPlannerError) {
      throw new AiPlannerError(error.code, error.message, error.status, error.retryable, metadata(first.model, startedAt, clock, usage, false, undefined, true));
    }
    throw error;
  }

  try {
    const plan = parseAndCompileCandidate(first.content, request, startedAt, idFactory);
    return { ...plan, metadata: metadata(first.model, startedAt, clock, usage, false) };
  } catch (error) {
    if (error instanceof UnparseableCandidateError) {
      throw new AiPlannerError(
        "invalid_output",
        "AI 未返回有效 JSON，未继续重试。请调整指令后再试。",
        422,
        true,
        metadata(first.model, startedAt, clock, usage, false, error.issues, true),
      );
    }
    if (!(error instanceof CandidateValidationError)) throw error;
    const firstIssues = error.issues;
    const remainingCompletionTokens = DEEPSEEK_PLANNER_TOKEN_BUDGET.maxCompletionTokens - usage.completionTokens;
    if (remainingCompletionTokens < 1) {
      throw new AiPlannerError(
        "invalid_output",
        "AI 首次输出已用尽 completion token 预算，未继续修复。",
        422,
        false,
        metadata(first.model, startedAt, clock, usage, false, firstIssues, true),
      );
    }

    let repair: CompletionResult;
    try {
      repair = await requestJsonObject(
        repairMessages(request, outputSchema, firstIssues),
        apiKey,
        model,
        options,
        remainingCompletionTokens,
      );
    } catch (repairRequestError) {
      if (repairRequestError instanceof AiPlannerError) {
        throw new AiPlannerError(
          repairRequestError.code,
          repairRequestError.message,
          repairRequestError.status,
          repairRequestError.retryable,
          metadata(first.model, startedAt, clock, usage, true, firstIssues, true),
        );
      }
      throw repairRequestError;
    }
    usage = addUsage(usage, repair.usage);
    try {
      assertPlannerUsageBudget(usage);
    } catch (error) {
      if (error instanceof AiPlannerError) {
        throw new AiPlannerError(
          error.code,
          error.message,
          error.status,
          error.retryable,
          metadata(repair.model, startedAt, clock, usage, true, firstIssues, true),
        );
      }
      throw error;
    }
    try {
      const plan = parseAndCompileCandidate(repair.content, request, startedAt, idFactory);
      return { ...plan, metadata: metadata(repair.model, startedAt, clock, usage, true, firstIssues) };
    } catch (repairError) {
      if (repairError instanceof AiPlannerError) throw repairError;
      const finalIssues = repairError instanceof CandidateValidationError || repairError instanceof UnparseableCandidateError
        ? repairError.issues
        : firstIssues;
      throw new AiPlannerError(
        "invalid_output",
        "AI 在一次受控修复后仍未生成合法变更操作，请调整指令后重试。",
        422,
        true,
        metadata(repair.model, startedAt, clock, usage, true, finalIssues, true),
      );
    }
  }
}
