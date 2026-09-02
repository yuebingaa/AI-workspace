import { beforeEach, describe, expect, it } from "vitest";
import { datasetRepository } from "@/core/datasets/server/dataset-repository";
import { GET as getDataset, DELETE as deleteDataset } from "./[datasetId]/route";
import { POST as confirmConsent } from "./[datasetId]/consent/route";
import { POST as uploadDataset } from "./route";

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
});
