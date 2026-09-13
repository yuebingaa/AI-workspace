import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeFileSync, fsyncSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { datasetUploadResponseSchema, type DatasetUploadResponse } from "@/core/datasets/contracts";
import { DatasetAiAccessPolicyConflictError, DatasetAiAccessRevokedError, type DatasetRepository } from "@/core/datasets/server/dataset-repository";
import type { OwnershipScope } from "@/core/identity/ownership";
import { JsonFileSnapshotAdapter, configuredSnapshotAdapter } from "@/core/persistence/server/json-file-snapshot";
import { loadStudioStateSafely, parseStudioPersistedState, type StudioPersistedState } from "@/core/repository/studio-repository";
import { PROJECT_FORMAT, PROJECT_LIMITS, projectManifestSchema, type ProjectManifest, type ProjectSession } from "../contracts";
import { projectDatasetReferences } from "../references";

export class ProjectError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "ProjectError"; }
}
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const manifestName = "agentcanvas.project.json";

/** Never accept UNC/device paths, drive roots or directory junctions as project scope. */
export function checkedProjectPath(input: string, allowMissingLeaf = false): string {
  if (!isAbsolute(input) || /[\u0000-\u001f]/u.test(input) || input.startsWith("\\\\") || input.length > 1_500) throw new ProjectError("请输入本机文件夹的完整绝对路径，不支持网络或设备路径");
  if (process.platform === "win32" && (!/^[A-Za-z]:[\\/]/u.test(input) || input.slice(2).includes(":"))) throw new ProjectError("请输入本机磁盘上的普通文件夹路径");
  const path = resolve(input);
  if (path === parse(path).root || path.toLowerCase() === resolve(homedir()).toLowerCase()) throw new ProjectError("请选择专用项目文件夹，不能选择磁盘根目录或用户主目录");
  const parts: string[] = [];
  for (let at = path; at !== dirname(at); at = dirname(at)) parts.unshift(at);
  parts.forEach((part) => {
    if (allowMissingLeaf && part === path && !existsSync(part)) return;
    if (!existsSync(part)) throw new ProjectError("父文件夹不存在，请先创建父文件夹");
    const stat = lstatSync(part);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ProjectError("项目路径不能经过符号链接、目录联接或普通文件");
  });
  return existsSync(path) ? realpathSync(path) : path;
}

