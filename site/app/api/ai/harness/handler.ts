import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { runNotebook } from "@/core/notebook/server/runtime";
import {
  HarnessIdempotencyConflictError,
  HarnessIdempotencyStore,
  HarnessRequestError,
} from "@/core/harness/deepseek-harness";
import { CoordinatedHarness } from "@/core/harness/agents/coordinator";
import {
  MAX_HARNESS_REQUEST_BYTES,
  MAX_HARNESS_IMAGE_ATTACHMENTS,
  MAX_HARNESS_IMAGE_BYTES,
  MAX_HARNESS_TOTAL_IMAGE_BYTES,
  harnessPublicRequestSchema,
  harnessRequestSchema,
  harnessResponseSchema,
} from "@/core/harness/contracts";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { demoLocalDataRuntime } from "@/fixtures/retail-orders";
import { createLabRequest } from "@/core/visualization-lab/cases";
import { createHarnessExcelExporter } from "@/core/exports/server/harness-excel-exporter";
import { requestDatasetRepository, requestProjectHandle, projectErrorResponse } from "@/core/projects/server/request";
import { ProjectError } from "@/core/projects/server/store";
import { validateSemanticModel } from "@/core/semantic/model";
import { ownershipNamespace } from "@/core/identity/ownership";
import { DEMO_IDENTITY_RESPONSE_HEADERS, resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import { findLiveHarnessCase } from "@/core/evaluation/live/manifest";
import { BoundedBodyError, readBoundedBodyBytes, readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import { EDS_UPLOAD_LIMITS, EdsAnalysisError, type EdsWorkbookSheet } from "@/core/eds";
import { readEdsXlsx } from "@/core/eds/server/workbook";
import { sanitizeEdsPublicError } from "@/core/eds/server/public-error";
import { liveHarnessTrustedModelSchema, type LiveHarnessEvaluationCase } from "@/core/evaluation/live/contracts";
import {
  createEdsWorkspaceDataSources,
  createEdsWorkspaceRuntime,
  isEdsWorkspaceDataSourceId,
} from "@/core/eds";
import {
  LIVE_EVALUATION_CASE_HEADER,
  LIVE_EVALUATION_NONCE_HEADER,
  LIVE_EVALUATION_RUN_HEADER,
  LIVE_EVALUATION_SESSION_HEADER,
  LIVE_EVALUATION_SESSION_VALUE,
  isLoopbackHttpUrl,
  safeNonceMatches,
} from "@/core/evaluation/live/protocol";
import { PlaywrightMultimodalVisualVerifier, type UploadedHarnessImage } from "@/core/harness/visual-verifier";
import { createRequestMcpRuntime } from "@/core/wecom/server/runtime";
import { wecomOwnershipNamespace } from "@/core/wecom/server/session";
import { isDataIndependentUiStyleMutation } from "@/core/harness/conversation";
import { resolveDeepSeekApiKey, resolveDeepSeekModel } from "@/core/ai/server/runtime-credentials";
import { createHarnessStreamResponse } from "@/core/harness/stream";
import type { HarnessTraceEvent } from "@/core/harness/contracts";
import { harnessConversationStore } from "@/core/harness/server/conversation-store";

export const runtime = "nodejs";
const REQUEST_BODY_TIMEOUT_MS = 15_000;
const MAX_HARNESS_MULTIPART_BYTES = EDS_UPLOAD_LIMITS.maxFileBytes + MAX_HARNESS_TOTAL_IMAGE_BYTES + MAX_HARNESS_REQUEST_BYTES + 1024 * 1024;
const RAW_WORKBOOK_CACHE_TTL_MS = 30 * 60 * 1_000;
const RAW_WORKBOOK_CACHE_MAX_ENTRIES = 4;

interface CachedRawWorkbook {
  contentHash: string;
  sheets: EdsWorkbookSheet[];
  expiresAt: number;
}

const rawWorkbookCache = new Map<string, CachedRawWorkbook>();

const noStoreHeaders = {
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
  ...DEMO_IDENTITY_RESPONSE_HEADERS,
};
const harness = new CoordinatedHarness();
const idempotencyStore = new HarnessIdempotencyStore();

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function error(message: string, status: number) {
  return NextResponse.json({ error: { message } }, { status, headers: noStoreHeaders });
}

function configuredVisualVerifier(request: Request) {
  if (process.env.HARNESS_VISUAL_VERIFICATION_ENABLED !== "1") return undefined;
  const apiKey = process.env.HARNESS_VISION_API_KEY?.trim();
  const model = process.env.HARNESS_VISION_MODEL?.trim();
  const apiUrl = process.env.HARNESS_VISION_API_URL?.trim();
  if (!apiKey || !model || !apiUrl) return undefined;
  return new PlaywrightMultimodalVisualVerifier({
    baseUrl: process.env.HARNESS_VISUAL_BASE_URL?.trim() || new URL(request.url).origin,
    apiUrl,
    apiKey,
    model,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() ? {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.trim(),
    } : {}),
    ...(process.env.HARNESS_PLAYWRIGHT_CAPTURE_URL?.trim() ? {
      captureServiceUrl: process.env.HARNESS_PLAYWRIGHT_CAPTURE_URL.trim(),
    } : {}),
    timeoutMs: positiveInteger(process.env.HARNESS_VISUAL_VERIFICATION_TIMEOUT_MS, 35_000),
  });
}

function cachedRawWorkbook(contentHash: string): CachedRawWorkbook | undefined {
  const now = Date.now();
  for (const [key, cached] of rawWorkbookCache) {
    if (cached.expiresAt <= now) rawWorkbookCache.delete(key);
  }
  const cached = rawWorkbookCache.get(contentHash);
  if (!cached) return undefined;
  cached.expiresAt = now + RAW_WORKBOOK_CACHE_TTL_MS;
  rawWorkbookCache.delete(contentHash);
  rawWorkbookCache.set(contentHash, cached);
  return cached;
}

function rememberRawWorkbook(contentHash: string, sheets: EdsWorkbookSheet[]): void {
  rawWorkbookCache.set(contentHash, { contentHash, sheets, expiresAt: Date.now() + RAW_WORKBOOK_CACHE_TTL_MS });
  while (rawWorkbookCache.size > RAW_WORKBOOK_CACHE_MAX_ENTRIES) {
    const oldest = rawWorkbookCache.keys().next().value as string | undefined;
    if (!oldest) break;
    rawWorkbookCache.delete(oldest);
  }
}

function imageSignatureMatches(bytes: Buffer, mimeType: UploadedHarnessImage["manifest"]["mimeType"]): boolean {
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

async function parseMultipartHarnessRequest(request: Request, contentType: string): Promise<{
  raw: unknown;
  rawWorkbook?: { fileName: string; contentHash: string; sheets: EdsWorkbookSheet[] };
  images: UploadedHarnessImage[];
}> {
  const bytes = await readBoundedBodyBytes(request, MAX_HARNESS_MULTIPART_BYTES, { signal: request.signal, timeoutMs: REQUEST_BODY_TIMEOUT_MS });
  let form: FormData;
  try {
    form = await new Request(request.url, {
      method: "POST",
      headers: { "content-type": contentType },
      body: (bytes.buffer as ArrayBuffer).slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }).formData();
  } catch {
    throw new HarnessRequestError("Harness multipart/form-data 请求格式无效。", 400);
  }
  const allowed = new Set(["payload", "rawWorkbook", "imageAttachment"]);
  const workbookParts = form.getAll("rawWorkbook");
  const imageParts = form.getAll("imageAttachment");
  if ([...form.keys()].some((key) => !allowed.has(key))
    || form.getAll("payload").length !== 1
    || workbookParts.length > 1
    || imageParts.length > MAX_HARNESS_IMAGE_ATTACHMENTS
    || (workbookParts.length === 0 && imageParts.length === 0)) {
    throw new HarnessRequestError("Harness 文件请求必须包含一个 payload，并可附带一个原始工作簿和最多 3 张图片。", 400);
  }
  const payload = form.get("payload");
  const workbook = workbookParts[0];
  if (typeof payload !== "string" || Buffer.byteLength(payload, "utf8") > MAX_HARNESS_REQUEST_BYTES) {
    throw new HarnessRequestError("Harness 请求上下文过大或格式无效。", 413);
  }
  if (workbook !== undefined && (!(workbook instanceof File) || workbook.size < 1 || workbook.size > EDS_UPLOAD_LIMITS.maxFileBytes)) {
    throw new HarnessRequestError("Harness 原始工作簿为空或超过 10 MiB。", 413);
  }
  if (imageParts.some((item) => !(item instanceof File)
    || item.size < 1
    || item.size > MAX_HARNESS_IMAGE_BYTES
    || !["image/jpeg", "image/png", "image/webp"].includes(item.type))
    || imageParts.reduce((total, item) => total + (item instanceof File ? item.size : 0), 0) > MAX_HARNESS_TOTAL_IMAGE_BYTES) {
    throw new HarnessRequestError("上传图片必须是 JPEG、PNG 或 WebP；单张不超过 3 MiB、合计不超过 6 MiB。", 413);
  }
  let raw: unknown;
  try { raw = JSON.parse(payload) as unknown; } catch { throw new HarnessRequestError("Harness payload 不是有效 JSON。", 400); }
  const images = await Promise.all(imageParts.map(async (item, index): Promise<UploadedHarnessImage> => {
    const file = item as File;
    const imageBytes = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type as UploadedHarnessImage["manifest"]["mimeType"];
    if (!imageSignatureMatches(imageBytes, mimeType)) throw new HarnessRequestError("上传图片的文件内容与声明格式不一致。", 400);
    return {
      bytes: imageBytes,
      manifest: {
        id: `uploaded_image_${index + 1}`,
        fileName: file.name.slice(0, 180),
        mimeType,
        byteLength: imageBytes.byteLength,
        sha256: createHash("sha256").update(imageBytes).digest("hex"),
      },
    };
  }));
  if (!(workbook instanceof File)) return { raw, images };
  const workbookBuffer = Buffer.from(await workbook.arrayBuffer());
  const contentHash = createHash("sha256").update(workbookBuffer).digest("hex");
  const cached = cachedRawWorkbook(contentHash);
  const sheets = cached?.sheets ?? await readEdsXlsx({
      buffer: workbookBuffer,
      originalFileName: workbook.name,
      mimeType: workbook.type,
    });
  if (!cached) rememberRawWorkbook(contentHash, sheets);
  return { raw, rawWorkbook: { fileName: workbook.name, contentHash, sheets }, images };
}

function liveEvaluationCase(request: Request): LiveHarnessEvaluationCase | NextResponse | null {
  const session = request.headers.get(LIVE_EVALUATION_SESSION_HEADER);
  const hasLiveHeader = session !== null
    || request.headers.has(LIVE_EVALUATION_NONCE_HEADER)
    || request.headers.has(LIVE_EVALUATION_CASE_HEADER)
    || request.headers.has(LIVE_EVALUATION_RUN_HEADER);
  if (!hasLiveHeader) return null;
  // vinext/Vite only forwards statically referenced server variables into the route runtime.
  if (session !== LIVE_EVALUATION_SESSION_VALUE || process.env.HARNESS_EVAL_SERVER !== "1") {
    return error("Live Harness 评测服务端开关未启用。", 403);
  }
  if (!isLoopbackHttpUrl(request.url)) return error("Live Harness 评测仅允许本机 loopback 请求。", 403);
  if (!safeNonceMatches(
    process.env.HARNESS_EVAL_SESSION_NONCE,
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
    !resolveDeepSeekApiKey()
    || !configuredModel
    || !liveHarnessTrustedModelSchema.safeParse(configuredModel).success
  ) {
    return error("Live Harness 评测所需的服务端 AI 配置尚未完成。", 503);
  }
  return evaluationCase;
}

export async function handleHarnessRequest(request: Request, streaming = false, options: { visualizationLab?: boolean } = {}) {
  // Only the dedicated server route selects this mode; it is not a public request flag.
  const visualizationLab = options.visualizationLab === true;
  const liveEvaluation = visualizationLab ? undefined : liveEvaluationCase(request);
  if (liveEvaluation instanceof NextResponse) return liveEvaluation;
  const contentTypeHeader = request.headers.get("content-type") ?? "";
  const contentType = contentTypeHeader.split(";", 1)[0].trim().toLocaleLowerCase("en-US");
  if (visualizationLab && (contentType !== "application/json" || request.headers.has("x-agentcanvas-project"))) {
    return error("可视化测试只接受独立示例画布的 JSON 请求。", 400);
  }
  if (contentType !== "application/json" && contentType !== "multipart/form-data") {
    return error("Harness 请求必须使用 application/json；授权原始数据时使用 multipart/form-data。", 415);
  }
  let raw: unknown;
  let rawWorkbook: { fileName: string; contentHash: string; sheets: EdsWorkbookSheet[] } | undefined;
  let uploadedImages: UploadedHarnessImage[] = [];
  try {
    if (contentType === "multipart/form-data") {
      const parsedMultipart = await parseMultipartHarnessRequest(request, contentTypeHeader);
      raw = parsedMultipart.raw;
      rawWorkbook = parsedMultipart.rawWorkbook;
      uploadedImages = parsedMultipart.images;
    } else {
      const text = await readBoundedUtf8Body(request, MAX_HARNESS_REQUEST_BYTES, { signal: request.signal, timeoutMs: REQUEST_BODY_TIMEOUT_MS });
      raw = JSON.parse(text) as unknown;
    }
  } catch (caught) {
    if (caught instanceof HarnessRequestError) return error(caught.message, caught.status);
    if (caught instanceof EdsAnalysisError) return error(`原始工作簿不可用：${sanitizeEdsPublicError(caught.message)}`, caught.status);
    if (caught instanceof SyntaxError) return error("Harness 请求体不是有效 JSON。", 400);
    const tooLarge = caught instanceof BoundedBodyError && caught.code === "too-large";
    const interrupted = caught instanceof BoundedBodyError && (caught.code === "timeout" || caught.code === "aborted");
    return error(
      tooLarge ? "Harness 请求上下文过大。" : interrupted ? "Harness 请求体读取超时或已取消。" : "Harness 请求体长度或编码无效。",
      tooLarge ? 413 : interrupted ? 408 : 400,
    );
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
    const datasetRepository = requestDatasetRepository(request);
    const projectHandle = requestProjectHandle(request);
    const conversationNamespace = `${wecomOwnershipNamespace(request, ownershipNamespace(identity))}${projectHandle ? `:project:${projectHandle}` : ""}${visualizationLab ? ":visualization-lab" : ""}`;
    const publicRequest = visualizationLab
      ? createLabRequest(parsed.data.instruction, parsed.data.idempotencyKey)
      : liveEvaluation
      ? {
          ...parsed.data,
          appSpec: structuredClone(fixtures.dataProduct.appSpec),
          recipes: structuredClone(fixtures.dataProduct.recipes),
        }
      : parsed.data;
    // Never trust connection permissions supplied in the browser request.
    if (publicRequest.notebookContext) {
      const connections = listConnections(projectHandle, true);
      if (connections.length) assertLocalProjectRequest(request);
      publicRequest.notebookContext = { ...publicRequest.notebookContext, connections };
    }
    const uploadedSourceIds = publicRequest.appSpec.dataSources.filter((source) => source.sourceType === "csv"
      && (!publicRequest.notebookContext || publicRequest.notebookContext.sourceIds.includes(source.id))).map((source) => source.id);
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
    const uploaded = isDataIndependentUiStyleMutation(publicRequest.instruction) ? [] : await Promise.all(uploadedSourceIds.map(async (datasetId) => {
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
    if (publicRequest.semanticModel) {
      if (publicRequest.semanticModel.sourceDatasetId !== publicRequest.dataSourceId) throw new HarnessRequestError("语义模型与当前数据表不匹配，请重新选择模型。", 400);
      try {
        validateSemanticModel(publicRequest.semanticModel, canonicalSources.find((source) => source.id === publicRequest.semanticModel!.sourceDatasetId));
      } catch (error) { throw new HarnessRequestError(error instanceof Error ? error.message : "语义模型无效", 400); }
    }
    const serverRequest = harnessRequestSchema.parse({
      ...publicRequest,
      appSpec: { ...publicRequest.appSpec, dataSources: canonicalSources },
      recipes: canonicalRecipes,
      role: identity.role,
      ...(rawWorkbook ? {
        rawWorkbookManifest: {
          fileName: rawWorkbook.fileName,
          contentHash: rawWorkbook.contentHash,
          sheets: rawWorkbook.sheets.map((sheet) => ({
            name: sheet.sheet,
            rowCount: sheet.data.length,
            columnCount: sheet.data.reduce((maximum, row) => Math.max(maximum, row.length), 0),
          })),
        },
      } : {}),
      ...(uploadedImages.length ? { imageAttachmentManifest: uploadedImages.map(({ manifest }) => manifest) } : {}),
    });
    const dataRuntime = {
      rowsByDataSourceId: {
        ...(visualizationLab ? demoLocalDataRuntime : fixtures.dataRuntime).rowsByDataSourceId,
        ...Object.fromEntries(uploaded.map((dataset) => [dataset.descriptor.datasetId, dataset.rows])),
        ...(publicRequest.edsWorkspace ? createEdsWorkspaceRuntime(publicRequest.edsWorkspace).rowsByDataSourceId : {}),
      },
    };
    const expectedAiAccessPolicies = uploaded.map((dataset) => ({
      datasetId: dataset.descriptor.datasetId,
      policy: dataset.descriptor.aiAccessPolicy,
    }));
    // The studio capture service opens a fresh workbench, not this candidate.
    // Lab candidates are rendered and assessed in the browser; never attach unrelated screenshot evidence.
    const visualVerifier = visualizationLab ? undefined : configuredVisualVerifier(request);
    const configuredContextBudget = {
      ...(process.env.HARNESS_MAX_TOTAL_INPUT_CHARS?.trim()
        ? { maxTotalInputChars: positiveInteger(process.env.HARNESS_MAX_TOTAL_INPUT_CHARS, 96_000) }
        : {}),
      ...(process.env.HARNESS_MAX_TOTAL_PROMPT_TOKENS?.trim()
        ? { maxTotalPromptTokens: positiveInteger(process.env.HARNESS_MAX_TOTAL_PROMPT_TOKENS, 48_000) }
        : {}),
    };
    if (uploadedImages.length && !visualVerifier) {
      throw new HarnessRequestError("图片分析尚未配置，请先启用支持图像输入的视觉模型。", 503);
    }
    const runHarness = async (signal: AbortSignal, onEvent?: (event: HarnessTraceEvent) => void) => {
      const preparing: HarnessTraceEvent = {
        id: `harness_${serverRequest.idempotencyKey}:1`, sequence: 1, taskId: `harness_${serverRequest.idempotencyKey}`,
        timestamp: new Date().toISOString(), type: "task_started", taskState: "planning",
        message: "请求已接受，正在准备授权上下文、图片证据和外部工具。",
      };
      onEvent?.(preparing);
      const sequenceEvent = (event: HarnessTraceEvent): HarnessTraceEvent => ({ ...event,
        id: `${event.taskId}:${event.sequence + 1}`, sequence: event.sequence + 1,
        type: event.type === "task_started" ? "status_update" : event.type,
      });
      const conversation = harnessConversationStore.begin(serverRequest, conversationNamespace);
      let mcpRuntime;
      try {
        mcpRuntime = liveEvaluation || visualizationLab ? undefined : await createRequestMcpRuntime(request, signal);
        const imageEvidence = uploadedImages.length && visualVerifier
          ? await visualVerifier.inspectUploadedImages({
              instruction: serverRequest.instruction,
              images: uploadedImages,
              signal,
            })
          : undefined;
        const effectiveRequest = harnessRequestSchema.parse({
          ...serverRequest,
          ...(conversation.context ? { conversationContext: conversation.context } : {}),
          ...(imageEvidence ? { userImageEvidence: imageEvidence } : {}),
          ...(mcpRuntime?.catalog().length ? { mcpTools: mcpRuntime.catalog() } : {}),
        });
        const task = await harness.run(effectiveRequest, {
          agentMode: !liveEvaluation && !visualizationLab && process.env.HARNESS_MULTI_AGENT_MODE === "data" ? "data" : "single",
          dataRuntime,
          apiKey: resolveDeepSeekApiKey(),
          model: liveEvaluation ? process.env.DEEPSEEK_MODEL : resolveDeepSeekModel(),
          signal,
          onEvent: (event) => onEvent?.(sequenceEvent(event)),
          excelExporter: createHarnessExcelExporter({ ownership: identity, repository: datasetRepository }),
          connectionInspector: (connectionId, signal) => inspectConnectionSchema({ connectionId, signal, project: projectHandle, forAi: true }),
          notebookRunner: async (artifact, context) => runNotebook({ document: { name: artifact.name,
            revision: context.request.notebookContext?.document.revision ?? 0, cells: artifact.cells },
            sources: artifact.sourceDataSourceIds.map((id) => {
              const source = context.request.appSpec.dataSources.find((item) => item.id === id);
              const rows = context.dataRuntime.rowsByDataSourceId[id];
              if (!source || !rows) throw new Error("Notebook 源数据不可用");
              return { source, rows };
            }), semanticModels: context.request.semanticModel ? [context.request.semanticModel] : [],
            connectionQuery: (connectionId, sql, signal) => executeConnectionSql({ connectionId, sql, signal, project: projectHandle, forAi: true }),
            forAi: true, signal: context.signal, userId: identity.ownerId, taskId: `harness_${context.request.idempotencyKey}` }),
          ...(rawWorkbook ? { rawWorkbook } : {}),
          ...(mcpRuntime ? { mcpRuntime } : {}),
          ...(visualVerifier ? {
            visualVerifier,
            visualVerificationTimeoutMs: positiveInteger(process.env.HARNESS_VISUAL_VERIFICATION_TIMEOUT_MS, 35_000),
          } : {}),
          authorizeModelCall: () => {
            if (expectedAiAccessPolicies.length > 0) datasetRepository.assertAiAccessPolicies(identity, expectedAiAccessPolicies);
            const expected = publicRequest.notebookContext?.connections ?? [];
            if (expected.length && JSON.stringify(listConnections(projectHandle, true)) !== JSON.stringify(expected)) {
              throw new Error("数据库连接的 Agent 授权已变化，请重新发起任务");
            }
          },
          bounds: {
            maxModelCalls: liveEvaluation?.limits.maxModelCalls ?? positiveInteger(process.env.HARNESS_MAX_MODEL_CALLS, 8),
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
          } : Object.keys(configuredContextBudget).length ? { contextBudget: configuredContextBudget } : {}),
        });
        task.trace = [preparing, ...(task.trace ?? []).map(sequenceEvent)];
        conversation.commit(task);
        return task;
      } finally {
        conversation.release();
        await mcpRuntime?.close();
      }
    };
    // Live 评测使用一次性 run ID 且不写入常规幂等任务缓存；普通工作台请求保持原行为。
    const execute = (signal: AbortSignal, onEvent?: (event: HarnessTraceEvent) => void) => liveEvaluation
      ? runHarness(signal, onEvent)
      : idempotencyStore.execute(serverRequest, (emit) => runHarness(signal, emit), conversationNamespace, onEvent, signal);
    if (streaming) return createHarnessStreamResponse(request.signal, async (signal, emit) => {
      try { return await execute(signal, emit); }
      catch (caught) {
        if (caught instanceof HarnessRequestError || caught instanceof HarnessIdempotencyConflictError) throw caught;
        // Match the JSON route: unexpected setup/storage/provider errors cannot expose local paths/configuration.
        throw new Error("Harness 服务暂时不可用。任务尚未取得有效结果，请检查服务后重试。");
      }
    }, noStoreHeaders);
    const task = await execute(request.signal);
    return NextResponse.json(harnessResponseSchema.parse({ task }), { status: 200, headers: noStoreHeaders });
  } catch (caught) {
    if (caught instanceof HarnessIdempotencyConflictError) return error(caught.message, 409);
    if (caught instanceof ProjectError) return projectErrorResponse(caught);
    if (caught instanceof HarnessRequestError) return error(caught.message, caught.status);
    return error("Harness 服务暂时不可用。", 503);
  }
}
import { listConnections } from "@/core/connections/server/config";
import { executeConnectionSql, inspectConnectionSchema } from "@/core/connections/server/query";
import { assertLocalProjectRequest } from "@/core/projects/server/request";
