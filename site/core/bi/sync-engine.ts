import type { DataRow, DataSourceDefinition, DataValue, LocalDataRuntime } from "@/core/models/data-binding";
import { dataSourceDefinitionSchema } from "@/core/schemas/data-binding";
import { BI_SYNC_LIMITS, type BiConnectionCheck, type BiConnector, type BiDeltaPull, type BiPullResult } from "./contracts";

export interface BiSyncRequest {
  connectionId: string;
  externalDatasetId: string;
  dataSourceId: string;
}

export interface BiSyncedDataset {
  connectionId: string;
  connectorKind: string;
  externalDatasetId: string;
  version: string;
  synchronizedAt: string;
  source: DataSourceDefinition;
  rows: DataRow[];
}

export type BiSyncResult =
  | { status: "updated"; mode: "snapshot" | "delta"; dataset: BiSyncedDataset }
  | { status: "unchanged"; checkedAt: string; dataset: BiSyncedDataset };

export class BiSyncValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BiSyncValidationError";
  }
}

function cloneDataset(dataset: BiSyncedDataset): BiSyncedDataset {
  return structuredClone(dataset);
}

function requireText(value: string, label: string, maximum = 200): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum || /[\u0000-\u001f]/u.test(trimmed)) {
    throw new BiSyncValidationError(`${label}无效`);
  }
  return trimmed;
}

