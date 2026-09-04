import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessTaskSummarySchema, type HarnessTaskSummary } from "@/core/harness";
import type { ChangeOperation } from "@/core/models";
import { changeSetSchema } from "@/core/schemas";
import { demoFixtureResult } from "@/fixtures/demo-product";
import {
  LIVE_HARNESS_GLOBAL_BUDGET,
  LIVE_HARNESS_SUITE_ID,
  type LiveHarnessEvaluationCase,
} from "./contracts";
import {
  LiveHarnessEvaluationError,
  MAX_LIVE_HARNESS_REQUEST_TIMEOUT_MS,
  MAX_LIVE_HARNESS_RESPONSE_BYTES,
  createLiveServerResourceCleanup,
  findFreeLoopbackPort,
  runLiveHarnessEvaluation,
  safeRemoveSessionDirectory,
  stopOwnedChildProcess,
  waitForLiveEvaluationServer,
  type LiveEvaluationServer,
  type LiveHarnessRunnerOptions,
} from "./harness-live-runner";
import { liveHarnessSmokeCases } from "./manifest";
import { LIVE_EVALUATION_CASE_HEADER, LIVE_EVALUATION_RUNNER_FLAG, isLoopbackHttpUrl, safeNonceMatches } from "./protocol";
import { formatLiveHarnessEvaluationJson, formatLiveHarnessEvaluationMarkdown } from "./reporters";

const NONCE = "a".repeat(64);
const RUN_ID = "b".repeat(32);
const GIT_COMMIT = "c".repeat(40);
const FAKE_SECRET_CANARY = "FAKE_LIVE_SECRET_CANARY_7D2C";
const FAKE_DATA_CANARY = "FAKE_LIVE_DATA_CANARY_91B4";
const FAKE_INSTRUCTION_CANARY = "FAKE_LIVE_INSTRUCTION_CANARY_E6A8";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function materializeOperations(evaluationCase: LiveHarnessEvaluationCase): ChangeOperation[] {
  return evaluationCase.expected.operations.map((operation, index) => ({
    ...operation,
    id: `operation_${evaluationCase.id}_${index}`,
    label: `Live 评测操作 ${index + 1}`,
    description: "由 Mock 服务构造的待确认操作。",
  } as ChangeOperation));
}

function taskForCase(
  evaluationCase: LiveHarnessEvaluationCase,
  overrides: {
    usage?: HarnessTaskSummary["usage"] | null;
    state?: HarnessTaskSummary["state"];
    terminationCode?: HarnessTaskSummary["terminationCode"];
    toolSequence?: HarnessTaskSummary["events"][number]["toolCall"][];
    activeElapsedMs?: number;
    retryOfTaskId?: string;
    model?: string;
  } = {},
) {
  const timestamp = "2026-09-03T00:00:00.000Z";
  const expectedTools = evaluationCase.expected.toolSequence;
  const toolEvents = (overrides.toolSequence ?? expectedTools.map((name, index) => ({
    id: `tool_${index}`,
    name,
    status: "running" as const,
    durationMs: 0,
  }))).filter((item): item is NonNullable<typeof item> => Boolean(item)).map((toolCall, index) => ({
    id: `event_tool_${index}`,
    type: "toolCall" as const,
    state: "executingTool" as const,
    timestamp,
    message: "执行受控工具。",
    toolCall,
  }));
  const operations = materializeOperations(evaluationCase);
  const pendingChangeSet = operations.length > 0 ? changeSetSchema.parse({
    id: `changeset_${evaluationCase.id.replaceAll("-", "_")}`,
    title: "Live 评测待确认变更",
    status: "ready",
    operations,
  }) : undefined;
  const activeElapsedMs = overrides.activeElapsedMs ?? 100;
  const usage = overrides.usage === null ? undefined : overrides.usage ?? {
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
  };
  return harnessTaskSummarySchema.parse({
    id: `harness_${evaluationCase.id}`,
    idempotencyKey: `live_${evaluationCase.id.replaceAll("-", "_")}`,
    instruction: evaluationCase.request.instruction,
    pageId: evaluationCase.request.pageId,
    role: "editor",
    state: overrides.state ?? evaluationCase.expected.terminalState,
    terminationCode: overrides.terminationCode ?? evaluationCase.expected.terminationCode,
    createdAt: timestamp,
    updatedAt: timestamp,
    events: [{ id: "event_start", type: "state", state: "planning", timestamp, message: "开始。" }, ...toolEvents],
    counters: {
      loopCount: evaluationCase.limits.maxModelCalls,
      modelCallCount: evaluationCase.limits.maxModelCalls,
      toolCallCount: expectedTools.length,
    },
    resultMessage: "已返回安全摘要。",
    ...(pendingChangeSet ? { pendingChangeSet } : {}),
    model: overrides.model ?? "mock-server-model",
    ...(usage ? { usage } : {}),
    totalDurationMs: activeElapsedMs,
    executionTiming: {
      phase: evaluationCase.expected.terminalState,
      activeElapsedMs,
      remainingMs: Math.max(0, evaluationCase.limits.activeElapsedReservationMs - activeElapsedMs),
      totalBudgetMs: evaluationCase.limits.activeElapsedReservationMs,
      modelRequestTimeoutMs: 25_000,
      toolCallTimeoutMs: 10_000,
      modelDurationMs: activeElapsedMs,
      toolDurationMs: 0,
      otherDurationMs: 0,
      retainedObservationCount: expectedTools.length,
    },
    ...(overrides.retryOfTaskId ? { retryOfTaskId: overrides.retryOfTaskId } : {}),
  });
}

