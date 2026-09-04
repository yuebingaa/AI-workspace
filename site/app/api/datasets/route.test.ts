import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { datasetRepository } from "@/core/datasets/server/dataset-repository";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import { GET as getDataset, DELETE as deleteDataset } from "./[datasetId]/route";
import { POST as confirmConsent } from "./[datasetId]/consent/route";
import { GET as listDatasets, persistDatasetResponse, POST as uploadDataset } from "./route";

function uploadRequest(csv: string, fileName = "customers.csv", mimeType = "text/csv") {
  const bytes = new TextEncoder().encode(csv);
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes.slice(0, 4)); controller.enqueue(bytes.slice(4)); controller.close(); },
  });
  return new Request("http://localhost/api/datasets", {
    method: "POST",
    headers: { "content-type": mimeType, "content-length": String(bytes.byteLength), "x-file-name": encodeURIComponent(fileName) },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("CSV 数据集 API", () => {
  beforeEach(() => datasetRepository.clear());
  afterEach(() => vi.restoreAllMocks());

  it("returns 408 for aborted CSV bodies without persisting a dataset", async () => {
    const cancel = vi.fn();
    const put = vi.spyOn(datasetRepository, "put");
    const controller = new AbortController();
    const request = new Request("http://localhost/api/datasets", {
      method: "POST",
      headers: { "content-type": "text/csv", "x-file-name": "stalled.csv" },
      body: new ReadableStream<Uint8Array>({ cancel }),
      duplex: "half",
      signal: controller.signal,
    } as RequestInit & { duplex: "half" });

    const responsePromise = uploadDataset(request);
    controller.abort();
    const response = await responsePromise;

    expect(response.status).toBe(408);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
  });

  it("returns 408 for aborted consent bodies without changing the dataset", async () => {
    const cancel = vi.fn();
    const setPolicy = vi.spyOn(datasetRepository, "setAiAccessPolicy");
    const controller = new AbortController();
    const request = new Request(
      "http://localhost/api/datasets/dataset_upload_1234567890123456/consent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new ReadableStream<Uint8Array>({ cancel }),
        duplex: "half",
        signal: controller.signal,
      } as RequestInit & { duplex: "half" },
    );

    const responsePromise = confirmConsent(request);
    controller.abort();
    const response = await responsePromise;

    expect(response.status).toBe(408);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(setPolicy).not.toHaveBeenCalled();
  });

  it("上传、读取、确认敏感策略并删除，不接受用户磁盘路径", async () => {
    const uploaded = await uploadDataset(uploadRequest("email,amount\nsynthetic-a@example.invalid,10\nsynthetic-b@example.invalid,20"));
    expect(uploaded.status).toBe(201);
    expect(uploaded.headers.get("x-datacanvas-identity-mode")).toBe("demo-single-user");
    const payload = await uploaded.json() as { dataset: { datasetId: string; aiAccessPolicy: string }; rows: unknown[] };
    expect(payload.dataset.datasetId).toMatch(/^dataset_upload_/u);
    expect(payload.dataset.aiAccessPolicy).toBe("pending");
    expect(payload.rows).toHaveLength(2);

    const loaded = await getDataset(new Request(`http://localhost/api/datasets/${payload.dataset.datasetId}`));
    expect(loaded.status).toBe(200);
    const consent = await confirmConsent(new Request(`http://localhost/api/datasets/${payload.dataset.datasetId}/consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy: "exclude-sensitive-samples" }),
    }));
    expect(consent.status).toBe(200);
    expect((await consent.json() as { dataset: { aiAccessPolicy: string } }).dataset.aiAccessPolicy).toBe("exclude-sensitive-samples");
    expect((await deleteDataset(new Request(`http://localhost/api/datasets/${payload.dataset.datasetId}`, { method: "DELETE" }))).status).toBe(204);
    expect((await getDataset(new Request(`http://localhost/api/datasets/${payload.dataset.datasetId}`))).status).toBe(404);

    expect((await uploadDataset(uploadRequest("a\n1", "../secret.csv"))).status).toBe(400);
  });

  it("拒绝伪装文件和错误编码", async () => {
    const binary = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    const request = new Request("http://localhost/api/datasets", {
      method: "POST",
      headers: { "content-type": "text/csv", "content-length": String(binary.length), "x-file-name": "fake.csv" },
      body: binary,
    });
    expect((await uploadDataset(request)).status).toBe(415);
  });

  it("拒绝无效或超过上限的 Content-Length", async () => {
    const invalid = uploadRequest("a\n1");
    invalid.headers.set("content-length", "invalid");
    expect((await uploadDataset(invalid)).status).toBe(400);

    const oversized = uploadRequest("a\n1");
    oversized.headers.set("content-length", String(11 * 1024 * 1024));
    expect((await uploadDataset(oversized)).status).toBe(413);
  });

  it("序列化响应超限时在持久化前失败，不留下孤儿数据", async () => {
    const parsed = await parseCsvUpload({
      stream: uploadRequest("a\n1").body!,
      originalFileName: "synthetic.csv",
      mimeType: "text/csv",
    });
    const put = vi.spyOn(datasetRepository, "put");

    await expect(persistDatasetResponse(
      { tenantId: "tenant_demo_local", ownerId: "owner_demo_local" },
      parsed,
      16,
    )).rejects.toThrow(/响应超过/);
    expect(put).not.toHaveBeenCalled();
  });

  it("敏感字段确认流式限制实际请求体并校验长度与 MIME", async () => {
    const url = "http://localhost/api/datasets/dataset_upload_1234567890123456/consent";
    const actualOversized = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "1" },
      body: "x".repeat(1_025),
    });
    expect((await confirmConsent(actualOversized)).status).toBe(413);

    const invalidLength = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "invalid" },
      body: "{}",
    });
    expect((await confirmConsent(invalidLength)).status).toBe(400);

    const wrongMime = new Request(url, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect((await confirmConsent(wrongMime)).status).toBe(415);
  });

  it("敏感字段确认并发请求仅接受首个策略，且无敏感字段返回冲突", async () => {
    const sensitiveUpload = await uploadDataset(uploadRequest("email,amount\nsynthetic@example.invalid,10"));
    const sensitive = await sensitiveUpload.json() as { dataset: { datasetId: string } };
    const consentUrl = `http://localhost/api/datasets/${sensitive.dataset.datasetId}/consent`;
    const policies = ["masked", "exclude-sensitive-samples"] as const;
    const responses = await Promise.all(policies.map((policy) => confirmConsent(new Request(consentUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy }),
    }))));

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winningPolicy = policies[responses.findIndex((response) => response.status === 200)];
    expect((await datasetRepository.get(
      resolveDemoRequestIdentity(),
      sensitive.dataset.datasetId,
    ))?.descriptor.aiAccessPolicy).toBe(winningPolicy);

    const ordinaryUpload = await uploadDataset(uploadRequest("category,amount\nA,10"));
    const ordinary = await ordinaryUpload.json() as { dataset: { datasetId: string } };
    const ordinaryConsent = await confirmConsent(new Request(
      `http://localhost/api/datasets/${ordinary.dataset.datasetId}/consent`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policy: "masked" }),
      },
    ));
    expect(ordinaryConsent.status).toBe(409);
  });

  it("持久化读取或删除失败时返回脱敏 500", async () => {
    vi.spyOn(datasetRepository, "list").mockRejectedValueOnce(new Error("C:\\private\\datasets.json.lock"));
    const listed = await listDatasets();
    expect(listed.status).toBe(500);
    expect(await listed.text()).not.toContain("private");

    vi.spyOn(datasetRepository, "get").mockRejectedValueOnce(new Error("synthetic persistence failure"));
    const read = await getDataset(new Request("http://localhost/api/datasets/dataset_upload_1234567890123456"));
    expect(read.status).toBe(500);
    expect(read.headers.get("x-content-type-options")).toBe("nosniff");

    vi.spyOn(datasetRepository, "delete").mockRejectedValueOnce(new Error("synthetic persistence failure"));
    const removed = await deleteDataset(new Request("http://localhost/api/datasets/dataset_upload_1234567890123456", { method: "DELETE" }));
    expect(removed.status).toBe(500);
    expect(await removed.text()).not.toContain("synthetic");
  });
});
