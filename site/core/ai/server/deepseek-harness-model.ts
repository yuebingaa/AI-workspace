import { z } from "zod";
import { DEEPSEEK_CHAT_COMPLETIONS_URL, MAX_DEEPSEEK_RESPONSE_BYTES } from "./deepseek-endpoint";
import { readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import { NOTEBOOK_CONTEXT_SELECTION_RULE } from "@/core/notebook/context-selection";
import {
  harnessSemanticIntentDecisionSchema, harnessDynamicPlanDecisionSchema,
  type HarnessModel, type HarnessSemanticIntentInput, type HarnessSemanticIntentResult,
  type HarnessPlannerInput, type HarnessPlannerResult, type HarnessModelInput, type HarnessModelResult,
} from "@/core/harness/contracts";
import { HarnessModelFormatError, HarnessModelProtocolError } from "@/core/harness/model-errors";
import {
  HARNESS_SEMANTIC_ROUTER_PROMPT, HARNESS_DYNAMIC_PLANNER_PROMPT,
} from "@/core/harness/model-policy";
import { withinModelLimit } from "@/core/harness/model-limits";
import { createModelHarnessExecutionPlan } from "@/core/harness/execution-planner";
import { normalizeHarnessModelTurn } from "@/core/harness/action-normalizer";
import { harnessSystemPrompt } from "@/core/harness/context-selector";
import { failureExplanationInstruction } from "@/core/harness/failure-response";
import { sanitizeHarnessText } from "@/core/harness/security";

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

export class DeepSeekProviderProtocolError extends HarnessModelProtocolError {
  readonly code = "provider_model_mismatch" as const;

  constructor() {
    super("DeepSeek 返回的模型标识与本次服务端配置不一致。");
    this.name = "DeepSeekProviderProtocolError";
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

async function deepSeekResponseError(response: Response): Promise<Error> {
  const rawDetail = await readBoundedUtf8Body(response, 16 * 1024)
    .then((text) => {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } };
      return typeof parsed.error?.message === "string" ? parsed.error.message : "";
    })
    .catch(() => "");
  const detail = sanitizeHarnessText(rawDetail).slice(0, 300);
  const suffix = detail ? `：${detail}` : "";
  if (response.status === 400) return new Error(`DeepSeek 拒绝了本次请求（HTTP 400）${suffix || "：请求格式或模型上下文不受支持。"}`);
  if (response.status === 401) return new Error("DeepSeek 认证失败。");
  if (response.status === 402) return new Error("DeepSeek 账户余额不足。");
  if (response.status === 403) return new Error(`DeepSeek 拒绝访问当前模型${suffix}。`);
  if (response.status === 404) return new Error(`DeepSeek 当前模型不存在或暂不可用${suffix}。`);
  if (response.status === 408 || response.status === 504) return new Error(`DeepSeek 请求超时（HTTP ${response.status}）${suffix}。`);
  if (response.status === 429) return new Error(`DeepSeek 请求过于频繁${suffix}。`);
  return new Error(`DeepSeek 服务暂时不可用（HTTP ${response.status}）${suffix}。`);
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
    const maxCompletionTokens = options.maxCompletionTokens;
    if (
      maxCompletionTokens !== undefined
      && (!Number.isSafeInteger(maxCompletionTokens) || maxCompletionTokens < 1)
    ) {
      throw new Error("DeepSeek 显式输出 token 上限必须是正整数。");
    }
    if (
      options.promptTokenLimit !== undefined
      && (!Number.isSafeInteger(options.promptTokenLimit) || options.promptTokenLimit < 1)
    ) {
      throw new Error("DeepSeek 显式输入 token 上限必须是正整数。");
    }
  }

  async classifyIntent(input: HarnessSemanticIntentInput): Promise<HarnessSemanticIntentResult> {
    const maxCompletionTokens = this.options.maxCompletionTokens;
    const payload = {
      instruction: input.instruction,
      hasNotebookContext: input.hasNotebookContext ?? false,
      ...(input.notebookSelection ? { notebookSelection: input.notebookSelection, notebookSelectionRule: NOTEBOOK_CONTEXT_SELECTION_RULE } : {}),
      ...(input.previousInstruction ? { previousInstruction: input.previousInstruction } : {}),
      ...(input.previousAssistantMessage ? { previousAssistantMessage: input.previousAssistantMessage } : {}),
      ...(input.conversationBrief ? { conversationBrief: input.conversationBrief } : {}),
      page: input.page,
      dataSources: input.dataSources,
      ...(input.semanticModel ? { semanticModel: input.semanticModel } : {}),
      capabilities: {
        hasEdsWorkspace: input.hasEdsWorkspace,
        hasRawWorkbookAccess: input.hasRawWorkbookAccess,
        hasVisualVerification: input.hasVisualVerification,
        hasUploadedImageEvidence: Boolean(input.userImageEvidence),
        role: input.role,
        pageChangesRequireConfirmation: true,
      },
      ...(input.mcpTools?.length ? { mcpTools: input.mcpTools } : {}),
      outputSchema: {
        mode: ["conversation", "readOnlyTask", "changePreview"],
        requiresVisualVerification: "boolean",
        booleans: ["wantsData", "wantsEdsAnalysis", "wantsRawWorkbook", "wantsFields", "wantsRecipe", "wantsAppInspection", "wantsExcel", "wantsMcpTool", "wantsNotebook", "wantsAnalysisPlan"],
        changeAction: ["none", "add", "update", "remove", "move"],
        changeTarget: ["none", "workspace", "genericComponent", "chart", "edsBreakdownChart", "edsLineIssueChart", "edsTable"],
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
    if (!response.ok) throw await deepSeekResponseError(response);
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
    const promptLimit = this.options.promptTokenLimit ?? null;
    if (
      promptTokens === undefined
      || completionTokens === undefined
      || totalTokens === undefined
      || totalTokens !== promptTokens + completionTokens
      || !withinModelLimit(completionTokens, maxCompletionTokens ?? null)
      || !withinModelLimit(promptTokens, promptLimit)
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

  async plan(input: HarnessPlannerInput): Promise<HarnessPlannerResult> {
    const maxCompletionTokens = this.options.maxCompletionTokens;
    const payload = {
      instruction: input.instruction,
      semanticIntent: input.semanticIntent,
      ...(input.inputInspection ? { inputInspection: input.inputInspection } : {}),
      ...(input.conversationBrief ? { conversationBrief: input.conversationBrief } : {}),
      preflightEvidence: input.evidence,
      activeSkills: input.activeSkills,
      availableTools: input.availableTools,
      fallbackPlan: {
        requiredToolSequence: input.fallbackPlan.steps.flatMap((step) => step.kind === "tool" && step.toolName ? [step.toolName] : []),
        finalObjective: input.fallbackPlan.steps.find((step) => step.kind === "finalize")?.objective,
      },
    };
    const inputChars = HARNESS_DYNAMIC_PLANNER_PROMPT.length + JSON.stringify(payload).length;
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
          { role: "system", content: HARNESS_DYNAMIC_PLANNER_PROMPT },
          { role: "user", content: JSON.stringify(payload) },
        ],
      }),
      signal: input.signal,
    });
    if (!response.ok) throw await deepSeekResponseError(response);
    const raw = await readBoundedUtf8Body(response, MAX_DEEPSEEK_RESPONSE_BYTES)
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => null);
    const provider = providerResponseSchema.safeParse(raw);
    if (!provider.success) throw new Error("DeepSeek 返回了无法识别的动态规划响应。");
    if (provider.data.model !== undefined && provider.data.model !== this.options.model) throw new DeepSeekProviderProtocolError();
    const content = provider.data.choices[0].message.content;
    if (!content) throw new Error("DeepSeek 未返回动态任务计划。");
    const rawUsage = provider.data.usage;
    const promptTokens = rawUsage?.prompt_tokens;
    const completionTokens = rawUsage?.completion_tokens;
    const totalTokens = rawUsage?.total_tokens;
    const promptLimit = this.options.promptTokenLimit ?? null;
    if (
      promptTokens === undefined
      || completionTokens === undefined
      || totalTokens === undefined
      || totalTokens !== promptTokens + completionTokens
      || !withinModelLimit(completionTokens, maxCompletionTokens ?? null)
      || !withinModelLimit(promptTokens, promptLimit)
    ) throw new Error("DeepSeek 动态规划未返回可信的 token 用量，已降级为安全规则计划。");
    const decision = harnessDynamicPlanDecisionSchema.safeParse(parseHarnessJsonContent(content));
    if (!decision.success) throw new Error("DeepSeek 动态任务计划未通过 Schema 校验。");
    return {
      plan: createModelHarnessExecutionPlan(input.instruction, input.fallbackPlan, decision.data),
      model: this.options.model,
      usage: { promptTokens, completionTokens, totalTokens },
      inputChars,
    };
  }

  async next(input: HarnessModelInput): Promise<HarnessModelResult> {
    const maxCompletionTokens = this.options.maxCompletionTokens;
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
            content: input.purpose === "failureExplanation" ? failureExplanationInstruction
              : harnessSystemPrompt(input.iteration, input.context.wecomContinuation === true, input.context.notebookSearchContinuation === true),
          },
          {
            role: "user",
            content: JSON.stringify({ ...input.context, tools: input.tools }),
          },
        ],
      }),
      signal: input.signal,
    });
    if (!response.ok) throw await deepSeekResponseError(response);
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
    const promptLimit = this.options.promptTokenLimit ?? null;
    const invalidUsage = promptTokens === undefined
      || completionTokens === undefined
      || totalTokens === undefined
      || totalTokens !== promptTokens + completionTokens
      || !withinModelLimit(completionTokens, maxCompletionTokens ?? null)
      || !withinModelLimit(promptTokens, promptLimit);
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
