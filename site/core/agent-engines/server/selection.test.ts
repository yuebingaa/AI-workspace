import { describe, expect, it, vi } from "vitest";
import { AgentEngineSelection, agentEngineSelection } from "./selection";

const available = { available: true, version: "fixture" };
describe("Agent engine selection", () => {
  it("hot reload refreshes catalog methods while preserving selection, revision and active leases", async () => {
    const initial = agentEngineSelection.status(available);
    const target = initial.engine === "harness" ? "dsh" : "harness";
    agentEngineSelection.select({ engine: target, revision: initial.revision }, available);
    const lease = agentEngineSelection.acquire();
    const before = agentEngineSelection.status(available);
    const prototype = Object.getPrototypeOf(agentEngineSelection);
    vi.resetModules();
    const fresh = await import("./selection");
    try {
      expect(fresh.agentEngineSelection).toBe(agentEngineSelection);
      expect(Object.getPrototypeOf(fresh.agentEngineSelection)).not.toBe(prototype);
      expect(fresh.agentEngineSelection.status(available)).toEqual(before);
      expect(before.plugins).toHaveLength(3);
      expect(() => fresh.agentEngineSelection.select({ engine: initial.engine, revision: before.revision }, available)).toThrow("正在执行");
    } finally {
      lease.release(); lease.release();
      expect(fresh.agentEngineSelection.status(available).activeTasks).toBe(0);
      fresh.agentEngineSelection.select({ engine: initial.engine, revision: before.revision }, available);
    }
  });
  it("defaults to legacy, clones status and preserves the running engine", () => {
    const selection = new AgentEngineSelection();
    expect(selection.status(available)).toMatchObject({ engine: "harness", revision: 0, activeTasks: 0 });
    selection.select({ engine: "dsh", revision: 0 }, available);
    const task = selection.acquire();
    expect(task.engine).toBe("dsh");
    expect(() => selection.select({ engine: "harness", revision: 1 }, available)).toThrow("正在执行");
    task.release(); task.release();
    expect(selection.status(available).activeTasks).toBe(0);
    selection.select({ engine: "harness", revision: 1 }, available);
    expect(task.engine).toBe("dsh");
    expect(selection.status(available).engine).toBe("harness");
    const status = selection.status(available); status.plugins[0].tools.length = 0;
    expect(selection.status(available).plugins[0].tools).toHaveLength(4);
  });
  it("rejects stale settings and unavailable DSH without changing selection", () => {
    const selection = new AgentEngineSelection();
    expect(() => selection.select({ engine: "dsh", revision: 0 }, { available: false })).toThrow("尚不可用");
    selection.select({ engine: "dsh", revision: 0 }, available);
    expect(() => selection.select({ engine: "harness", revision: 0 }, available)).toThrow("已变化");
    expect(selection.status(available)).toMatchObject({ engine: "dsh", revision: 1 });
    expect(new AgentEngineSelection().status(available).engine).toBe("harness");
  });
  it("explicit legacy evaluations do not overwrite the selected engine", () => {
    const selection = new AgentEngineSelection();
    selection.select({ engine: "dsh", revision: 0 }, available);
    const first = selection.acquire("harness"), second = selection.acquire();
    expect(first.engine).toBe("harness"); expect(second.engine).toBe("dsh");
    first.release(); expect(selection.status(available).activeTasks).toBe(1);
    second.release(); expect(selection.status(available).engine).toBe("dsh");
  });
});
