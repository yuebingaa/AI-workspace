import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DshSessionResult } from "../../../runtime/dsh/driver.mjs";
import { DEEPSEEK_BASE_URL } from "@/core/ai/server/deepseek-endpoint";
import { createOfficialDshDriver, inspectOfficialDshRuntime } from "./dsh-driver";
import type { DshDriverInput } from "./dsh-engine";

const dependencies = vi.hoisted(() => ({
  close: vi.fn(async () => {}), broker: vi.fn(),
  apiKey: vi.fn(() => "synthetic-offline-test-key"), model: vi.fn(() => "configured-model"),
}));
vi.mock("./tool-broker", () => ({ createDshToolBroker: dependencies.broker }));
vi.mock("@/core/ai/server/runtime-credentials", () => ({
  resolveDeepSeekApiKey: dependencies.apiKey, resolveDeepSeekModel: dependencies.model,
}));

type Runner = NonNullable<Parameters<typeof createOfficialDshDriver>[1]>;
const fixtureModel = () => ({ mode: "fixture" as const, actions: [] });
function result(overrides: Partial<DshSessionResult> = {}): DshSessionResult {
  return { runtime: "official-dsh-sdk", version: "0.1.7-rc.2", mode: "fixture", reaped: true,
    sessionId: "controlled-test", finalResponse: "Controlled result",
    events: [{ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }], notifications: [], ...overrides };
}
function input(overrides: Partial<DshDriverInput> = {}): DshDriverInput {
  return { instruction: "Controlled instruction", context: { notebook: { title: "Synthetic" } }, tools: [],
    signal: new AbortController().signal, authorizeCurrentAccess: vi.fn(), onModelCall: vi.fn(), ...overrides };
}

