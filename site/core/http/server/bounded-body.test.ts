import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundedBodyError, readBoundedUtf8Body } from "./bounded-body";

function streamedRequest(chunks: Uint8Array[], contentLength?: string) {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: contentLength === undefined ? undefined : { "content-length": contentLength },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("readBoundedUtf8Body", () => {
  afterEach(() => vi.useRealTimers());

  it("按实际流字节限制伪报短长度的请求体", async () => {
    const request = streamedRequest([new TextEncoder().encode("1234"), new TextEncoder().encode("5678")], "1");
    await expect(readBoundedUtf8Body(request, 7)).rejects.toEqual(new BoundedBodyError("too-large"));
  });

  it("拒绝非法声明长度和非法 UTF-8", async () => {
    await expect(readBoundedUtf8Body(streamedRequest([new Uint8Array([1])], "invalid"), 10))
      .rejects.toEqual(new BoundedBodyError("invalid-length"));
    await expect(readBoundedUtf8Body(streamedRequest([new Uint8Array([0xc3, 0x28])]), 10))
      .rejects.toEqual(new BoundedBodyError("invalid-encoding"));
  });

  it("保留跨分块 UTF-8 文本", async () => {
    const bytes = new TextEncoder().encode("中文 JSON");
    await expect(readBoundedUtf8Body(streamedRequest([bytes.slice(0, 2), bytes.slice(2)]), 20)).resolves.toBe("中文 JSON");
  });

  it("同样限制服务端读取的 HTTP 响应体", async () => {
    const response = new Response("12345678", { headers: { "content-length": "8" } });
    await expect(readBoundedUtf8Body(response, 7)).rejects.toEqual(new BoundedBodyError("too-large"));
  });

  it("times out a stalled body and cancels its reader exactly once", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({ cancel }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const reading = readBoundedUtf8Body(request, 10, { timeoutMs: 25 });
    const assertion = expect(reading).rejects.toEqual(new BoundedBodyError("timeout"));
    await vi.advanceTimersByTimeAsync(25);

    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("stops an aborted body and cancels its reader exactly once", async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({ cancel }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const reading = readBoundedUtf8Body(request, 10, { signal: controller.signal, timeoutMs: 1_000 });
    controller.abort();

    await expect(reading).rejects.toEqual(new BoundedBodyError("aborted"));
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
