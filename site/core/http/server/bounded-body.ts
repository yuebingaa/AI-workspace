export type BoundedBodyErrorCode = "invalid-length" | "too-large" | "invalid-encoding" | "read-failed" | "timeout" | "aborted";

export class BoundedBodyError extends Error {
  constructor(readonly code: BoundedBodyErrorCode) {
    super(code);
    this.name = "BoundedBodyError";
  }
}

type ReadableHttpBody = Pick<Request, "body" | "headers">;

export async function readBoundedUtf8Body(
  source: ReadableHttpBody,
  maxBytes: number,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("请求体大小限制必须是正整数");
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) {
    throw new Error("请求体读取超时必须是正整数毫秒");
  }
  const declaredLengthHeader = source.headers.get("content-length");
  if (declaredLengthHeader !== null && !/^\d+$/u.test(declaredLengthHeader.trim())) {
    throw new BoundedBodyError("invalid-length");
  }
  const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader);
  if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes)) {
    throw new BoundedBodyError("too-large");
  }
  if (options.signal?.aborted) throw new BoundedBodyError("aborted");
  if (!source.body) return "";

  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectInterrupted!: (error: BoundedBodyError) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
  const cancelReader = () => {
    if (!cancelled) {
      cancelled = true;
      void reader.cancel().catch(() => undefined);
    }
  };
  const interrupt = (code: "timeout" | "aborted") => {
    rejectInterrupted(new BoundedBodyError(code));
    cancelReader();
  };
  const abort = () => interrupt("aborted");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.timeoutMs !== undefined) timer = setTimeout(() => interrupt("timeout"), options.timeoutMs);
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        cancelReader();
        throw new BoundedBodyError("too-large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BoundedBodyError) throw error;
    throw new BoundedBodyError("read-failed");
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    try { reader.releaseLock(); } catch { /* cancellation can leave a read pending in non-compliant streams */ }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  chunks.forEach((chunk) => { bytes.set(chunk, offset); offset += chunk.byteLength; });
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BoundedBodyError("invalid-encoding");
  }
}
