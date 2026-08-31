import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "./rate-limit";

describe("AI 服务端频率限制", () => {
  it("限制时间窗口内的请求并在窗口后恢复", () => {
    let now = 0;
    const limiter = new InMemoryRateLimiter(2, 1_000, () => now);
    expect(limiter.consume("client-a")).toBe(true);
    expect(limiter.consume("client-a")).toBe(true);
    expect(limiter.consume("client-a")).toBe(false);
    expect(limiter.consume("client-b")).toBe(true);
    now = 1_001;
    expect(limiter.consume("client-a")).toBe(true);
  });
});
