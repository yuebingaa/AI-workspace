import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface SnapshotSchema<T> {
  parse(value: unknown): T;
}

export interface SnapshotAdapter<T> {
  readonly mode: "json-file";
  load(): T | null;
  save(snapshot: T): void;
  backup(now?: Date): string | null;
  restore(backupPath: string): T;
  describe(): { mode: "json-file"; configured: true; snapshotExists: boolean };
}

export interface JsonFileSnapshotOptions<T> {
  rootDirectory: string;
  fileName: string;
  schema: SnapshotSchema<T>;
  maxBytes?: number;
}

function safeRoot(rootDirectory: string): string {
  const root = resolve(rootDirectory.trim());
  if (!rootDirectory.trim() || !isAbsolute(root) || root.length < 4 || /[\u0000-\u001f]/u.test(root)) {
    throw new Error("本地持久化目录必须是有效的绝对路径");
  }
  return root;
}

function safeFileName(fileName: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,80}\.json$/u.test(fileName) || fileName.includes("..")) {
    throw new Error("本地持久化文件名不合法");
  }
  return fileName;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const windowsRenameRetryDelaysMs = [10, 25, 50] as const;
const transientWindowsRenameCodes = new Set(["EPERM", "EACCES", "EBUSY"]);
const renameRetrySignal = new Int32Array(new SharedArrayBuffer(4));

function waitSynchronously(delayMs: number): void {
  Atomics.wait(renameRetrySignal, 0, 0, delayMs);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

export function renameSnapshotWithRetry(
  source: string,
  destination: string,
  options: {
    platform?: NodeJS.Platform;
    rename?: typeof renameSync;
    wait?: (delayMs: number) => void;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  const rename = options.rename ?? renameSync;
  const wait = options.wait ?? waitSynchronously;

  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      const retryDelay = windowsRenameRetryDelaysMs[attempt];
      if (platform !== "win32" || retryDelay === undefined || !transientWindowsRenameCodes.has(errorCode(error) ?? "")) {
        throw error;
      }
      wait(retryDelay);
    }
  }
}

export class JsonFileSnapshotAdapter<T> implements SnapshotAdapter<T> {
  readonly mode = "json-file" as const;
  private readonly root: string;
  private readonly path: string;
  private readonly lockPath: string;
  private readonly maxBytes: number;
  private lastSeenFingerprint: string | null | undefined;

  constructor(private readonly options: JsonFileSnapshotOptions<T>) {
    this.root = safeRoot(options.rootDirectory);
    this.path = join(this.root, safeFileName(options.fileName));
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new Error("本地持久化大小限制必须是正整数");
    this.lockPath = `${this.path}.lock`;
  }

