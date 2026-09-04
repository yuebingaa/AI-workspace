import {
  analyzeEdsWorkbook,
  analyzeEdsWorkbookForSelection,
  EdsAnalysisError,
  EdsSelectionRequiredError,
  EDS_MAX_RESPONSE_BYTES,
  EDS_UPLOAD_LIMITS,
  edsAnalysisResponseSchema,
  edsSelectionRequiredResponseSchema,
  edsWorkbookSelectionSchema,
  type EdsWorkbookSelection,
} from "@/core/eds";
import { generateEdsReportExcel, readEdsXlsx } from "@/core/eds/server/workbook";
import { sanitizeEdsPublicError } from "@/core/eds/server/public-error";
import { excelExportStore } from "@/core/exports/server/excel-export-store";
import { DEMO_IDENTITY_RESPONSE_HEADERS, resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";

export const runtime = "nodejs";

const MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = EDS_UPLOAD_LIMITS.maxCombinedBytes + MAX_MULTIPART_OVERHEAD_BYTES;
const BODY_READ_TIMEOUT_MS = 15_000;
const WORKBOOK_PARSE_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_EDS_REQUESTS = 1;

export class EdsConcurrencyLease {
  private readonly pending = new Set<Promise<unknown>>();
  private releaseRequested = false;
  private slotReleased = false;

  constructor(private readonly releaseSlot: () => void) {}

  track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    void operation.then(
      () => this.settle(operation),
      () => this.settle(operation),
    );
    return operation;
  }

  releaseWhenIdle(): void {
    this.releaseRequested = true;
    this.releaseIfIdle();
  }

  private settle(operation: Promise<unknown>): void {
    this.pending.delete(operation);
    this.releaseIfIdle();
  }

  private releaseIfIdle(): void {
    if (!this.releaseRequested || this.pending.size > 0 || this.slotReleased) return;
    this.slotReleased = true;
    this.releaseSlot();
  }
}

export class EdsConcurrencyGate {
  private active = 0;

  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("EDS 并发上限必须是正整数");
  }

  tryAcquire(): EdsConcurrencyLease | null {
    if (this.active >= this.maximum) return null;
    this.active += 1;
    return new EdsConcurrencyLease(() => { this.active -= 1; });
  }
}

const edsConcurrencyGate = new EdsConcurrencyGate(MAX_CONCURRENT_EDS_REQUESTS);

const noStoreHeaders = {
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
  ...DEMO_IDENTITY_RESPONSE_HEADERS,
};

function jsonError(message: string, status: number, headers: HeadersInit = {}) {
  return Response.json({ error: { message: sanitizeEdsPublicError(message) } }, { status, headers: { ...noStoreHeaders, ...headers } });
}

function selectionRequired(error: EdsSelectionRequiredError) {
  const payload = edsSelectionRequiredResponseSchema.parse({
    error: { code: "EDS_SELECTION_REQUIRED", message: error.message, selections: error.selections },
  });
  return Response.json(payload, { status: 409, headers: noStoreHeaders });
}

function uploadedFile(value: FormDataEntryValue | null, label: string, required: true): File;
function uploadedFile(value: FormDataEntryValue | null, label: string, required: false): File | null;
function uploadedFile(value: FormDataEntryValue | null, label: string, required: boolean): File | null {
  if (value instanceof File && value.size > 0) return value;
  if (required) throw new EdsAnalysisError(`${label}不能为空`);
  return null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, status: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new EdsAnalysisError(message, status)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readBoundedRequestBody(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new EdsAnalysisError("EDS 上传内容不能为空");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let timedOut = false;
  let aborted = request.signal.aborted;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelRequested = false;
  const cancelReader = () => {
    if (cancelRequested) return;
    cancelRequested = true;
    void reader.cancel().catch(() => undefined);
  };
  const cancelForAbort = () => {
    aborted = true;
    cancelReader();
  };
  if (aborted) cancelForAbort();
  else request.signal.addEventListener("abort", cancelForAbort, { once: true });
  try {
    const readAll = (async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        totalBytes += chunk.value.byteLength;
        if (totalBytes > MAX_REQUEST_BYTES) {
          cancelReader();
          throw new EdsAnalysisError("EDS 上传内容超过 20 MiB 限制。", 413);
        }
        chunks.push(chunk.value);
      }
      const body = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return body;
    })();
    const body = await Promise.race([
      readAll,
      new Promise<Uint8Array>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          cancelReader();
          reject(new EdsAnalysisError("EDS 上传请求读取超时", 408));
        }, BODY_READ_TIMEOUT_MS);
      }),
    ]);
    if (timedOut) throw new EdsAnalysisError("EDS 上传请求读取超时", 408);
    if (aborted || request.signal.aborted) throw new EdsAnalysisError("EDS 上传请求已取消", 408);
    return body;
  } catch (error) {
    if (timedOut) throw error;
    if (aborted || request.signal.aborted) throw new EdsAnalysisError("EDS 上传请求已取消", 408);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    request.signal.removeEventListener("abort", cancelForAbort);
    try { reader.releaseLock(); } catch { /* 清理异常不得覆盖已确定的 HTTP 结果。 */ }
  }
}

