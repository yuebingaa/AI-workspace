import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createExecutionState } from "@/core/changesets";
import { createHarnessTask } from "@/core/harness/task-state";
import { HarnessConversationStore } from "@/core/harness/server/conversation-store";
import { PROJECT_FORMAT, type ProjectSession } from "@/core/projects/contracts";
import { ProjectStateRepository, type ProjectStateWriter } from "@/core/projects/state-repository";
import { projectState } from "@/core/projects/test-fixture";
import {
  createStudioSnapshot, exportStudioBackup, importStudioBackup, LocalStorageStudioRepository,
  parseStudioPersistedState, STUDIO_STORAGE_KEY, type StorageLike,
} from "./studio-repository";

const source = JSON.stringify({ id: "failed_python", kind: "python", code: "# diagnostic-only-synthetic-source" });
function failedTask() {
  return {
    ...createHarnessTask("diagnostic_request", "检查单元失败", "page_home", "editor", {
      now: () => new Date("2026-09-16T00:00:00.000Z"), id: () => "diagnostic_event",
    }),
    state: "failed" as const, resultMessage: "单元执行失败，正式文档未改变。",
    notebookDiagnostics: {
      version: 1 as const, baseRevision: 0, editVersion: 1, runId: "synthetic_run", status: "failure" as const,
      cells: [{ cellId: "failed_python", kind: "python" as const, title: "合成失败单元", status: "failure" as const,
        source, sourceChars: source.length, sourceTruncated: false,
        timing: { preparationMs: 50, executionMs: 10, failurePhase: "execution" as const, termination: "error" as const } }],
      omittedCellCount: 0,
    },
  };
}
function liveState() { return { ...projectState(), harnessTasks: [failedTask()] }; }
function memoryStorage(): StorageLike {
  const entries = new Map<string, string>();
  return { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); }, removeItem: (key) => { entries.delete(key); } };
}

describe("Notebook diagnostics are transient, not project or model context", () => {
  it("projects snapshots without mutating the current read-only diagnostic or formal notebook", () => {
    const live = liveState(), before = structuredClone(live);
    const snapshot = createStudioSnapshot(live.dataProduct, createExecutionState(live.appSpec), [], [], live.harnessTasks);
    expect(snapshot.harnessTasks[0]).not.toHaveProperty("notebookDiagnostics");
    expect(snapshot.harnessTasks[0]).toMatchObject({ state: "failed", resultMessage: live.harnessTasks[0].resultMessage });
    expect(live).toEqual(before);
    expect(snapshot.dataProduct).toEqual(live.dataProduct);
  });

  it("strips diagnostics when writing localStorage and when parsing previously supplied snapshots", () => {
    const live = liveState(), storage = memoryStorage(), repository = new LocalStorageStudioRepository(storage);
    repository.save(live);
    expect(storage.getItem(STUDIO_STORAGE_KEY)).not.toContain("diagnostic-only-synthetic-source");
    expect(repository.load()?.harnessTasks[0]).not.toHaveProperty("notebookDiagnostics");
    storage.setItem(STUDIO_STORAGE_KEY, JSON.stringify(live));
    expect(repository.load()?.harnessTasks[0]).not.toHaveProperty("notebookDiagnostics");
    expect(parseStudioPersistedState(live).harnessTasks[0]).not.toHaveProperty("notebookDiagnostics");
    expect(live.harnessTasks[0].notebookDiagnostics.cells[0].source).toBe(source);
  });

  it("excludes source from backup export and explicitly supplied backup import", () => {
    const live = liveState(), encoded = exportStudioBackup(live);
    expect(encoded).not.toContain("notebookDiagnostics");
    const supplied = JSON.parse(encoded);
    supplied.state.harnessTasks = live.harnessTasks;
    const restored = importStudioBackup(JSON.stringify(supplied));
    expect(restored.harnessTasks[0]).not.toHaveProperty("notebookDiagnostics");
    expect(restored.dataProduct).toEqual(live.dataProduct);
  });

  it("sends only the persistent projection through the project writer port", async () => {
    const state = projectState();
    const session: ProjectSession = { handle: randomUUID(), path: "C:\\synthetic-diagnostics-project", manifest: {
      format: PROJECT_FORMAT, id: randomUUID(), name: "合成项目", createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z", stateRevision: 0, state, tables: [], files: [],
    } };
    const write = vi.fn<ProjectStateWriter>().mockResolvedValue({ stateRevision: 1 });
    const repository = new ProjectStateRepository(session, vi.fn(), write), live = liveState();
    repository.save(live); await repository.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0].state.harnessTasks[0]).not.toHaveProperty("notebookDiagnostics");
    expect(JSON.stringify(write.mock.calls[0][0])).not.toContain("diagnostic-only-synthetic-source");
    expect(live.harnessTasks[0].notebookDiagnostics.cells[0].source).toBe(source);
  });

  it("does not copy task diagnostics into server conversation memory or a follow-up context", () => {
    const store = new HarnessConversationStore(), live = liveState();
    const request = { idempotencyKey: "diagnostic_follow_up", conversation_id: "diagnostic_conversation", instruction: "检查单元失败",
      pageId: "page_home", role: "editor" as const, appSpec: live.appSpec, recipes: live.dataProduct.recipes };
    const first = store.begin(request, "diagnostic_project"); first.commit(live.harnessTasks[0]); first.release();
    const next = store.begin(request, "diagnostic_project");
    expect(next.context?.recentMessages).toHaveLength(1);
    expect(JSON.stringify(next.context)).not.toContain("notebookDiagnostics");
    expect(JSON.stringify(next.context)).not.toContain("diagnostic-only-synthetic-source");
    next.release();
  });
});
