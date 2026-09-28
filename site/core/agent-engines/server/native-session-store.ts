import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/** Storage limits, not model context limits. Old generations are never silently evicted. */
export const DSH_NATIVE_SESSION_LIMITS = Object.freeze({
  conversations: 1_000, generations: 256, files: 128, depth: 8,
  fileBytes: 16 * 1024 * 1024, generationBytes: 32 * 1024 * 1024,
  storeBytes: 512 * 1024 * 1024, storeEntries: 50_000,
});

type FailureCode = "busy" | "invalid" | "capacity" | "unavailable" | "lease_closed";
const messages: Record<FailureCode, string> = {
  busy: "原生会话正在使用中；请等待任务结束。残留锁须在确认没有运行实例后处理。",
  invalid: "原生会话存储校验失败，未恢复历史。",
  capacity: "原生会话存储达到容量保护上限，未覆盖已保存历史。",
  unavailable: "原生会话存储不可用，未接受本轮恢复点。",
  lease_closed: "原生会话租约已结束或已提交，不能再次提交。",
};
export class DshNativeSessionStoreError extends Error {
  constructor(readonly code: FailureCode) { super(messages[code]); this.name = "DshNativeSessionStoreError"; }
}
function failure(code: FailureCode): never { throw new DshNativeSessionStoreError(code); }
function safeError(error: unknown): DshNativeSessionStoreError {
  return error instanceof DshNativeSessionStoreError ? error : new DshNativeSessionStoreError("unavailable");
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const epochPattern = new RegExp(`^${uuid}$`, "u");
const generationPattern = new RegExp(`^generation-${uuid}$`, "u");
const candidatePattern = new RegExp(`^(?:stage|generation)-${uuid}$`, "u");
const sessionPattern = new RegExp(`^agentcanvas-${uuid}$`, "u");
const hashPattern = /^[a-f0-9]{64}$/u;
const limits = DSH_NATIVE_SESSION_LIMITS;
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function boundedIdentity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > 4_096) failure("invalid");
}
function keyFor(namespace: string, conversationId: string, pageId: string): string {
  [namespace, conversationId, pageId].forEach(boundedIdentity);
  return hash(JSON.stringify([namespace, conversationId, pageId]));
}
function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
type Head = { generation: string; sessionId: string; digest: string; files: number; bytes: number };
type Manifest = { schemaVersion: 1; epoch: string; scopeHash: string | null; reason: "new" | "scope" | "clear"; head: Head | null };
function manifestFrom(value: unknown): Manifest {
  if (!exactKeys(value, ["schemaVersion", "epoch", "scopeHash", "reason", "head"])
    || value.schemaVersion !== 1 || typeof value.epoch !== "string" || !epochPattern.test(value.epoch)
    || (value.scopeHash !== null && (typeof value.scopeHash !== "string" || !hashPattern.test(value.scopeHash)))
    || !["new", "scope", "clear"].includes(String(value.reason))) failure("invalid");
  if (value.head !== null) {
    const head = value.head;
    if (!exactKeys(head, ["generation", "sessionId", "digest", "files", "bytes"])
      || typeof head.generation !== "string" || !generationPattern.test(head.generation)
      || typeof head.sessionId !== "string" || !sessionPattern.test(head.sessionId)
      || typeof head.digest !== "string" || !hashPattern.test(head.digest)
      || !Number.isSafeInteger(head.files) || Number(head.files) < 1 || Number(head.files) > limits.files
      || !Number.isSafeInteger(head.bytes) || Number(head.bytes) < 1 || Number(head.bytes) > limits.generationBytes
      || value.scopeHash === null) failure("invalid");
  }
  return value as Manifest;
}

/** Check every ancestor, including Windows junctions; do not follow linked parents. */
async function plainDirectory(path: string, create = false): Promise<void> {
  const volume = parse(path).root;
  let current = volume;
  for (const part of relative(volume, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (!create || !hasCode(error, "ENOENT")) throw error;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if (!hasCode(mkdirError, "EEXIST")) throw mkdirError; }
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) failure("invalid");
  }
}
async function readPlainFile(path: string, maxBytes: number): Promise<Buffer> {
  await plainDirectory(parse(path).dir);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) failure("invalid");
  if (before.size > maxBytes) failure("capacity");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) failure("invalid");
    // A bounded buffer also prevents a concurrently growing file from allocating without limit.
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.nlink !== 1) failure("invalid");
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
async function writeNewFile(path: string, bytes: Uint8Array): Promise<void> {
  await plainDirectory(parse(path).dir);
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}
type LockRelease = (() => Promise<void>) & { verify(): Promise<void> };
async function acquireLock(path: string): Promise<LockRelease> {
  await plainDirectory(parse(path).dir);
  const token = JSON.stringify({ pid: process.pid, token: randomUUID() });
  try { await writeNewFile(path, Buffer.from(token)); }
  catch (error) { if (hasCode(error, "EEXIST")) failure("busy"); throw error; }
  let released = false;
  const verify = async () => {
    if (released || (await readPlainFile(path, 512)).toString("utf8") !== token) failure("invalid");
  };
  return Object.assign(async () => {
    if (released) return;
    await verify();
    await unlink(path);
    released = true;
  }, { verify });
}
async function readManifest(slot: string): Promise<Manifest | null> {
  try { return manifestFrom(JSON.parse((await readPlainFile(join(slot, "head.json"), 2_048)).toString("utf8"))); }
  catch (error) { if (hasCode(error, "ENOENT")) return null; throw error; }
}
async function saveManifest(slot: string, manifest: Manifest, check?: () => void, verifyLock?: () => Promise<void>): Promise<void> {
  const target = join(slot, "head.json");
  const temporary = join(slot, `head-${randomUUID()}.tmp`);
  await writeNewFile(temporary, Buffer.from(JSON.stringify(manifest)));
  // Never delete the old head before rename. Failure leaves it fully recoverable.
  await plainDirectory(slot);
  try {
    const current = await lstat(target);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) failure("invalid");
  } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  await verifyLock?.();
  check?.();
  await rename(temporary, target);
}

