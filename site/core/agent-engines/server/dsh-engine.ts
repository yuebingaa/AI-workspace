import {
  harnessModelUsageSchema, harnessRequestSchema, harnessTaskSummarySchema,
  harnessToolNameSchema, type HarnessModelUsage, type HarnessRequest, type HarnessTaskSummary, type HarnessTraceEvent,
} from "@/core/harness/contracts";
import { inputInspectionMessage, inspectHarnessInput } from "@/core/harness/input-inspector";
import { createNotebookToolBridge, type NotebookToolBridge } from "@/core/harness/server/notebook-tool-bridge";
import { notebookBridgePreflightMessage } from "@/core/harness/server/bridge-preflight";
import { sanitizeHarnessText } from "@/core/harness/security";
import { appendHarnessEvent, createHarnessTask } from "@/core/harness/task-state";
import { HarnessToolArgumentsError } from "@/core/harness/tool-registry";
import { cellSearchSchema } from "@/core/harness/notebook-cell-search";
import { buildNotebookSearchIndex } from "@/core/notebook/search";
import { resolveDshExecutionPolicy, type DshExecutionPolicy } from "./execution-policy";
import type { AuthorizedAgentDataPorts } from "./authorized-ports";
import { buildDshContext } from "./dsh-context";
import { formatDshDraftDelivery } from "./dsh-delivery";
import { dshConversationCapabilityNotice, dshConversationNeedsDraft, verifyDshConversationDelivery } from "./dsh-conversation-delivery";
import { dshToolErrorMessage, trustedNotebookSearchFailure } from "./tool-error-message";
import { canDeliverDshExistingAnalysisAnswer, isDshExistingAnalysisRequest, resolveDshReadonlyMode,
  verifyDshReadonlyAnswer, type DshAnalysisToolAttempt, type DshReadonlyObservation } from "./readonly-answer";

export interface DshDriverTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: unknown, callSignal?: AbortSignal): Promise<{ summary: string; data: unknown }>;
}

export interface DshDriverInput {
  /** Server composition only; never chosen by model text or a public flag. */
  profile?: "notebook" | "conversation";
  /** A private, per-turn staging lease; never parsed from the public request. */
  nativeSession?: DshNativeSessionBinding;
  instruction: string;
  context: Record<string, unknown>;
  tools: DshDriverTool[];
  signal: AbortSignal;
  authorizeCurrentAccess(): void;
  /** A trusted transport calls this before an actual model request, not from model text. */
  onModelCall(): void;
}

export interface DshDriverResult {
  finalResponse?: string;
  model?: string;
  usage?: HarnessModelUsage;
}

/** SDK/process transport is composed outside this business adapter. */
export type DshDriver = (input: DshDriverInput) => Promise<DshDriverResult>;

export interface DshNativeSessionBinding {
  sessionId: string;
  root: string;
  mode: "create" | "resume";
}

export interface DshEngineOptions extends AuthorizedAgentDataPorts, Partial<DshExecutionPolicy> {
  conversationMode?: boolean;
  nativeSession?: DshNativeSessionBinding;
  authorizeCurrentAccess(): void;
  signal?: AbortSignal;
  onEvent?(event: HarnessTraceEvent): void;
  driver: DshDriver;
}

