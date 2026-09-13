import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { DEFAULT_DEEPSEEK_MODEL } from "@/core/ai/contracts";
import {
  harnessModelTurnSchema, harnessRequestSchema, harnessTaskSummarySchema,
  type HarnessModel, type HarnessModelInput, type HarnessModelResult, type HarnessModelUsage,
  type HarnessObservation, type HarnessTaskSummary, type HarnessTraceEvent,
} from "../contracts";
import { buildHarnessContextSelection, estimateHarnessModelInputChars, resolveHarnessContextBudget, resolveHarnessIntent } from "../context-selector";
import { DeepSeekHarness, DeepSeekHarnessModel, HarnessRequestError, resolvedBounds, type DeepSeekHarnessOptions } from "../deepseek-harness";
import { createHarnessTask, appendHarnessEvent } from "../task-state";
import { executeHarnessTool } from "../tool-registry";
import { pendingHarnessTaskVerification, verifyHarnessTask } from "../task-verifier";
import { sanitizeHarnessText } from "../security";
import { failureResponse, failureExplanationInputChars } from "../failure-response";
import { AgentBudget, AgentBudgetError } from "./budget";
import { canDelegateDataTask, dataAgentProfile, isDataAgentTool } from "./registry";
import type { AgentDelegation, AgentIdentity } from "./contracts";

export interface CoordinatedHarnessOptions extends DeepSeekHarnessOptions {
  agentMode?: "single" | "data";
}