type FileRow = { path: string; relative: string; size: number };
async function generationFiles(root: string): Promise<FileRow[]> {
  const files: FileRow[] = [];
  let bytes = 0;
  let entries = 0;
  async function walk(directory: string, depth: number) {
    if (depth > limits.depth) failure("capacity");
    await plainDirectory(directory);
    for (const name of (await readdir(directory)).sort()) {
      if (++entries > limits.files * 3 || name.length > 200 || /[\u0000-\u001f]/u.test(name)) failure("capacity");
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) failure("invalid");
      if (info.isDirectory()) { await walk(path, depth + 1); continue; }
      if (!info.isFile() || info.nlink !== 1 || !/\.jsonl(?:\.zstd)?$/u.test(name)) failure("invalid");
      bytes += info.size;
      if (info.size > limits.fileBytes || bytes > limits.generationBytes || files.length >= limits.files) failure("capacity");
      files.push({ path, relative: relative(root, path), size: info.size });
    }
  }
  await walk(root, 0);
  return files;
}
async function inspectGeneration(root: string, copyTo?: string): Promise<Pick<Head, "digest" | "files" | "bytes">> {
  const rows = await generationFiles(root);
  const digest = createHash("sha256");
  let bytes = 0;
  for (const row of rows) {
    const content = await readPlainFile(row.path, limits.fileBytes);
    if (content.length !== row.size) failure("invalid");
    digest.update(JSON.stringify([row.relative.split(sep).join("/"), content.length])).update("\0").update(content);
    bytes += content.length;
    if (copyTo) {
      const destination = join(copyTo, row.relative);
      await plainDirectory(parse(destination).dir, true);
      await writeNewFile(destination, content);
    }
  }
  if (!rows.length || !bytes) failure("invalid");
  return { digest: digest.digest("hex"), files: rows.length, bytes };
}
async function inspectCapacity(root: string): Promise<{ conversations: number; bytes: number }> {
  let bytes = 0;
  let entries = 0;
  let conversations = 0;
  async function walk(directory: string, depth: number) {
    if (depth > limits.depth + 2) failure("capacity");
    await plainDirectory(directory);
    for (const name of await readdir(directory)) {
      if (++entries > limits.storeEntries) failure("capacity");
      const path = join(directory, name);
      const info = await lstat(path);
      // Orphans are never recovery sources. Count their regular bytes without
      // following links; a malformed abandoned candidate must not poison a
      // different accepted head. Every selected generation is checked strictly.
      if (info.isSymbolicLink()) { if (depth === 0) failure("invalid"); continue; }
      if (info.isDirectory()) {
        if (depth === 0) {
          if (!hashPattern.test(name)) failure("invalid");
          if (++conversations > limits.conversations) failure("capacity");
        }
        await walk(path, depth + 1);
      } else {
        if (!info.isFile()) { if (depth === 0) failure("invalid"); continue; }
        bytes += info.size;
        if (bytes > limits.storeBytes) failure("capacity");
      }
    }
  }
  await walk(root, 0);
  return { conversations, bytes };
}

export interface DshNativeSessionLease {
  readonly sessionId: string;
  /** Private candidate containing only the SDK persistence backend's log tree. */
  readonly root: string;
  readonly mode: "create" | "resume";
  readonly continuity: "new" | "resumed" | "reset";
  commit(check?: () => void): Promise<void>;
  release(): Promise<void>;
}
export interface DshNativeSessionIdentity {
  namespace: string; conversationId: string; pageId: string; scopeFingerprint: string;
}

/**
 * One accepted JSONL generation per hashed conversation and scope. Failed stages,
 * superseded generations and interrupted locks remain private and are never
 * discovered as recovery candidates. This is not secure erasure or an OS quota.
 */
