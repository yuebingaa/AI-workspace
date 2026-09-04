import { describe, expect, it } from "vitest";
import { BoundedBinaryError, readBoundedBinaryBody } from "./bounded-binary";

describe("有界二进制正文读取", () => {
  it("同时拒绝声明和实际超过上限的正文", async () => {
    await expect(readBoundedBinaryBody(new Response(new Uint8Array([1]), {
      headers: { "content-length": "5" },
    }), 4)).rejects.toEqual(new BoundedBinaryError("too-large"));
    await expect(readBoundedBinaryBody(new Response(new Uint8Array([1, 2, 3, 4, 5])), 4))
      .rejects.toEqual(new BoundedBinaryError("too-large"));
  });

  it("实际超限时不等待永不结算的底层取消", async () => {
    let cancelCalls = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
      },
      cancel() {
        cancelCalls += 1;
        return new Promise<void>(() => undefined);
      },
    }));
    let outcome: unknown;
    void readBoundedBinaryBody(response, 4).catch((error: unknown) => { outcome = error; });

    await new Promise<void>((resolveWait) => setImmediate(resolveWait));

    expect(outcome).toEqual(new BoundedBinaryError("too-large"));
    expect(cancelCalls).toBe(1);
  });

  it("拒绝无效长度并按顺序合并流式分块", async () => {
    await expect(readBoundedBinaryBody(new Response(new Uint8Array([1]), {
      headers: { "content-length": "invalid" },
    }), 4)).rejects.toEqual(new BoundedBinaryError("invalid-length"));
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    }));
    expect(await readBoundedBinaryBody(response, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});