  load(): T | null {
    if (!existsSync(this.path)) {
      this.lastSeenFingerprint = null;
      return null;
    }
    const serialized = this.readValidatedFile(this.path, "快照");
    try {
      const parsed = this.options.schema.parse(JSON.parse(serialized) as unknown);
      this.lastSeenFingerprint = this.fingerprint(serialized);
      return parsed;
    } catch (error) {
      throw new Error(`本地持久化快照校验失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  save(snapshot: T): void {
    const parsed = this.options.schema.parse(snapshot);
    const serialized = JSON.stringify(parsed);
    if (Buffer.byteLength(serialized) > this.maxBytes) throw new Error("本地持久化快照超过大小限制");
    this.withWriteLock(() => {
      const currentFingerprint = existsSync(this.path)
        ? this.fingerprint(this.readValidatedFile(this.path, "快照"))
        : null;
      if (this.lastSeenFingerprint === undefined && currentFingerprint !== null) {
        throw new Error("本地持久化保存前必须先加载现有快照");
      }
      if (this.lastSeenFingerprint !== undefined && currentFingerprint !== this.lastSeenFingerprint) {
        throw new Error("本地持久化快照已被其他进程修改，拒绝覆盖较新数据");
      }

      this.writeSerializedSnapshot(serialized);
    });
  }

  backup(now = new Date()): string | null {
    if (!existsSync(this.path)) return null;
    return this.withWriteLock(() => {
      const serialized = this.readValidatedFile(this.path, "快照");
      this.options.schema.parse(JSON.parse(serialized) as unknown);
      this.lastSeenFingerprint = this.fingerprint(serialized);
      const suffix = now.toISOString().replace(/[:.]/gu, "-");
      const backupPath = join(this.root, `${this.options.fileName}.backup-${suffix}-${randomUUID()}`);
      this.writeNewPrivateFile(backupPath, serialized);
      return backupPath;
    });
  }

  restore(backupPath: string): T {
    const resolvedBackup = resolve(backupPath);
    const relation = relative(this.root, resolvedBackup);
    const expectedBackupName = new RegExp(
      `^${escapeRegularExpression(this.options.fileName)}\\.backup-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
      "iu",
    );
    if (
      !relation
      || relation.startsWith("..")
      || isAbsolute(relation)
      || dirname(resolvedBackup) !== this.root
      || !expectedBackupName.test(basename(resolvedBackup))
    ) {
      throw new Error("备份文件必须是当前持久化文件在同目录生成的备份");
    }
    return this.withWriteLock(() => {
      const serialized = this.readValidatedFile(resolvedBackup, "备份");
      let parsed: T;
      try {
        parsed = this.options.schema.parse(JSON.parse(serialized) as unknown);
      } catch (error) {
        throw new Error(`本地持久化备份校验失败：${error instanceof Error ? error.message : "未知错误"}`);
      }
      const normalized = JSON.stringify(parsed);
      if (Buffer.byteLength(normalized) > this.maxBytes) throw new Error("本地持久化备份超过大小限制");
      this.writeSerializedSnapshot(normalized);
      return parsed;
    });
  }

  describe() {
    return { mode: this.mode, configured: true as const, snapshotExists: existsSync(this.path) };
  }

  private fingerprint(serialized: string): string {
    return createHash("sha256").update(serialized, "utf8").digest("hex");
  }

  private readValidatedFile(path: string, label: "快照" | "备份"): string {
    const pathMetadata = lstatSync(path);
    if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) throw new Error(`本地持久化${label}必须是普通文件`);
    if (pathMetadata.size > this.maxBytes) throw new Error(`本地持久化${label}超过大小限制`);

    const descriptor = openSync(path, "r");
    try {
      const openedMetadata = fstatSync(descriptor);
      if (!openedMetadata.isFile()) throw new Error(`本地持久化${label}必须是普通文件`);
      if (openedMetadata.dev !== pathMetadata.dev || openedMetadata.ino !== pathMetadata.ino) {
        throw new Error(`本地持久化${label}在读取期间已被替换`);
      }
      if (openedMetadata.size > this.maxBytes) throw new Error(`本地持久化${label}超过大小限制`);

      const bytes = Buffer.allocUnsafe(openedMetadata.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
        if (count === 0) break;
        offset += count;
      }
      const extra = Buffer.allocUnsafe(1);
      if (readSync(descriptor, extra, 0, 1, null) > 0) throw new Error(`本地持久化${label}超过大小限制`);
      return bytes.subarray(0, offset).toString("utf8");
    } finally {
      closeSync(descriptor);
    }
  }

  private writeNewPrivateFile(path: string, serialized: string): void {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, "wx", 0o600);
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(path, { force: true });
      throw error;
    }
  }

  private writeSerializedSnapshot(serialized: string): void {
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSnapshotWithRetry(temporary, this.path);
      this.lastSeenFingerprint = this.fingerprint(serialized);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  private withWriteLock<R>(operation: () => R): R {
    mkdirSync(this.root, { recursive: true });
    let descriptor: number;
    try {
      descriptor = openSync(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error("本地持久化文件正被另一个进程写入；确认没有其他实例后再处理残留锁文件");
      }
      throw error;
    }
    try {
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), "utf8");
      fsyncSync(descriptor);
      return operation();
    } finally {
      closeSync(descriptor);
      rmSync(this.lockPath, { force: true });
    }
  }
}

export function configuredSnapshotAdapter<T>(fileName: string, schema: SnapshotSchema<T>, maxBytes?: number): SnapshotAdapter<T> | undefined {
  const rootDirectory = process.env.STUDIO_LOCAL_STATE_DIR?.trim();
  return rootDirectory ? new JsonFileSnapshotAdapter({ rootDirectory, fileName, schema, maxBytes }) : undefined;
}