async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("DSH 任务已中止。"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Keep the existing UI/task protocol while DSH, not HarnessRuntime, owns the model loop. */
export async function runDshEngine(rawRequest: HarnessRequest, options: DshEngineOptions): Promise<HarnessTaskSummary> {
  const request = harnessRequestSchema.parse(structuredClone(rawRequest));
  // Discovery metadata is not an execution port. Only expose the server-owned
  // connection catalog when the corresponding business capability is composed.
  // The HTTP authorization closure still owns and rechecks the original scope.
  if (request.notebookContext && !options.connectionInspector) delete request.notebookContext.connections;
  const notebookCapabilities = options.notebookCapabilities ?? {
    python: { enabled: false, reason: "DSH 未接入本部署的 Python 能力策略。" },
  };
  const policy = resolveDshExecutionPolicy(options);
  const conversationMode = options.conversationMode === true;
  const readonlyMode = conversationMode ? undefined : resolveDshReadonlyMode(request);
  const existingAnalysis = !conversationMode && !readonlyMode && isDshExistingAnalysisRequest(request);
  const totalTimeout = policy.totalExecutionTimeoutMs, toolTimeout = policy.toolCallTimeoutMs;
  const clock = { now: () => new Date(), id: () => crypto.randomUUID() };
  let task = createHarnessTask(request.idempotencyKey, request.instruction, request.pageId, request.role, clock,
    { ...(request.retryOfTaskId ? { retryOfTaskId: request.retryOfTaskId } : {}) });
  const formal = JSON.stringify({ appSpec: request.appSpec, notebook: request.notebookContext?.document });
  const parameterCellIds = request.notebookContext?.document.cells.filter(cell => cell.kind === "parameter").map(cell => cell.id) ?? [];
  const trace: HarnessTraceEvent[] = [];
  let traceSequence = 0;
  const liveCellTitles = new Map(request.notebookContext?.document.cells.map(cell => [cell.id, cell.title]) ?? []);
  const controller = new AbortController();
  let ended = false;
  let timedOut = false;
  let toolTimedOut = false;
  let toolLimitReached = false;
  let authorizationRejected = false;
  let initializingBridge = false;
  let bridge: NotebookToolBridge | undefined;
  let toolsUnavailable: string | undefined;
  const successfulCalls: string[] = [];
  const observations: DshReadonlyObservation[] = [];
  const failedTools: string[] = [];
  const attempts: DshAnalysisToolAttempt[] = [];
  const startedAt = performance.now();
  const remainingBudget = () => ({ ...policy, toolCallsUsed: task.counters.toolCallCount,
    toolCallsRemaining: policy.maxToolCalls === null ? null : Math.max(0, policy.maxToolCalls - task.counters.toolCallCount),
    remainingMs: totalTimeout === null ? null : Math.max(0, Math.floor(totalTimeout - (performance.now() - startedAt))) });
  const abort = () => controller.abort(new Error("DSH 请求已取消。"));
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timer = totalTimeout === null ? undefined : setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("DSH 总执行时间已超限。"));
  }, totalTimeout);
  const check = () => {
    if (ended || controller.signal.aborted) throw new Error("DSH 任务已经结束或中止。");
    try { options.authorizeCurrentAccess(); }
    catch (error) {
      authorizationRejected = true;
      controller.abort(new Error("DSH 数据授权已失效。"));
      throw error;
    }
  };
  const emit = (type: HarnessTraceEvent["type"], message: string, details: Partial<HarnessTraceEvent> = {}) => {
    if (ended) return;
    const sequence = ++traceSequence;
    const event: HarnessTraceEvent = { ...details, id: `${task.id}:${sequence}`, sequence, taskId: task.id,
      timestamp: clock.now().toISOString(), type, message: sanitizeHarnessText(message), counters: { ...task.counters } };
    // Live code/results are window-local projections, never persisted in task history.
    const savedEvent = { ...event };
    delete savedEvent.notebookProgress;
    trace.push(savedEvent);
    // Retain a bounded UI snapshot, not an execution cap. SSE emits every event.
    if (trace.length > 256) trace.shift();
    try { options.onEvent?.(structuredClone(event)); } catch { /* A UI observer cannot change execution. */ }
  };
  emit("task_started", conversationMode ? "DSH 正在接收本轮对话。" : readonlyMode ? "DSH 正在准备只读 Notebook 说明。" : "DSH 正在准备受控 Notebook 分析。", { taskState: "planning",
    clientTimeoutMs: totalTimeout === null ? null : totalTimeout + 5_000 });
  try {
    check();
    initializingBridge = true;
    try {
      bridge = createNotebookToolBridge({ profile: "notebook", request, dataRuntime: options.dataRuntime,
        notebookRunner: options.notebookRunner, rawWorkbook: options.rawWorkbook, notebookCapabilities,
        pythonRuntimeInfo: options.pythonRuntimeInfo, connectionInspector: options.connectionInspector,
        signal: controller.signal, authorizeCurrentAccess: check,
        onProgress(progress) {
          check();
          const update = progress.update;
          if (update.kind === "draft") for (const cell of update.document.cells) liveCellTitles.set(cell.id, cell.title);
          const cellId = update.kind === "cell_started" ? update.cellId : update.kind === "cell_finished" ? update.result.cellId
            : update.kind === "draft" ? update.changedCellIds[0] : undefined;
          const status = update.kind === "draft" ? "edited" : update.kind === "run_started" ? "queued"
            : update.kind === "cell_started" ? "running" : update.kind === "cell_finished" ? update.result.status : update.status;
          const message = update.kind === "draft" ? `草稿 v${progress.editVersion} 已同步到 Notebook，尚未保存。`
            : update.kind === "run_started" ? `正在试运行草稿 v${progress.editVersion}，共 ${update.cellIds.length} 个单元。`
            : update.kind === "run_finished" ? update.status === "success" ? "本次草稿试运行通过，等待任务最终核验。" : "本次试运行存在失败，请查看对应单元。"
            : `${status === "running" ? "正在运行" : status === "success" ? "已完成" : status === "blocked" ? "上游失败，已阻断" : "执行失败"}：${liveCellTitles.get(cellId!) ?? cellId}`;
          emit("status_update", message, { notebookProgress: progress, notebookStatus: status,
            notebookEditVersion: progress.editVersion, ...(cellId ? { notebookCellId: cellId } : {}),
            ...("runId" in update ? { notebookRunId: update.runId } : {}) });
        } });
    } catch (error) {
      check();
      toolsUnavailable = conversationMode ? dshConversationCapabilityNotice(error) : undefined;
      if (!toolsUnavailable) throw error;
    }
    initializingBridge = false;
    const parameterSourceEvidence = readonlyMode?.parameterInspection && request.notebookContext
      ? { baseRevision: request.notebookContext.document.revision,
        sourceById: buildNotebookSearchIndex(request.notebookContext.document).sourceById } : undefined;
    const context = buildDshContext({ request, capabilities: notebookCapabilities,
      readonlyMode, existingAnalysis, conversationMode, toolsUnavailable, budget: remainingBudget() });
    emit("context_loaded", inputInspectionMessage(inspectHarnessInput(request)), { taskState: "planning" });
    const catalog = (bridge?.catalog() ?? []).filter((tool) => !readonlyMode || tool.name === "cellSearch"
      || (readonlyMode.allowRun && tool.name === "runNotebookCells"));
    const tools: DshDriverTool[] = catalog.map((tool) => ({
      name: tool.name, description: readonlyMode && tool.name === "runNotebookCells"
        ? "按当前editVersion在隔离环境复核已有Notebook，不修改定义。success时results已含本次实际输出样本；足以回答则直接回答，缺少所需输出再用cellSearch(view=output)，不提交草稿。failure时如实停止，不伪报结果。"
        : tool.description, parameters: structuredClone(tool.parameters),
      async execute(args, callSignal) {
        check();
        if (policy.maxToolCalls !== null && task.counters.toolCallCount >= policy.maxToolCalls) {
          toolLimitReached = true;
          controller.abort(new Error("DSH 工具调用次数已达到执行保护上限。"));
          throw new Error("DSH 工具调用次数已达到执行保护上限。");
        }
        const name = harnessToolNameSchema.parse(tool.name);
        const attempt: DshAnalysisToolAttempt = { toolName: name, status: "running" };
        if (existingAnalysis || conversationMode) attempts.push(attempt);
        const callId = `${task.id}_tool_${task.counters.toolCallCount + 1}`.slice(-160);
        task = appendHarnessEvent(task, { type: "toolCall", state: "executingTool", message: `执行工具：${name}`,
          toolCall: { id: callId, name, status: "running", durationMs: 0 } }, clock,
        { counters: { ...task.counters, toolCallCount: task.counters.toolCallCount + 1 } });
        emit("tool_started", `DSH 调用 ${name}。`, { taskState: "executingTool", toolCall: { id: callId, name, status: "running", durationMs: 0 } });
        const started = performance.now();
        const local = new AbortController();
        const signal = callSignal ? AbortSignal.any([controller.signal, local.signal, callSignal])
          : AbortSignal.any([controller.signal, local.signal]);
        const toolTimer = toolTimeout === null ? undefined : setTimeout(() => {
          toolTimedOut = true;
          local.abort(new Error("DSH 单次工具执行超时。"));
          controller.abort(new Error("DSH 单次工具执行超时。"));
        }, toolTimeout);
        try {
          const result = await bridge!.execute(name, args, signal);
          check();
          const observation = structuredClone(result.data);
          if (typeof observation !== "object" || observation === null || Array.isArray(observation)) {
            throw new Error("DSH 工具观察格式无效。");
          }
          attempt.status = "success";
          if (readonlyMode || existingAnalysis || conversationMode) observations.push({ toolCallId: callId, toolName: name, data: structuredClone(observation),
            ...(readonlyMode?.parameterInspection && name === "cellSearch" ? { sourceOffset: cellSearchSchema.parse(args).sourceOffset } : {}) });
          const durationMs = Math.max(0, Math.round(performance.now() - started));
          const summary = readonlyMode && name === "runNotebookCells" && "status" in observation && observation.status === "success"
            ? "已有单元本次复核运行成功；可依据返回结果直接回答，缺少所需输出再补读，未修改或提交草稿。" : result.summary;
          successfulCalls.push(callId);
          task = appendHarnessEvent(task, { type: "observation", state: "observing", message: summary,
            toolCall: { id: callId, name, status: "success", durationMs } }, clock);
          emit("tool_completed", summary, { taskState: "observing", toolCall: { id: callId, name, status: "success", durationMs } });
          // Artifacts are private bridge state. Only bounded tool observations enter DSH.
          return { summary,
            data: { ...observation,
              ...(readonlyMode && name === "runNotebookCells" ? { next: "answer",
                completionNotice: "只读任务：results足以回答时直接回答；缺少所需输出才用cellSearch(view=output)补读。明确样本和截断范围，不调用提交工具。" } : {}),
              ...(existingAnalysis && name === "runNotebookCells" && "status" in observation && observation.status === "success"
                && canDeliverDshExistingAnalysisAnswer(attempts) ? { next: "answer_or_edit",
                  completionNotice: "本次仅检索并运行已有步骤。results足以回答泛指分析请求时可直接解释，缺少输出可补读；无需空编辑或提交未修改的草稿。如需新增分析，仍可编辑后真实运行并提交，等待用户采用。" } : {}),
              executionBudget: remainingBudget() } };
        } catch (error) {
          attempt.status = "failure";
          attempt.recoverableSearchFailure = name === "cellSearch" && (Boolean(trustedNotebookSearchFailure(name, error))
            || (error instanceof HarnessToolArgumentsError && error.toolName === name));
          if (readonlyMode || existingAnalysis || conversationMode) failedTools.push(name);
          if (!ended) {
            const durationMs = Math.max(0, Math.round(performance.now() - started));
            const message = dshToolErrorMessage({ name, parameters: tool.parameters, error, signal,
              authorizeCurrentAccess: check });
            task = appendHarnessEvent(task, { type: "observation", state: "observing", message,
              toolCall: { id: callId, name, status: "failure", durationMs } }, clock);
            emit("tool_failed", message, { taskState: "observing", toolCall: { id: callId, name, status: "failure", durationMs } });
          }
          throw error;
        } finally { clearTimeout(toolTimer); }
      },
    }));
    const result = await untilAborted(options.driver({ instruction: request.instruction, context, tools,
      ...(conversationMode ? { profile: "conversation" as const } : {}),
      ...(conversationMode && options.nativeSession ? { nativeSession: options.nativeSession } : {}),
      signal: controller.signal, authorizeCurrentAccess: check,
      onModelCall() {
        check();
        task = { ...task, counters: { ...task.counters,
          modelCallCount: task.counters.modelCallCount + 1, loopCount: task.counters.loopCount + 1 } };
        if (task.counters.modelCallCount === 1) emit("status_update", conversationMode ? "DSH 正在组织答复并按需选择业务工具。" : "DSH 正在调用已配置模型选择分析步骤。", { taskState: task.state });
      },
    }), controller.signal);
    check();
    if (result.usage !== undefined) {
      const usage = harnessModelUsageSchema.parse(result.usage);
      if (usage.totalTokens !== usage.promptTokens + usage.completionTokens) throw new Error("DSH 用量回执不一致。");
      task = { ...task, usage };
    }
    if (result.model !== undefined) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(result.model)) throw new Error("DSH 模型回执无效。");
      task = { ...task, model: result.model };
    }
    const unchanged = JSON.stringify({ appSpec: request.appSpec, notebook: request.notebookContext?.document }) === formal;
    // A verified draft always retains the existing human-confirmation contract.
    // Simple analysis may answer from current results only if every attempted
    // tool stayed read-only; even rejected edits disqualify this terminal option.
    const draft = readonlyMode ? undefined : bridge?.getVerifiedDraft();
    const answerMode = readonlyMode ?? (!draft && existingAnalysis && canDeliverDshExistingAnalysisAnswer(attempts)
      ? { allowRun: true, requireOutput: true } : undefined);
    if (conversationMode && !draft && !dshConversationNeedsDraft(attempts)) {
      // No phrase classifier decides whether a reply needs a Notebook. The
      // real tool ledger determines what can honestly be verified/delivered.
      const delivery = () => verifyDshConversationDelivery({ finalResponse: result.finalResponse,
        formalUnchanged: unchanged, attempts, observations, parameterCellIds,
        baseRevision: request.notebookContext?.document.revision });
      bridge?.catalog();
      const answer = delivery();
      if (attempts.length) {
        emit("verification_started", "正在核对本轮实际调用的业务工具回执。", { verificationStatus: "pending" });
        check();
        bridge?.catalog();
        const current = delivery();
        if (JSON.stringify(current) !== JSON.stringify(answer)) throw new Error("DSH 对话证据在验证时发生变化。");
        task = { ...task, verification: { attempt: 1, status: answer.valid ? "passed" : "failed",
          evidenceToolCallIds: answer.evidenceIds, issues: answer.valid ? [] : [answer.issue],
          checks: [{ id: "conversation_tool_receipts", label: "本轮业务工具回执", status: answer.valid ? "passed" : "failed",
            detail: answer.valid ? "实际工具回执检查通过；不代表逐句验证模型说明。" : answer.issue }] } };
        emit("verification_completed", answer.valid ? "本轮工具回执检查通过，正式文档未修改。" : answer.issue,
          { verificationStatus: answer.valid ? "passed" : "failed", evidenceIds: answer.evidenceIds });
      }
      check();
      bridge?.catalog();
      if (JSON.stringify(delivery()) !== JSON.stringify(answer)) throw new Error("DSH 对话证据在交付前发生变化。");
      task = appendHarnessEvent(task, { type: answer.valid ? "observation" : "error", state: answer.valid ? "completed" : "failed",
        message: answer.valid ? (answer.kind === "conversation" ? "DSH 已回复本轮对话，未执行业务操作。" : "DSH 已依据本轮工具读取作出说明。") : answer.issue }, clock,
      { resultMessage: answer.valid ? answer.message : `本轮未完成：${answer.issue}`,
        ...(answer.valid ? {} : { error: answer.issue }), terminationCode: answer.valid ? "completed" : "verificationFailed" });
    } else if (answerMode) {
      emit("verification_started", "正在核对本次只读回答的检索与运行证据。", { verificationStatus: "pending" });
      check();
      // A cancelled individual tool call closes the private bridge, even when
      // the driver catches it. Earlier evidence must not revive that session.
      bridge!.catalog();
      if (existingAnalysis && !canDeliverDshExistingAnalysisAnswer(attempts)) {
        throw new Error("DSH 已有分析回答的工具范围在验证前发生变化。");
      }
      const answer = verifyDshReadonlyAnswer({ mode: answerMode, finalResponse: result.finalResponse,
        observations, formalUnchanged: unchanged, failedTools, parameterCellIds, parameterSourceEvidence });
      task = { ...task, verification: { attempt: 1, status: answer.valid ? "passed" : "failed",
        evidenceToolCallIds: answer.evidenceIds, issues: answer.valid ? [] : [answer.issue],
        checks: [
          { id: "readonly_evidence", label: "本次只读证据", status: answer.valid ? "passed" : "failed",
            detail: answer.valid ? "已核对本次授权工具回执；不代表逐句证明模型解释正确。" : answer.issue },
          { id: "formal_app_protection", label: "正式文档保护", status: unchanged ? "passed" : "failed",
            detail: unchanged ? (readonlyMode ? "正式Notebook与看板未修改，只读工具目录不含编辑/提交。"
              : "正式Notebook与看板未修改，本任务全部工具尝试均为检索或运行。") : "正式文档发生变化，拒绝交付。" },
        ] } };
      emit("verification_completed", answer.valid ? "只读证据检查通过，未修改Notebook或看板。" : answer.issue,
        { verificationStatus: answer.valid ? "passed" : "failed", evidenceIds: answer.evidenceIds });
      check();
      bridge!.catalog();
      if (existingAnalysis && !canDeliverDshExistingAnalysisAnswer(attempts)) {
        throw new Error("DSH 已有分析回答的工具范围在交付前发生变化。");
      }
      task = appendHarnessEvent(task, { type: answer.valid ? "observation" : "error", state: answer.valid ? "completed" : "failed",
        message: answer.valid ? "已完成只读说明，正式Notebook与看板未修改。" : answer.issue }, clock,
      { resultMessage: answer.valid ? answer.message : `本次只读说明未通过证据检查：${answer.issue}`,
        ...(answer.valid ? {} : { error: answer.issue }), terminationCode: answer.valid ? "completed" : "verificationFailed" });
    } else {
      emit("verification_started", "正在核对本任务的真实草稿提交与执行回执。", { verificationStatus: "pending" });
      const valid = Boolean(draft?.executionEvidence?.status === "success" && unchanged);
      // Verification holds bounded references, not the full execution history.
      // Recent events/trace are bounded snapshots; the live stream includes all calls.
      const verificationEvidenceIds = successfulCalls.slice(-15);
      task = { ...task, verification: {
        attempt: 1, status: valid ? "passed" : "failed", evidenceToolCallIds: verificationEvidenceIds,
        checks: [
          { id: "submitted_notebook", label: "本任务提交的成功草稿", status: draft ? "passed" : "failed", detail: draft ? "业务工具已验证并提交本任务草稿。" : "没有经过本任务提交工具验证的草稿。" },
          { id: "formal_app_protection", label: "正式文档保护", status: unchanged ? "passed" : "failed", detail: unchanged ? "正式 Notebook 与 AppSpec 未修改。" : "正式文档发生变化，拒绝交付。" },
        ], issues: valid ? [] : ["尚未取得可由用户采用的本任务成功草稿。"],
      } };
      emit("verification_completed", valid ? "草稿执行与提交检查通过，等待用户采用。" : "没有可采用的成功草稿，不能宣告分析完成。",
        { verificationStatus: valid ? "passed" : "failed", evidenceIds: verificationEvidenceIds });
      if (!valid || !draft) {
        task = appendHarnessEvent(task, { type: "error", state: "failed", message: "DSH 未交付可验证的 Notebook 草稿。" }, clock,
          { resultMessage: "本次分析未产生可采用的成功草稿，正式 Notebook 与看板未修改。", error: "缺少本任务成功提交的草稿。", terminationCode: "verificationFailed" });
      } else {
        check();
        const currentDraft = bridge!.getVerifiedDraft();
        if (!currentDraft || JSON.stringify(currentDraft) !== JSON.stringify(draft)) {
          throw new Error("DSH 已核验草稿在交付前失效。");
        }
        // Model prose is presentation only; the verified artifact and event own
        // the completion/confirmation state and cannot be overridden by text.
        const message = formatDshDraftDelivery(draft, result.finalResponse);
        task = appendHarnessEvent(task, { type: "confirmation", state: "awaitingConfirmation",
          message: "草稿执行与提交检查通过，等待用户确认；正式 Notebook 与看板尚未修改。" }, clock,
          { notebookArtifact: draft, resultMessage: message, terminationCode: "awaitingConfirmation" });
      }
    }
  } catch (error) {
    const cancelled = options.signal?.aborted === true;
    const preflight = initializingBridge ? notebookBridgePreflightMessage(error) : undefined;
    const unsupported = Boolean(preflight) && !cancelled && !authorizationRejected && !timedOut && !toolTimedOut;
    const delivery = conversationMode ? "有效答复或已验证草稿" : readonlyMode ? "有效只读回答" : "可采用草稿";
    const message = cancelled ? (readonlyMode ? "DSH 只读说明已取消，正式Notebook与看板未修改。" : "DSH 分析已取消，未采用任何草稿。")
      : authorizationRejected ? "数据授权已变化，DSH 未交付结果。"
      : toolTimedOut ? `DSH 工具执行超时，未交付${delivery}。`
      : timedOut ? `DSH 分析超过执行时间保护，未交付${delivery}。`
      : toolLimitReached ? `DSH 已达到工具调用次数保护（${policy.maxToolCalls} 次），未交付${delivery}；正式 Notebook 与看板未修改。`
      : unsupported ? `DSH ${preflight}；本次未启动模型或工具，正式 Notebook 与看板未修改。`
      : initializingBridge ? "DSH 初始化失败，未能确认具体原因；本次未启动模型或工具，正式 Notebook 与看板未修改。"
      : `DSH 执行未完成，未取得${delivery}；正式 Notebook 与看板未修改。`;
    task = appendHarnessEvent(task, { type: "error", state: cancelled ? "cancelled" : unsupported ? "blocked" : "failed", message }, clock,
      { resultMessage: message, error: message, notebookArtifact: undefined,
        ...(task.verification ? { verification: { ...task.verification, status: "failed", issues: [message] } } : {}),
        terminationCode: cancelled ? "cancelled" : unsupported ? "missingRequirements" : toolTimedOut ? "toolExecutionFailed" : "executionFailed" });
  } finally {
    ended = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    bridge?.close();
    controller.abort(new Error("DSH 任务已结束。"));
  }
  // The HTTP SSE adapter alone emits the terminal frame with this validated task.
  return harnessTaskSummarySchema.parse({ ...task, trace,
    totalDurationMs: Math.max(0, Math.round(performance.now() - startedAt)) });
}
