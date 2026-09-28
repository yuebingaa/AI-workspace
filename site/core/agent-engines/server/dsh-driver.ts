import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEEPSEEK_BASE_URL } from "@/core/ai/server/deepseek-endpoint";
import { resolveDeepSeekApiKey, resolveDeepSeekModel } from "@/core/ai/server/runtime-credentials";
import type { DshFixtureConfig, DshModelConfig, DshSessionResult } from "../../../runtime/dsh/driver.mjs";
import type { DshDriver } from "./dsh-engine";
import { createDshToolBroker } from "./tool-broker";
import { redactHarnessSecrets } from "@/core/harness/security";
import { configuredDshPluginSettings } from "./plugin-settings";
import type { DshPluginConfig } from "../plugin-settings";

type DshRuntime = typeof import("../../../runtime/dsh/driver.mjs");

// Keep the optional, Node-only SDK outside the website bundle. This path is
// server-owned; neither model text nor a public request can select a module.
async function runtimeModule(): Promise<DshRuntime> {
  // The native closure also keeps the driver's revisioned imports outside the
  // RSC runner. Already-running tasks retain their original module and SDK root.
  const loaderPath = resolve(process.cwd(), "runtime/dsh/native-loader.cjs");
  const loadCarrier = createRequire(loaderPath)(loaderPath) as (location: string) => Promise<DshRuntime>;
  const location = `${pathToFileURL(resolve(process.cwd(), "runtime/dsh/driver.mjs")).href}?carrier=10`;
  return loadCarrier(location);
}

export async function inspectOfficialDshRuntime(
  loadRuntime: () => Promise<Pick<DshRuntime, "inspectDshRuntime">> = runtimeModule,
) {
  try { return await (await loadRuntime()).inspectDshRuntime(); }
  catch { return { available: false, phase: "carrier_import" as const, code: "carrier_import_failed" as const,
    reason: "本地 DSH Runtime 加载失败（carrier_import/carrier_import_failed）；尚未启动子进程或模型请求。" }; }
}

function configuredModel(): DshModelConfig {
  const apiKey = resolveDeepSeekApiKey();
  if (!apiKey) throw new Error("请先配置 AI 接口。");
  const configuredTimeout = Number(process.env.HARNESS_MODEL_REQUEST_TIMEOUT_MS);
  return { mode: "deepseek", apiKey, model: resolveDeepSeekModel(), baseURL: DEEPSEEK_BASE_URL,
    timeoutMs: Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 25_000 };
}

export async function inspectOfficialDshPluginPackages() {
  return (await runtimeModule()).inspectDshPluginPackages();
}

export async function inspectOfficialDshPackageInventory() {
  return (await runtimeModule()).inspectDshPackageInventory();
}

/** Explicit dependency injection for offline tests; never selected by HTTP input. */
export function createOfficialDshDriver(
  model: () => DshModelConfig | DshFixtureConfig = configuredModel,
  runSession: (options: Parameters<DshRuntime["runDshSession"]>[0]) => Promise<DshSessionResult>
    = async (options) => (await runtimeModule()).runDshSession(options),
  pluginConfig: () => DshPluginConfig = () => ({ skills: false }),
): DshDriver {
  return async (input) => {
    input.signal.throwIfAborted();
    input.authorizeCurrentAccess();
    if (input.nativeSession && input.profile !== "conversation") throw new Error("原生会话仅供专用 DSH 对话入口使用。");
    const modelConfig = model();
    const plugins = pluginConfig();
    const broker = await createDshToolBroker(input);
    try {
      const context = structuredClone(input.context);
      if (input.nativeSession) {
        // Native logs, not a second website transcript, are the model's history.
        // Do not bootstrap unknown legacy source access into a new generation.
        delete context.recentConversation;
        delete context.continuityMemory;
        context.nativeConversation = { mode: input.nativeSession.mode,
          rule: "历史仅承接对话，不是当前数据权限或计算证据；本轮工具与当前上下文才是当前可用能力。旧网页聊天不会自动导入新建的原生会话。" };
      }
      const result = await runSession({ brokerUrl: broker.url, brokerToken: broker.token, modelConfig, plugins,
        ...(input.profile ? { profile: input.profile } : {}),
        ...(input.nativeSession ? { nativeSession: { root: input.nativeSession.root, mode: input.nativeSession.mode } } : {}),
        sessionId: input.nativeSession?.sessionId ?? `agentcanvas-${randomUUID()}`, signal: input.signal,
        instruction: JSON.stringify({ instruction: input.nativeSession ? redactHarnessSecrets(input.instruction) : input.instruction, context }),
      });
      input.signal.throwIfAborted();
      input.authorizeCurrentAccess();
      if (result.runtime !== "official-dsh-sdk" || !result.reaped) throw new Error("DSH 执行回执不完整。");
      if (input.nativeSession && result.persisted !== true) throw new Error("DSH 原生会话检查点未完成，本轮不写入后续历史。");
      // A final response is not a receipt. The engine alone reads the bridge's
      // verified draft; SDK session messages never enter the public SSE stream.
      return { finalResponse: result.finalResponse,
        ...(modelConfig.mode === "deepseek" ? { model: modelConfig.model } : {}) };
    } finally { await broker.close(); }
  };
}

export const officialDshDriver = createOfficialDshDriver(undefined, undefined, () => configuredDshPluginSettings().read().config);
