import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { harnessPublicRequestSchema, harnessResponseSchema, type HarnessTaskSummary, type HarnessToolName } from "@/core/harness";
import { changeSetSchema } from "@/core/schemas";
import { readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { operationsMatchExactly } from "../harness-evaluator";
import {
  LIVE_HARNESS_SCHEMA_VERSION,
  LIVE_HARNESS_SUITE_ID,
  LIVE_HARNESS_SUITE_VERSION,
  assertLiveHarnessEvaluationReportSafe,
  isLiveHarnessOutputStringSafe,
  liveHarnessEvaluationReportSchema,
  liveHarnessTrustedModelSchema,
  type LiveHarnessBudget,
  type LiveHarnessBudgetUsage,
  type LiveHarnessCaseHardGates,
  type LiveHarnessCaseResult,
  type LiveHarnessEvaluationCase,
  type LiveHarnessEvaluationReport,
  type LiveHarnessFailureCode,
} from "./contracts";
import { liveHarnessGlobalBudget, liveHarnessSmokeCases } from "./manifest";

export const MAX_LIVE_HARNESS_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_LIVE_HARNESS_REQUEST_TIMEOUT_MS = 120_000;
import {
  LIVE_EVALUATION_CASE_HEADER,
  LIVE_EVALUATION_NONCE_ENV,
  LIVE_EVALUATION_NONCE_HEADER,
  LIVE_EVALUATION_RUN_HEADER,
  LIVE_EVALUATION_RUNNER_FLAG,
  LIVE_EVALUATION_SERVER_FLAG,
  LIVE_EVALUATION_SESSION_HEADER,
  LIVE_EVALUATION_SESSION_VALUE,
  isLoopbackHttpUrl,
} from "./protocol";

const execFileAsync = promisify(execFile);

const SAFE_LIVE_ERROR_MESSAGES: Record<LiveHarnessFailureCode, string> = {
  runner_gate: "Live Harness Runner 未显式启用。",
  manifest: "Live Harness 用例清单无效。",
  retry: "Live Harness 自动重试配置无效。",
  session: "Live Harness 会话标识无效。",
  loopback: "Live Harness 服务地址不安全。",
  model_budget: "Live Harness 模型调用预算不足。",
  prompt_budget: "Live Harness prompt 预算不足。",
  completion_budget: "Live Harness completion 预算不足。",
  time_budget: "Live Harness 主动执行时间预算不足。",
  invalid_usage: "Live Harness provider usage 无效。",
  case_budget: "Live Harness 单用例预算被违反。",
  fixture: "Live Harness 演示 fixture 不可用。",
  redirect: "Live Harness 拒绝 HTTP 重定向。",
  http_401: "Live Harness 请求认证失败。",
  http_403: "Live Harness 请求被拒绝。",
  http_429: "Live Harness 请求受到限流。",
  http_500: "Live Harness 服务端请求失败。",
  http_other: "Live Harness HTTP 请求失败。",
  invalid_response: "Live Harness 响应无效。",
  timeout: "Live Harness 请求超时。",
  transport: "Live Harness 本机连接失败。",
  cleanup: "Live Harness 资源清理失败。",
  server_start: "Live Harness 本地服务启动失败。",
  git: "Live Harness 无法确定 Git 提交。",
  global_budget: "Live Harness 全局预算超限。",
  model: "Live Harness 服务端模型标识无效。",
  provider_model_mismatch: "Live Harness provider 模型标识不一致。",
  hard_gate: "Live Harness 安全硬门失败。",
  report_safety: "Live Harness 报告安全断言失败。",
  internal: "Live Harness 内部执行失败。",
};

export class LiveHarnessEvaluationError extends Error {
  readonly report?: LiveHarnessEvaluationReport;

  constructor(
    readonly code: LiveHarnessFailureCode,
    messageOrReport?: string | LiveHarnessEvaluationReport,
    report?: LiveHarnessEvaluationReport,
  ) {
    super(SAFE_LIVE_ERROR_MESSAGES[code]);
    this.name = "LiveHarnessEvaluationError";
    this.report = typeof messageOrReport === "object" ? messageOrReport : report;
  }
}

export interface LiveEvaluationServer {
  baseUrl: string;
  stop(): Promise<void>;
}

export interface LiveEvaluationServerOptions {
  nonce: string;
  environment: NodeJS.ProcessEnv;
  projectRoot: string;
}

export interface LiveHarnessRunnerOptions {
  environment?: NodeJS.ProcessEnv;
  projectRoot?: string;
  fetchImpl?: typeof fetch;
  budget?: Partial<LiveHarnessBudget>;
  cases?: LiveHarnessEvaluationCase[];
  nonceFactory?: () => string;
  runIdFactory?: () => string;
  gitCommit?: string;
  serverFactory?: (options: LiveEvaluationServerOptions) => Promise<LiveEvaluationServer>;
  requestTimeoutMs?: number;
}

function emptyUsage(): LiveHarnessBudgetUsage {
  return { modelCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, activeElapsedMs: 0 };
}

function addUsage(left: LiveHarnessBudgetUsage, right: LiveHarnessBudgetUsage): LiveHarnessBudgetUsage {
  return {
    modelCalls: left.modelCalls + right.modelCalls,
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    activeElapsedMs: left.activeElapsedMs + right.activeElapsedMs,
  };
}

function remainingBudget(limits: LiveHarnessBudget, used: LiveHarnessBudgetUsage) {
  return {
    modelCalls: Math.max(0, limits.maxModelCalls - used.modelCalls),
    promptTokens: Math.max(0, limits.maxPromptTokens - used.promptTokens),
    completionTokens: Math.max(0, limits.maxCompletionTokens - used.completionTokens),
    activeElapsedMs: Math.max(0, limits.maxActiveElapsedMs - used.activeElapsedMs),
  };
}

function globalBudgetExceeded(limits: LiveHarnessBudget, used: LiveHarnessBudgetUsage): boolean {
  return used.modelCalls > limits.maxModelCalls
    || used.promptTokens > limits.maxPromptTokens
    || used.completionTokens > limits.maxCompletionTokens
    || used.activeElapsedMs > limits.maxActiveElapsedMs;
}

function httpFailureCode(status: number): LiveHarnessFailureCode {
  if (status === 401) return "http_401";
  if (status === 403) return "http_403";
  if (status === 429) return "http_429";
  if (status >= 500 && status <= 599) return "http_500";
  return "http_other";
}

function ensureReservation(
  limits: LiveHarnessBudget,
  used: LiveHarnessBudgetUsage,
  evaluationCase: LiveHarnessEvaluationCase,
) {
  const remaining = remainingBudget(limits, used);
  const required = evaluationCase.limits;
  if (remaining.modelCalls < required.maxModelCalls) throw new LiveHarnessEvaluationError("model_budget", "剩余模型调用预算不足，未发送后续用例。");
  if (remaining.promptTokens < required.promptTokenReservation) throw new LiveHarnessEvaluationError("prompt_budget", "剩余 prompt token 预算不足，未发送后续用例。");
  if (remaining.completionTokens < required.completionTokenReservation) throw new LiveHarnessEvaluationError("completion_budget", "剩余 completion token 预算不足，未发送后续用例。");
  if (remaining.activeElapsedMs < required.activeElapsedReservationMs) throw new LiveHarnessEvaluationError("time_budget", "剩余主动执行时间预算不足，未发送后续用例。");
}

function taskUsage(task: HarnessTaskSummary, evaluationCase: LiveHarnessEvaluationCase): LiveHarnessBudgetUsage {
  const usage = task.usage;
  const activeElapsedMs = task.executionTiming?.activeElapsedMs ?? task.totalDurationMs;
  const values = [
    usage?.promptTokens,
    usage?.completionTokens,
    usage?.totalTokens,
    task.counters.modelCallCount,
    task.counters.toolCallCount,
    activeElapsedMs,
  ];
  if (values.some((value) => !Number.isInteger(value) || Number(value) < 0)) {
    throw new LiveHarnessEvaluationError("invalid_usage", "服务端未返回可信的评测用量，已停止后续用例。");
  }
  if (!usage || activeElapsedMs === undefined || usage.totalTokens !== usage.promptTokens + usage.completionTokens) {
    throw new LiveHarnessEvaluationError("invalid_usage", "服务端未返回完整一致的评测用量，已停止后续用例。");
  }
  if (
    task.counters.modelCallCount > evaluationCase.limits.maxModelCalls
    || task.counters.toolCallCount > evaluationCase.limits.maxToolCalls
    || usage.promptTokens > evaluationCase.limits.promptTokenReservation
    || usage.completionTokens > evaluationCase.limits.completionTokenReservation
    || activeElapsedMs > evaluationCase.limits.activeElapsedReservationMs
    || task.retryOfTaskId !== undefined
  ) {
    throw new LiveHarnessEvaluationError("case_budget", "单用例预算或零重试约束被违反，已停止后续用例。");
  }
  return {
    modelCalls: task.counters.modelCallCount,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    activeElapsedMs,
  };
}

function runningToolSequence(task: HarnessTaskSummary): HarnessToolName[] {
  return task.events
    .filter((event) => event.type === "toolCall" && event.toolCall?.status === "running")
    .flatMap((event) => event.toolCall?.name ?? []);
}

function evaluateTask(
  evaluationCase: LiveHarnessEvaluationCase,
  task: HarnessTaskSummary,
  formalBefore: unknown,
  formalAfter: unknown,
  usage: LiveHarnessBudgetUsage,
): LiveHarnessCaseResult {
  const sequence = runningToolSequence(task);
  const pending = task.pendingChangeSet ? changeSetSchema.safeParse(task.pendingChangeSet) : null;
  const expectsChangeSet = evaluationCase.expected.operations.length > 0;
  const pendingValid = expectsChangeSet ? pending?.success === true : task.pendingChangeSet === undefined;
  const operationMatch = expectsChangeSet
    ? pending?.success === true && operationsMatchExactly(pending.data.operations, evaluationCase.expected.operations)
    : task.pendingChangeSet === undefined;
  const gates: Omit<LiveHarnessCaseHardGates, "passed"> = {
    formalAppSpecUnchanged: isDeepStrictEqual(formalBefore, formalAfter),
    terminalStateMatches: task.state === evaluationCase.expected.terminalState,
    terminationCodeMatches: task.terminationCode === evaluationCase.expected.terminationCode,
    toolSequenceMatches: isDeepStrictEqual(sequence, evaluationCase.expected.toolSequence),
    toolCallCountMatches: task.counters.toolCallCount === evaluationCase.expected.toolSequence.length,
    pendingChangeSetSchemaValid: pendingValid,
    changeSetOperationsMatch: operationMatch,
    noUnexpectedChangeSet: expectsChangeSet ? task.pendingChangeSet !== undefined : task.pendingChangeSet === undefined,
    noForbiddenArtifact: task.exportArtifact === undefined,
  };
  const hardGates: LiveHarnessCaseHardGates = {
    ...gates,
    passed: Object.values(gates).every(Boolean),
  };
  return {
    id: evaluationCase.id,
    caseVersion: evaluationCase.caseVersion,
    category: evaluationCase.category,
    terminalState: task.state,
    terminationCode: task.terminationCode ?? "executionFailed",
    toolSequence: sequence,
    passed: hardGates.passed,
    modelCalls: usage.modelCalls,
    toolCalls: task.counters.toolCallCount,
    retryCount: 0,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    activeElapsedMs: usage.activeElapsedMs,
    hardGates,
  };
}

function failedCaseResult(
  evaluationCase: LiveHarnessEvaluationCase,
  terminationCode: LiveHarnessFailureCode,
): LiveHarnessCaseResult {
  const hardGates: LiveHarnessCaseHardGates = {
    formalAppSpecUnchanged: false,
    terminalStateMatches: false,
    terminationCodeMatches: false,
    toolSequenceMatches: false,
    toolCallCountMatches: false,
    pendingChangeSetSchemaValid: false,
    changeSetOperationsMatch: false,
    noUnexpectedChangeSet: false,
    noForbiddenArtifact: false,
    passed: false,
  };
  return {
    id: evaluationCase.id,
    caseVersion: evaluationCase.caseVersion,
    category: evaluationCase.category,
    terminalState: "failed",
    terminationCode,
    toolSequence: [],
    passed: false,
    modelCalls: 0,
    toolCalls: 0,
    retryCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    activeElapsedMs: 0,
    hardGates,
  };
}

function buildSafeReport(input: {
  gitCommit: string;
  model: string | null;
  terminationCode: "completed" | LiveHarnessFailureCode;
  budget: LiveHarnessBudget;
  used: LiveHarnessBudgetUsage;
  results: LiveHarnessCaseResult[];
  nonce: string;
}): LiveHarnessEvaluationReport {
  const completed = input.terminationCode === "completed";
  const rawReport = {
    schemaVersion: LIVE_HARNESS_SCHEMA_VERSION,
    suiteId: LIVE_HARNESS_SUITE_ID,
    suiteVersion: LIVE_HARNESS_SUITE_VERSION,
    mode: "live",
    gitCommit: input.gitCommit,
    provider: "deepseek",
    model: input.model,
    passed: completed && input.results.length === 3 && input.results.every((result) => result.passed),
    hardGatesPassed: completed && input.results.length === 3 && input.results.every((result) => result.hardGates.passed),
    terminationCode: input.terminationCode,
    budget: {
      limits: input.budget,
      used: input.used,
      remaining: remainingBudget(input.budget, input.used),
    },
    cases: input.results,
  };
  const parsed = liveHarnessEvaluationReportSchema.safeParse(rawReport);
  if (!parsed.success) throw new LiveHarnessEvaluationError("report_safety");
  try {
    assertLiveHarnessEvaluationReportSafe(parsed.data, { sessionNonce: input.nonce });
  } catch {
    throw new LiveHarnessEvaluationError("report_safety");
  }
  return parsed.data;
}

async function fetchHarnessTask(
  baseUrl: string,
  evaluationCase: LiveHarnessEvaluationCase,
  runId: string,
  nonce: string,
  fetchImpl: typeof fetch,
  requestTimeoutMs?: number,
) {
  if (!demoFixtureResult.success) throw new LiveHarnessEvaluationError("fixture", "演示 fixture 不可用。");
  const fixture = demoFixtureResult.data.dataProduct;
  const request = harnessPublicRequestSchema.parse({
    idempotencyKey: `live_${runId}_${evaluationCase.id.replaceAll("-", "_")}`,
    ...evaluationCase.request,
    appSpec: structuredClone(fixture.appSpec),
    recipes: structuredClone(fixture.recipes),
  });
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    requestTimeoutMs ?? evaluationCase.limits.activeElapsedReservationMs + 15_000,
  );
  try {
    const response = await fetchImpl(new URL("/api/ai/harness", baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        [LIVE_EVALUATION_SESSION_HEADER]: LIVE_EVALUATION_SESSION_VALUE,
        [LIVE_EVALUATION_NONCE_HEADER]: nonce,
        [LIVE_EVALUATION_CASE_HEADER]: evaluationCase.id,
        [LIVE_EVALUATION_RUN_HEADER]: runId,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const target = new URL(response.headers.get("location") ?? "", baseUrl).toString();
      if (!isLoopbackHttpUrl(target)) throw new LiveHarnessEvaluationError("redirect", "Live 评测拒绝重定向到非 loopback 地址。");
      throw new LiveHarnessEvaluationError("redirect", "Live 评测不跟随 HTTP 重定向。");
    }
    if (response.url && !isLoopbackHttpUrl(response.url)) throw new LiveHarnessEvaluationError("redirect", "Live 评测响应来自非 loopback 地址。");
    if (!response.ok) throw new LiveHarnessEvaluationError(httpFailureCode(response.status));
    let raw: unknown = null;
    try {
      raw = JSON.parse(await readBoundedUtf8Body(response, MAX_LIVE_HARNESS_RESPONSE_BYTES)) as unknown;
    } catch (error) {
      if (controller.signal.aborted) throw error;
    }
    const parsed = harnessResponseSchema.safeParse(raw);
    if (!parsed.success) throw new LiveHarnessEvaluationError("invalid_response", "Live Harness 响应未通过 Schema 校验。");
    return { task: parsed.data.task, request };
  } catch (error) {
    if (error instanceof LiveHarnessEvaluationError) throw error;
    if (controller.signal.aborted) throw new LiveHarnessEvaluationError("timeout", "Live Harness 请求超时，未自动重试。");
    throw new LiveHarnessEvaluationError("transport", "Live Harness 本机连接失败，未自动重试。");
  } finally {
    clearTimeout(timer);
  }
}

export async function findFreeLoopbackPort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

export async function safeRemoveSessionDirectory(path: string) {
  const root = resolve(tmpdir());
  const target = resolve(path);
  const child = relative(root, target);
  if (!child || child.startsWith("..") || child.includes(":\\")) {
    throw new LiveHarnessEvaluationError("cleanup", "拒绝清理非评测临时目录。");
  }
  await rm(target, { recursive: true, force: true });
}

export async function stopOwnedChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!child.pid) return;
  const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
  child.kill("SIGTERM");
  await Promise.race([closed, new Promise<void>((resolveWait) => setTimeout(resolveWait, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([closed, new Promise<void>((resolveWait) => setTimeout(resolveWait, 2_000))]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new LiveHarnessEvaluationError("cleanup");
  }
}

export interface LiveServerResourceCleanupOperations {
  stopChild?: (child: ChildProcess) => Promise<void>;
  removeDirectory?: (path: string) => Promise<void>;
}

export function createLiveServerResourceCleanup(
  child: ChildProcess,
  temporaryDirectory: string,
  operations: LiveServerResourceCleanupOperations = {},
): () => Promise<void> {
  const stopChild = operations.stopChild ?? stopOwnedChildProcess;
  const removeDirectory = operations.removeDirectory ?? safeRemoveSessionDirectory;
  let childStopped = false;
  let directoryRemoved = false;
  let cleaning: Promise<void> | undefined;
  return async () => {
    if (cleaning) return cleaning;
    if (childStopped && directoryRemoved) return;
    const operation = (async () => {
      let failed = false;
      if (!childStopped) {
        try {
          await stopChild(child);
          childStopped = true;
        } catch {
          failed = true;
        }
      }
      if (!directoryRemoved) {
        try {
          await removeDirectory(temporaryDirectory);
          directoryRemoved = true;
        } catch {
          failed = true;
        }
      }
      if (failed) throw new LiveHarnessEvaluationError("cleanup");
    })();
    cleaning = operation;
    try {
      await operation;
    } finally {
      if (cleaning === operation) cleaning = undefined;
    }
  };
}

export interface LiveServerWaitOptions {
  monotonicNow?: () => number;
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
}

export async function waitForLiveEvaluationServer(
  baseUrl: string,
  child: ChildProcess,
  startupError: () => Error | undefined,
  options: LiveServerWaitOptions = {},
): Promise<void> {
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const readMonotonic = () => {
    let value: number;
    try { value = monotonicNow(); } catch { throw new LiveHarnessEvaluationError("server_start"); }
    if (!Number.isFinite(value)) throw new LiveHarnessEvaluationError("server_start");
    return value;
  };
  const startedAt = readMonotonic();
  while (true) {
    const elapsedMs = readMonotonic() - startedAt;
    if (elapsedMs < 0) throw new LiveHarnessEvaluationError("server_start");
    if (elapsedMs >= 30_000) break;
    if (startupError()) throw new LiveHarnessEvaluationError("server_start", "Live 评测本地服务启动失败。");
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new LiveHarnessEvaluationError("server_start", "Live 评测本地服务启动失败。");
    }
    try {
      const response = await (options.fetchImpl ?? fetch)(baseUrl, { redirect: "manual", signal: AbortSignal.timeout(1_000) });
      if (response.status === 200 && (!response.url || isLoopbackHttpUrl(response.url))) return;
    } catch {
      // 本地服务仍在启动；不触发任何 Harness 或模型请求。
    }
    await (options.sleep ?? ((delayMs) => new Promise((resolveWait) => setTimeout(resolveWait, delayMs))))(150);
  }
  throw new LiveHarnessEvaluationError("server_start", "Live 评测本地服务启动超时。");
}

export async function startLocalLiveEvaluationServer(
  options: LiveEvaluationServerOptions,
): Promise<LiveEvaluationServer> {
  const port = await findFreeLoopbackPort();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "harness-live-eval-"));
  const cli = resolve(options.projectRoot, "node_modules", "vinext", "dist", "cli.js");
  const environment: NodeJS.ProcessEnv = {
    ...options.environment,
    [LIVE_EVALUATION_SERVER_FLAG]: "1",
    [LIVE_EVALUATION_NONCE_ENV]: options.nonce,
    VINEXT_NO_DEV_LOCK: "1",
    WRANGLER_WRITE_LOGS: "false",
    WRANGLER_LOG_PATH: join(temporaryDirectory, "wrangler", "logs"),
    MINIFLARE_REGISTRY_PATH: join(temporaryDirectory, "wrangler", "registry"),
  };
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [cli, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: options.projectRoot,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    try { await safeRemoveSessionDirectory(temporaryDirectory); } catch { /* 启动失败是主结果。 */ }
    throw new LiveHarnessEvaluationError("server_start", "Live 评测本地服务启动失败。");
  }
  let startupError: Error | undefined;
  child.once("error", (error) => { startupError = error; });
  child.stdout?.resume();
  child.stderr?.resume();
  const baseUrl = `http://127.0.0.1:${port}`;
  const cleanupResources = createLiveServerResourceCleanup(child, temporaryDirectory);
  try {
    await waitForLiveEvaluationServer(baseUrl, child, () => startupError);
  } catch (error) {
    try { await cleanupResources(); } catch { /* 保留启动失败主错误；两项资源均已尝试。 */ }
    throw error;
  }
  return {
    baseUrl,
    async stop() {
      await cleanupResources();
    },
  };
}

