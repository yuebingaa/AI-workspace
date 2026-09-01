import { z } from "zod";
import type { ChangeSetExecutionState, ChangeSetHistoryEntry } from "@/core/changesets";
import { restoreExecutionState } from "@/core/changesets";
import {
  harnessTaskSummarySchema,
  type HarnessTaskSummary,
} from "@/core/harness/contracts";
import {
  recoverHarnessTasksAfterRefresh,
  type HarnessTaskClock,
} from "@/core/harness/task-state";
import type {
  AppSpec,
  ChangeSetAuditRecord,
  DataProduct,
  QueryExecutionRecord,
} from "@/core/models";
import { appSpecSchema, dataProductSchema, formatSchemaIssues, StudioValidationError } from "@/core/schemas";

export const STUDIO_STORAGE_VERSION = 2 as const;
export const STUDIO_STORAGE_KEY = "datacanvas-ai:studio:v1";

const auditRecordSchema: z.ZodType<ChangeSetAuditRecord> = z.object({
  id: z.string().min(1),
  changeSetId: z.string().min(1),
  role: z.enum(["viewer", "editor", "admin"]),
  source: z.enum(["ai", "puck", "manual"]),
  operationSummary: z.string(),
  status: z.enum(["previewed", "applied", "cancelled", "undone", "failed"]),
  timestamp: z.iso.datetime(),
  error: z.string().optional(),
  ai: z.object({
    model: z.string().min(1),
    durationMs: z.number().nonnegative(),
    transport: z.enum(["responses_json_schema", "chat_function", "chat_json_object"]).optional(),
    repairAttempted: z.boolean().optional(),
    validationIssues: z.array(z.object({
      stage: z.enum(["json_parse", "draft_schema", "compile", "changeset_validation"]),
      path: z.string().min(1).max(240),
      code: z.string().min(1).max(120),
      operationType: z.enum(["addNode", "updateNodeProps", "removeNode", "moveNode", "updatePage"]).optional(),
    }).strict()).max(12).optional(),
    usage: z.object({
      promptTokens: z.number().int().nonnegative(),
      completionTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
    }).strict(),
  }).strict().optional(),
}).strict();

