import { describe, expect, it, vi } from "vitest";
import type { NotebookDocument } from "@/core/notebook/contracts";
import type { NotebookArtifact } from "@/core/notebook/definition";
import { NotebookAiRunScheduler, type AiNotebookRunEnvironment, type AiNotebookRunRequest } from "./ai-run-scheduler";

const baseline: NotebookDocument = {
  name: "Saved notebook", revision: 4,
  cells: [{ id: "text_1", kind: "text", title: "Saved step", markdown: "Saved content" }],
};
const draft: NotebookArtifact = {
  id: "draft_1", version: 1, status: "draft", name: "AI preview", baseRevision: 4,
  cells: [{ id: "text_1", kind: "text", title: "Preview step", markdown: "Preview content" }],
  executionOrder: ["text_1"], lineage: [{ cellId: "text_1", dependsOn: [] }],
  sourceDataSourceIds: [], createdAt: "2026-09-24T00:00:00.000Z",
};
const candidate: NotebookDocument = { ...baseline, name: draft.name, cells: draft.cells };
const request: AiNotebookRunRequest = { taskId: "task_1", draft, baseline, scopeKey: "project_1/page_1" };

function fixture() {
  const scheduler = new NotebookAiRunScheduler();
  const prepare = vi.fn<(request: AiNotebookRunRequest) => NotebookDocument>(() => structuredClone(candidate));
  const run = vi.fn(), cancel = vi.fn(), blocked = vi.fn(), handled = vi.fn();
  const handlers = { prepare, run, cancel, blocked, handled };
  let environment: AiNotebookRunEnvironment = {
    document: structuredClone(baseline), contextKey: "sources_1", scopeKey: request.scopeKey,
    enabled: true, canEdit: true, hidden: false, editing: false, busy: false, externalBusy: false,
  };
  const update = (next: Partial<AiNotebookRunEnvironment> = {}) => {
    environment = { ...environment, ...next };
    scheduler.update(environment, handlers);
  };
  update();
  const begin = () => update({ request });
  const commit = () => update({ document: structuredClone(candidate), request: null });
  return { scheduler, handlers, prepare, run, cancel, blocked, handled, update, begin, commit };
}

const guards = [
  ["disabled", { enabled: false }], ["no edit permission", { canEdit: false }],
  ["hidden", { hidden: true }], ["editing", { editing: true }],
  ["busy", { busy: true }], ["another AI task", { externalBusy: true }],
] satisfies [string, Partial<AiNotebookRunEnvironment>][];
const ready = { enabled: true, canEdit: true, hidden: false, editing: false, busy: false, externalBusy: false };