async function currentGitCommit(projectRoot: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectRoot });
  const commit = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new LiveHarnessEvaluationError("git", "无法确定 Live 评测 Git 提交。");
  return commit;
}

export async function runLiveHarnessEvaluation(
  options: LiveHarnessRunnerOptions = {},
): Promise<LiveHarnessEvaluationReport> {
  const environment = options.environment ?? process.env;
  if (environment[LIVE_EVALUATION_RUNNER_FLAG] !== "1") {
    throw new LiveHarnessEvaluationError("runner_gate", "未显式启用 Live Harness 评测；没有发送任何请求。");
  }
  if (
    options.requestTimeoutMs !== undefined
    && (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1 || options.requestTimeoutMs > MAX_LIVE_HARNESS_REQUEST_TIMEOUT_MS)
  ) {
    throw new LiveHarnessEvaluationError("time_budget", "Live Harness 单次 HTTP 等待不能超过固定上限。");
  }
  const projectRoot = options.projectRoot ?? process.cwd();
  const cases = options.cases ?? liveHarnessSmokeCases;
  if (!isDeepStrictEqual(cases, liveHarnessSmokeCases)) {
    throw new LiveHarnessEvaluationError("manifest", "Live Harness 评测用例清单不符合固定三用例范围。");
  }
  const budget = { ...liveHarnessGlobalBudget, ...options.budget };
  if (budget.maxRetriesPerCase !== 0) throw new LiveHarnessEvaluationError("retry", "Live Harness 自动重试必须保持为 0。");
  for (const [name, maximum] of Object.entries(liveHarnessGlobalBudget) as Array<[keyof LiveHarnessBudget, number]>) {
    const value = budget[name];
    if (!Number.isSafeInteger(value) || value < (name === "maxRetriesPerCase" ? 0 : 1) || value > maximum) {
      throw new LiveHarnessEvaluationError("global_budget", "Live Harness 预算不能超过固定全局上限。");
    }
  }
  const nonce = options.nonceFactory?.() ?? randomBytes(32).toString("hex");
  const runId = options.runIdFactory?.() ?? randomBytes(16).toString("hex");
  if (!/^[a-f0-9]{64}$/.test(nonce) || !/^[a-f0-9]{32}$/.test(runId)) {
    throw new LiveHarnessEvaluationError("session", "Live Harness 会话随机标识无效。");
  }
  const gitCommit = options.gitCommit ?? await currentGitCommit(projectRoot);
  const server = await (options.serverFactory ?? startLocalLiveEvaluationServer)({ nonce, environment, projectRoot });
  if (!isLoopbackHttpUrl(server.baseUrl)) {
    try {
      await server.stop();
    } catch {
      // 地址安全拒绝是主结果；清理失败不得把它改写成未知异常。
    }
    throw new LiveHarnessEvaluationError("loopback", "Live Harness 服务地址不是允许的 loopback 地址。");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const results: LiveHarnessCaseResult[] = [];
  let used = emptyUsage();
  let model = "";
  let currentCase: LiveHarnessEvaluationCase | undefined;
  let primaryFailure = false;
  try {
    for (const evaluationCase of cases) {
      currentCase = evaluationCase;
      ensureReservation(budget, used, evaluationCase);
      if (!demoFixtureResult.success) throw new LiveHarnessEvaluationError("fixture", "演示 fixture 不可用。");
      const formalBefore = structuredClone(demoFixtureResult.data.dataProduct.appSpec);
      const { task } = await fetchHarnessTask(
        server.baseUrl,
        evaluationCase,
        runId,
        nonce,
        fetchImpl,
        options.requestTimeoutMs,
      );
      if (
        task.model !== undefined
        && (
          !liveHarnessTrustedModelSchema.safeParse(task.model).success
          || !isLiveHarnessOutputStringSafe(task.model, { sessionNonce: nonce })
        )
      ) {
        throw new LiveHarnessEvaluationError("report_safety");
      }
      const usage = taskUsage(task, evaluationCase);
      used = addUsage(used, usage);
      if (globalBudgetExceeded(budget, used)) throw new LiveHarnessEvaluationError("global_budget", "Live Harness 全局预算已超限。");
      if (!task.model) throw new LiveHarnessEvaluationError("model", "Live Harness 响应缺少服务端模型标识。");
      if (model && model !== task.model) throw new LiveHarnessEvaluationError("provider_model_mismatch");
      model = task.model;
      const formalAfter = structuredClone(demoFixtureResult.data.dataProduct.appSpec);
      const result = evaluateTask(evaluationCase, task, formalBefore, formalAfter, usage);
      results.push(result);
      if (!result.passed) throw new LiveHarnessEvaluationError("hard_gate", `Live Harness 用例 ${evaluationCase.id} 未通过安全硬门。`);
    }
    return buildSafeReport({
      gitCommit,
      model,
      terminationCode: "completed",
      budget,
      used,
      results,
      nonce,
    });
  } catch (caught) {
    primaryFailure = true;
    const error = caught instanceof LiveHarnessEvaluationError
      ? caught
      : new LiveHarnessEvaluationError("internal");
    const failureResults = [...results];
    if (currentCase && !failureResults.some((result) => result.id === currentCase?.id)) {
      failureResults.push(failedCaseResult(currentCase, error.code));
    }
    let failureCode = error.code;
    let report: LiveHarnessEvaluationReport;
    try {
      report = buildSafeReport({
        gitCommit,
        model: model || null,
        terminationCode: failureCode,
        budget,
        used,
        results: failureResults,
        nonce,
      });
    } catch {
      failureCode = "report_safety";
      const safeFailureResults = currentCase
        ? [failedCaseResult(currentCase, failureCode)]
        : [];
      report = buildSafeReport({
        gitCommit,
        model: null,
        terminationCode: failureCode,
        budget,
        used: emptyUsage(),
        results: safeFailureResults,
        nonce,
      });
    }
    throw new LiveHarnessEvaluationError(failureCode, report);
  } finally {
    try {
      await server.stop();
    } catch {
      if (!primaryFailure) throw new LiveHarnessEvaluationError("cleanup");
    }
  }
}