const queryRecordSchema: z.ZodType<QueryExecutionRecord> = z.object({
  id: z.string().min(1),
  componentId: z.string().min(1),
  pageId: z.string().min(1),
  componentKind: z.enum(["metric", "chart", "table"]),
  dataSourceId: z.string().min(1),
  bindingSummary: z.string(),
  planSummary: z.string(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  inputRowCount: z.number().int().nonnegative(),
  outputRowCount: z.number().int().nonnegative(),
  status: z.enum(["success", "failure"]),
  error: z.string().optional(),
}).strict();

const historyEntrySchema: z.ZodType<ChangeSetHistoryEntry> = z.object({
  appSpec: appSpecSchema,
  changeSetId: z.string().min(1),
  requiredRole: z.enum(["editor", "admin"]),
}).strict();

export interface StudioPersistedState {
  version: typeof STUDIO_STORAGE_VERSION;
  dataProduct: DataProduct;
  appSpec: AppSpec;
  changeHistory: ChangeSetHistoryEntry[];
  appliedChangeSetIds: string[];
  auditRecords: ChangeSetAuditRecord[];
  queryRecords: QueryExecutionRecord[];
  harnessTasks: HarnessTaskSummary[];
  savedAt: string;
}

const persistedStateSchema: z.ZodType<StudioPersistedState> = z.object({
  version: z.literal(STUDIO_STORAGE_VERSION),
  dataProduct: dataProductSchema,
  appSpec: appSpecSchema,
  changeHistory: z.array(historyEntrySchema).max(100),
  appliedChangeSetIds: z.array(z.string().min(1)).max(100),
  auditRecords: z.array(auditRecordSchema).max(100),
  queryRecords: z.array(queryRecordSchema).max(100),
  harnessTasks: z.array(harnessTaskSummarySchema).max(20),
  savedAt: z.iso.datetime(),
}).strict();

export interface StudioRepository {
  load(): StudioPersistedState | null;
  save(state: StudioPersistedState): void;
  clear(): void;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const migrations: Record<number, (value: Record<string, unknown>) => Record<string, unknown>> = {
  0: (value) => {
    const { history, ...rest } = value;
    return {
      ...rest,
      version: 1,
      changeHistory: value.changeHistory ?? history ?? [],
      appliedChangeSetIds: value.appliedChangeSetIds ?? [],
      auditRecords: value.auditRecords ?? [],
      queryRecords: value.queryRecords ?? [],
      savedAt: value.savedAt ?? new Date(0).toISOString(),
    };
  },
  1: (value) => ({ ...value, version: 2, harnessTasks: value.harnessTasks ?? [] }),
};

export function migrateStudioState(value: unknown): unknown {
  if (!isRecord(value) || !Number.isInteger(value.version)) {
    throw new StudioValidationError("本地存储版本校验失败", ["缺少有效的存储版本号"]);
  }
  let working = value;
  let version = Number(working.version);
  if (version > STUDIO_STORAGE_VERSION) {
    throw new StudioValidationError("本地存储版本不兼容", [`当前版本 ${version} 高于应用支持的版本 ${STUDIO_STORAGE_VERSION}`]);
  }
  while (version < STUDIO_STORAGE_VERSION) {
    const migrate = migrations[version];
    if (!migrate) throw new StudioValidationError("本地存储迁移失败", [`缺少从版本 ${version} 开始的迁移程序`]);
    working = migrate(working);
    version = Number(working.version);
  }
  return working;
}

export function parseStudioPersistedState(value: unknown): StudioPersistedState {
  const result = persistedStateSchema.safeParse(migrateStudioState(value));
  if (!result.success) {
    throw new StudioValidationError("本地工作台数据校验失败", formatSchemaIssues(result.error, "StudioPersistedState"));
  }
  return result.data;
}

export class LocalStorageStudioRepository implements StudioRepository {
  constructor(private readonly storage: StorageLike, private readonly key = STUDIO_STORAGE_KEY) {}

  load(): StudioPersistedState | null {
    const serialized = this.storage.getItem(this.key);
    if (serialized === null) return null;
    try {
      return parseStudioPersistedState(JSON.parse(serialized) as unknown);
    } catch (error) {
      if (error instanceof StudioValidationError) throw error;
      throw new StudioValidationError("本地工作台数据读取失败", ["存储内容不是有效 JSON"]);
    }
  }

  save(state: StudioPersistedState): void {
    const parsed = parseStudioPersistedState(state);
    this.storage.setItem(this.key, JSON.stringify(parsed));
  }

  clear(): void {
    this.storage.removeItem(this.key);
  }
}

export function createBrowserStudioRepository(): StudioRepository | null {
  if (typeof window === "undefined") return null;
  try {
    return new LocalStorageStudioRepository(window.localStorage);
  } catch {
    return null;
  }
}

export interface SafeStudioState {
  dataProduct: DataProduct;
  execution: ChangeSetExecutionState;
  auditRecords: ChangeSetAuditRecord[];
  queryRecords: QueryExecutionRecord[];
  harnessTasks: HarnessTaskSummary[];
  notice: string | null;
  restored: boolean;
}

export function loadStudioStateSafely(
  repository: StudioRepository | null,
  fixture: DataProduct,
): SafeStudioState {
  const fallback = (): SafeStudioState => ({
    dataProduct: structuredClone(fixture),
    execution: restoreExecutionState(fixture.appSpec, [], []),
    auditRecords: [],
    queryRecords: [],
    harnessTasks: [],
    notice: null,
    restored: false,
  });
  if (!repository) return fallback();
  try {
    const saved = repository.load();
    if (!saved) return fallback();
    const execution = restoreExecutionState(saved.appSpec, saved.changeHistory, saved.appliedChangeSetIds);
    let recoverySequence = 0;
    const recoveryClock: HarnessTaskClock = {
      now: () => new Date(),
      id: () => `harness_recovery_${Date.now()}_${++recoverySequence}`,
    };
    return {
      dataProduct: { ...saved.dataProduct, appSpec: execution.present },
      execution,
      auditRecords: saved.auditRecords,
      queryRecords: saved.queryRecords,
      harnessTasks: recoverHarnessTasksAfterRefresh(saved.harnessTasks, recoveryClock),
      notice: "已恢复上次保存在此浏览器中的工作台状态。",
      restored: true,
    };
  } catch (error) {
    const state = fallback();
    return {
      ...state,
      notice: `本地数据损坏或版本不兼容，已回退到安全演示数据。${error instanceof Error ? ` ${error.message}` : ""}`,
    };
  }
}

export function createStudioSnapshot(
  dataProduct: DataProduct,
  execution: ChangeSetExecutionState,
  auditRecords: ChangeSetAuditRecord[],
  queryRecords: QueryExecutionRecord[],
  harnessTasks: HarnessTaskSummary[] = [],
): StudioPersistedState {
  return parseStudioPersistedState({
    version: STUDIO_STORAGE_VERSION,
    dataProduct: { ...dataProduct, appSpec: execution.present },
    appSpec: execution.present,
    changeHistory: execution.history,
    appliedChangeSetIds: execution.appliedChangeSetIds,
    auditRecords,
    queryRecords,
    harnessTasks,
    savedAt: new Date().toISOString(),
  });
}

export function restoreDemoData(repository: StudioRepository | null, fixture: DataProduct): SafeStudioState {
  repository?.clear();
  return {
    dataProduct: structuredClone(fixture),
    execution: restoreExecutionState(fixture.appSpec, [], []),
    auditRecords: [],
    queryRecords: [],
    harnessTasks: [],
    notice: "已恢复安全演示数据。",
    restored: false,
  };
}