describe("explicit AI Notebook preview scheduler", () => {
  it("never infers an event from opening, restoring, or changing a document", () => {
    const { update, prepare, run, handled } = fixture();
    update({ enabled: false }); update({ document: candidate }); update({ enabled: true });
    update({ document: { ...candidate, lastDraftId: draft.id } });
    expect(prepare).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(handled).not.toHaveBeenCalled();
  });

  it("prepares an isolated candidate, clears the event, and waits for an exact parent commit", () => {
    const { begin, update, commit, prepare, run, handled, blocked } = fixture();
    begin();
    expect(handled).toHaveBeenCalledExactlyOnceWith(request.taskId);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(request);
    expect(handled.mock.invocationCallOrder[0]).toBeLessThan(prepare.mock.invocationCallOrder[0]);
    expect(run).not.toHaveBeenCalled();
    update({ request: null }); update();
    expect(run).not.toHaveBeenCalled();
    expect(baseline.name).toBe("Saved notebook"); expect(baseline.cells[0].title).toBe("Saved step");
    commit(); expect(run).toHaveBeenCalledOnce(); expect(blocked).not.toHaveBeenCalled();
  });

  it("uses the current handlers and committed document for the actual run", () => {
    const { scheduler, begin, handlers, run } = fixture(); begin();
    const nextRun = vi.fn();
    scheduler.update({ document: candidate, contextKey: "sources_1", scopeKey: request.scopeKey, ...ready }, { ...handlers, run: nextRun });
    expect(nextRun).toHaveBeenCalledOnce(); expect(run).not.toHaveBeenCalled();
  });

  it("runs once despite repeated effects and completion or failure renders", () => {
    const { begin, commit, update, prepare, run, handled, cancel } = fixture();
    begin(); begin(); commit(); update({ request }); update({ busy: true }); update({ busy: false }); update();
    expect(prepare).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledOnce(); expect(handled).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("does not replay a consumed task with a different request object or payload", () => {
    const { begin, commit, update, prepare, run } = fixture(); begin(); commit();
    update({ request: { ...request, draft: { ...draft, id: "replacement_draft" }, baseline: candidate } });
    expect(prepare).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledOnce();
  });

  it.each(guards)("consumes a new event rejected because it is %s", (_name, guard) => {
    const { update, prepare, run, handled, blocked } = fixture();
    update({ ...guard, request });
    expect(handled).toHaveBeenCalledExactlyOnceWith(request.taskId);
    expect(blocked).toHaveBeenCalledOnce(); expect(prepare).not.toHaveBeenCalled();
    update(ready); update({ document: candidate });
    expect(prepare).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(blocked).toHaveBeenCalledOnce();
  });

  it.each(guards)("discards a pending preview when it becomes %s instead of resuming later", (_name, guard) => {
    const { begin, update, commit, prepare, run, cancel, blocked } = fixture(); begin();
    update(guard); update(ready); commit();
    expect(prepare).toHaveBeenCalledOnce(); expect(run).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce(); expect(blocked).toHaveBeenCalledOnce();
  });

  it("rejects a completion from a different project or page scope", () => {
    const { update, prepare, handled, blocked } = fixture();
    update({ request: { ...request, scopeKey: "project_2/page_1" } });
    expect(prepare).not.toHaveBeenCalled(); expect(handled).toHaveBeenCalledOnce(); expect(blocked).toHaveBeenCalledOnce();
    update({ request }); expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects an event arriving in the same update as a source context change", () => {
    const { update, prepare, handled, blocked } = fixture();
    update({ contextKey: "sources_2", request }); update({ contextKey: "sources_1" });
    expect(prepare).not.toHaveBeenCalled(); expect(handled).toHaveBeenCalledOnce(); expect(blocked).toHaveBeenCalledOnce();
  });

  it.each(["contextKey", "scopeKey"] as const)("cancels a prepared preview when %s changes, even if later restored", (key) => {
    const { begin, update, commit, run, cancel } = fixture(); begin();
    update({ [key]: "changed" }); update({ contextKey: "sources_1", scopeKey: request.scopeKey }); commit();
    expect(run).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ["name", { ...baseline, name: "Edited name" }],
    ["cell contents at the same revision", { ...baseline, cells: [{ ...baseline.cells[0], title: "Edited title" }] }],
    ["adoption metadata", { ...baseline, lastDraftId: "different_draft" }],
    ["revision", { ...baseline, revision: 5 }],
  ] satisfies [string, NotebookDocument][])("compares the complete baseline, including %s", (_name, document) => {
    const { update, prepare, run, handled, blocked } = fixture();
    update({ document, request }); update({ document: baseline }); update({ document: candidate });
    expect(prepare).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    expect(handled).toHaveBeenCalledOnce(); expect(blocked).toHaveBeenCalledOnce();
  });

  it.each([
    ["name", { ...candidate, name: "Other candidate" }],
    ["cell contents", { ...candidate, cells: [{ ...candidate.cells[0], title: "Other title" }] }],
    ["adoption metadata", { ...candidate, lastDraftId: draft.id }],
    ["revision", { ...candidate, revision: 5 }],
  ] satisfies [string, NotebookDocument][])("requires the entire prepared candidate to match, including %s", (_name, document) => {
    const { begin, update, commit, run, cancel, blocked } = fixture(); begin();
    update({ document }); commit();
    expect(run).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce(); expect(blocked).toHaveBeenCalledOnce();
  });

  it("rejects a foreign definition seen before the parent commits the candidate", () => {
    const { begin, update, commit, run, cancel } = fixture(); begin();
    update({ document: { ...baseline, name: "External edit" } }); commit();
    expect(run).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
  });

  it("consumes preparation capability failures and surfaces the reason once", () => {
    const { prepare, begin, commit, run, handled, blocked } = fixture();
    prepare.mockImplementation(() => { throw new Error("Python 能力不可用，无法准备草稿预览"); });
    begin(); begin(); commit();
    expect(prepare).toHaveBeenCalledOnce(); expect(run).not.toHaveBeenCalled(); expect(handled).toHaveBeenCalledOnce();
    expect(blocked).toHaveBeenCalledExactlyOnceWith("Python 能力不可用，无法准备草稿预览");
  });

  it("handles a non-Error preparation failure without starting or retrying", () => {
    const { prepare, begin, commit, run, blocked } = fixture();
    prepare.mockImplementation(() => { throw "failure"; });
    begin(); commit(); begin();
    expect(prepare).toHaveBeenCalledOnce(); expect(run).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledExactlyOnceWith("AI 草稿预览准备失败；请检查草稿后手动处理。");
  });

  it("does not run if preparation returns the unchanged saved document", () => {
    const { prepare, begin, update, run, blocked } = fixture(); prepare.mockReturnValue(baseline);
    begin(); update(); expect(run).not.toHaveBeenCalled(); expect(blocked).toHaveBeenCalledOnce();
  });

  it("consumes the pending preview before a synchronous run failure", () => {
    const { run, begin, commit, update, cancel, blocked } = fixture();
    run.mockImplementation(() => { throw new Error("Preview runtime unavailable"); });
    begin(); commit(); update(); update({ request });
    expect(run).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
    expect(blocked).toHaveBeenCalledExactlyOnceWith("Preview runtime unavailable");
  });

  it("clears a pending preview on manual cancellation and never resumes it", () => {
    const { scheduler, begin, commit, update, run, cancel } = fixture(); begin();
    scheduler.clearPending(); scheduler.clearPending(); commit(); update({ request });
    expect(run).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
  });

  it("cleans up pending work while preserving consumed task IDs through effect replay", () => {
    const { scheduler, begin, commit, prepare, run, cancel } = fixture(); begin();
    scheduler.dispose(); scheduler.dispose(); begin(); commit();
    expect(prepare).toHaveBeenCalledOnce(); expect(run).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ["disabled", { enabled: false }], ["permission lost", { canEdit: false }],
    ["hidden", { hidden: true }], ["editing", { editing: true }],
    ["another AI task", { externalBusy: true }], ["source changed", { contextKey: "sources_2" }],
    ["page changed", { scopeKey: "project_1/page_2" }], ["definition changed", { document: baseline }],
  ] satisfies [string, Partial<AiNotebookRunEnvironment>][])("cancels the active preview when %s without retrying", (_name, change) => {
    const { begin, commit, update, run, cancel } = fixture(); begin(); commit(); update({ busy: true });
    update(change); update({ ...ready, document: candidate, contextKey: "sources_1", scopeKey: request.scopeKey });
    expect(run).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects overlapping new completions rather than running two candidates", () => {
    const { begin, update, commit, prepare, run, cancel, handled } = fixture(); begin();
    update({ request: { ...request, taskId: "task_2" } }); commit();
    expect(prepare).toHaveBeenCalledOnce(); expect(run).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
    expect(handled).toHaveBeenCalledTimes(2);
  });

  it("accepts a genuinely new task after the previous preview run has settled", () => {
    const { begin, commit, update, prepare, run, handled } = fixture(); begin(); commit();
    update({ busy: true }); update({ busy: false });
    const nextCandidate = { ...candidate, name: "Next preview" };
    const nextRequest = { ...request, taskId: "task_2", baseline: candidate };
    prepare.mockReturnValue(nextCandidate);
    update({ request: nextRequest }); update({ document: nextCandidate, request: null });
    expect(prepare).toHaveBeenCalledTimes(2); expect(run).toHaveBeenCalledTimes(2); expect(handled).toHaveBeenCalledTimes(2);
  });

  it("does not lock future events if the runner settles before a busy render is observed", () => {
    const { begin, commit, update, prepare, run } = fixture(); begin(); commit();
    const nextCandidate = { ...candidate, name: "Next preview" };
    prepare.mockReturnValue(nextCandidate);
    update({ request: { ...request, taskId: "task_2", baseline: candidate } });
    update({ document: nextCandidate, request: null });
    expect(prepare).toHaveBeenCalledTimes(2); expect(run).toHaveBeenCalledTimes(2);
  });

  it("fails closed if the owner cannot clear the completion event", () => {
    const { handled, begin, commit, prepare, run, blocked } = fixture();
    handled.mockImplementation(() => { throw new Error("Event acknowledgement failed"); });
    begin(); begin(); commit();
    expect(handled).toHaveBeenCalledOnce(); expect(prepare).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledExactlyOnceWith("Event acknowledgement failed");
  });

  it("does not recreate pending work if preparation disposes the scheduler", () => {
    const { scheduler, prepare, begin, commit, run, cancel } = fixture();
    prepare.mockImplementation(() => { scheduler.dispose(); return candidate; });
    begin(); commit(); expect(run).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not replay when run synchronously updates the scheduler", () => {
    const { run, begin, commit, update } = fixture();
    run.mockImplementation(() => update({ busy: true }));
    begin(); commit(); update({ busy: false }); update({ request });
    expect(run).toHaveBeenCalledOnce();
  });
});
