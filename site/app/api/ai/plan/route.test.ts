import { beforeEach, describe, expect, it } from "vitest";
import { aiPlannerRateLimiter } from "@/core/ai/server/rate-limit";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { POST } from "./route";

describe("AI Planner 服务端身份边界", () => {
  beforeEach(() => aiPlannerRateLimiter.clear());

  it("strict 公共请求拒绝客户端 role、tenantId、ownerId 和 userId", async () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    const response = await POST(new Request("http://localhost/api/ai/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instruction: "修改标题",
        pageId: "page_home",
        appSpec: demoFixtureResult.data.dataProduct.appSpec,
        role: "admin",
        tenantId: "fake_tenant",
        ownerId: "fake_owner",
        userId: "fake_user",
      }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_request", retryable: false },
    });
  });
});
