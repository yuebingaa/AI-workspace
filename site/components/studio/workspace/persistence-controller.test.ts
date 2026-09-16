import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioPersistedState, StudioRepository } from "@/core/repository";
import { projectState } from "@/core/projects/test-fixture";
import { StudioPersistenceController } from "./persistence-controller";

function setup() {
  const jobs: (() => void)[] = [];
  const controller = new StudioPersistenceController((job) => jobs.push(job));
  const repository = { load: () => null, save: vi.fn<(state: StudioPersistedState) => void>(), clear: vi.fn() } satisfies StudioRepository;
  const state = projectState();
  const input = { repository, mode: "temporary" as const, queryRecords: state.queryRecords, snapshot: vi.fn(() => state) };
  const notice = vi.fn();
  const drain = () => { for (const job of jobs.splice(0)) job(); };
  return { controller, repository, state, input, notice, drain };
}

afterEach(() => vi.unstubAllGlobals());

describe("workspace persistence scheduling", () => {
  it("persists changed session selection or draft without requiring a query", () => {
    const { controller, repository, input, notice, drain } = setup();
    const conversationState = { activeId: "first" };
    controller.scheduleAutomatic({ ...input, conversationState }, notice); drain();
    controller.scheduleAutomatic({ ...input, conversationState }, notice); drain();
    expect(repository.save).toHaveBeenCalledTimes(1);
    controller.scheduleAutomatic({ ...input, conversationState: { activeId: "second" } }, notice); drain();
    expect(repository.save).toHaveBeenCalledTimes(2);
  });
  it("calls the browser scheduler without rebinding it to the controller instance", () => {
    const jobs: (() => void)[] = [];
    vi.stubGlobal("queueMicrotask", function (this: unknown, job: () => void) {
      expect(this).toBeUndefined();
      jobs.push(job);
    });
    const { input, repository, notice } = setup();
    new StudioPersistenceController().scheduleAutomatic(input, notice);
    expect(repository.save).not.toHaveBeenCalled();
    jobs[0](); expect(repository.save).toHaveBeenCalledTimes(1);
  });
  it("defers snapshot construction and saving until the scheduled job runs", () => {
    const { controller, repository, state, input, notice, drain } = setup();
    controller.scheduleAutomatic(input, notice);
    expect(input.snapshot).not.toHaveBeenCalled(); expect(repository.save).not.toHaveBeenCalled();
    drain();
    expect(input.snapshot).toHaveBeenCalledTimes(1); expect(repository.save).toHaveBeenCalledExactlyOnceWith(state);
    expect(notice).not.toHaveBeenCalled();
  });

  it("cancels obsolete snapshots while keeping the newest request, even after older cleanup", () => {
    const { controller, repository, state, input, notice, drain } = setup();
    const oldCleanup = controller.scheduleAutomatic(input, notice);
    const next = structuredClone(state); next.dataProduct.name = "最新状态";
    controller.scheduleAutomatic({ ...input, snapshot: () => next }, notice);
    oldCleanup(); drain();
    expect(input.snapshot).not.toHaveBeenCalled();
    expect(repository.save).toHaveBeenCalledExactlyOnceWith(next);
  });

  it("cancels on cleanup without suppressing StrictMode replay for the same query records", () => {
    const { controller, repository, input, notice, drain } = setup();
    const cleanup = controller.scheduleAutomatic(input, notice);
    cleanup(); drain();
    expect(repository.save).not.toHaveBeenCalled(); expect(notice).not.toHaveBeenCalled();
    controller.scheduleAutomatic(input, notice); drain();
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("keeps temporary autosaves query-triggered, while project documents save on other changes", () => {
    const { controller, repository, input, notice, drain } = setup();
    controller.scheduleAutomatic(input, notice); drain();
    controller.scheduleAutomatic(input, notice); drain();
    expect(repository.save).toHaveBeenCalledTimes(1);
    controller.scheduleAutomatic({ ...input, queryRecords: [] }, notice); drain();
    expect(repository.save).toHaveBeenCalledTimes(2);
    controller.scheduleAutomatic({ ...input, mode: "project" }, notice); drain();
    controller.scheduleAutomatic({ ...input, mode: "project" }, notice); drain();
    expect(repository.save).toHaveBeenCalledTimes(4);
  });

  it("does not reuse another repository's temporary query marker", () => {
    const { controller, repository, input, notice, drain } = setup();
    controller.scheduleAutomatic(input, notice); drain();
    const nextRepository = { ...repository, save: vi.fn() };
    controller.scheduleAutomatic({ ...input, repository: nextRepository }, notice); drain();
    expect(repository.save).toHaveBeenCalledTimes(1); expect(nextRepository.save).toHaveBeenCalledTimes(1);
  });

  it("saves explicit user operations synchronously and cancels an older queued automatic snapshot", () => {
    const { controller, repository, state, input, notice, drain } = setup();
    controller.scheduleAutomatic(input, notice);
    const explicit = structuredClone(state); explicit.dataProduct.name = "用户已确认的更改";
    expect(controller.saveExplicitly(repository, explicit)).toEqual({ persisted: true, notice: null });
    expect(repository.save).toHaveBeenCalledExactlyOnceWith(explicit);
    drain(); expect(input.snapshot).not.toHaveBeenCalled(); expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("preserves restored backup state and only resumes temporary autosave on new query records", () => {
    const { controller, repository, state, input, notice, drain } = setup();
    controller.scheduleAutomatic(input, notice);
    const restored = structuredClone(state); restored.dataProduct.name = "从备份恢复";
    repository.save(restored);
    controller.markQueriesRestored(repository, restored.queryRecords);
    controller.scheduleAutomatic({ ...input, queryRecords: restored.queryRecords, snapshot: () => restored }, notice);
    drain();
    expect(input.snapshot).not.toHaveBeenCalled();
    expect(repository.save).toHaveBeenCalledExactlyOnceWith(restored);
    controller.scheduleAutomatic({ ...input, queryRecords: [], snapshot: () => restored }, notice); drain();
    expect(repository.save).toHaveBeenCalledTimes(2);
  });

  it("reports automatic storage failure asynchronously, without an automatic retry/render loop", () => {
    const { controller, repository, state, input, notice, drain } = setup();
    repository.save.mockImplementation(() => { throw new Error("synthetic quota failure"); });
    controller.scheduleAutomatic(input, notice); expect(notice).not.toHaveBeenCalled(); drain();
    expect(notice).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("本地保存失败"));
    controller.scheduleAutomatic(input, notice); drain();
    expect(repository.save).toHaveBeenCalledTimes(1); expect(notice).toHaveBeenCalledTimes(1);
    const result = controller.saveExplicitly(repository, state);
    expect(result.persisted).toBe(false); expect(result.notice).toContain("synthetic quota failure");
    expect(repository.save).toHaveBeenCalledTimes(2);
  });

  it("keeps unavailable storage feedback instead of silently accepting changes", () => {
    const { controller, input, state, notice, drain } = setup();
    controller.scheduleAutomatic({ ...input, repository: null }, notice); drain();
    expect(notice).toHaveBeenCalledExactlyOnceWith("浏览器本地存储不可用，当前页面更改不会在刷新后保留。");
    expect(controller.saveExplicitly(null, state)).toEqual({ persisted: false, notice: notice.mock.calls[0][0] });
  });

  it("reports invalid automatic snapshots without an unhandled exception or overwriting saved data", () => {
    const { controller, repository, input, notice, drain } = setup();
    controller.scheduleAutomatic({ ...input, snapshot: () => { throw new Error("synthetic invalid snapshot"); } }, notice);
    expect(() => drain()).not.toThrow(); expect(repository.save).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("工作区保存快照无效"));
  });
});
