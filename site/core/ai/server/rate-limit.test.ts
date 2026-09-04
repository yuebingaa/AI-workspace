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

  it("限制客户端键数量并淘汰最旧键", () => {
    const limiter = new InMemoryRateLimiter(1, 1_000, () => 0, 2);
    expect(limiter.consume("client-a")).toBe(true);
    expect(limiter.consume("client-b")).toBe(true);
    expect(limiter.consume("client-b")).toBe(false);
    expect(limiter.consume("client-c")).toBe(true);
    expect(limiter.consume("client-a")).toBe(true);
  });

  it("拒绝会导致无界或死循环的非法配置", () => {
    expect(() => new InMemoryRateLimiter(0)).toThrow(/请求数/);
    expect(() => new InMemoryRateLimiter(1, 0)).toThrow(/窗口/);
    expect(() => new InMemoryRateLimiter(1, 1_000, Date.now, 0)).toThrow(/客户端容量/);
  });

  it("时钟失效时 fail-closed 且不清除已有配额", () => {
    let now: number | "throw" = 0;
    const limiter = new InMemoryRateLimiter(2, 1_000, () => {
      if (now === "throw") throw new Error("synthetic clock failure");
      return now;
    });

    expect(limiter.consume("client-a")).toBe(true);
    expect(limiter.consume("client-a")).toBe(true);
    now = Number.NaN;
    expect(limiter.consume("client-a")).toBe(false);
    now = "throw";
    expect(limiter.consume("client-a")).toBe(false);
    now = 0;
    expect(limiter.consume("client-a")).toBe(false);
    now = 1_000;
    expect(limiter.consume("client-a")).toBe(true);
  });
});