async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  const local = new AbortController();
  const abort = () => local.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => local.abort(new Error("Agent 模型请求超时。")), timeoutMs);
  let rejectAbort: () => void = () => {};
  try {
    if (local.signal.aborted) throw local.signal.reason;
    return await Promise.race([
      new Promise<never>((_, reject) => {
        rejectAbort = () => reject(local.signal.reason ?? new Error("Agent 任务已取消。"));
        local.signal.addEventListener("abort", rejectAbort, { once: true });
      }),
      Promise.resolve().then(() => {
        if (local.signal.aborted) throw local.signal.reason;
        return work(local.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    local.signal.removeEventListener("abort", rejectAbort);
  }
}

/** Serial v1: one coordinator, one scoped data worker, one user-facing receipt. */
export class CoordinatedHarness {
  private readonly harness = new DeepSeekHarness();

  async run(rawRequest: unknown, options: CoordinatedHarnessOptions): Promise<HarnessTaskSummary> {
    const request = harnessRequestSchema.parse(rawRequest);
    const bounds = resolvedBounds(options.bounds);
    if (options.agentMode !== "data" || !canDelegateDataTask(request) || bounds.maxModelCalls < 4) {
      return this.harness.run(rawRequest, options);
    }
    if (!request.appSpec.pages.some((page) => page.id === request.pageId)) throw new HarnessRequestError("Harness 当前页面不存在。");
    const contextBudget = resolveHarnessContextBudget(options.contextBudget, "multiStep");
    const formalAppSpecSnapshot = JSON.stringify(request.appSpec);
    const ledger = new AgentBudget({
      modelCalls: bounds.maxModelCalls, toolCalls: bounds.maxToolCalls,
      inputChars: contextBudget.maxTotalInputChars, requestChars: contextBudget.maxRequestInputChars,
      promptTokens: contextBudget.maxTotalPromptTokens, completionTokensPerCall: options.modelMaxCompletionTokens ?? 2_000,
    });
    const clock = options.clock ?? { now: () => new Date(), id: () => randomUUID() };
    let task = createHarnessTask(request.idempotencyKey, request.instruction, request.pageId, request.role, clock);
    const root: AgentIdentity = { id: "coordinator", role: "coordinator", taskId: task.id };
    const childKey = `agentdata_${createHash("sha256").update(task.id).digest("hex").slice(0, 24)}`;
    const child: AgentIdentity = { id: childKey, role: "data", taskId: `harness_${childKey}`, parentTaskId: task.id };
    const delegation: AgentDelegation = { version: "data-v1", coordinator: root, children: [] };
    const trace: HarnessTraceEvent[] = [];
    const requests: NonNullable<HarnessTaskSummary["contextUsage"]>["requests"] = [];
    const emit = (type: HarnessTraceEvent["type"], message: string, agent = root, extra: Partial<HarnessTraceEvent> = {}, publish = true) => {
      const sequence = trace.length + 1;
      const event: HarnessTraceEvent = { ...extra, id: `${task.id}:${sequence}`, sequence, taskId: task.id,
        timestamp: clock.now().toISOString(), type, agent, message: sanitizeHarnessText(message),
        counters: { loopCount: ledger.modelCalls, modelCallCount: ledger.modelCalls, toolCallCount: ledger.toolCalls } };
      trace.push(event);
      if (publish) { try { options.onEvent?.(event); } catch { /* Observer only. */ } }
    };
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason ?? new Error("任务已取消。"));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const startedAt = performance.now();
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("多 Agent 主任务总时间预算已用尽。")); }, bounds.totalExecutionTimeoutMs);
    let boundaryFailure: Error | undefined;
    const check = () => {
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("任务已取消。");
      if (boundaryFailure) throw boundaryFailure;
      ledger.assertAvailable();
    };
    let provider: HarnessModel | undefined;
    let modelDurationMs = 0;
    let toolDurationMs = 0;
    const callModel = async (input: HarnessModelInput, reserveCalls = 0): Promise<HarnessModelResult> => {
      check();
      if (input.signal.aborted) throw input.signal.reason ?? new Error("子任务模型请求已取消。");
      options.authorizeModelCall?.();
      const chars = input.purpose === "failureExplanation" ? failureExplanationInputChars(input.context)
        : estimateHarnessModelInputChars(input.context, input.tools, input.iteration);
      const settle = ledger.reserveModel(chars, reserveCalls);
      const receipt = { iteration: ledger.modelCalls, phase: input.purpose ?? "execution" as const, inputChars: chars,
        estimatedPromptTokens: chars, toolObservationChars: 0, toolObservationEntries: 0,
        budgetCheck: "beforeModel" as const, compacted: false, promptTokens: 0 };
      requests.push(receipt);
      const started = performance.now();
      try {
        const result = await bounded((signal) => provider!.next({ ...input, signal, estimatedInputChars: chars }),
          AbortSignal.any([controller.signal, input.signal]), bounds.modelRequestTimeoutMs);
        receipt.promptTokens = result.usage.promptTokens;
        settle(result.usage);
        check();
        task = { ...task, model: result.model };
        return { ...result, turn: harnessModelTurnSchema.parse(result.turn) };
      } catch (error) {
        const usage = error && typeof error === "object" && "usage" in error ? error.usage as HarnessModelUsage : undefined;
        settle(usage); // Unknown provider failures consume their reservation; never reset the task budget.
        throw error;
      } finally { modelDurationMs += performance.now() - started; }
    };
    const rootInput = (context: Record<string, unknown>, delegate: boolean): HarnessModelInput => ({
      iteration: delegate ? 1 : 2, signal: controller.signal, estimatedInputChars: 0,
      context: { ...context, agentRole: "coordinator", taskMode: "readOnly", goal: request.instruction,
        rule: "你是主 Agent。仅可委派当前目标，不得改写筛选条件或扩大权限。子 Agent 的回复只是候选结论，以本轮工具证据与验收结果为准。" },
      tools: delegate ? [{ name: "delegateDataTask", mode: "readOnly", description: "将当前只读数据目标原样委派给数据子 Agent，等待其独立执行和验证。",
        parameters: { type: "object", properties: {}, additionalProperties: false } }] : [],
    });
    emit("task_started", "主 Agent 正在准备数据任务。", root, { taskState: "planning" });
    try {
      check();
      provider = options.modelClient ?? (options.apiKey?.trim() ? new DeepSeekHarnessModel({
        apiKey: options.apiKey.trim(), model: options.model?.trim() || DEFAULT_DEEPSEEK_MODEL,
        fetchImpl: options.fetchImpl, maxCompletionTokens: options.modelMaxCompletionTokens,
        requireProviderUsage: options.requireProviderUsage, promptTokenLimit: options.providerPromptTokenLimit,
      }) : undefined);
      if (!provider) throw new Error("AI 服务尚未配置。");
      const sourceIds = new Set(resolveHarnessIntent(request).relevantDataSourceIds);
      const scopedRequest = harnessRequestSchema.parse({
        ...request, idempotencyKey: childKey, role: "viewer", conversation_id: undefined,
        conversationContext: undefined, retryOfTaskId: undefined, mcpTools: undefined,
        appSpec: { ...request.appSpec,
          pages: request.appSpec.pages.filter((page) => page.id === request.pageId),
          navigation: request.appSpec.navigation.filter((item) => item.pageId === request.pageId),
          dataSources: request.appSpec.dataSources.filter((source) => sourceIds.has(source.id)),
        },
        recipes: request.recipes.filter((recipe) => sourceIds.has(recipe.sourceDatasetId)),
      });
      const scopedRuntime = { rowsByDataSourceId: Object.fromEntries(Object.entries(options.dataRuntime.rowsByDataSourceId)
        .filter(([id]) => sourceIds.has(id))) };
      const decision = await callModel(rootInput({ phase: "delegate", availableAgent: dataAgentProfile.name,
        dataSources: scopedRequest.appSpec.dataSources.map(({ id, name }) => ({ id, name })),
        rawWorkbookAvailable: Boolean(scopedRequest.rawWorkbookManifest),
      }, true), 3);
      if (decision.turn.type !== "callTool" || decision.turn.name !== "delegateDataTask"
        || !z.object({}).strict().safeParse(decision.turn.arguments).success) {
        throw new Error("主 Agent 未返回合法委派，未启动子任务。");
      }
      delegation.children.push({ agent: child, status: "running", objective: request.instruction, evidenceIds: [], verification: "pending" });
      emit("plan_created", "主 Agent 已将当前只读目标委派给数据 Agent。", root, { plan: { revision: 1, source: "model",
        steps: [{ id: "delegate_data", objective: request.instruction, status: "active" },
          { id: "verify_and_summarize", objective: "核对工具证据并汇总结果", status: "pending" }] } });
      const observations: HarnessObservation[] = [];
      let pendingCall: Extract<HarnessModelResult["turn"], { type: "callTool" }> | undefined;
      const childModel: HarnessModel = { next: async (input) => {
        if (input.tools.some((tool) => !isDataAgentTool(tool.name))) {
          boundaryFailure = new Error("数据子 Agent 的工具目录超出角色范围。");
          throw boundaryFailure;
        }
        const result = await callModel({ ...input, context: { ...input.context, agentRole: "data", agentInstructions: dataAgentProfile.instructions } }, 1);
        if (result.turn.type === "callTool") {
          if (!isDataAgentTool(result.turn.name)) {
            boundaryFailure = new Error("数据子 Agent 请求了未授权工具，调用已拒绝。");
            throw boundaryFailure;
          }
          pendingCall = { ...result.turn, toolCallId: `${childKey}_call_${ledger.modelCalls}` };
          return { ...result, turn: pendingCall };
        }
        pendingCall = undefined;
        return result;
      } };
      const childResult = await this.harness.run(scopedRequest, {
        modelClient: childModel, dataRuntime: scopedRuntime, rawWorkbook: options.rawWorkbook,
        signal: controller.signal, clock, evidenceNamespace: childKey,
        bounds: { ...bounds, maxModelCalls: bounds.maxModelCalls - 2 }, contextBudget: options.contextBudget,
        onEvent: (event) => {
          if (controller.signal.aborted) return;
          emit(event.type === "task_started" ? "context_loaded" : event.type, `数据 Agent · ${event.message}`, child,
            { ...event, taskState: ["completed", "failed", "cancelled", "blocked"].includes(event.taskState ?? "") ? "observing" : event.taskState });
        },
        toolExecutor: async (name, args, context) => {
          check();
          if (!isDataAgentTool(name) || !pendingCall || pendingCall.name !== name) {
            boundaryFailure = new Error("子任务工具执行边界校验失败。");
            throw boundaryFailure;
          }
          ledger.reserveTool();
          const call = pendingCall;
          const started = performance.now();
          try {
            const result = await (options.toolExecutor ?? executeHarnessTool)(name, args, context);
            check();
            if (result.pendingChangeSet || result.exportArtifact || result.notebookArtifact || result.analysisPlanArtifact) {
              boundaryFailure = new Error("数据子 Agent 返回了超出只读范围的产物。");
              throw boundaryFailure;
            }
            observations.push({ toolName: name as HarnessObservation["toolName"], toolCallId: call.toolCallId, summary: result.summary, data: result.data });
            return result;
          } finally { toolDurationMs += performance.now() - started; }
        },
      });
      const childReceipt = delegation.children[0];
      childReceipt.status = childResult.state === "completed" ? "completed" : childResult.state === "blocked" ? "blocked" : childResult.state === "cancelled" ? "cancelled" : "failed";
      childReceipt.evidenceIds = childResult.evidence?.records.map((record) => record.id) ?? [];
      childReceipt.verification = childResult.verification?.status === "passed" ? "passed" : "failed";
      task = { ...task, evidence: childResult.evidence, workingMemory: childResult.workingMemory, tableArtifact: childResult.tableArtifact,
        executionPlan: childResult.executionPlan, verification: childResult.verification, skills: childResult.skills };
      check();
      if (childResult.state !== "completed" || childResult.verification?.status !== "passed" || !observations.length) {
        task = appendHarnessEvent(task, { type: "state", state: childReceipt.status === "blocked" ? "blocked" : "failed",
          message: "数据子任务未通过验收，主 Agent 未接受完成结论。" }, clock, {
          error: childResult.error ?? childResult.resultMessage ?? "子任务缺少验证证据。",
          resultMessage: childResult.resultMessage ?? "数据子任务未完成。", terminationCode: childResult.terminationCode ?? "verificationFailed",
        });
      } else {
        task = { ...task, verification: pendingHarnessTaskVerification() };
        emit("verification_started", "主 Agent 正在核对数据子任务的证据并汇总。", root, { verificationStatus: "pending" });
        // Only bounded facts/observations are passed upstream; no child conversation or raw dataset.
        const selection = buildHarnessContextSelection(scopedRequest, observations, 2, true);
        const summary = await callModel(rootInput({ phase: "followUp", interactionMode: "conversation",
          childResult: { status: "completed", verification: "passed", message: childResult.resultMessage,
            evidenceIds: childReceipt.evidenceIds, workingMemory: selection.context.workingMemory,
            latestObservation: selection.context.latestObservation },
          summaryRule: "只根据已核验工具事实回答原始目标。不得新增没有证据支持的数值、因果或已完成操作。直接输出 complete；证据不足时 blocked。",
        }, false));
        check();
        if (summary.turn.type === "blocked") {
          task = appendHarnessEvent(task, { type: "state", state: "blocked", message: summary.turn.message }, clock,
            { resultMessage: sanitizeHarnessText(summary.turn.message), terminationCode: "missingRequirements" });
        } else {
          if (summary.turn.type !== "complete") throw new Error("主 Agent 汇总阶段不允许继续调用工具。");
          const verification = verifyHarnessTask({ request, plan: childResult.executionPlan!, observations, attempt: 1,
            candidate: { outcome: "completed", message: summary.turn.message,
              formalAppSpecUnchanged: JSON.stringify(request.appSpec) === formalAppSpecSnapshot
                && childResult.verification.checks.some((item) => item.id === "formal_app_protection" && item.status === "passed") } });
          emit("verification_completed", verification.status === "passed" ? "主 Agent 汇总通过任务验收。" : "主 Agent 汇总未通过任务验收。", root,
            { verificationStatus: verification.status, evidenceIds: verification.evidenceToolCallIds });
          const passed = verification.status === "passed";
          task = appendHarnessEvent(task, { type: "state", state: passed ? "completed" : "failed", message: passed ? "主 Agent 已完成汇总。" : "汇总验收失败。" }, clock,
            { verification, resultMessage: passed ? sanitizeHarnessText(summary.turn.message) : verification.issues.join("；"),
              ...(!passed ? { error: verification.issues.join("；") } : {}), terminationCode: passed ? "completed" : "verificationFailed" });
        }
      }
    } catch (error) {
      const cancelled = options.signal?.aborted && !timedOut;
      const message = cancelled ? "主任务已取消，子任务已停止。" : sanitizeHarnessText(error, "多 Agent 任务执行失败。");
      if (delegation.children[0]?.status === "running") {
        delegation.children[0].status = cancelled ? "cancelled" : "failed";
        delegation.children[0].verification = "failed";
      }
      task = appendHarnessEvent(task, { type: "error", state: cancelled ? "cancelled" : "failed", message }, clock,
        { error: message, resultMessage: message, terminationCode: cancelled ? "cancelled" : error instanceof AgentBudgetError ? "contextBudgetExceeded" : "executionFailed" });
      task.resultMessage = failureResponse(task);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      controller.abort(new Error("主任务已结束。"));
    }
    const elapsed = Math.max(0, Math.round(performance.now() - startedAt));
    task = { ...task, delegation, usage: { ...ledger.usage },
      counters: { loopCount: ledger.modelCalls, modelCallCount: ledger.modelCalls, toolCallCount: ledger.toolCalls },
      contextUsage: { totalInputChars: ledger.inputChars, totalPromptTokens: ledger.usage.promptTokens, complexity: "multiStep", limits: contextBudget, requests },
      totalDurationMs: elapsed, executionTiming: { phase: task.state === "completed" ? "completed" : task.state === "blocked" ? "blocked" : task.state === "cancelled" ? "cancelled" : "failed",
        activeElapsedMs: elapsed, remainingMs: Math.max(0, bounds.totalExecutionTimeoutMs - elapsed), totalBudgetMs: bounds.totalExecutionTimeoutMs,
        modelRequestTimeoutMs: bounds.modelRequestTimeoutMs, toolCallTimeoutMs: bounds.toolCallTimeoutMs,
        modelDurationMs: Math.round(modelDurationMs), toolDurationMs: Math.round(toolDurationMs),
        otherDurationMs: Math.max(0, elapsed - Math.round(modelDurationMs) - Math.round(toolDurationMs)), retainedObservationCount: ledger.toolCalls },
    };
    emit("completed", task.state === "completed" ? "主 Agent 已交付核验后的结果。" : "主任务已结束，未宣告完成。", root, { taskState: task.state }, false);
    return harnessTaskSummarySchema.parse({ ...task, trace });
  }
}