function fakeServer(baseUrl = "http://127.0.0.1:43123") {
  const stop = vi.fn(async () => undefined);
  const factory = vi.fn(async (): Promise<LiveEvaluationServer> => ({ baseUrl, stop }));
  return { factory, stop };
}

function successfulHttpFetch(model = "mock-server-model") {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const caseId = new Headers(init?.headers).get(LIVE_EVALUATION_CASE_HEADER);
    const evaluationCase = liveHarnessSmokeCases.find((item) => item.id === caseId);
    if (!evaluationCase) return new Response(null, { status: 400 });
    return new Response(JSON.stringify({ task: taskForCase(evaluationCase, { model }) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

async function startLoopbackChild(port: number): Promise<ChildProcess> {
  const source = [
    "const net = require('node:net');",
    "const server = net.createServer();",
    "server.listen(Number(process.argv[1]), '127.0.0.1', () => process.stdout.write('ready\\n'));",
    "const stop = () => server.close(() => process.exit(0));",
    "process.on('SIGTERM', stop);",
    "process.on('SIGINT', stop);",
  ].join("");
  const child = spawn(process.execPath, ["-e", source, String(port)], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await Promise.race([
    once(child.stdout!, "data"),
    once(child, "error").then(([error]) => Promise.reject(error)),
    once(child, "exit").then(([code]) => Promise.reject(new Error(`helper exited before ready: ${String(code)}`))),
  ]);
  return child;
}

async function expectPortCanRebind(port: number): Promise<void> {
  await new Promise<void>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolvePort()));
  });
}

function enabledOptions(overrides: LiveHarnessRunnerOptions = {}): LiveHarnessRunnerOptions {
  return {
    environment: { NODE_ENV: "test" as const, [LIVE_EVALUATION_RUNNER_FLAG]: "1" },
    nonceFactory: () => NONCE,
    runIdFactory: () => RUN_ID,
    gitCommit: GIT_COMMIT,
    ...overrides,
  };
}

describe("Live Harness HTTP Runner 安全基础设施", () => {
  it("本地服务启动期限使用单调时钟并对回拨 fail-closed", async () => {
    const child = { exitCode: null, signalCode: null } as ChildProcess;
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error("not ready"); });
    const sleep = vi.fn(async () => undefined);
    let timeoutClockCalls = 0;
    const timeoutClock = () => [100, 100, 30_100][timeoutClockCalls++] ?? 30_100;

    await expect(waitForLiveEvaluationServer("http://127.0.0.1:43123", child, () => undefined, {
      monotonicNow: timeoutClock,
      fetchImpl,
      sleep,
    })).rejects.toMatchObject({ code: "server_start" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);

    let rollbackClockCalls = 0;
    await expect(waitForLiveEvaluationServer("http://127.0.0.1:43123", child, () => undefined, {
      monotonicNow: () => rollbackClockCalls++ === 0 ? 100 : 99,
      fetchImpl,
      sleep,
    })).rejects.toMatchObject({ code: "server_start" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("本地服务被 signal 终止后在探活和休眠前立即失败", async () => {
    const child = { exitCode: null, signalCode: "SIGTERM" } as ChildProcess;
    const fetchImpl = vi.fn<typeof fetch>();
    const sleep = vi.fn(async () => undefined);

    await expect(waitForLiveEvaluationServer("http://127.0.0.1:43123", child, () => undefined, {
      monotonicNow: () => 100,
      fetchImpl,
      sleep,
    })).rejects.toMatchObject({ code: "server_start" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("缺少 Runner 显式开关时不会启动服务或发送请求，即使存在虚假密钥", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const server = fakeServer();
    await expect(runLiveHarnessEvaluation({
      environment: { NODE_ENV: "test", DEEPSEEK_API_KEY: "fixed-fake-key-not-used" },
      fetchImpl,
      serverFactory: server.factory,
    })).rejects.toMatchObject({ code: "runner_gate" } satisfies Partial<LiveHarnessEvaluationError>);
    expect(server.factory).toHaveBeenCalledTimes(0);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it("普通测试命令只匹配离线测试，Live 入口使用独立配置且不加载环境文件", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const defaultConfig = await readFile(join(process.cwd(), "vitest.config.ts"), "utf8");
    const liveConfig = await readFile(join(process.cwd(), "vitest.live.config.ts"), "utf8");
    const offlineRunner = await readFile(join(process.cwd(), "scripts/run-offline-tests.mjs"), "utf8");
    expect(packageJson.scripts.test).toBe("node scripts/run-offline-tests.mjs");
    expect(packageJson.scripts.test).not.toContain("live");
    expect(offlineRunner).not.toContain("vitest.live");
    expect(packageJson.scripts["test:eval"]).not.toContain("live");
    expect(packageJson.scripts["test:eval:live"]).toContain("vitest.live.config.ts");
    expect(defaultConfig).toContain('include: ["**/*.test.ts", "**/*.test.tsx"]');
    expect(liveConfig).toContain("envDir: false");
    expect(liveConfig).toContain('include: ["core/evaluation/live/**/*.live.ts"]');
    expect(liveConfig).toContain("testTimeout: 240_000");
  });

  it("manifest 精确包含三个用例及 2/1、4/3、1/1 上限", () => {
    expect(liveHarnessSmokeCases.map((item) => item.id)).toEqual([
      "dataset-summary",
      "east-anomaly-recipe-preview",
      "revenue-title-change-preview",
    ]);
    expect(liveHarnessSmokeCases.map((item) => [item.limits.maxModelCalls, item.limits.maxToolCalls])).toEqual([
      [2, 1],
      [4, 3],
      [1, 1],
    ]);
    expect(LIVE_HARNESS_GLOBAL_BUDGET).toMatchObject({
      maxModelCalls: 7,
      maxPromptTokens: 12_000,
      maxCompletionTokens: 3_000,
      maxActiveElapsedMs: 180_000,
      maxRetriesPerCase: 0,
    });
  });

  it("拒绝放宽固定 Live 预算或篡改同 ID 用例内容，且不启动服务", async () => {
    const server = fakeServer();
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(runLiveHarnessEvaluation(enabledOptions({
      serverFactory: server.factory,
      fetchImpl,
      budget: { maxModelCalls: LIVE_HARNESS_GLOBAL_BUDGET.maxModelCalls + 1 },
    }))).rejects.toMatchObject({ code: "global_budget" });

    const changedCases = structuredClone(liveHarnessSmokeCases);
    changedCases[0].limits.maxModelCalls += 1;
    await expect(runLiveHarnessEvaluation(enabledOptions({ serverFactory: server.factory, fetchImpl, cases: changedCases })))
      .rejects.toMatchObject({ code: "manifest" });
    expect(server.factory).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("拒绝放宽 Live 单次 HTTP 等待且不启动服务", async () => {
    const server = fakeServer();
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(runLiveHarnessEvaluation(enabledOptions({
      serverFactory: server.factory,
      fetchImpl,
      requestTimeoutMs: MAX_LIVE_HARNESS_REQUEST_TIMEOUT_MS + 1,
    }))).rejects.toMatchObject({ code: "time_budget" });
    expect(server.factory).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("仅允许无凭据的 HTTP loopback 地址", () => {
    expect(isLoopbackHttpUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isLoopbackHttpUrl("http://localhost:3000")).toBe(true);
    expect(isLoopbackHttpUrl("http://[::1]:3000")).toBe(true);
    expect(isLoopbackHttpUrl("http://0.0.0.0:3000")).toBe(false);
    expect(isLoopbackHttpUrl("http://192.168.1.8:3000")).toBe(false);
    expect(isLoopbackHttpUrl("https://127.0.0.1:3000")).toBe(false);
    expect(isLoopbackHttpUrl("http://user:password@127.0.0.1:3000")).toBe(false);
  });

  it("nonce 空值、过短、过长和长度不一致均安全返回 false", () => {
    expect(safeNonceMatches("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(safeNonceMatches("a".repeat(64), "")).toBe(false);
    expect(safeNonceMatches("a".repeat(64), "a".repeat(31))).toBe(false);
    expect(safeNonceMatches("a".repeat(65), "a".repeat(65))).toBe(false);
    expect(safeNonceMatches("a".repeat(64), "a".repeat(63))).toBe(false);
  });

  it("只接受 loopback，成功与失败路径都清理服务生命周期", async () => {
    const external = fakeServer("http://192.168.1.20:43123");
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(runLiveHarnessEvaluation(enabledOptions({
      serverFactory: external.factory,
      fetchImpl,
    }))).rejects.toMatchObject({ code: "loopback" });
    expect(fetchImpl).toHaveBeenCalledTimes(0);
    expect(external.stop).toHaveBeenCalledTimes(1);

    const failed = fakeServer();
    await expect(runLiveHarnessEvaluation(enabledOptions({
      serverFactory: failed.factory,
      fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 500 })),
    }))).rejects.toMatchObject({ code: "http_500" });
    expect(failed.stop).toHaveBeenCalledTimes(1);
  });

  it("清理失败不覆盖既有失败，成功路径则映射为受控 cleanup", async () => {
    const failingStop = vi.fn(async () => { throw new Error("private cleanup detail"); });
    const externalFactory = vi.fn(async (): Promise<LiveEvaluationServer> => ({
      baseUrl: "http://192.168.1.20:43123",
      stop: failingStop,
    }));
    await expect(runLiveHarnessEvaluation(enabledOptions({
      serverFactory: externalFactory,
      fetchImpl: vi.fn<typeof fetch>(),
    }))).rejects.toMatchObject({ code: "loopback" });

    const failedFactory = vi.fn(async (): Promise<LiveEvaluationServer> => ({
      baseUrl: "http://127.0.0.1:43123",
      stop: failingStop,
    }));
    await expect(runLiveHarnessEvaluation(enabledOptions({
      serverFactory: failedFactory,
      fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 500 })),
    }))).rejects.toMatchObject({
      code: "http_500",
      report: { terminationCode: "http_500" },
    });

    const successFactory = vi.fn(async (): Promise<LiveEvaluationServer> => ({
      baseUrl: "http://127.0.0.1:43123",
      stop: failingStop,
    }));
    await expect(runLiveHarnessEvaluation(enabledOptions({
      serverFactory: successFactory,
      fetchImpl: successfulHttpFetch(),
    }))).rejects.toMatchObject({ code: "cleanup" });
    expect(failingStop).toHaveBeenCalledTimes(3);
  });

  it("第二个用例失败后不发送第三个请求，并保留受控的前两步失败摘要", async () => {
    const server = fakeServer();
    let requestCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      requestCount += 1;
      if (requestCount === 2) return new Response(null, { status: 500 });
      const caseId = new Headers(init?.headers).get(LIVE_EVALUATION_CASE_HEADER);
      const evaluationCase = liveHarnessSmokeCases.find((item) => item.id === caseId)!;
      return new Response(JSON.stringify({ task: taskForCase(evaluationCase) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    let caught: unknown;
    try {
      await runLiveHarnessEvaluation(enabledOptions({ serverFactory: server.factory, fetchImpl }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "http_500",
      report: {
        passed: false,
        hardGatesPassed: false,
        terminationCode: "http_500",
        cases: [
          { id: "dataset-summary", passed: true },
          { id: "east-anomaly-recipe-preview", passed: false, terminationCode: "http_500" },
        ],
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(server.stop).toHaveBeenCalledTimes(1);
  });

  it("拒绝所有重定向，尤其不允许跳转到非 loopback 地址", async () => {
    const server = fakeServer();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 302,
      headers: { location: "https://example.invalid/harness" },
    }));
    await expect(runLiveHarnessEvaluation(enabledOptions({ serverFactory: server.factory, fetchImpl })))
      .rejects.toMatchObject({ code: "redirect" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(server.stop).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["模型调用", { maxModelCalls: 2 }, "model_budget"],
    ["prompt", { maxPromptTokens: 2_600 }, "prompt_budget"],
    ["completion", { maxCompletionTokens: 900 }, "completion_budget"],
    ["主动时间", { maxActiveElapsedMs: 45_100 }, "time_budget"],
  ])("%s 全局预算不足时不发送下一个用例", async (_label, budget, code) => {
    const server = fakeServer();
    const fetchImpl = successfulHttpFetch();
    await expect(runLiveHarnessEvaluation(enabledOptions({ serverFactory: server.factory, fetchImpl, budget })))
      .rejects.toMatchObject({ code });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(server.stop).toHaveBeenCalledTimes(1);
  });

  it("provider usage 缺失或不一致时 fail closed 并停止后续用例", async () => {
    const server = fakeServer();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      task: taskForCase(liveHarnessSmokeCases[0], { usage: null }),
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(runLiveHarnessEvaluation(enabledOptions({ serverFactory: server.factory, fetchImpl })))
      .rejects.toMatchObject({ code: "invalid_usage" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["NaN", { promptTokens: Number.NaN, completionTokens: 20, totalTokens: 120 }, "invalid_response"],
    ["Infinity", { promptTokens: Number.POSITIVE_INFINITY, completionTokens: 20, totalTokens: 120 }, "invalid_response"],
    ["-Infinity", { promptTokens: Number.NEGATIVE_INFINITY, completionTokens: 20, totalTokens: 120 }, "invalid_response"],
    ["负数", { promptTokens: -1, completionTokens: 20, totalTokens: 19 }, "invalid_response"],
    ["字符串数字", { promptTokens: "100", completionTokens: 20, totalTokens: 120 }, "invalid_response"],
    ["总量不一致", { promptTokens: 100, completionTokens: 20, totalTokens: 999 }, "invalid_usage"],
  ])("异常 usage（%s）fail closed 且不发送后续请求", async (_label, usage, code) => {
    const server = fakeServer();
    const task = taskForCase(liveHarnessSmokeCases[0]);
    task.usage = usage as HarnessTaskSummary["usage"];
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ task }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(runLiveHarnessEvaluation(enabledOptions({ serverFactory: server.factory, fetchImpl })))
      .rejects.toMatchObject({ code });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429, 500])("HTTP %i 不重试并立即停止 suite", async (status) => {
    const server = fakeServer();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status }));
    await expect(runLiveHarnessEvaluation(enabledOptions({ serverFactory: server.factory, fetchImpl })))
      .rejects.toMatchObject({ code: `http_${status}` });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["解析", new Response("not-json", { status: 200, headers: { "content-type": "application/json" } })],
    ["Schema", new Response(JSON.stringify({ task: {} }), { status: 200, headers: { "content-type": "application/json" } })],
  ])("%s 失败不重试并停止 suite", async (_label, response) => {
    const server = fakeServer();
    const fetchImpl = vi.fn<typeof fetch>(async () => response.clone());
    await expect(runLiveHarnessEvaluation(enabledOptions({ serverFactory: server.factory, fetchImpl })))
      .rejects.toMatchObject({ code: "invalid_response" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(server.stop).toHaveBeenCalledTimes(1);
  });

  it("超大 Live Harness 响应在 Schema 校验前失败且不重试", async () => {
    const server = fakeServer();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(MAX_LIVE_HARNESS_RESPONSE_BYTES + 1) },
    }));
    await expect(runLiveHarnessEvaluation(enabledOptions({ serverFactory: server.factory, fetchImpl })))
      .rejects.toMatchObject({ code: "invalid_response" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(server.stop).toHaveBeenCalledTimes(1);
  });

  it("请求超时后不重试并清理服务", async () => {
    const server = fakeServer();
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    await expect(runLiveHarnessEvaluation(enabledOptions({
      serverFactory: server.factory,
      fetchImpl,
      requestTimeoutMs: 1,
    }))).rejects.toMatchObject({ code: "timeout" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(server.stop).toHaveBeenCalledTimes(1);
  });

  it("Live 请求超时覆盖收到响应头后的正文读取", async () => {
    const server = fakeServer();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      },
    })));
    await expect(runLiveHarnessEvaluation(enabledOptions({
      serverFactory: server.factory,
      fetchImpl,
      requestTimeoutMs: 1,
    }))).rejects.toMatchObject({ code: "timeout" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(server.stop).toHaveBeenCalledTimes(1);
  });

  it("三个 Mock HTTP 用例通过精确终态、工具、ChangeSet 和 AppSpec 硬门", async () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    const originalAppSpec = structuredClone(demoFixtureResult.data.dataProduct.appSpec);
    const server = fakeServer();
    const fetchImpl = successfulHttpFetch();
    const localStorageWrite = vi.fn();
    vi.stubGlobal("localStorage", { setItem: localStorageWrite });

    const report = await runLiveHarnessEvaluation(enabledOptions({ serverFactory: server.factory, fetchImpl }));

    expect(report).toMatchObject({
      schemaVersion: 1,
      suiteId: LIVE_HARNESS_SUITE_ID,
      suiteVersion: "1.0.0",
      mode: "live",
      gitCommit: GIT_COMMIT,
      provider: "deepseek",
      model: "mock-server-model",
      passed: true,
      hardGatesPassed: true,
    });
    expect(report.cases.map((item) => [item.terminalState, item.toolSequence])).toEqual([
      ["completed", ["inspectDataset"]],
      ["completed", ["inspectDataset", "inspectFields", "previewDataRecipe"]],
      ["awaitingConfirmation", ["createChangeSetPreview"]],
    ]);
    expect(report.cases.every((item) => item.hardGates.passed)).toBe(true);
    expect(report.budget.used).toMatchObject({ modelCalls: 7, promptTokens: 300, completionTokens: 60, totalTokens: 360 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(localStorageWrite).toHaveBeenCalledTimes(0);
    expect(demoFixtureResult.data.dataProduct.appSpec).toEqual(originalAppSpec);
    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as { idempotencyKey: string });
    expect(new Set(bodies.map((body) => body.idempotencyKey)).size).toBe(3);
  });

  it("非法标题 ChangeSet 或错误终态触发硬门并停止后续用例", async () => {
    const server = fakeServer();
    let index = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const caseId = new Headers(init?.headers).get(LIVE_EVALUATION_CASE_HEADER);
      const evaluationCase = liveHarnessSmokeCases.find((item) => item.id === caseId)!;
      const task = taskForCase(evaluationCase);
      if (index++ === 2 && task.pendingChangeSet) {
        task.pendingChangeSet.operations.push({
          id: "operation_extra",
          label: "额外操作",
          description: "用于验证安全硬门。",
          type: "updateNodeProps",
          pageId: "page_home",
          nodeId: "page_home_revenue",
          props: { label: "额外操作" },
        });
      }
      return new Response(JSON.stringify({ task }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await expect(runLiveHarnessEvaluation(enabledOptions({ serverFactory: server.factory, fetchImpl })))
      .rejects.toMatchObject({ code: "hard_gate" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("测试替身主动变异正式 AppSpec 时硬门失败且报告不包含完整变异对象", async () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    const formalAppSpec = demoFixtureResult.data.dataProduct.appSpec;
    const originalTitle = formalAppSpec.pages[0].title;
    const mutationCanary = "FAKE_MUTATED_APPSPEC_CANARY_2AC9";
    const server = fakeServer();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      formalAppSpec.pages[0].title = mutationCanary;
      return new Response(JSON.stringify({ task: taskForCase(liveHarnessSmokeCases[0]) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    let caught: unknown;
    try {
      await runLiveHarnessEvaluation(enabledOptions({ serverFactory: server.factory, fetchImpl }));
    } catch (error) {
      caught = error;
    } finally {
      formalAppSpec.pages[0].title = originalTitle;
    }
    expect(caught).toMatchObject({ code: "hard_gate", report: { hardGatesPassed: false } });
    expect(JSON.stringify(caught)).not.toContain(mutationCanary);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["虚假密钥", FAKE_SECRET_CANARY],
    ["session nonce", NONCE],
    ["数据 canary", FAKE_DATA_CANARY],
    ["指令 canary", FAKE_INSTRUCTION_CANARY],
    ["换行", "deepseek-v4-flash\nINJECTED"],
    ["反引号", "deepseek-v4-flash`injected"],
    ["HTML", "deepseek-v4-flash<script>"],
    ["Markdown", "deepseek-v4-flash|injected"],
  ])("报告拒绝 provider model %s 污染，JSON/Markdown 只保留安全错误码", async (_label, injectedModel) => {
    const server = fakeServer();
    let caught: unknown;
    try {
      await runLiveHarnessEvaluation(enabledOptions({
        serverFactory: server.factory,
        fetchImpl: successfulHttpFetch(injectedModel),
      }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "report_safety",
      report: { passed: false, hardGatesPassed: false, terminationCode: "report_safety" },
    });
    const error = caught as LiveHarnessEvaluationError;
    const json = formatLiveHarnessEvaluationJson(error.report!);
    const markdown = formatLiveHarnessEvaluationMarkdown(error.report!);
    expect(`${json}\n${markdown}`).not.toContain(injectedModel);
    expect(`${json}\n${markdown}`).toContain("report_safety");
  });

  it("合法可信 deepseek-v4-flash 标识通过并在 Markdown 中安全代码化", async () => {
    const server = fakeServer();
    const report = await runLiveHarnessEvaluation(enabledOptions({
      serverFactory: server.factory,
      fetchImpl: successfulHttpFetch("deepseek-v4-flash"),
    }));
    expect(report.model).toBe("deepseek-v4-flash");
    expect(formatLiveHarnessEvaluationMarkdown(report)).toContain("`deepseek-v4-flash`");
  });

  it("JSON 与 Markdown 来自同一脱敏报告且不覆盖离线 suite", async () => {
    const server = fakeServer();
    const report = await runLiveHarnessEvaluation(enabledOptions({ serverFactory: server.factory, fetchImpl: successfulHttpFetch() }));
    const json = formatLiveHarnessEvaluationJson(report);
    const markdown = formatLiveHarnessEvaluationMarkdown(report);
    const serialized = `${json}\n${markdown}`;
    expect(JSON.parse(json)).toEqual(report);
    expect(markdown).toContain(report.suiteId);
    expect(report.suiteId).not.toBe("harness-baseline-v1");
    expect(serialized).not.toContain(NONCE);
    expect(serialized).not.toContain("instruction");
    expect(serialized).not.toContain("page_home_revenue");
    expect(serialized).not.toContain("月度总收入");
    expect(serialized).not.toContain("reasoning_content");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("rowsByDataSourceId");

    const polluted = structuredClone(report);
    polluted.model = FAKE_SECRET_CANARY;
    expect(() => formatLiveHarnessEvaluationJson(polluted)).toThrow("Live evaluation report safety assertion failed.");
    expect(() => formatLiveHarnessEvaluationMarkdown(polluted)).toThrow("Live evaluation report safety assertion failed.");
  });

  it("评测临时目录只能在系统临时根内创建并可完整清理", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-live-cleanup-test-"));
    await writeFile(join(directory, "sentinel.txt"), "synthetic");
    expect(existsSync(directory)).toBe(true);
    await safeRemoveSessionDirectory(directory);
    expect(existsSync(directory)).toBe(false);
  });

  it("Live 双资源清理独立尝试、只重试失败资源且完成后幂等", async () => {
    const child = { exitCode: null, signalCode: null } as ChildProcess;
    const stopChild = vi.fn()
      .mockRejectedValueOnce(new Error("private child cleanup failure"))
      .mockResolvedValue(undefined);
    const removeDirectory = vi.fn(async () => undefined);
    const cleanup = createLiveServerResourceCleanup(child, "C:\\synthetic-session", { stopChild, removeDirectory });

    await expect(cleanup()).rejects.toMatchObject({ code: "cleanup" });
    expect(stopChild).toHaveBeenCalledTimes(1);
    expect(removeDirectory).toHaveBeenCalledTimes(1);
    await expect(cleanup()).resolves.toBeUndefined();
    await expect(cleanup()).resolves.toBeUndefined();
    expect(stopChild).toHaveBeenCalledTimes(2);
    expect(removeDirectory).toHaveBeenCalledTimes(1);

    const secondStopChild = vi.fn(async () => undefined);
    const secondRemoveDirectory = vi.fn()
      .mockRejectedValueOnce(new Error("private directory cleanup failure"))
      .mockResolvedValue(undefined);
    const secondCleanup = createLiveServerResourceCleanup(child, "C:\\second-session", {
      stopChild: secondStopChild,
      removeDirectory: secondRemoveDirectory,
    });
    await expect(secondCleanup()).rejects.toMatchObject({ code: "cleanup" });
    await expect(secondCleanup()).resolves.toBeUndefined();
    expect(secondStopChild).toHaveBeenCalledTimes(1);
    expect(secondRemoveDirectory).toHaveBeenCalledTimes(2);
  });

  it("正常清理真实 ChildProcess 后端口可重新绑定", async () => {
    const port = await findFreeLoopbackPort();
    const child = await startLoopbackChild(port);
    try {
      await stopOwnedChildProcess(child);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      await expectPortCanRebind(port);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 15_000);

  it("Runner 模拟超时路径只清理其记录的真实 ChildProcess 并释放端口", async () => {
    const port = await findFreeLoopbackPort();
    const child = await startLoopbackChild(port);
    const stop = vi.fn(async () => stopOwnedChildProcess(child));
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    try {
      await expect(runLiveHarnessEvaluation(enabledOptions({
        serverFactory: async () => ({ baseUrl: `http://127.0.0.1:${port}`, stop }),
        fetchImpl,
        requestTimeoutMs: 1,
      }))).rejects.toMatchObject({ code: "timeout" });
      expect(stop).toHaveBeenCalledTimes(1);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      await expectPortCanRebind(port);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 15_000);
});
