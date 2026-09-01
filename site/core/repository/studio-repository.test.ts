import { describe, expect, it } from "vitest";
import { applyChangeSet, createExecutionState } from "@/core/changesets";
import { createChangeSetAuditRecord } from "@/core/audit";
import { executeRecordedBinding } from "@/core/data";
import { appendHarnessEvent, createHarnessTask, taskWithPendingChangeSet } from "@/core/harness/task-state";
import type { AppNode } from "@/core/models";
import { demoFixtureResult } from "@/fixtures/demo-product";
import {
  createBrowserStudioRepository,
  createStudioSnapshot,
  loadStudioStateSafely,
  LocalStorageStudioRepository,
  restoreDemoData,
  STUDIO_STORAGE_KEY,
  STUDIO_STORAGE_VERSION,
  type StorageLike,
} from "./studio-repository";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function fixtures() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return structuredClone(demoFixtureResult.data);
}

function findNode(node: AppNode, id: string): AppNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
}

describe("StudioRepository 本地持久化", () => {
  it("保存并重新载入正式 AppSpec 和 ChangeSet 历史", () => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    const execution = applyChangeSet(createExecutionState(dataProduct.appSpec), repurchaseChangeSet, "editor");
    const storage = new MemoryStorage();
    const repository = new LocalStorageStudioRepository(storage);
    const audit = createChangeSetAuditRecord(repurchaseChangeSet, "editor", "ai", "applied");
    const metric = findNode(execution.present.pages[0].root, "page_home_revenue");
    if (!metric || metric.type !== "MetricCard") throw new Error("缺少指标卡 fixture");
    const query = executeRecordedBinding("metric", metric.props.binding, execution.present.dataSources, fixtures().dataRuntime, { componentId: metric.id, pageId: "page_home" }).record;
    repository.save(createStudioSnapshot(dataProduct, execution, [audit], [query]));

    const loaded = loadStudioStateSafely(repository, dataProduct);
    expect(loaded.restored).toBe(true);
    expect(loaded.execution.history).toHaveLength(1);
    expect(loaded.auditRecords).toHaveLength(1);
    expect(loaded.queryRecords).toHaveLength(1);
    expect(findNode(loaded.execution.present.pages[0].root, "metric_repurchase")).toBeDefined();
  });

  it("Schema 校验失败后回退到安全 fixture", () => {
    const { dataProduct } = fixtures();
    const storage = new MemoryStorage();
    storage.setItem(STUDIO_STORAGE_KEY, JSON.stringify({ version: 1, appSpec: {} }));
    const loaded = loadStudioStateSafely(new LocalStorageStudioRepository(storage), dataProduct);
    expect(loaded.restored).toBe(false);
    expect(loaded.execution.present).toEqual(dataProduct.appSpec);
    expect(loaded.notice).toMatch(/已回退到安全演示数据/);
  });

  it("将版本 0 存储迁移到当前版本", () => {
    const { dataProduct } = fixtures();
    const snapshot = createStudioSnapshot(dataProduct, createExecutionState(dataProduct.appSpec), [], []);
    const legacy: Record<string, unknown> = { ...snapshot, version: 0, history: snapshot.changeHistory };
    delete legacy.changeHistory;
    delete legacy.savedAt;
    const storage = new MemoryStorage();
    storage.setItem(STUDIO_STORAGE_KEY, JSON.stringify(legacy));
    const loaded = new LocalStorageStudioRepository(storage).load();
    expect(loaded?.version).toBe(STUDIO_STORAGE_VERSION);
    expect(loaded?.savedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("恢复演示数据会清除本地快照", () => {
    const { dataProduct } = fixtures();
    const storage = new MemoryStorage();
    const repository = new LocalStorageStudioRepository(storage);
    repository.save(createStudioSnapshot(dataProduct, createExecutionState(dataProduct.appSpec), [], []));
    const restored = restoreDemoData(repository, dataProduct);
    expect(storage.getItem(STUDIO_STORAGE_KEY)).toBeNull();
    expect(restored.execution.present).toEqual(dataProduct.appSpec);
    expect(restored.auditRecords).toEqual([]);
  });

  it("刷新后恢复任务摘要，但不会自动继续运行或应用待确认写操作", () => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    let sequence = 0;
    const clock = { now: () => new Date("2026-01-02T00:00:00.000Z"), id: () => `event_restore_${++sequence}` };
    const planning = createHarnessTask("request_refresh_running", "检查数据", "page_home", "editor", clock);
    let awaiting = createHarnessTask("request_refresh_pending", "生成复购指标", "page_home", "editor", clock);
    awaiting = taskWithPendingChangeSet(awaiting, repurchaseChangeSet);
    awaiting = appendHarnessEvent(awaiting, {
      type: "confirmation",
      state: "awaitingConfirmation",
      message: "等待用户确认。",
    }, clock);
    const storage = new MemoryStorage();
    const repository = new LocalStorageStudioRepository(storage);
    repository.save(createStudioSnapshot(dataProduct, createExecutionState(dataProduct.appSpec), [], [], [planning, awaiting]));

    const loaded = loadStudioStateSafely(repository, dataProduct);
    expect(loaded.harnessTasks.find((task) => task.id === planning.id)?.state).toBe("cancelled");
    expect(loaded.harnessTasks.find((task) => task.id === awaiting.id)?.state).toBe("awaitingConfirmation");
    expect(loaded.execution.preview).toBeNull();
    expect(loaded.execution.present).toEqual(dataProduct.appSpec);
  });

  it("SSR 环境没有 localStorage 时安全返回 null", () => {
    expect(typeof window).toBe("undefined");
    expect(createBrowserStudioRepository()).toBeNull();
  });
});
