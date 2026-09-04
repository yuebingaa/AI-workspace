import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeEdsFiles, EdsClientError } from "./client";
import { EDS_MAX_RESPONSE_BYTES } from "./contracts";

function files() {
  return [
    new File(["source"], "input.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    new File(["template"], "output.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
  ] as const;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("EDS 客户端边界", () => {
  it("普通分析只提交输入文件，不生成空的验收模板字段", async () => {
    const [source] = files();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = init?.body;
      expect(body).toBeInstanceOf(FormData);
      expect((body as FormData).get("source")).toBe(source);
      expect((body as FormData).has("template")).toBe(false);
      return new Response(JSON.stringify({ error: { message: "synthetic stop" } }), { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeEdsFiles(source)).rejects.toEqual(new EdsClientError(400, "synthetic stop"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("在 JSON 解析前拒绝声明或实际超过上限的响应", async () => {
    const [source, template] = files();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", {
        headers: { "content-length": String(EDS_MAX_RESPONSE_BYTES + 1) },
      }))
      .mockResolvedValueOnce(new Response("x".repeat(EDS_MAX_RESPONSE_BYTES + 1)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeEdsFiles(source, template))
      .rejects.toEqual(new EdsClientError(502, "EDS 分析响应过大、编码无效或读取失败。"));
    await expect(analyzeEdsFiles(source, template))
      .rejects.toEqual(new EdsClientError(502, "EDS 分析响应过大、编码无效或读取失败。"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("拒绝非 UTF-8 响应且不自动重试", async () => {
    const [source, template] = files();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([0xff])));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeEdsFiles(source, template))
      .rejects.toEqual(new EdsClientError(502, "EDS 分析响应过大、编码无效或读取失败。"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("60 秒超时覆盖收到响应头后的正文读取", async () => {
    vi.useFakeTimers();
    const [source, template] = files();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      },
    })));
    vi.stubGlobal("fetch", fetchMock);

    const assertion = expect(analyzeEdsFiles(source, template))
      .rejects.toEqual(new EdsClientError(408, "EDS 分析超过 60 秒，已停止等待。"));
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("网络失败返回统一可读错误且不自动重试", async () => {
    const [source, template] = files();
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("synthetic network failure"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeEdsFiles(source, template))
      .rejects.toEqual(new EdsClientError(0, "EDS 分析网络连接失败。"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("保留服务端 429 忙碌提示且不自动重试", async () => {
    const [source, template] = files();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "EDS 分析正在运行，请稍后重试。" } }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": "15" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeEdsFiles(source, template))
      .rejects.toEqual(new EdsClientError(429, "EDS 分析正在运行，请稍后重试。"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
