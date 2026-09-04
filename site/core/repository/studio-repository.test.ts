import { describe, expect, it, vi } from "vitest";
import { applyChangeSet, createExecutionState } from "@/core/changesets";
import { createChangeSetAuditRecord } from "@/core/audit";
import { executeRecordedBinding } from "@/core/data";
import { appendHarnessEvent, createHarnessTask, taskWithPendingChangeSet } from "@/core/harness/task-state";
import type { AppNode } from "@/core/models";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { EDS_RULE_VERSION, EDS_TEMPLATE_VERSION, type EdsWorkspaceSnapshot } from "@/core/eds";
import {
  createBrowserStudioRepository,
  createStudioSnapshot,
  exportStudioBackup,
  importStudioBackup,
  loadStudioStateSafely,
  LocalStorageStudioRepository,
  restoreDemoData,
  restoreStudioBackup,
  saveStudioStateSafely,
  STUDIO_BACKUP_MAX_BYTES,
  STUDIO_STORAGE_KEY,
  STUDIO_STORAGE_VERSION,
  type StudioRepository,
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

function edsWorkspace(): EdsWorkspaceSnapshot {
  return {
    version: 1,
    generatedAt: "2026-09-04T03:30:00.000Z",
    summary: {
      date: "2026-08-25",
      shift: "白班",
      inputRows: 0,
      matchedRows: 0,
      issueCount: 14,
      channelCount: 20,
      totalOccurrences: 0,
      totalMinutes: 0,
    },
    issueSummary: Array.from({ length: 14 }, (_, index) => ({ label: `异常 ${index + 1}`, count: 0, minutes: 0 })),
    lineSummary: [{ label: "线体 1", count: 0, minutes: 0 }],
    configuration: { templateVersion: EDS_TEMPLATE_VERSION, ruleVersion: EDS_RULE_VERSION },
  };
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

  it("把受控 EDS 派生汇总写入 localStorage 并在刷新恢复，旧快照迁移为空", () => {
    const { dataProduct } = fixtures();
    const storage = new MemoryStorage();
    const repository = new LocalStorageStudioRepository(storage);
    repository.save(createStudioSnapshot(
      dataProduct,
      createExecutionState(dataProduct.appSpec),
      [],
      [],
      [],
      edsWorkspace(),
    ));

    const serialized = storage.getItem(STUDIO_STORAGE_KEY)!;
    expect(serialized).toContain("issueSummary");
    expect(serialized).toContain(EDS_TEMPLATE_VERSION);
    expect(repository.load()?.edsWorkspace).toEqual(edsWorkspace());
    expect(loadStudioStateSafely(repository, dataProduct).edsWorkspace).toEqual(edsWorkspace());

    const current = JSON.parse(serialized) as Record<string, unknown>;
    delete current.edsWorkspace;
    current.version = 2;
    storage.setItem(STUDIO_STORAGE_KEY, JSON.stringify(current));
    expect(repository.load()?.edsWorkspace).toBeNull();
  });

  it("在 JSON 解析和 localStorage 写入前强制执行不可放宽的字节上限", () => {
    const { dataProduct } = fixtures();
    const storage = new MemoryStorage();
    const repository = new LocalStorageStudioRepository(storage, STUDIO_STORAGE_KEY, 32);
    storage.setItem(STUDIO_STORAGE_KEY, " ".repeat(33));
    const jsonParse = vi.spyOn(JSON, "parse");

    expect(() => repository.load()).toThrow(/本地工作台数据过大/);
    expect(jsonParse).not.toHaveBeenCalled();
    jsonParse.mockRestore();

    const snapshot = createStudioSnapshot(dataProduct, createExecutionState(dataProduct.appSpec), [], []);
    const setItem = vi.spyOn(storage, "setItem");
    expect(() => repository.save(snapshot)).toThrow(/本地工作台数据过大/);
    expect(setItem).not.toHaveBeenCalled();
    expect(storage.getItem(STUDIO_STORAGE_KEY)).toBe(" ".repeat(33));
    expect(() => new LocalStorageStudioRepository(storage, STUDIO_STORAGE_KEY, STUDIO_BACKUP_MAX_BYTES + 1))
      .toThrow(/存储上限必须是/);
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

  it("浏览器存储清除失败时仍恢复页面并返回可见提示", () => {
    const { dataProduct } = fixtures();
    const repository: StudioRepository = {
      load: () => null,
      save: () => undefined,
      clear: () => { throw new Error("synthetic storage failure"); },
    };
    const restored = restoreDemoData(repository, dataProduct);

    expect(restored.execution.present).toEqual(dataProduct.appSpec);
    expect(restored.restored).toBe(false);
    expect(restored.notice).toMatch(/未能清除浏览器本地快照/);
  });

  it("浏览器保存失败或不可用时返回可见且不误报成功的结果", () => {
    const { dataProduct } = fixtures();
    const snapshot = createStudioSnapshot(dataProduct, createExecutionState(dataProduct.appSpec), [], []);
    const failingRepository: StudioRepository = {
      load: () => null,
      save: () => { throw new Error("synthetic quota failure"); },
      clear: () => undefined,
    };

    expect(saveStudioStateSafely(failingRepository, snapshot)).toMatchObject({
      persisted: false,
      notice: expect.stringMatching(/本地保存失败.*刷新后可能丢失/),
    });
    expect(saveStudioStateSafely(null, snapshot)).toMatchObject({
      persisted: false,
      notice: expect.stringMatching(/本地存储不可用.*刷新后保留/),
    });

    const storage = new MemoryStorage();
    expect(saveStudioStateSafely(new LocalStorageStudioRepository(storage), snapshot)).toEqual({ persisted: true, notice: null });
    expect(storage.getItem(STUDIO_STORAGE_KEY)).not.toBeNull();
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

    const recoveryNow = vi.fn(() => new Date("2030-01-02T03:04:05.123Z"));
    const loaded = loadStudioStateSafely(repository, dataProduct, recoveryNow);
    const recoveredPlanning = loaded.harnessTasks.find((task) => task.id === planning.id);
    expect(recoveredPlanning?.state).toBe("cancelled");
    expect(loaded.harnessTasks.find((task) => task.id === awaiting.id)?.state).toBe("awaitingConfirmation");
    const recoveryEvent = recoveredPlanning?.events.at(-1);
    expect(recoveryEvent?.timestamp).toBe("2030-01-02T03:04:05.123Z");
    expect(recoveryEvent?.id).toBe(`harness_recovery_${Date.parse(recoveryEvent?.timestamp ?? "")}_1`);
    expect(recoveryNow).toHaveBeenCalledTimes(1);
    expect(loaded.execution.preview).toBeNull();
    expect(loaded.execution.present).toEqual(dataProduct.appSpec);
  });

  it("SSR 环境没有 localStorage 时安全返回 null", () => {
    expect(typeof window).toBe("undefined");
    expect(createBrowserStudioRepository()).toBeNull();
  });

  it("备份并恢复包含 Harness 与审计记录的已校验工作台状态", () => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    const audit = createChangeSetAuditRecord(repurchaseChangeSet, "editor", "ai", "previewed");
    const clock = { now: () => new Date("2026-09-04T00:00:00.000Z"), id: () => "event_backup" };
    const task = createHarnessTask("request_backup", "检查数据", "page_home", "editor", clock);
    const snapshot = createStudioSnapshot(dataProduct, createExecutionState(dataProduct.appSpec), [audit], [], [task]);
    const serialized = exportStudioBackup(snapshot, new Date("2026-09-04T00:01:00.000Z"));
    const storage = new MemoryStorage();
    const repository = new LocalStorageStudioRepository(storage);

    expect(importStudioBackup(serialized)).toMatchObject({ auditRecords: [{ id: audit.id }], harnessTasks: [{ id: task.id }] });
    restoreStudioBackup(repository, serialized);
    expect(repository.load()).toMatchObject({ auditRecords: [{ id: audit.id }], harnessTasks: [{ id: task.id }] });
    expect(() => importStudioBackup("{bad")).toThrow(/备份校验失败/);
    expect(() => exportStudioBackup(snapshot, new Date(Number.NaN))).toThrow(/工作台备份时间无效.*导出时间必须是有效 Date/);
    expect(() => exportStudioBackup(snapshot, new Date(8_640_000_000_000_000))).toThrow(/工作台备份时间无效.*导出时间必须是有效 Date/);
    expect(() => exportStudioBackup(snapshot, null as unknown as Date)).toThrow(/工作台备份时间无效.*导出时间必须是有效 Date/);
  });

  it("恢复任务时拒绝项目 ISO schema 无法表示的极端年份", () => {
    const { dataProduct } = fixtures();
    const clock = { now: () => new Date("2026-01-02T00:00:00.000Z"), id: () => "event_extreme_restore" };
    const planning = createHarnessTask("request_extreme_restore", "检查数据", "page_home", "editor", clock);
    const storage = new MemoryStorage();
    const repository = new LocalStorageStudioRepository(storage);
    repository.save(createStudioSnapshot(dataProduct, createExecutionState(dataProduct.appSpec), [], [], [planning]));

    const loaded = loadStudioStateSafely(repository, dataProduct, () => new Date(8_640_000_000_000_000));

    expect(loaded.restored).toBe(false);
    expect(loaded.harnessTasks).toEqual([]);
    expect(loaded.notice).toMatch(/Harness 恢复时钟无效.*有效 Date/);
  });
});