function requireIsoDate(value: string, label: string): string {
  const parsed = new Date(value);
  if (!value || !Number.isSafeInteger(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new BiSyncValidationError(`${label}必须是标准 UTC ISO 时间`);
  }
  return value;
}

function validateRows(source: DataSourceDefinition, rows: DataRow[]): void {
  if (rows.length > BI_SYNC_LIMITS.maxRows) throw new BiSyncValidationError(`BI 数据超过 ${BI_SYNC_LIMITS.maxRows} 行限制`);
  if (source.fields.length > BI_SYNC_LIMITS.maxColumns) throw new BiSyncValidationError(`BI 数据超过 ${BI_SYNC_LIMITS.maxColumns} 列限制`);
  if (rows.length * source.fields.length > BI_SYNC_LIMITS.maxCells) throw new BiSyncValidationError("BI 数据单次同步单元格数量超限");

  const fields = new Map(source.fields.map((field) => [field.name, field]));
  const issues: string[] = [];
  rows.forEach((row, rowIndex) => {
    const rowFields = Object.keys(row);
    if (rowFields.length !== fields.size || rowFields.some((field) => !fields.has(field))) {
      issues.push(`第 ${rowIndex + 1} 行字段集合与 BI 数据模型不一致`);
      return;
    }
    for (const field of source.fields) {
      const value = row[field.name];
      if (value === null) continue;
      const valid = field.type === "date"
        ? typeof value === "string" && !Number.isNaN(Date.parse(value))
        : field.type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : typeof value === field.type;
      if (!valid) issues.push(`第 ${rowIndex + 1} 行字段“${field.label}”类型应为 ${field.type}`);
      if (typeof value === "string" && value.length > BI_SYNC_LIMITS.maxCellChars) {
        issues.push(`第 ${rowIndex + 1} 行字段“${field.label}”文本过长`);
      }
      if (issues.length >= 10) break;
    }
  });
  if (issues.length) throw new BiSyncValidationError(`BI 数据校验失败：${issues.slice(0, 10).join("；")}`);
}

function primaryKey(value: DataValue, label: string): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new BiSyncValidationError(`${label}必须是非空字符串或有限数值`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new BiSyncValidationError(`${label}必须是有限数值`);
  if (typeof value === "string" && !value.trim()) throw new BiSyncValidationError(`${label}不能为空`);
  return `${typeof value}:${String(value)}`;
}

function applyDelta(current: BiSyncedDataset, delta: BiDeltaPull): DataRow[] {
  if (delta.baseVersion !== current.version) {
    throw new BiSyncValidationError(`BI 增量基线版本不匹配：期望 ${current.version}，收到 ${delta.baseVersion}`);
  }
  if (!current.source.fields.some((field) => field.name === delta.primaryKey)) {
    throw new BiSyncValidationError(`BI 增量主键字段不存在：${delta.primaryKey}`);
  }

  const rows = new Map<string, DataRow>();
  current.rows.forEach((row) => {
    const key = primaryKey(row[delta.primaryKey], `已有数据主键 ${delta.primaryKey}`);
    if (rows.has(key)) throw new BiSyncValidationError(`已有 BI 数据包含重复主键：${String(row[delta.primaryKey])}`);
    rows.set(key, structuredClone(row));
  });

  const deleted = new Set<string>();
  delta.deletedKeys.forEach((value) => {
    const key = primaryKey(value, `删除主键 ${delta.primaryKey}`);
    if (deleted.has(key)) throw new BiSyncValidationError(`BI 增量包含重复删除主键：${String(value)}`);
    deleted.add(key);
    rows.delete(key);
  });

  const upserts = new Set<string>();
  delta.upserts.forEach((row) => {
    const key = primaryKey(row[delta.primaryKey], `更新数据主键 ${delta.primaryKey}`);
    if (upserts.has(key)) throw new BiSyncValidationError(`BI 增量包含重复更新主键：${String(row[delta.primaryKey])}`);
    upserts.add(key);
    rows.set(key, structuredClone(row));
  });
  return [...rows.values()];
}

function checkedConnection(value: BiConnectionCheck): BiConnectionCheck {
  if (value.ok !== true) throw new BiSyncValidationError("BI 连接测试没有返回成功状态");
  requireText(value.serviceName, "BI 服务名称", 120);
  requireIsoDate(value.checkedAt, "BI 连接检查时间");
  if (value.latencyMs !== undefined && (!Number.isFinite(value.latencyMs) || value.latencyMs < 0)) {
    throw new BiSyncValidationError("BI 连接延迟无效");
  }
  return structuredClone(value);
}

export async function testBiConnection(connector: BiConnector, signal?: AbortSignal): Promise<BiConnectionCheck> {
  requireText(connector.kind, "BI 连接器类型", 80);
  return checkedConnection(await connector.testConnection(signal));
}

export class BiSyncEngine {
  private readonly datasets = new Map<string, BiSyncedDataset>();
  private readonly pending = new Map<string, Promise<BiSyncResult>>();

  get(dataSourceId: string): BiSyncedDataset | null {
    const current = this.datasets.get(dataSourceId);
    return current ? cloneDataset(current) : null;
  }

  runtime(dataSourceId: string): LocalDataRuntime {
    const current = this.datasets.get(dataSourceId);
    if (!current) throw new BiSyncValidationError(`BI 数据源不存在：${dataSourceId}`);
    return { rowsByDataSourceId: { [dataSourceId]: structuredClone(current.rows) } };
  }

  async synchronize(connector: BiConnector, request: BiSyncRequest, signal?: AbortSignal): Promise<BiSyncResult> {
    const dataSourceId = requireText(request.dataSourceId, "内部数据源标识", 160);
    if (!/^dataset_bi_[A-Za-z0-9_-]{8,149}$/u.test(dataSourceId)) {
      throw new BiSyncValidationError("内部数据源标识必须以 dataset_bi_ 开头并使用安全字符");
    }
    requireText(request.connectionId, "BI 连接标识", 120);
    requireText(request.externalDatasetId, "BI 外部数据集标识");
    requireText(connector.kind, "BI 连接器类型", 80);

    const previous = this.pending.get(dataSourceId) ?? Promise.resolve(null);
    const task = previous.catch(() => null).then(() => this.performSync(connector, { ...request, dataSourceId }, signal));
    this.pending.set(dataSourceId, task);
    try {
      return await task;
    } finally {
      if (this.pending.get(dataSourceId) === task) this.pending.delete(dataSourceId);
    }
  }

  private async performSync(connector: BiConnector, request: BiSyncRequest, signal?: AbortSignal): Promise<BiSyncResult> {
    const current = this.datasets.get(request.dataSourceId);
    if (current && (
      current.connectionId !== request.connectionId
      || current.externalDatasetId !== request.externalDatasetId
      || current.connectorKind !== connector.kind
    )) {
      throw new BiSyncValidationError("同一内部数据源不能切换到其他 BI 连接或外部数据集");
    }

    const pulled = await connector.pullDataset({
      externalDatasetId: request.externalDatasetId,
      previousVersion: current?.version ?? null,
      signal,
    });
    return this.acceptPull(connector, request, pulled, current);
  }

  private acceptPull(
    connector: BiConnector,
    request: BiSyncRequest,
    pulled: BiPullResult,
    current: BiSyncedDataset | undefined,
  ): BiSyncResult {
    if (pulled.status === "not-modified") {
      if (!current) throw new BiSyncValidationError("BI 首次同步不能返回未变化状态");
      const checkedAt = requireIsoDate(pulled.checkedAt, "BI 检查时间");
      return { status: "unchanged", checkedAt, dataset: cloneDataset(current) };
    }

    const observedAt = requireIsoDate(pulled.observedAt, "BI 数据观察时间");
    const version = requireText(pulled.version, "BI 数据版本", 200);
    if (current && version === current.version) {
      throw new BiSyncValidationError("BI 返回了已存在版本；无变化时应返回 not-modified");
    }

    let source: DataSourceDefinition;
    let rows: DataRow[];
    if (pulled.status === "snapshot") {
      rows = structuredClone(pulled.rows);
      source = dataSourceDefinitionSchema.parse({
        id: request.dataSourceId,
        name: requireText(pulled.datasetName, "BI 数据集名称", 200),
        rowCount: rows.length,
        columnCount: pulled.fields.length,
        qualityScore: pulled.qualityScore ?? 100,
        updatedAt: observedAt,
        sourceType: "bi",
        fields: pulled.fields,
      });
    } else {
      if (!current) throw new BiSyncValidationError("BI 首次同步必须返回完整快照");
      rows = applyDelta(current, pulled);
      source = dataSourceDefinitionSchema.parse({
        ...current.source,
        rowCount: rows.length,
        updatedAt: observedAt,
      });
    }
    validateRows(source, rows);

    const dataset: BiSyncedDataset = {
      connectionId: request.connectionId,
      connectorKind: connector.kind,
      externalDatasetId: request.externalDatasetId,
      version,
      synchronizedAt: observedAt,
      source,
      rows,
    };
    this.datasets.set(request.dataSourceId, cloneDataset(dataset));
    return { status: "updated", mode: pulled.status, dataset: cloneDataset(dataset) };
  }
}