beforeEach(() => {
  dependencies.broker.mockResolvedValue({ url: "http://127.0.0.1:31000", token: "t".repeat(64), close: dependencies.close });
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe("official DSH driver composition", () => {
  it("captures server plugin configuration per task, separate from public context and broker tools", async () => {
    const run = vi.fn<Runner>(async () => result());
    let skills = true;
    const driver = createOfficialDshDriver(fixtureModel, run, () => ({ skills }));
    await driver(input()); skills = false; await driver(input());
    expect(run.mock.calls[0][0].plugins).toEqual({ skills: true });
    expect(run.mock.calls[1][0].plugins).toEqual({ skills: false });
    expect(JSON.parse(run.mock.calls[0][0].instruction)).toEqual({ instruction: input().instruction, context: input().context });
  });
  it("passes only a private native staging binding, with no duplicate website history", async () => {
    const run = vi.fn<Runner>(async () => result({ persisted: true }));
    const nativeSession = { sessionId: "native_owned_session", root: "private-stage", mode: "resume" as const };
    const request = input({ profile: "conversation", nativeSession,
      context: { notebook: { title: "Current" }, recentConversation: { summary: "Old website copy" }, continuityMemory: { value: "Old memory" } } });
    await createOfficialDshDriver(fixtureModel, run)(request);
    expect(run.mock.calls[0][0]).toMatchObject({ sessionId: nativeSession.sessionId, nativeSession: { root: nativeSession.root, mode: "resume" } });
    const prompt = JSON.parse(run.mock.calls[0][0].instruction);
    expect(prompt.context).not.toHaveProperty("recentConversation");
    expect(prompt.context).not.toHaveProperty("continuityMemory");
    expect(prompt.context.notebook.title).toBe("Current");
    expect(request.context.recentConversation).toBeDefined();
  });
  it("rejects a missing native checkpoint and refuses native bindings in the classic profile", async () => {
    const run = vi.fn<Runner>(async () => result());
    const nativeSession = { sessionId: "native_owned_session", root: "private-stage", mode: "create" as const };
    await expect(createOfficialDshDriver(fixtureModel, run)(input({ nativeSession }))).rejects.toThrow("专用 DSH");
    expect(run).not.toHaveBeenCalled();
    await expect(createOfficialDshDriver(fixtureModel, run)(input({ profile: "conversation", nativeSession }))).rejects.toThrow("检查点");
    expect(dependencies.close).toHaveBeenCalledOnce();
  });
  it("forwards the server-owned conversation profile to both broker and SDK, without changing default tasks", async () => {
    const run = vi.fn<Runner>(async () => result());
    await createOfficialDshDriver(fixtureModel, run)(input({ profile: "conversation" }));
    expect(dependencies.broker.mock.calls[0][0].profile).toBe("conversation");
    expect(run.mock.calls[0][0].profile).toBe("conversation");
    await createOfficialDshDriver(fixtureModel, run)(input());
    expect(run.mock.calls[1][0]).not.toHaveProperty("profile");
  });
  it("readiness forwards safe SDK phase without opening a broker or requesting a model", async () => {
    const inspect = vi.fn(async () => ({ available: false, version: "0.1.7-rc.2",
      phase: "sdk_import" as const, code: "module_not_found" as const }));
    expect(await inspectOfficialDshRuntime(async () => ({ inspectDshRuntime: inspect })))
      .toEqual({ available: false, version: "0.1.7-rc.2", phase: "sdk_import", code: "module_not_found" });
    expect(inspect).toHaveBeenCalledOnce();
    expect(dependencies.apiKey).not.toHaveBeenCalled();
    expect(dependencies.broker).not.toHaveBeenCalled();
  });

  it("carrier import diagnostics never expose raw exception paths or credentials", async () => {
    const status = await inspectOfficialDshRuntime(async () => {
      throw new Error("synthetic-private-path/credential");
    });
    expect(status).toMatchObject({ available: false, phase: "carrier_import", code: "carrier_import_failed" });
    expect(JSON.stringify(status)).not.toContain("synthetic-private-path");
    expect(dependencies.apiKey).not.toHaveBeenCalled();
    expect(dependencies.broker).not.toHaveBeenCalled();
  });

  it("forwards server-owned context/configuration and returns only the narrow receipt after broker cleanup", async () => {
    const run = vi.fn<Runner>(async () => result());
    const request = input();
    const response = await createOfficialDshDriver(fixtureModel, run)(request);
    expect(response).toEqual({ finalResponse: "Controlled result" });
    expect(dependencies.broker).toHaveBeenCalledExactlyOnceWith(request);
    expect(run).toHaveBeenCalledOnce();
    const options = run.mock.calls[0][0];
    expect(options.brokerToken).toBe("t".repeat(64));
    expect(options.signal).toBe(request.signal);
    expect(options.modelConfig).toEqual({ mode: "fixture", actions: [] });
    expect(JSON.parse(options.instruction)).toEqual({ instruction: request.instruction, context: request.context });
    expect(options.sessionId).toMatch(/^agentcanvas-[a-f0-9-]+$/u);
    expect(options).not.toHaveProperty("onNotification");
    expect(request.authorizeCurrentAccess).toHaveBeenCalledTimes(2);
    expect(dependencies.close).toHaveBeenCalledOnce();
  });

  it("uses existing server model and key with no invented max_tokens or model capability", async () => {
    vi.stubEnv("HARNESS_MODEL_REQUEST_TIMEOUT_MS", "12345");
    const run = vi.fn<Runner>(async () => result({ mode: "deepseek" }));
    expect(await createOfficialDshDriver(undefined, run)(input())).toEqual({
      finalResponse: "Controlled result", model: "configured-model",
    });
    expect(run.mock.calls[0][0].modelConfig).toEqual({ mode: "deepseek", apiKey: "synthetic-offline-test-key",
      baseURL: DEEPSEEK_BASE_URL, model: "configured-model", timeoutMs: 12345 });
    expect(dependencies.close).toHaveBeenCalledOnce();
  });

  it("rejects pre-cancelled or initially unauthorized requests before opening a broker or runtime", async () => {
    const run = vi.fn<Runner>();
    const controller = new AbortController(); controller.abort();
    await expect(createOfficialDshDriver(fixtureModel, run)(input({ signal: controller.signal }))).rejects.toThrow();
    await expect(createOfficialDshDriver(fixtureModel, run)(input({ authorizeCurrentAccess() {
      throw new Error("Controlled authorization revocation");
    } }))).rejects.toThrow("Controlled authorization revocation");
    expect(dependencies.broker).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses an unreaped SDK receipt and still closes the broker", async () => {
    const run = vi.fn<Runner>(async () => result({ reaped: false }));
    await expect(createOfficialDshDriver(fixtureModel, run)(input())).rejects.toThrow();
    expect(dependencies.close).toHaveBeenCalledOnce();
  });

  it("forwards runtime rejection without fallback and closes its broker", async () => {
    const run = vi.fn<Runner>(async () => { throw new Error("Controlled DSH terminal failure"); });
    await expect(createOfficialDshDriver(fixtureModel, run)(input())).rejects.toThrow("Controlled DSH terminal failure");
    expect(run).toHaveBeenCalledOnce();
    expect(dependencies.close).toHaveBeenCalledOnce();
  });

  it("rechecks authorization after the awaited SDK cleanup before exposing a receipt", async () => {
    let allowed = true;
    const run = vi.fn<Runner>(async () => { allowed = false; return result(); });
    await expect(createOfficialDshDriver(fixtureModel, run)(input({ authorizeCurrentAccess() {
      if (!allowed) throw new Error("Controlled late revocation");
    } }))).rejects.toThrow("Controlled late revocation");
    expect(dependencies.close).toHaveBeenCalledOnce();
  });

  it("does not settle cancellation ahead of the runtime's pending teardown", async () => {
    const controller = new AbortController();
    let entered: () => void = () => {}, finish: () => void = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const cleanup = new Promise<void>((resolve) => { finish = resolve; });
    const run = vi.fn<Runner>(async () => { entered(); await cleanup; return result(); });
    let settled = false;
    const pending = createOfficialDshDriver(fixtureModel, run)(input({ signal: controller.signal }));
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await started;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(dependencies.close).not.toHaveBeenCalled();
    finish();
    await expect(pending).rejects.toThrow();
    expect(dependencies.close).toHaveBeenCalledOnce();
  });
});