export class DshNativeSessionStore {
  private readonly directory: string;
  constructor(rootDirectory: string) {
    if (typeof rootDirectory !== "string" || !isAbsolute(rootDirectory)
      || /[\u0000-\u001f]/u.test(rootDirectory) || resolve(rootDirectory) === parse(resolve(rootDirectory)).root) failure("invalid");
    this.directory = resolve(rootDirectory);
  }
  private async catalog<T>(operation: () => Promise<T>): Promise<T> {
    await plainDirectory(this.directory, true);
    const unlock = await acquireLock(join(this.directory, ".catalog.lock"));
    try { return await operation(); }
    finally { await unlock(); }
  }
  async begin(input: DshNativeSessionIdentity): Promise<DshNativeSessionLease> {
    let unlock: LockRelease | undefined;
    try {
      const key = keyFor(input.namespace, input.conversationId, input.pageId);
      boundedIdentity(input.scopeFingerprint);
      const scopeHash = hash(input.scopeFingerprint);
      const slot = join(this.directory, key);
      return await this.catalog(async () => {
        const usage = await inspectCapacity(this.directory);
        try { await plainDirectory(slot); }
        catch (error) {
          if (!hasCode(error, "ENOENT")) throw error;
          if (usage.conversations >= limits.conversations) failure("capacity");
          await plainDirectory(slot, true);
        }
        unlock = await acquireLock(join(slot, ".lease.lock"));
        let manifest = await readManifest(slot);
        if (!manifest || manifest.scopeHash !== scopeHash) {
          manifest = { schemaVersion: 1, epoch: randomUUID(), scopeHash,
            reason: manifest ? (manifest.reason === "clear" && !manifest.head ? "clear" : "scope") : "new", head: null };
          // Scope transitions retire the old head even if the coming model turn fails.
          await saveManifest(slot, manifest);
        }
        const generations = (await readdir(slot)).filter((name) => candidatePattern.test(name));
        if (generations.length >= limits.generations) failure("capacity");
        if (usage.bytes + (manifest.head?.bytes ?? 0) + 4_096 > limits.storeBytes) failure("capacity");
        const candidateId = randomUUID();
        const root = join(slot, `stage-${candidateId}`);
        await plainDirectory(root, true);
        const previous = manifest.head;
        if (previous) {
          const copied = await inspectGeneration(join(slot, previous.generation), root);
          if (copied.digest !== previous.digest || copied.files !== previous.files || copied.bytes !== previous.bytes) failure("invalid");
        }
        const sessionId = previous?.sessionId ?? `agentcanvas-${randomUUID()}`;
        const expected = JSON.stringify(manifest);
        let state: "open" | "committing" | "committed" | "failed" | "released" = "open";
        let pendingCommit: Promise<void> | undefined;
        let pendingRelease: Promise<void> | undefined;
        const releaseLock = unlock;
        const lease: DshNativeSessionLease = {
          sessionId, root, mode: previous ? "resume" : "create",
          continuity: previous ? "resumed" : manifest.reason === "new" ? "new" : "reset",
          commit: (check) => {
            if (state !== "open") return Promise.reject(new DshNativeSessionStoreError("lease_closed"));
            state = "committing";
            pendingCommit = this.catalog(async () => {
              await releaseLock.verify();
              if (JSON.stringify(await readManifest(slot)) !== expected) failure("invalid");
              await inspectCapacity(this.directory);
              const inspected = await inspectGeneration(root);
              const generation = `generation-${candidateId}`;
              await plainDirectory(slot);
              await rename(root, join(slot, generation));
              await saveManifest(slot, { ...manifest, head: { generation, sessionId, ...inspected } }, check, releaseLock.verify);
              state = "committed";
            }).catch((error: unknown) => { state = "failed"; throw safeError(error); });
            return pendingCommit;
          },
          release: () => {
            if (pendingRelease) return pendingRelease;
            const waiting = pendingCommit;
            if (state === "open") state = "released";
            pendingRelease = (async () => {
              try { if (waiting) await waiting.catch(() => {}); await releaseLock(); }
              catch (error) { throw safeError(error); }
              finally { state = "released"; }
            })();
            return pendingRelease;
          },
        };
        return lease;
      });
    } catch (error) {
      if (unlock) { try { await unlock(); } catch { /* Retain an unverifiable lock; never steal it. */ } }
      throw safeError(error);
    }
  }
  async clear(namespace: string, conversationId: string, pageId: string): Promise<void> {
    try {
      const slot = join(this.directory, keyFor(namespace, conversationId, pageId));
      await this.catalog(async () => {
        // Clearing is permitted even at capacity; it does not scan or resurrect old generations.
        try { await plainDirectory(slot); }
        catch (error) { if (hasCode(error, "ENOENT")) return; throw error; }
        const unlock = await acquireLock(join(slot, ".lease.lock"));
        try {
          await readManifest(slot);
          await saveManifest(slot, { schemaVersion: 1, epoch: randomUUID(), scopeHash: null, reason: "clear", head: null });
        } finally { await unlock(); }
      });
    } catch (error) { throw safeError(error); }
  }
}

/** No configuration means no repository-local fallback and no filesystem access. */
export function configuredDshNativeSessionStore(): DshNativeSessionStore | undefined {
  const configured = process.env.STUDIO_LOCAL_STATE_DIR?.trim();
  if (!configured) return undefined;
  if (!isAbsolute(configured)) failure("invalid");
  return new DshNativeSessionStore(join(configured, "dsh-native-sessions"));
}