export class LocalProjectStore {
  private readonly rootIdentity: { dev: number; ino: number };
  constructor(readonly root: string) { checkedProjectPath(root); const stat = lstatSync(root); this.rootIdentity = { dev: stat.dev, ino: stat.ino }; }
  private check() {
    checkedProjectPath(this.root);
    const stat = lstatSync(this.root);
    if (stat.dev !== this.rootIdentity.dev || stat.ino !== this.rootIdentity.ino) throw new ProjectError("项目文件夹已被替换，请重新打开项目", 409);
    for (const folder of ["tables", "files"]) checkedProjectPath(join(this.root, folder));
  }
  private adapter() {
    this.check();
    return new JsonFileSnapshotAdapter({ rootDirectory: this.root, fileName: manifestName, schema: projectManifestSchema, maxBytes: PROJECT_LIMITS.manifestBytes });
  }
  read(): ProjectManifest {
    const result = this.adapter().load();
    if (!result) throw new ProjectError("该文件夹不是 AgentCanvas 项目，缺少项目清单", 404);
    return result;
  }
  private edit<T>(change: (manifest: ProjectManifest) => T): T {
    const adapter = this.adapter();
    const manifest = adapter.load();
    if (!manifest) throw new ProjectError("项目清单不存在", 404);
    const result = change(manifest);
    manifest.updatedAt = new Date().toISOString();
    // Existing adapter performs atomic write, exclusive write lock and compare-before-replace.
    adapter.save(manifest);
    return result;
  }
  static create(input: string, name: string): LocalProjectStore {
    const root = checkedProjectPath(input, true);
    if (existsSync(root) && readdirSync(root).length) throw new ProjectError("新建项目需要空文件夹；已有项目请使用“打开项目”", 409);
    if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
    for (const folder of ["tables", "files"]) mkdirSync(join(root, folder), { mode: 0o700 });
    const store = new LocalProjectStore(root);
    const now = new Date().toISOString();
    const adapter = store.adapter();
    adapter.load();
    adapter.save({ format: PROJECT_FORMAT, id: randomUUID(), name, createdAt: now, updatedAt: now, stateRevision: 0, state: null, tables: [], files: [] });
    return store;
  }
  saveState(value: StudioPersistedState, expectedRevision: number): number {
    const state = parseStudioPersistedState(value);
    if (!loadStudioStateSafely({ load: () => state, save: () => {}, clear: () => {} }, state.dataProduct).restored) throw new ProjectError("工作台定义或变更历史校验失败，未覆盖已有项目", 409);
    return this.edit((manifest) => {
      if (manifest.stateRevision !== expectedRevision) throw new ProjectError("项目已被另一窗口修改，已保留当前未保存内容；请重新打开项目后再操作", 409);
      const live = new Map(manifest.tables.filter((table) => !table.deletedAt).map((table) => [table.descriptor.datasetId, table.descriptor]));
      for (const source of state.appSpec.dataSources) if (source.sourceType === "csv" && !live.has(source.id)) throw new ProjectError("项目定义引用了不存在或已移入回收站的数据，请刷新数据目录", 409);
      const known = new Set(state.appSpec.dataSources.map((source) => source.id));
      const references = [
        ...Object.values(state.dataProduct.notebooks ?? {}).flatMap((book) => book.cells.flatMap((cell) => cell.kind === "data" ? [cell.sourceDataSourceId] : [])),
        ...(state.dataProduct.semanticLayer?.models.map((model) => model.sourceDatasetId) ?? []),
        ...state.dataProduct.recipes.map((recipe) => recipe.sourceDatasetId),
      ];
      if (references.some((id) => !known.has(id))) throw new ProjectError("Notebook、语义模型或配方引用的数据不在当前项目中", 409);
      state.appSpec.dataSources = state.appSpec.dataSources.map((source) => live.get(source.id)?.source ?? source);
      state.dataProduct.appSpec = state.appSpec;
      state.dataProduct.datasets = state.dataProduct.datasets.map((entry) => {
        const descriptor = live.get(entry.id);
        return descriptor ? { ...entry, name: descriptor.source.name, ephemeral: false, expiresAt: undefined, shared: true } : entry;
      });
      manifest.state = state;
      manifest.stateRevision += 1;
      return manifest.stateRevision;
    });
  }
  private readBytes(folder: "tables" | "files", name: string, max: number): Buffer {
    this.check();
    if (basename(name) !== name || name.includes("..")) throw new ProjectError("项目文件路径无效");
    const path = join(this.root, folder, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new ProjectError("项目文件不是安全的普通文件或超过大小限制");
    const fd = openSync(path, "r");
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > max || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new ProjectError("项目文件在读取时发生变化", 409);
      // Bounded even if another process grows the file after stat().
      const bytes = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, length);
        if (!count) break;
        length += count;
      }
      if (length !== opened.size) throw new ProjectError("项目文件在读取时发生变化", 409);
      this.check(); return bytes.subarray(0, length);
    } finally { closeSync(fd); }
  }
  private writeBytes(folder: "tables" | "files", name: string, bytes: Buffer) {
    this.check();
    const fd = openSync(join(this.root, folder, name), "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    this.check();
  }
  getTable(id: string): DatasetUploadResponse | null {
    const entry = this.read().tables.find((table) => table.descriptor.datasetId === id && !table.deletedAt);
    if (!entry) return null;
    const bytes = this.readBytes("tables", entry.file, PROJECT_LIMITS.tableBytes);
    if (digest(bytes) !== entry.sha256) throw new ProjectError("数据表内容被外部修改，请重新导入；不会使用不匹配的数据", 409);
    const payload = datasetUploadResponseSchema.parse(JSON.parse(bytes.toString("utf8")));
    return datasetUploadResponseSchema.parse({ dataset: entry.descriptor, rows: payload.rows });
  }
  putTable(input: DatasetUploadResponse, kind: "table" | "result" = "table"): DatasetUploadResponse {
    const payload = datasetUploadResponseSchema.parse(input);
    payload.dataset.storageMode = "project";
    delete payload.dataset.expiresAt; delete payload.dataset.retentionMinutes;
    delete payload.dataset.source.expiresAt; payload.dataset.source.ephemeral = false;
    payload.dataset.persistenceNotice = "已保存到本地项目；重启后可读取，不按临时保留期过期。请定期备份整个项目文件夹。";
    const normalized = datasetUploadResponseSchema.parse(payload);
    const bytes = Buffer.from(JSON.stringify(normalized));
    if (bytes.length > PROJECT_LIMITS.tableBytes) throw new ProjectError("数据表超过 32 MiB 限制", 413);
    this.edit((manifest) => {
      if (manifest.tables.some((table) => table.descriptor.datasetId === normalized.dataset.datasetId)) throw new ProjectError("数据标识已存在，拒绝覆盖", 409);
      if (manifest.tables.length >= PROJECT_LIMITS.tables) throw new ProjectError("项目最多保存 50 张数据表（含回收站）", 409);
      const file = `table-${randomUUID()}.json`;
      const entry = { descriptor: normalized.dataset, file, bytes: bytes.length, sha256: digest(bytes), kind, savedAt: new Date().toISOString() };
      projectManifestSchema.parse({ ...manifest, tables: [...manifest.tables, entry] });
      this.writeBytes("tables", file, bytes);
      manifest.tables.push(entry);
    });
    return normalized;
  }
  renameTable(id: string, name: string) {
    this.edit((manifest) => {
      const table = manifest.tables.find((entry) => entry.descriptor.datasetId === id && !entry.deletedAt);
      if (!table) throw new ProjectError("数据表不存在", 404);
      table.descriptor.source.name = name;
    });
  }
  deleteTable(id: string): boolean {
    return this.edit((manifest) => {
      const table = manifest.tables.find((entry) => entry.descriptor.datasetId === id && !entry.deletedAt);
      if (!table) return false;
      const uses = projectDatasetReferences(manifest.state, id, table.descriptor.recipe);
      if (uses.length) throw new ProjectError(`数据仍被引用，未删除：${uses.join("；")}`, 409);
      table.deletedAt = new Date().toISOString();
      // Metadata-only cleanup is part of the same atomic archive operation. A crash before
      // the browser removes its reference must not leave the saved project unopenable.
      const state = manifest.state;
      if (state) {
        state.appSpec.dataSources = state.appSpec.dataSources.filter((source) => source.id !== id);
        state.dataProduct.appSpec = state.appSpec;
        state.dataProduct.datasets = state.dataProduct.datasets.filter((entry) => entry.id !== id);
        state.dataProduct.recipes = state.dataProduct.recipes.filter((entry) => entry.sourceDatasetId !== id);
        state.changeHistory.forEach((entry) => { entry.appSpec.dataSources = entry.appSpec.dataSources.filter((source) => source.id !== id); });
      }
      return true;
    });
  }
  restoreTable(id: string) {
    this.edit((manifest) => {
      const table = manifest.tables.find((entry) => entry.descriptor.datasetId === id && entry.deletedAt);
      if (!table) throw new ProjectError("回收站中没有该数据表", 404);
      delete table.deletedAt;
    });
    return this.getTable(id)!;
  }
  consent(id: string, policy: "masked" | "exclude-sensitive-samples") {
    return this.edit((manifest) => {
      const table = manifest.tables.find((entry) => entry.descriptor.datasetId === id && !entry.deletedAt);
      if (!table) throw new ProjectError("数据表不存在", 404);
      const descriptor = table.descriptor;
      if (descriptor.aiAccessPolicy === policy) return descriptor;
      if (descriptor.aiAccessPolicy !== "pending") throw new DatasetAiAccessPolicyConflictError("当前数据处理方式不能被重复请求改写");
      descriptor.aiAccessPolicy = policy; descriptor.source.aiAccessPolicy = policy;
      return descriptor;
    });
  }
  saveOriginal(name: string, bytes: Buffer, datasetId: string) {
    const extension = /\.xlsx$/iu.test(name) ? "xlsx" : /\.csv$/iu.test(name) ? "csv" : null;
    if (!extension || !bytes.length || bytes.length > PROJECT_LIMITS.fileBytes || /[\\/\u0000-\u001f]/u.test(name) || name.length > 255) throw new ProjectError("只接受不超过 10 MiB 的 CSV / XLSX 原始文件");
    if (extension === "xlsx" && bytes.subarray(0, 2).toString() !== "PK") throw new ProjectError("XLSX 文件格式无效");
    return this.edit((manifest) => {
      if (!manifest.tables.some((entry) => entry.descriptor.datasetId === datasetId && !entry.deletedAt)) throw new ProjectError("原始文件必须关联当前项目的数据表");
      const hash = digest(bytes);
      const existing = manifest.files.find((entry) => entry.sha256 === hash && entry.name === name);
      if (existing) { existing.datasetIds = [...new Set([...existing.datasetIds, datasetId])]; return existing; }
      const id = randomUUID();
      const entry = { id, name, file: `file-${id}.${extension}`, bytes: bytes.length, sha256: hash, datasetIds: [datasetId], savedAt: new Date().toISOString() };
      projectManifestSchema.parse({ ...manifest, files: [...manifest.files, entry] });
      this.writeBytes("files", entry.file, bytes);
      manifest.files.push(entry); return entry;
    });
  }
  getOriginal(id: string) {
    const entry = this.read().files.find((file) => file.id === id);
    if (!entry) throw new ProjectError("原始文件不存在", 404);
    const bytes = this.readBytes("files", entry.file, PROJECT_LIMITS.fileBytes);
    if (digest(bytes) !== entry.sha256) throw new ProjectError("原始文件校验失败", 409);
    return { entry, bytes };
  }
  datasets(ownership: OwnershipScope): DatasetRepository & { assertAiAccessPolicies: (owner: OwnershipScope, expected: ReadonlyArray<{ datasetId: string; policy: string }>) => void } {
    const checkOwner = (owner: OwnershipScope) => { if (owner.ownerId !== ownership.ownerId || owner.tenantId !== ownership.tenantId) throw new ProjectError("项目所有者不匹配", 403); };
    return {
      put: async (owner, value) => { checkOwner(owner); const saved = this.putTable(value); return { ownership: owner, descriptor: saved.dataset, rows: saved.rows }; },
      get: async (owner, id) => { checkOwner(owner); const saved = this.getTable(id); return saved ? { ownership: owner, descriptor: saved.dataset, rows: saved.rows } : null; },
      list: async (owner) => { checkOwner(owner); return this.read().tables.filter((table) => !table.deletedAt).map((table) => table.descriptor); },
      delete: async (owner, id) => { checkOwner(owner); return this.deleteTable(id); },
      setAiAccessPolicy: async (owner, id, policy) => { checkOwner(owner); return this.consent(id, policy); },
      assertAiAccessPolicies: (owner, expected) => {
        checkOwner(owner); const tables = this.read().tables;
        expected.forEach(({ datasetId, policy }) => {
          const current = tables.find((table) => table.descriptor.datasetId === datasetId && !table.deletedAt);
          if (!current || current.descriptor.aiAccessPolicy !== policy || policy === "pending") throw new DatasetAiAccessRevokedError(datasetId);
        });
      },
    };
  }
}

