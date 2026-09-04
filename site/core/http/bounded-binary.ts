export type BoundedBinaryErrorCode = "invalid-length" | "too-large" | "read-failed";

export class BoundedBinaryError extends Error {
  constructor(readonly code: BoundedBinaryErrorCode) {
    super(code);
    this.name = "BoundedBinaryError";
  }
}

type ReadableHttpBody = Pick<Response, "body" | "headers">;

export async function readBoundedBinaryBody(source: ReadableHttpBody, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("二进制正文大小限制必须是正整数");
  const declaredLengthHeader = source.headers.get("content-length");
  if (declaredLengthHeader !== null && !/^\d+$/u.test(declaredLengthHeader.trim())) {
    throw new BoundedBinaryError("invalid-length");
  }
  const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader);
  if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes)) {
    throw new BoundedBinaryError("too-large");
  }
  if (!source.body) return new Uint8Array();

  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new BoundedBinaryError("too-large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BoundedBinaryError) throw error;
    throw new BoundedBinaryError("read-failed");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  chunks.forEach((chunk) => { bytes.set(chunk, offset); offset += chunk.byteLength; });
  return bytes;
}
