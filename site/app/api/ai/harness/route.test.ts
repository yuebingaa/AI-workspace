import { beforeEach, describe, expect, it } from "vitest";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { datasetRepository } from "@/core/datasets/server/dataset-repository";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { POST } from "./route";

function stream(text: string) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
}

describe("Harness 上传数据隐私门", () => {
  beforeEach(() => datasetRepository.clear());

  it("敏感字段未确认时拒绝把上传数据摘要交给模型", async () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    let sequence = 0;
    const uploaded = await parseCsvUpload({
      stream: stream("email,value\nsynthetic-private@example.invalid,1"),
      originalFileName: "synthetic-private.csv",
      mimeType: "text/csv",
      id: () => `a${String(++sequence).padStart(31, "0")}`,
    });
    datasetRepository.put(uploaded);
    const fixture = demoFixtureResult.data.dataProduct;
    const body = {
      idempotencyKey: "request_pending_sensitive_001",
      instruction: "检查 private 数据集字段。",
      pageId: "page_home",
      dataSourceId: uploaded.dataset.datasetId,
      appSpec: { ...fixture.appSpec, dataSources: [...fixture.appSpec.dataSources, uploaded.dataset.source] },
      recipes: [...fixture.recipes, uploaded.dataset.recipe],
      role: "editor",
    };
    const response = await POST(new Request("http://localhost/api/ai/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).toContain("敏感字段");
  });
});