async function parseBoundedMultipart(request: Request, contentType: string): Promise<FormData> {
  const body = await readBoundedRequestBody(request);
  try {
    return await new Request(request.url, {
      method: "POST",
      headers: { "content-type": contentType },
      body: (body.buffer as ArrayBuffer).slice(body.byteOffset, body.byteOffset + body.byteLength),
    }).formData();
  } catch {
    throw new EdsAnalysisError("EDS multipart/form-data 请求格式无效", 400);
  }
}

function validateFormFields(form: FormData): void {
  const allowed = new Set(["source", "template", "selectionDate", "selectionShift"]);
  for (const key of form.keys()) {
    if (!allowed.has(key)) throw new EdsAnalysisError("EDS 上传包含不支持的字段");
  }
  if (form.getAll("source").length !== 1) throw new EdsAnalysisError("输入工作簿字段必须且只能出现一次");
  if (form.getAll("template").length > 1) throw new EdsAnalysisError("验收基准字段最多出现一次");
  if (form.getAll("selectionDate").length > 1 || form.getAll("selectionShift").length > 1) {
    throw new EdsAnalysisError("日期和班次选择字段最多出现一次");
  }
}

function selectedScope(form: FormData): EdsWorkbookSelection | undefined {
  const date = form.get("selectionDate");
  const shift = form.get("selectionShift");
  if (date === null && shift === null) return undefined;
  if (typeof date !== "string" || typeof shift !== "string") {
    throw new EdsAnalysisError("日期和班次必须同时提供且格式有效");
  }
  const parsed = edsWorkbookSelectionSchema.safeParse({ date, shift });
  if (!parsed.success) throw new EdsAnalysisError("日期和班次必须同时提供且格式有效");
  return parsed.data;
}

export async function POST(request: Request) {
  const declaredLengthHeader = request.headers.get("content-length");
  if (declaredLengthHeader !== null && !/^\d+$/u.test(declaredLengthHeader.trim())) {
    return jsonError("Content-Length 请求头无效。", 400);
  }
  const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader);
  if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_REQUEST_BYTES)) {
    return jsonError("EDS 上传内容超过 20 MiB 限制。", 413);
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLocaleLowerCase("en-US").startsWith("multipart/form-data;")) return jsonError("EDS 分析必须使用 multipart/form-data 上传。", 415);
  const concurrencyLease = edsConcurrencyGate.tryAcquire();
  if (!concurrencyLease) {
    return jsonError("EDS 分析正在运行，请稍后重试。", 429, { "retry-after": "15" });
  }
  try {
    const form = await parseBoundedMultipart(request, contentType);
    validateFormFields(form);
    const sourceFile = uploadedFile(form.get("source"), "输入工作簿", true);
    const templateFile = uploadedFile(form.get("template"), "验收基准", false);
    const selection = selectedScope(form);
    if (sourceFile.size + (templateFile?.size ?? 0) > EDS_UPLOAD_LIMITS.maxCombinedBytes) throw new EdsAnalysisError("EDS 工作簿合计超过 20 MiB 限制", 413);
    const sourceSheets = await withTimeout(concurrencyLease.track(readEdsXlsx({
      buffer: Buffer.from(await sourceFile.arrayBuffer()),
      originalFileName: sourceFile.name,
      mimeType: sourceFile.type,
    })), WORKBOOK_PARSE_TIMEOUT_MS, "输入工作簿解析超时", 504);
    const templateSheets = templateFile
      ? await withTimeout(concurrencyLease.track(readEdsXlsx({
          buffer: Buffer.from(await templateFile.arrayBuffer()),
          originalFileName: templateFile.name,
          mimeType: templateFile.type,
        })), WORKBOOK_PARSE_TIMEOUT_MS, "验收基准解析超时", 504)
      : undefined;
    const analysis = selection
      ? analyzeEdsWorkbookForSelection(sourceSheets, selection, templateSheets)
      : analyzeEdsWorkbook(sourceSheets, templateSheets);
    const generated = await generateEdsReportExcel(analysis, new Date(), (operation) => {
      concurrencyLease.track(operation);
    });
    const ownership = resolveDemoRequestIdentity();
    const exportArtifact = excelExportStore.put(generated, ownership);
    try {
      const response = edsAnalysisResponseSchema.parse({
        summary: analysis.summary,
        issueSummary: analysis.issueSummary,
        lineSummary: analysis.lineSummary,
        configuration: analysis.configuration,
        comparison: analysis.comparison,
        exportArtifact,
        warnings: analysis.warnings,
      });
      const responseBody = JSON.stringify(response);
      if (Buffer.byteLength(responseBody, "utf8") > EDS_MAX_RESPONSE_BYTES) {
        throw new EdsAnalysisError("EDS 分析响应超过安全大小限制", 500);
      }
      return new Response(responseBody, {
        status: 201,
        headers: { ...noStoreHeaders, "content-type": "application/json" },
      });
    } catch (error) {
      try { excelExportStore.revoke(exportArtifact.id, ownership); } catch { /* persistence health records cleanup failure */ }
      throw error;
    }
  } catch (error) {
    if (error instanceof EdsSelectionRequiredError) return selectionRequired(error);
    if (error instanceof EdsAnalysisError) return jsonError(error.message, error.status);
    return jsonError("EDS 工作簿分析失败，请检查输入文件后重试。", 500);
  } finally {
    concurrencyLease.releaseWhenIdle();
  }
}
