import { describe, expect, it } from "vitest";
import { buildHealthPayload, GET } from "./route";

describe("健康检查 API", () => {
  it("返回无路径无密钥的持久化、容量与降级状态", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const text = await response.text();
    const payload = JSON.parse(text) as Record<string, unknown>;
    expect(payload).toMatchObject({ status: "ok", identityMode: "demo-single-user" });
    expect(text.toLocaleLowerCase("en-US")).not.toContain("deepseek_api_key");
    expect(text).not.toMatch(/[A-Za-z]:\\/u);
    expect(text).not.toContain("/home/");
  });

  it("运行期持久化失败时降级且不暴露底层错误", () => {
    const payload = buildHealthPayload({
      datasets: {
        mode: "json-file",
        persistenceHealthy: false,
        lastPersistenceErrorAt: "2026-09-04T00:00:00.000Z",
        count: 1,
        capacity: 10,
        utilization: 0.1,
        warning: "数据集本地持久化最近一次写入失败",
      },
      exports: {
        mode: "json-file",
        persistenceHealthy: true,
        lastPersistenceErrorAt: null,
        count: 0,
        capacity: 20,
        utilization: 0,
        warning: null,
      },
      datasetStartupError: null,
      exportStartupError: null,
      checkedAt: new Date("2026-09-04T00:01:00.000Z"),
    });
    expect(payload).toMatchObject({
      status: "degraded",
      persistence: { configured: true, startupErrors: 0, runtimeErrors: 1 },
    });
    expect(payload.warnings.join(" ")).toContain("业务变更已回滚");
    expect(JSON.stringify(payload)).not.toContain("synthetic disk failure");
  });
});
