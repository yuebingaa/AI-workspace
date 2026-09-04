export class InMemoryRateLimiter {
  private readonly entries = new Map<string, number[]>();

  constructor(
    private readonly maximumRequests = 5,
    private readonly windowMs = 60_000,
    private readonly clock: () => number = Date.now,
    private readonly maximumKeys = 1_000,
  ) {
    if (!Number.isSafeInteger(maximumRequests) || maximumRequests < 1) throw new Error("频率限制请求数必须是正整数");
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error("频率限制窗口必须是正整数");
    if (!Number.isSafeInteger(maximumKeys) || maximumKeys < 1) throw new Error("频率限制客户端容量必须是正整数");
  }

  private currentTime(): number | null {
    try {
      const now = this.clock();
      return Number.isSafeInteger(now) && now >= 0 ? now : null;
    } catch {
      return null;
    }
  }

  consume(key: string): boolean {
    const now = this.currentTime();
    if (now === null) return false;
    for (const [entryKey, timestamps] of this.entries) {
      const retained = timestamps.filter((timestamp) => now - timestamp < this.windowMs);
      if (retained.length) this.entries.set(entryKey, retained);
      else this.entries.delete(entryKey);
    }
    if (!this.entries.has(key) && this.entries.size >= this.maximumKeys) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    const active = (this.entries.get(key) ?? []).filter((timestamp) => now - timestamp < this.windowMs);
    if (active.length >= this.maximumRequests) {
      this.entries.set(key, active);
      return false;
    }
    this.entries.set(key, [...active, now]);
    return true;
  }

  clear() {
    this.entries.clear();
  }
}

export const aiPlannerRateLimiter = new InMemoryRateLimiter();
