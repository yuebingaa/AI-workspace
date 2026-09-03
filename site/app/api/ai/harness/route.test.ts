import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiPlannerRateLimiter } from "@/core/ai/server/rate-limit";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { datasetRepository } from "@/core/datasets/server/dataset-repository";
import { resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { POST } from "./route";

function stream(text: string) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
}

describe("Harness 上传数据隐私门", () => {
  beforeEach(() => {
    datasetRepository.clear();
    aiPlannerRateLimiter.clear();
    vi.stubEnv("DEEPSEEK_API_KEY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("拒绝客户端身份字段，并为合法公共请求注入服务端 editor 角色", async () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    const fixture = demoFixtureResult.data.dataProduct;
    const publicRequest = {
      idempotencyKey: "request_server_identity_001",
      instruction: "检查零售数据。",
      pageId: "page_home",
      appSpec: fixture.appSpec,
      recipes: fixture.recipes,
    };
    const rejected = await POST(new Request("http://localhost/api/ai/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...publicRequest,
        role: "admin",
        tenantId: "fake_tenant",
        ownerId: "fake_owner",
        userId: "fake_user",
      }),
    }));
    expect(rejected.status).toBe(400);

    const accepted = await POST(new Request("http://localhost/api/ai/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(publicRequest),
    }));
    const body = await accepted.json() as { task: { role: string } };
    expect(accepted.status).toBe(200);
    expect(body.task.role).toBe("editor");
  });

  it("敏感字段未确认时拒绝把上传数据摘要交给模型", async () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    let sequence = 0;
    const uploaded = await parseCsvUpload({
      stream: stream("email,value\nsynthetic-private@example.invalid,1"),
      originalFileName: "synthetic-private.csv",
      mimeType: "text/csv",
      id: () => `a${String(++sequence).padStart(31, "0")}`,
    });
    await datasetRepository.put(resolveDemoRequestIdentity(), uploaded);
    const fixture = demoFixtureResult.data.dataProduct;
    const body = {
      idempotencyKey: "request_pending_sensitive_001",
      instruction: "检查 private 数据集字段。",
      pageId: "page_home",
      dataSourceId: uploaded.dataset.datasetId,
      appSpec: { ...fixture.appSpec, dataSources: [...fixture.appSpec.dataSources, uploaded.dataset.source] },
      recipes: [...fixture.recipes, uploaded.dataset.recipe],
    };
    const response = await POST(new Request("http://localhost/api/ai/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).toContain("敏感字段");
  });

  it("拒绝读取其他所有者的数据集", async () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    let sequence = 0;
    const uploaded = await parseCsvUpload({
      stream: stream("region,value\n区域甲,1"),
      originalFileName: "other-owner.csv",
      mimeType: "text/csv",
      id: () => `b${String(++sequence).padStart(31, "0")}`,
    });
    await datasetRepository.put({ tenantId: "tenant_demo_local", ownerId: "owner_other" }, uploaded);
    const fixture = demoFixtureResult.data.dataProduct;
    const response = await POST(new Request("http://localhost/api/ai/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "request_other_owner_001",
        instruction: "检查数据集。",
        pageId: "page_home",
        dataSourceId: uploaded.dataset.datasetId,
        appSpec: { ...fixture.appSpec, dataSources: [...fixture.appSpec.dataSources, uploaded.dataset.source] },
        recipes: [...fixture.recipes, uploaded.dataset.recipe],
      }),
    }));

    expect(response.status).toBe(410);
  });
});