const indexSchema = z.object({ version: z.literal(1), entries: z.array(z.object({ handle: z.string().uuid(), path: z.string().max(2_000), name: z.string().max(100) }).strict()).max(100) }).strict();
function projectIndex() {
  const adapter = configuredSnapshotAdapter("local-projects.json", indexSchema, 512 * 1024);
  if (!adapter) throw new ProjectError("本地项目模式需要配置持久化运行目录，请通过 site:* 管理的本机网站使用", 503);
  return adapter;
}
const cache = globalThis as typeof globalThis & { __agentCanvasProjects?: Map<string, LocalProjectStore> };
const stores = cache.__agentCanvasProjects ??= new Map();
export function recentProjects() { return projectIndex().load()?.entries ?? []; }
export function openProject(input: string, createName?: string): ProjectSession {
  const index = projectIndex();
  const saved = index.load() ?? { version: 1 as const, entries: [] };
  if (saved.entries.length >= 100 && !saved.entries.some((entry) => entry.path.toLowerCase() === resolve(input).toLowerCase())) throw new ProjectError("最近项目数量达到 100 个上限");
  let path = input;
  if (createName && !path) {
    const documents = checkedProjectPath(join(homedir(), "Documents"), true);
    if (!existsSync(documents)) mkdirSync(documents, { mode: 0o700 });
    const parent = checkedProjectPath(join(documents, "AgentCanvas Projects"), true);
    if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
    path = join(parent, `project-${randomUUID().slice(0, 8)}`);
  }
  const root = checkedProjectPath(path, Boolean(createName));
  const store = createName ? LocalProjectStore.create(root, createName) : new LocalProjectStore(root);
  const manifest = store.read();
  const handle = saved.entries.find((entry) => entry.path.toLowerCase() === root.toLowerCase())?.handle ?? randomUUID();
  if (!saved.entries.some((entry) => entry.handle === handle) && saved.entries.length >= 100) throw new ProjectError("最近项目数量达到 100 个上限");
  saved.entries = [{ handle, path: root, name: manifest.name }, ...saved.entries.filter((entry) => entry.handle !== handle)];
  index.save(saved); stores.set(handle, store);
  return { handle, path: root, manifest };
}
export function projectByHandle(handle: string): LocalProjectStore {
  const entry = recentProjects().find((item) => item.handle === handle);
  if (!entry) throw new ProjectError("项目尚未打开，请先选择项目文件夹", 404);
  let store = stores.get(handle);
  if (!store) { store = new LocalProjectStore(checkedProjectPath(entry.path)); stores.set(handle, store); }
  return store;
}
