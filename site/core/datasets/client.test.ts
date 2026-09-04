import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmDatasetAiAccess,
  DatasetAiAccessConflictError,
  DatasetClientError,
  deleteUploadedDataset,
  loadUploadedDataset,
  MAX_DATASET_RESPONSE_BYTES,
  uploadCsvDataset,
} from "./client";
import { parseCsvUpload } from "./server/csv-dataset";

function stream(text: string) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
}

class TimeoutXmlHttpRequest {
  static latest: TimeoutXmlHttpRequest | null = null;
  readonly upload: {
    onprogress: ((event: ProgressEvent<EventTarget>) => void) | null;
    onload: (() => void) | null;
  } = { onprogress: null, onload: null };
  timeout = 0;
  responseType: XMLHttpRequestResponseType = "";
  responseText = "";
  status = 0;
  onload: (() => void) | null = null;
  onprogress: ((event: ProgressEvent<EventTarget>) => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  constructor() { TimeoutXmlHttpRequest.latest = this; }
  open() {}
  setRequestHeader() {}
  getResponseHeader() { return null; }
  abort() { this.onabort?.(); }
  send() { queueMicrotask(() => this.ontimeout?.()); }
}

class OversizedResponseXmlHttpRequest extends TimeoutXmlHttpRequest {
  send() {
    queueMicrotask(() => this.onprogress?.({ loaded: MAX_DATASET_RESPONSE_BYTES + 1 } as ProgressEvent<EventTarget>));
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  TimeoutXmlHttpRequest.latest = null;
});

describe("CSV 数据集客户端", () => {
  it("上传等待超过 60 秒时返回明确超时且不自动重试", async () => {
    vi.stubGlobal("XMLHttpRequest", TimeoutXmlHttpRequest);
    const progress: number[] = [];
    const request = uploadCsvDataset(new File(["a\n1"], "input.csv", { type: "text/csv" }), (event) => progress.push(event.percent));

    await expect(request.promise).rejects.toEqual(new DatasetClientError(408, "CSV 上传超过 60 秒，已停止等待。"));
    expect(TimeoutXmlHttpRequest.latest?.timeout).toBe(60_000);
    expect(progress).toEqual([0]);
  });

  it("XHR 下载上传结果超过上限时立即中止并区分用户取消", async () => {
    vi.stubGlobal("XMLHttpRequest", OversizedResponseXmlHttpRequest);
    const request = uploadCsvDataset(new File(["a\n1"], "input.csv", { type: "text/csv" }), () => undefined);

    await expect(request.promise).rejects.toEqual(new DatasetClientError(502, "CSV 上传响应超过 32 MiB 限制。"));
  });

  it("数据集操作等待超过 30 秒时中止且不自动重试", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const request = confirmDatasetAiAccess("dataset_upload_1234567890123456", "masked");
    const assertion = expect(request).rejects.toEqual(new DatasetClientError(408, "保存敏感字段处理方式超过 30 秒，已停止等待。"));
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("数据集操作网络失败时返回可读错误且不自动重试", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("synthetic network failure"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteUploadedDataset("dataset_upload_1234567890123456"))
      .rejects.toEqual(new DatasetClientError(0, "删除上传数据集时网络连接失败。"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("确认策略 409 后读取权威描述符并在专用错误中返回", async () => {
    let sequence = 0;
    const payload = await parseCsvUpload({
      stream: stream("email,value\nsynthetic@example.invalid,1"),
      originalFileName: "conflict.csv",
      mimeType: "text/csv",
      id: () => `d${String(++sequence).padStart(31, "0")}`,
    });
    payload.dataset.aiAccessPolicy = "exclude-sensitive-samples";
    payload.dataset.source.aiAccessPolicy = "exclude-sensitive-samples";
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { message: "敏感字段处理方式已经确认，不能由重放请求改写" } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json(payload));
    vi.stubGlobal("fetch", fetchMock);

    const request = confirmDatasetAiAccess(payload.dataset.datasetId, "masked");
    const error = await request.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DatasetAiAccessConflictError);
    expect(error).toMatchObject({
      status: 409,
      message: "敏感字段处理方式已经确认，不能由重放请求改写",
      currentDataset: { datasetId: payload.dataset.datasetId, aiAccessPolicy: "exclude-sensitive-samples" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("确认策略 409 后权威状态读取失败时保留原始冲突错误", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { message: "并发确认冲突" } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ error: { message: "已删除" } }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(confirmDatasetAiAccess("dataset_upload_1234567890123456", "masked"))
      .rejects.toEqual(new DatasetClientError(409, "并发确认冲突"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("30 秒超时覆盖收到响应头后的正文读取", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      },
    })));
    vi.stubGlobal("fetch", fetchMock);

    const request = loadUploadedDataset("dataset_upload_1234567890123456");
    const assertion = expect(request).rejects.toEqual(new DatasetClientError(408, "读取上传数据集超过 30 秒，已停止等待。"));
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("在 JSON 解析前拒绝超出硬上限的服务端响应", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(MAX_DATASET_RESPONSE_BYTES + 1) },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadUploadedDataset("dataset_upload_1234567890123456"))
      .rejects.toEqual(new DatasetClientError(502, "读取上传数据集的服务端响应过大或无效。"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
