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

export const runtime = "nodejs";

const noStoreHeaders = { "cache-control": "no-store", ...DEMO_IDENTITY_RESPONSE_HEADERS };
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

export async function POST(request: Request) {
  if (!aiPlannerRateLimiter.consume(clientKey(request))) return error("Harness 请求过于频繁，请稍后重试。", 429);
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_HARNESS_REQUEST_BYTES) return error("Harness 请求上下文过大。", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_HARNESS_REQUEST_BYTES) return error("Harness 请求上下文过大。", 413);
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
  try {
    const identity = resolveDemoRequestIdentity();
    const uploadedSourceIds = parsed.data.appSpec.dataSources.filter((source) => source.sourceType === "csv").map((source) => source.id);
    const uploaded = await Promise.all(uploadedSourceIds.map(async (datasetId) => {
      const stored = await datasetRepository.get(identity, datasetId);
      if (!stored) throw new HarnessRequestError(`上传数据集 ${datasetId} 不存在或已过期，请重新上传。`, 410);
      if (stored.descriptor.aiAccessPolicy === "pending") {
        throw new HarnessRequestError(`数据集“${stored.descriptor.source.name}”包含可能的敏感字段，请先确认 AI 数据处理方式。`, 403);
      }
      return stored;
    }));
    const canonicalSources = parsed.data.appSpec.dataSources.map((source) => (
      source.sourceType === "csv"
        ? uploaded.find((dataset) => dataset.descriptor.datasetId === source.id)?.descriptor.source ?? source
        : source
    ));
    const canonicalRecipes = [
      ...parsed.data.recipes.filter((recipe) => !uploadedSourceIds.includes(recipe.sourceDatasetId)),
      ...uploaded.map((dataset) => dataset.descriptor.recipe),
    ];
    const serverRequest = harnessRequestSchema.parse({
      ...parsed.data,
      appSpec: { ...parsed.data.appSpec, dataSources: canonicalSources },
      recipes: canonicalRecipes,
      role: identity.role,
    });
    const dataRuntime = {
      rowsByDataSourceId: {
        ...fixtures.dataRuntime.rowsByDataSourceId,
        ...Object.fromEntries(uploaded.map((dataset) => [dataset.descriptor.datasetId, dataset.rows])),
      },
    };
    const task = await idempotencyStore.execute(serverRequest, () => harness.run(serverRequest, {
      dataRuntime,
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: process.env.DEEPSEEK_MODEL,
      signal: request.signal,
      excelExporter: createHarnessExcelExporter({ ownership: identity, repository: datasetRepository }),
      bounds: {
        maxModelCalls: positiveInteger(process.env.HARNESS_MAX_MODEL_CALLS, 5),
        maxToolCalls: positiveInteger(process.env.HARNESS_MAX_TOOL_CALLS, 6),
        modelRequestTimeoutMs: positiveInteger(process.env.HARNESS_MODEL_REQUEST_TIMEOUT_MS, 25_000),
        toolCallTimeoutMs: positiveInteger(process.env.HARNESS_TOOL_CALL_TIMEOUT_MS, 10_000),
        totalExecutionTimeoutMs: positiveInteger(process.env.HARNESS_TOTAL_EXECUTION_TIMEOUT_MS, 90_000),
      },
    }), ownershipNamespace(identity));
    return NextResponse.json({ task }, { status: 200, headers: noStoreHeaders });
  } catch (caught) {
    if (caught instanceof HarnessIdempotencyConflictError) return error(caught.message, 409);
    if (caught instanceof HarnessRequestError) return error(caught.message, caught.status);
    return error("Harness 服务暂时不可用。", 503);
  }
}
