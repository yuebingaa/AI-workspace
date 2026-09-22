import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTEBOOK_AUTO_RUN_DELAY_MS, NotebookAutoRunScheduler } from "./auto-run-scheduler";

const initial = { documentKey: "v0", contextKey: "inputs-v0", editing: false, busy: false, hidden: false, canEdit: true, externalBusy: false };
function fixture() {
  const changed = vi.fn(), run = vi.fn(), cancelAutomatic = vi.fn();
  const scheduler = new NotebookAutoRunScheduler(changed);
  const handlers = { run, cancelAutomatic };
  let environment = { ...initial };
  const update = (next: Partial<typeof initial>) => { environment = { ...environment, ...next }; scheduler.update(environment, handlers); };
  update({}); cancelAutomatic.mockClear();
  const approve = () => { scheduler.approve("v0", "v1", ["parameter"]); update({ documentKey: "v1" }); };
  return { scheduler, changed, run, cancelAutomatic, update, approve };
}

describe("explicit Notebook parameter auto-run scheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("defaults off and never derives permission from a changed document", () => {
    const { scheduler, update, run } = fixture();
    scheduler.approve("v0", "v1", ["parameter"]); update({ documentKey: "v1" });
    vi.runAllTimers(); expect(run).not.toHaveBeenCalled();
  });
  it("enabling alone does not run existing or stale definitions", () => {
    const { scheduler, update, run } = fixture();
    scheduler.setEnabled(true); update({ documentKey: "restored-project" });
    vi.runAllTimers(); expect(run).not.toHaveBeenCalled();
  });
  it("waits for the parent to accept a saved definition before starting the debounce", () => {
    const { scheduler, update, run } = fixture();
    scheduler.setEnabled(true); scheduler.approve("v0", "v1", ["parameter"]);
    vi.advanceTimersByTime(2000); expect(run).not.toHaveBeenCalled();
    update({ documentKey: "v1" }); vi.advanceTimersByTime(NOTEBOOK_AUTO_RUN_DELAY_MS - 1);
    expect(run).not.toHaveBeenCalled(); vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledExactlyOnceWith(["parameter"]);
  });
  it("merges consecutive accepted parameter saves and resets the debounce", () => {
    const { scheduler, update, approve, run } = fixture();
    scheduler.setEnabled(true); approve(); vi.advanceTimersByTime(450);
    scheduler.approve("v1", "v2", ["other", "parameter"]); update({ documentKey: "v2" });
    vi.advanceTimersByTime(599); expect(run).not.toHaveBeenCalled(); vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledExactlyOnceWith(["parameter", "other"]);
  });
  it("pauses while editing, preserving approved work when unsaved edits are cancelled", () => {
    const { scheduler, update, approve, run, changed } = fixture();
    scheduler.setEnabled(true); approve(); vi.advanceTimersByTime(300); update({ editing: true });
    expect(changed).toHaveBeenLastCalledWith({ enabled: true, pendingCount: 1, paused: true });
    vi.advanceTimersByTime(5000); expect(run).not.toHaveBeenCalled(); update({ editing: false });
    vi.advanceTimersByTime(599); expect(run).not.toHaveBeenCalled(); vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledExactlyOnceWith(["parameter"]);
  });
  it("does not restart the timer because callback identities or unrelated renders changed", () => {
    const { scheduler, update, approve, run } = fixture();
    scheduler.setEnabled(true); approve(); vi.advanceTimersByTime(500); update({});
    vi.advanceTimersByTime(100); expect(run).toHaveBeenCalledOnce();
  });
  it("switching off cancels automatic work but does not replay it after switching on", () => {
    const { scheduler, approve, run, cancelAutomatic } = fixture();
    scheduler.setEnabled(true); approve(); scheduler.setEnabled(false);
    expect(cancelAutomatic).toHaveBeenCalledOnce(); scheduler.setEnabled(true);
    vi.runAllTimers(); expect(run).not.toHaveBeenCalled();
  });
  it.each(["hidden", "permission"] as const)("resets off on %s and requires fresh explicit opt-in", (reason) => {
    const { scheduler, update, approve, run, changed, cancelAutomatic } = fixture();
    scheduler.setEnabled(true); approve(); update(reason === "hidden" ? { hidden: true } : { canEdit: false });
    expect(changed).toHaveBeenLastCalledWith({ enabled: false, pendingCount: 0, paused: false });
    expect(cancelAutomatic).toHaveBeenCalled(); update({ hidden: false, canEdit: true });
    scheduler.approve("v1", "v2", ["parameter"]); update({ documentKey: "v2" });
    vi.runAllTimers(); expect(run).not.toHaveBeenCalled();
  });
  it("external Agent activity clears work without silently resuming it when the Agent stops", () => {
    const { scheduler, update, approve, run, changed, cancelAutomatic } = fixture();
    scheduler.setEnabled(true); approve(); update({ externalBusy: true });
    expect(changed).toHaveBeenLastCalledWith({ enabled: true, pendingCount: 0, paused: false });
    expect(cancelAutomatic).toHaveBeenCalled(); update({ externalBusy: false });
    vi.runAllTimers(); expect(run).not.toHaveBeenCalled();
  });
  it("rejects opt-in and approval while external execution owns the workspace", () => {
    const { scheduler, update, run } = fixture();
    update({ externalBusy: true }); scheduler.setEnabled(true);
    scheduler.approve("v0", "v1", ["parameter"]); update({ externalBusy: false, documentKey: "v1" });
    vi.runAllTimers(); expect(run).not.toHaveBeenCalled();
  });
  it("does not accept another parameter save while an execution is busy", () => {
    const { scheduler, update, run } = fixture();
    scheduler.setEnabled(true); update({ busy: true }); scheduler.approve("v0", "v1", ["parameter"]);
    update({ busy: false, documentKey: "v1" }); vi.runAllTimers(); expect(run).not.toHaveBeenCalled();
  });
  it("an external replacement clears a pending save instead of overwriting or running it", () => {
    const { scheduler, update, approve, run, changed } = fixture();
    scheduler.setEnabled(true); approve(); update({ documentKey: "same-revision-different-definition" });
    expect(changed).toHaveBeenLastCalledWith({ enabled: true, pendingCount: 0, paused: false });
    vi.runAllTimers(); expect(run).not.toHaveBeenCalled();
  });
  it("rejects a replaced candidate even before the parent acknowledges it", () => {
    const { scheduler, update, run } = fixture();
    scheduler.setEnabled(true); scheduler.approve("v0", "v1", ["parameter"]);
    update({ documentKey: "foreign" }); update({ documentKey: "v1" });
    vi.runAllTimers(); expect(run).not.toHaveBeenCalled();
  });
  it("drops an approved queue when external inputs change without disabling or recreating it", () => {
    const { scheduler, update, approve, run, changed, cancelAutomatic } = fixture();
    scheduler.setEnabled(true); approve(); vi.advanceTimersByTime(300);
    update({ contextKey: "inputs-v1" });
    expect(changed).toHaveBeenLastCalledWith({ enabled: true, pendingCount: 0, paused: false });
    expect(cancelAutomatic).toHaveBeenCalledOnce();
    vi.runAllTimers(); expect(run).not.toHaveBeenCalled();
    update({ contextKey: "inputs-v0" }); vi.runAllTimers(); expect(run).not.toHaveBeenCalled();
    scheduler.approve("v1", "v2", ["parameter"]); update({ documentKey: "v2" }); vi.runAllTimers();
    expect(run).toHaveBeenCalledExactlyOnceWith(["parameter"]);
  });
  it("empty or rejected saves never enqueue work", () => {
    const { scheduler, update, run } = fixture(); scheduler.setEnabled(true);
    scheduler.approve("v0", "v1", []); update({ documentKey: "v1" });
    vi.runAllTimers(); expect(run).not.toHaveBeenCalled();
  });
  it("manual execution can discard a pending automatic duplicate while keeping opt-in", () => {
    const { scheduler, approve, run, changed } = fixture(); scheduler.setEnabled(true); approve();
    scheduler.clearPending(); vi.runAllTimers(); expect(run).not.toHaveBeenCalled();
    expect(changed).toHaveBeenLastCalledWith({ enabled: true, pendingCount: 0, paused: false });
  });
  it("completion or failure does not re-enqueue the consumed save", () => {
    const { scheduler, update, approve, run } = fixture(); scheduler.setEnabled(true); approve();
    vi.runAllTimers(); update({ busy: true }); update({ busy: false }); vi.runAllTimers();
    expect(run).toHaveBeenCalledOnce();
    scheduler.approve("v1", "v2", ["parameter"]); update({ documentKey: "v2" }); vi.runAllTimers();
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("unmount cleanup removes timers and cancels automatic work without publishing state", () => {
    const { scheduler, approve, run, changed, cancelAutomatic } = fixture(); scheduler.setEnabled(true); approve();
    changed.mockClear(); scheduler.dispose(); vi.runAllTimers();
    expect(run).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled(); expect(cancelAutomatic).toHaveBeenCalledOnce();
  });
});
