export class InMemoryRateLimiter {
  private readonly entries = new Map<string, number[]>();

  constructor(
    private readonly maximumRequests = 5,
    private readonly windowMs = 60_000,
    private readonly clock: () => number = Date.now,
  ) {}

  consume(key: string): boolean {
    const now = this.clock();
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
