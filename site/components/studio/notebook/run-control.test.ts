import { describe, expect, it } from "vitest";
import { createNotebookRunControl } from "./run-control";

describe("Notebook run ownership", () => {
  it("starts idle and refuses overlapping requests synchronously, including a different mode", () => {
    const control = createNotebookRunControl();
    expect(control.current()).toBeNull();
    const lease = control.start("auto")!;
    expect(lease.kind).toBe("auto");
    expect(Object.isFrozen(lease)).toBe(true);
    expect(control.current()).toBe(lease);
    expect(control.isCurrent(lease)).toBe(true);
    expect(control.start("auto")).toBeNull();
    expect(control.start("manual")).toBeNull();
  });

  it("cancellation makes a response uncommittable but holds the lock until finally", () => {
    const control = createNotebookRunControl();
    const lease = control.start("auto")!;
    expect(control.cancel("auto")).toBe(true);
    expect(lease.controller.signal.aborted).toBe(true);
    expect(control.owns(lease)).toBe(true);
    expect(control.isCurrent(lease)).toBe(false);
    expect(control.start("manual")).toBeNull();
    expect(control.finish(lease)).toBe(true);
    expect(control.current()).toBeNull();
    expect(control.start("manual")).not.toBeNull();
  });

  it.each(["manual", "auto"] as const)("mode-specific cancellation does not interrupt %s ownership", (kind) => {
    const control = createNotebookRunControl();
    const lease = control.start(kind)!;
    expect(control.cancel(kind === "manual" ? "auto" : "manual")).toBe(false);
    expect(control.isCurrent(lease)).toBe(true);
    expect(control.cancel()).toBe(true);
    expect(control.isCurrent(lease)).toBe(false);
  });

  it("timeout aborts use the same commit guard and ownership rules", () => {
    const control = createNotebookRunControl();
    const lease = control.start("manual")!;
    lease.controller.abort(new DOMException("Synthetic deadline", "TimeoutError"));
    expect(control.owns(lease)).toBe(true);
    expect(control.isCurrent(lease)).toBe(false);
    expect(control.start("auto")).toBeNull();
    expect(control.finish(lease)).toBe(true);
  });

  it("an old finally cannot release a newer run or claim its response", () => {
    const control = createNotebookRunControl();
    const old = control.start("manual")!;
    expect(control.finish(old)).toBe(true);
    const next = control.start("auto")!;
    expect(next.id).toBeGreaterThan(old.id);
    expect(control.isCurrent(old)).toBe(false);
    expect(control.owns(old)).toBe(false);
    expect(control.finish(old)).toBe(false);
    expect(control.current()).toBe(next);
    expect(control.isCurrent(next)).toBe(true);
  });

  it("does not accept a copied ticket with matching IDs or controller", () => {
    const control = createNotebookRunControl();
    const lease = control.start("auto")!;
    expect(control.isCurrent({ ...lease })).toBe(false);
    expect(control.finish({ ...lease })).toBe(false);
    expect(control.current()).toBe(lease);
  });

  it("is isolated per Notebook instance", () => {
    const first = createNotebookRunControl(), second = createNotebookRunControl();
    const a = first.start("auto")!, b = second.start("manual")!;
    expect(first.isCurrent(b)).toBe(false);
    first.cancel();
    expect(second.isCurrent(b)).toBe(true);
    expect(second.finish(a)).toBe(false);
  });

  it("handles repeated cleanup and idle cancellation without creating a run", () => {
    const control = createNotebookRunControl();
    expect(control.cancel()).toBe(false);
    const lease = control.start("auto")!;
    let aborts = 0;
    lease.controller.signal.addEventListener("abort", () => { aborts += 1; });
    control.cancel(); control.cancel();
    expect(aborts).toBe(1);
    expect(control.finish(lease)).toBe(true);
    expect(control.finish(lease)).toBe(false);
    expect(control.cancel()).toBe(false);
  });

  it("drops a late successful transport response after cancellation", async () => {
    const control = createNotebookRunControl();
    const lease = control.start("auto")!;
    let release!: () => void;
    const transport = new Promise<void>((resolve) => { release = resolve; });
    const commits: number[] = [];
    const task = (async () => {
      try { await transport; if (control.isCurrent(lease)) commits.push(lease.id); }
      finally { control.finish(lease); }
    })();
    control.cancel("auto");
    expect(control.start("auto")).toBeNull();
    release(); await task;
    expect(commits).toEqual([]);
    expect(control.current()).toBeNull();
    expect(control.start("manual")).not.toBeNull();
  });
});
