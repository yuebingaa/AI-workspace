import { NextResponse } from "next/server";
import { aiPlannerRateLimiter } from "@/core/ai/server/rate-limit";
import {
  DeepSeekHarness,
  HarnessIdempotencyConflictError,
  HarnessIdempotencyStore,
  HarnessRequestError,
} from "@/core/harness/deepseek-harness";
import {
  MAX_HARNESS_REQUEST_BYTES,
  harnessPublicRequestSchema,
  harnessRequestSchema,
} from "@/core/harness/contracts";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { createHarnessExcelExporter } from "@/core/exports/server/harness-excel-exporter";
import { datasetRepository } from "@/core/datasets/server/dataset-repository";
import { ownershipNamespace } from "@/core/identity/ownership";
import { DEMO_IDENTITY_RESPONSE_HEADERS, resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import { findLiveHarnessCase } from "@/core/evaluation/live/manifest";
import { BoundedBodyError, readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import { liveHarnessTrustedModelSchema, type LiveHarnessEvaluationCase } from "@/core/evaluation/live/contracts";
import {
  createEdsWorkspaceDataSources,
  createEdsWorkspaceRuntime,
  isEdsWorkspaceDataSourceId,
} from "@/core/eds";
import {
  LIVE_EVALUATION_CASE_HEADER,
  LIVE_EVALUATION_NONCE_ENV,
  LIVE_EVALUATION_NONCE_HEADER,
  LIVE_EVALUATION_RUN_HEADER,
  LIVE_EVALUATION_SERVER_FLAG,
  LIVE_EVALUATION_SESSION_HEADER,
  LIVE_EVALUATION_SESSION_VALUE,
  isLoopbackHttpUrl,
  safeNonceMatches,
} from "@/core/evaluation/live/protocol";

export const runtime = "nodejs";
const REQUEST_BODY_TIMEOUT_MS = 15_000;

const noStoreHeaders = {
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
  ...DEMO_IDENTITY_RESPONSE_HEADERS,
};
const harness = new DeepSeekHarness();
const idempotencyStore = new HarnessIdempotencyStore();

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `harness:${(forwarded || request.headers.get("x-real-ip") || "local").slice(0, 110)}`;
}

function error(message: string, status: number) {
  return NextResponse.json({ error: { message } }, { status, headers: noStoreHeaders });
}

function liveEvaluationCase(request: Request): LiveHarnessEvaluationCase | NextResponse | null {
  const session = request.headers.get(LIVE_EVALUATION_SESSION_HEADER);
  const hasLiveHeader = session !== null
    || request.headers.has(LIVE_EVALUATION_NONCE_HEADER)
    || request.headers.has(LIVE_EVALUATION_CASE_HEADER)
    || request.headers.has(LIVE_EVALUATION_RUN_HEADER);
  if (!hasLiveHeader) return null;
  if (session !== LIVE_EVALUATION_SESSION_VALUE || process.env[LIVE_EVALUATION_SERVER_FLAG] !== "1") {
    return error("Live Harness 评测服务端开关未启用。", 403);
  }
  if (!isLoopbackHttpUrl(request.url)) return error("Live Harness 评测仅允许本机 loopback 请求。", 403);
  if (!safeNonceMatches(
    process.env[LIVE_EVALUATION_NONCE_ENV],
    request.headers.get(LIVE_EVALUATION_NONCE_HEADER),
  )) {
    return error("Live Harness 评测会话校验失败。", 403);
  }
  const runId = request.headers.get(LIVE_EVALUATION_RUN_HEADER);
  if (!runId || !/^[a-f0-9]{32}$/.test(runId)) return error("Live Harness 评测运行标识无效。", 400);
  const evaluationCase = findLiveHarnessCase(request.headers.get(LIVE_EVALUATION_CASE_HEADER) ?? "");
  if (!evaluationCase) return error("Live Harness 评测用例不在允许列表中。", 400);
  const configuredModel = process.env.DEEPSEEK_MODEL?.trim();
  if (
    !process.env.DEEPSEEK_API_KEY?.trim()
    || !configuredModel
    || !liveHarnessTrustedModelSchema.safeParse(configuredModel).success
  ) {
    return error("Live Harness 评测所需的服务端 AI 配置尚未完成。", 503);
  }
  return evaluationCase;
}

export async function POST(request: Request) {
  const liveEvaluation = liveEvaluationCase(request);
  if (liveEvaluation instanceof NextResponse) return liveEvaluation;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLocaleLowerCase("en-US");
  if (contentType !== "application/json") return error("Harness 请求必须使用 application/json。", 415);
  if (!aiPlannerRateLimiter.consume(clientKey(request))) return error("Harness 请求过于频繁，请稍后重试。", 429);
  let text: string;
  try {
    text = await readBoundedUtf8Body(request, MAX_HARNESS_REQUEST_BYTES, { signal: request.signal, timeoutMs: REQUEST_BODY_TIMEOUT_MS });
  } catch (caught) {
    const tooLarge = caught instanceof BoundedBodyError && caught.code === "too-large";
    const interrupted = caught instanceof BoundedBodyError && (caught.code === "timeout" || caught.code === "aborted");
    return error(
      tooLarge ? "Harness 请求上下文过大。" : interrupted ? "Harness 请求体读取超时或已取消。" : "Harness 请求体长度或编码无效。",
      tooLarge ? 413 : interrupted ? 408 : 400,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return error("Harness 请求体不是有效 JSON。", 400);
  }
  const parsed = harnessPublicRequestSchema.safeParse(raw);
  if (!parsed.success) return error("Harness 请求格式不正确。", 400);
  if (!demoFixtureResult.success) return error("服务端演示数据不可用。", 500);
  const fixtures = demoFixtureResult.data;
  if (liveEvaluation) {
    const expected = liveEvaluation.request;
    const matchesManifest = parsed.data.instruction === expected.instruction
      && parsed.data.pageId === expected.pageId
      && parsed.data.dataSourceId === expected.dataSourceId
      && parsed.data.appSpec.dataSources.every((source) => source.sourceType !== "csv");
    if (!matchesManifest) return error("Live Harness 评测请求与服务端用例清单不一致。", 400);
  }
  try {
    const identity = resolveDemoRequestIdentity();
    const publicRequest = liveEvaluation
      ? {
          ...parsed.data,
          appSpec: structuredClone(fixtures.dataProduct.appSpec),
          recipes: structuredClone(fixtures.dataProduct.recipes),
        }
      : parsed.data;
    const uploadedSourceIds = publicRequest.appSpec.dataSources.filter((source) => source.sourceType === "csv").map((source) => source.id);
    const claimedEdsSourceIds = publicRequest.appSpec.dataSources
      .filter((source) => isEdsWorkspaceDataSourceId(source.id))
      .map((source) => source.id);
    const canonicalEdsSources = publicRequest.edsWorkspace
      ? createEdsWorkspaceDataSources(publicRequest.edsWorkspace)
      : [];
    if (
      (claimedEdsSourceIds.length > 0 && !publicRequest.edsWorkspace)
      || (publicRequest.edsWorkspace && canonicalEdsSources.some((source) => !claimedEdsSourceIds.includes(source.id)))
    ) {
      throw new HarnessRequestError("EDS 派生汇总上下文缺失或与工作台数据源不一致，请重新生成 EDS 看板。", 400);
    }
    const uploaded = await Promise.all(uploadedSourceIds.map(async (datasetId) => {
      const stored = await datasetRepository.get(identity, datasetId);
      if (!stored) throw new HarnessRequestError(`上传数据集 ${datasetId} 不存在或已过期，请重新上传。`, 410);
      if (stored.descriptor.aiAccessPolicy === "pending") {
        throw new HarnessRequestError(`数据集“${stored.descriptor.source.name}”包含可能的敏感字段，请先确认 AI 数据处理方式。`, 403);
      }
      return stored;
    }));
    const canonicalSources = publicRequest.appSpec.dataSources.map((source) => (
      source.sourceType === "csv"
        ? uploaded.find((dataset) => dataset.descriptor.datasetId === source.id)?.descriptor.source ?? source
        : canonicalEdsSources.find((candidate) => candidate.id === source.id) ?? source
    ));
    const canonicalRecipes = [
      ...publicRequest.recipes.filter((recipe) => !uploadedSourceIds.includes(recipe.sourceDatasetId)),
      ...uploaded.map((dataset) => dataset.descriptor.recipe),
    ];
    const serverRequest = harnessRequestSchema.parse({
      ...publicRequest,
      appSpec: { ...publicRequest.appSpec, dataSources: canonicalSources },
      recipes: canonicalRecipes,
      role: identity.role,
    });
    const dataRuntime = {
      rowsByDataSourceId: {
        ...fixtures.dataRuntime.rowsByDataSourceId,
        ...Object.fromEntries(uploaded.map((dataset) => [dataset.descriptor.datasetId, dataset.rows])),
        ...(publicRequest.edsWorkspace ? createEdsWorkspaceRuntime(publicRequest.edsWorkspace).rowsByDataSourceId : {}),
      },
    };
    const expectedAiAccessPolicies = uploaded.map((dataset) => ({
      datasetId: dataset.descriptor.datasetId,
      policy: dataset.descriptor.aiAccessPolicy,
    }));
    const runHarness = () => harness.run(serverRequest, {
      dataRuntime,
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: process.env.DEEPSEEK_MODEL,
      signal: request.signal,
      excelExporter: createHarnessExcelExporter({ ownership: identity, repository: datasetRepository }),
      ...(expectedAiAccessPolicies.length > 0 ? {
        authorizeModelCall: () => datasetRepository.assertAiAccessPolicies(identity, expectedAiAccessPolicies),
      } : {}),
      bounds: {
        maxModelCalls: liveEvaluation?.limits.maxModelCalls ?? positiveInteger(process.env.HARNESS_MAX_MODEL_CALLS, 5),
        maxToolCalls: liveEvaluation?.limits.maxToolCalls ?? positiveInteger(process.env.HARNESS_MAX_TOOL_CALLS, 6),
        modelRequestTimeoutMs: positiveInteger(process.env.HARNESS_MODEL_REQUEST_TIMEOUT_MS, 25_000),
        toolCallTimeoutMs: positiveInteger(process.env.HARNESS_TOOL_CALL_TIMEOUT_MS, 10_000),
        totalExecutionTimeoutMs: liveEvaluation?.limits.activeElapsedReservationMs
          ?? positiveInteger(process.env.HARNESS_TOTAL_EXECUTION_TIMEOUT_MS, 90_000),
      },
      ...(liveEvaluation ? {
        contextBudget: { maxTotalPromptTokens: liveEvaluation.limits.promptTokenReservation },
        modelMaxCompletionTokens: liveEvaluation.limits.maxCompletionTokensPerCall,
        requireProviderUsage: true,
        providerPromptTokenLimit: liveEvaluation.limits.promptTokenReservation,
      } : {}),
    });
    // Live 评测使用一次性 run ID 且不写入常规幂等任务缓存；普通工作台请求保持原行为。
    const task = liveEvaluation
      ? await runHarness()
      : await idempotencyStore.execute(serverRequest, runHarness, ownershipNamespace(identity));
    return NextResponse.json({ task }, { status: 200, headers: noStoreHeaders });
  } catch (caught) {
    if (caught instanceof HarnessIdempotencyConflictError) return error(caught.message, 409);
    if (caught instanceof HarnessRequestError) return error(caught.message, caught.status);
    return error("Harness 服务暂时不可用。", 503);
  }
}
