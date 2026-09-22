import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEEPSEEK_BASE_URL } from "@/core/ai/server/deepseek-endpoint";
import { resolveDeepSeekApiKey, resolveDeepSeekModel } from "@/core/ai/server/runtime-credentials";
import type { DshFixtureConfig, DshModelConfig, DshSessionResult } from "../../../runtime/dsh/driver.mjs";
import type { DshDriver } from "./dsh-engine";
import { createDshToolBroker } from "./tool-broker";

type DshRuntime = typeof import("../../../runtime/dsh/driver.mjs");

// Keep the optional, Node-only SDK outside the website bundle. This path is
// server-owned; neither model text nor a public request can select a module.
async function runtimeModule(): Promise<DshRuntime> {
  // A fixed carrier revision makes development HMR load the installation-aware
  // driver once; already-running tasks keep their original module and SDK root.
  const location = `${pathToFileURL(resolve(process.cwd(), "runtime/dsh/driver.mjs")).href}?carrier=4`;
  return import(/* @vite-ignore */ location) as Promise<DshRuntime>;
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

/** Explicit dependency injection for offline tests; never selected by HTTP input. */
export function createOfficialDshDriver(
  model: () => DshModelConfig | DshFixtureConfig = configuredModel,
  runSession: (options: Parameters<DshRuntime["runDshSession"]>[0]) => Promise<DshSessionResult>
    = async (options) => (await runtimeModule()).runDshSession(options),
): DshDriver {
  return async (input) => {
    input.signal.throwIfAborted();
    input.authorizeCurrentAccess();
    const modelConfig = model();
    const broker = await createDshToolBroker(input);
    try {
      const result = await runSession({ brokerUrl: broker.url, brokerToken: broker.token, modelConfig,
        sessionId: `agentcanvas-${randomUUID()}`, signal: input.signal,
        instruction: JSON.stringify({ instruction: input.instruction, context: input.context }),
      });
      input.signal.throwIfAborted();
      input.authorizeCurrentAccess();
      if (result.runtime !== "official-dsh-sdk" || !result.reaped) throw new Error("DSH 执行回执不完整。");
      // A final response is not a receipt. The engine alone reads the bridge's
      // verified draft; SDK session messages never enter the public SSE stream.
      return { finalResponse: result.finalResponse,
        ...(modelConfig.mode === "deepseek" ? { model: modelConfig.model } : {}) };
    } finally { await broker.close(); }
  };
}

export const officialDshDriver = createOfficialDshDriver();
