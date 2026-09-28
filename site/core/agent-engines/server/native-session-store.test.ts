import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { link, mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  configuredDshNativeSessionStore, DSH_NATIVE_SESSION_LIMITS,
  DshNativeSessionStore, type DshNativeSessionLease,
} from "./native-session-store";

const faults = vi.hoisted(() => ({ renameHead: false, beforeHead: undefined as (() => void) | undefined }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (String(args[1]).endsWith(`${sep}head.json`)) {
      faults.beforeHead?.();
      if (faults.renameHead) throw Object.assign(new Error("synthetic-private-path-and-secret"), { code: "EPERM" });
    }
    return actual.rename(...args);
  } };
});

let temporary: string;
let root: string;
let store: DshNativeSessionStore;
const leases: DshNativeSessionLease[] = [];
const identity = { namespace: "synthetic-namespace", conversationId: "synthetic-conversation", pageId: "synthetic-page", scopeFingerprint: "scope-one" };
function slotFor(input = identity): string {
  return join(root, createHash("sha256").update(JSON.stringify([input.namespace, input.conversationId, input.pageId])).digest("hex"));
}
async function begin(overrides: Partial<typeof identity> = {}, owner = store) {
  const lease = await owner.begin({ ...identity, ...overrides });
  leases.push(lease);
  return lease;
}
async function log(lease: DshNativeSessionLease, content = "{\"synthetic\":true}\n") {
  const path = join(lease.root, "project-hash", lease.sessionId, "log.v4.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return path;
}
async function head() { return JSON.parse(await readFile(join(slotFor(), "head.json"), "utf8")); }
async function accept(content = "{\"turn\":1}\n") {
  const lease = await begin();
  await log(lease, content);
  await lease.commit();
  await lease.release();
  return lease;
}
beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "agentcanvas-native-store-test-"));
  root = join(temporary, "state");
  store = new DshNativeSessionStore(root);
  faults.renameHead = false;
  faults.beforeHead = undefined;
});
afterEach(async () => {
  for (const lease of leases.splice(0)) await lease.release().catch(() => {});
  faults.renameHead = false;
  faults.beforeHead = undefined;
  vi.unstubAllEnvs();
  // Only this test's freshly allocated directory is eligible for recursive cleanup.
  const suffix = relative(resolve(tmpdir()), resolve(temporary));
  if (suffix.startsWith("agentcanvas-native-store-test-") && !suffix.includes(sep)) {
    await rm(temporary, { recursive: true, force: true });
  }
});

describe("DSH native accepted-session store", () => {
  it("creates no fallback directory when local state is unconfigured", () => {
    vi.stubEnv("STUDIO_LOCAL_STATE_DIR", "");
    expect(configuredDshNativeSessionStore()).toBeUndefined();
    vi.stubEnv("STUDIO_LOCAL_STATE_DIR", "relative-state");
    expect(() => configuredDshNativeSessionStore()).toThrow("校验失败");
  });

  it("locates configured storage in its dedicated child directory", async () => {
    vi.stubEnv("STUDIO_LOCAL_STATE_DIR", temporary);
    const configured = configuredDshNativeSessionStore()!;
    const lease = await begin({}, configured);
    expect(lease.root.startsWith(join(temporary, "dsh-native-sessions") + sep)).toBe(true);
    expect(await readdir(temporary)).toEqual(["dsh-native-sessions"]);
  });

  it("copies the accepted official log tree into an independent candidate and preserves its session id", async () => {
    const first = await accept();
    const previous = await head();
    const second = await begin({}, new DshNativeSessionStore(root));
    expect(second).toMatchObject({ sessionId: first.sessionId, mode: "resume", continuity: "resumed" });
    expect(second.root).not.toBe(first.root);
    const candidate = join(second.root, "project-hash", second.sessionId, "log.v4.jsonl");
    expect(await readFile(candidate, "utf8")).toContain('"turn":1');
    await writeFile(candidate, '{"turn":2}\n', "utf8");
    expect(await readFile(join(slotFor(), previous.head.generation, "project-hash", first.sessionId, "log.v4.jsonl"), "utf8"))
      .toContain('"turn":1');
    await second.commit();
    expect((await head()).head.generation).not.toBe(previous.head.generation);
    expect((await head()).head.sessionId).toBe(first.sessionId);
  });

  it("never resumes an uncommitted candidate, including after a new store instance", async () => {
    const failed = await begin();
    expect(failed).toMatchObject({ mode: "create", continuity: "new" });
    await log(failed, '{"unaccepted":true}\n');
    await failed.release();
    const next = await begin({}, new DshNativeSessionStore(root));
    expect(next.mode).toBe("create");
    expect(next.sessionId).not.toBe(failed.sessionId);
    expect(await readdir(next.root)).toEqual([]);
  });

  it("keeps an accepted head when a later same-scope candidate fails", async () => {
    const first = await accept();
    const previous = await head();
    const failed = await begin();
    await log(failed, '{"unaccepted":true}\n');
    await failed.release();
    expect(await head()).toEqual(previous);
    const resumed = await begin();
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(await readFile(join(resumed.root, "project-hash", first.sessionId, "log.v4.jsonl"), "utf8")).toContain('"turn":1');
  });

  it("retires the old scope before running and never resurrects it after a failed scope change", async () => {
    const first = await accept();
    const changed = await begin({ scopeFingerprint: "scope-two" });
    expect(changed).toMatchObject({ mode: "create", continuity: "reset" });
    expect(changed.sessionId).not.toBe(first.sessionId);
    expect(await readdir(changed.root)).toEqual([]);
    expect((await head()).head).toBeNull();
    await changed.release();
    const restoredScope = await begin();
    expect(restoredScope).toMatchObject({ mode: "create", continuity: "reset" });
    expect(restoredScope.sessionId).not.toBe(first.sessionId);
  });

  it("clear atomically invalidates the head but leaves private old logs out of recovery", async () => {
    const first = await accept();
    const previous = await head();
    await store.clear(identity.namespace, identity.conversationId, identity.pageId);
    expect((await head()).head).toBeNull();
    expect(await readdir(slotFor())).toContain(previous.head.generation);
    const next = await begin();
    expect(next).toMatchObject({ mode: "create", continuity: "reset" });
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(await readdir(next.root)).toEqual([]);
  });

  it("rejects overlapping begin and clear across independent store instances", async () => {
    const active = await begin();
    const other = new DshNativeSessionStore(root);
    await expect(other.begin(identity)).rejects.toMatchObject({ code: "busy" });
    await expect(other.clear(identity.namespace, identity.conversationId, identity.pageId)).rejects.toMatchObject({ code: "busy" });
    const independent = await begin({ conversationId: "another-conversation" }, other);
    expect(independent.sessionId).not.toBe(active.sessionId);
  });

  it("observes a lease lock held by another Node process", async () => {
    const first = await begin();
    await first.release();
    const lock = join(slotFor(), ".lease.lock");
    const child = spawn(process.execPath, ["-e", "const fs=require('node:fs'); const path=process.argv[1]; fs.writeFileSync(path, 'external-owner', {flag:'wx'}); process.stdout.write('locked'); process.stdin.resume(); process.stdin.once('data',()=>{fs.unlinkSync(path);process.exit(0)});", lock], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    try {
      await new Promise<void>((done, reject) => {
        child.stdout.once("data", () => done());
        child.once("error", reject);
        child.once("exit", (code) => { if (code) reject(new Error("synthetic child failed")); });
      });
      await expect(store.begin(identity)).rejects.toMatchObject({ code: "busy" });
    } finally {
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      child.stdin.end("release");
      await exited;
    }
  });

  it("isolates namespace, conversation, and page without persisting their raw names", async () => {
    const first = await accept();
    for (const variation of [{ namespace: "private-user-name" }, { pageId: "private-project-name" }, { conversationId: "private-conversation-name" }]) {
      const next = await begin(variation);
      expect(next).toMatchObject({ mode: "create", continuity: "new" });
      expect(next.sessionId).not.toBe(first.sessionId);
      expect(next.root).not.toMatch(/private-|synthetic-/u);
      const manifest = await readFile(join(dirname(next.root), "head.json"), "utf8");
      expect(manifest).not.toMatch(/private-|synthetic-|scope-one/u);
    }
  });

  it("hashes hostile identity strings and rejects traversal in a stored head", async () => {
    const next = await begin({ conversationId: "../../outside", pageId: "..\\outside" });
    expect(relative(root, next.root)).not.toContain("..");
    await next.release();
    await accept();
    const corrupt = await head();
    corrupt.head.generation = "../../outside";
    await writeFile(join(slotFor(), "head.json"), JSON.stringify(corrupt));
    await expect(begin()).rejects.toMatchObject({ code: "invalid" });
  });

  it("keeps the original head recoverable when atomic manifest rename fails", async () => {
    const first = await accept();
    const previous = await head();
    const next = await begin();
    await log(next, '{"turn":2}\n');
    faults.renameHead = true;
    await expect(next.commit()).rejects.toThrow("存储不可用");
    expect(await head()).toEqual(previous);
    await expect(next.commit()).rejects.toMatchObject({ code: "lease_closed" });
    await next.release();
    faults.renameHead = false;
    expect((await begin()).sessionId).toBe(first.sessionId);
  });

  it("runs authorization immediately before the head rename and preserves the old head on refusal", async () => {
    await accept();
    const previous = await head();
    const next = await begin();
    await log(next, '{"turn":2}\n');
    const check = vi.fn(() => { throw new Error("synthetic-private-revocation"); });
    let headRenames = 0;
    faults.beforeHead = () => { headRenames++; };
    await expect(next.commit(check)).rejects.toThrow("存储不可用");
    expect(check).toHaveBeenCalledOnce();
    expect(headRenames).toBe(0);
    expect(await head()).toEqual(previous);
  });

  it("runs the final authorization check once on successful commits", async () => {
    const next = await begin();
    await log(next);
    const check = vi.fn();
    faults.beforeHead = () => expect(check).toHaveBeenCalledOnce();
    await next.commit(check);
    expect(check).toHaveBeenCalledOnce();
  });

  it("refuses duplicate, concurrent, or released commits while release stays idempotent", async () => {
    const next = await begin();
    await log(next);
    const pending = next.commit();
    await expect(next.commit()).rejects.toMatchObject({ code: "lease_closed" });
    await pending;
    await expect(next.commit()).rejects.toMatchObject({ code: "lease_closed" });
    await next.release();
    await next.release();
    const cancelled = await begin();
    await cancelled.release();
    await expect(cancelled.commit()).rejects.toMatchObject({ code: "lease_closed" });
  });

  it("waits for an in-progress commit before releasing its lock", async () => {
    const next = await begin();
    await log(next);
    await Promise.all([next.commit(), next.release()]);
    expect((await begin()).mode).toBe("resume");
  });

  it("refuses empty candidates and non-log configuration files", async () => {
    const empty = await begin();
    await expect(empty.commit()).rejects.toMatchObject({ code: "invalid" });
    await empty.release();
    const config = await begin();
    await log(config);
    await writeFile(join(config.root, "model-config.json"), '{"apiKey":"synthetic"}');
    await expect(config.commit()).rejects.toMatchObject({ code: "invalid" });
    expect((await head()).head).toBeNull();
  });

  it("detects modified accepted logs instead of silently resuming corrupt history", async () => {
    const first = await accept();
    const previous = await head();
    await writeFile(join(slotFor(), previous.head.generation, "project-hash", first.sessionId, "log.v4.jsonl"), '{"edited":true}\n');
    await expect(begin()).rejects.toMatchObject({ code: "invalid" });
    expect(await head()).toEqual(previous);
  });

  it("rejects junctions at the configured root, accepted logs, and candidate subdirectories", async () => {
    const outside = join(temporary, "outside");
    await mkdir(outside);
    const linked = join(temporary, "linked");
    await symlink(outside, linked, "junction");
    await expect(new DshNativeSessionStore(join(linked, "nested")).begin(identity)).rejects.toMatchObject({ code: "invalid" });
    expect(await readdir(outside)).toEqual([]);
    const next = await begin();
    await symlink(outside, join(next.root, "linked"), "junction");
    await expect(next.commit()).rejects.toMatchObject({ code: "invalid" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("does not let a rejected linked candidate poison the previously accepted head", async () => {
    const first = await accept();
    const failed = await begin();
    const outside = join(temporary, "outside");
    await mkdir(outside);
    await symlink(outside, join(failed.root, "linked"), "junction");
    await expect(failed.commit()).rejects.toMatchObject({ code: "invalid" });
    await failed.release();
    expect((await begin()).sessionId).toBe(first.sessionId);
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses hard-linked candidate logs without modifying the external file", async () => {
    const next = await begin();
    const external = join(temporary, "external.jsonl");
    await writeFile(external, "{\"external\":true}\n");
    await link(external, join(next.root, "linked.jsonl"));
    await expect(next.commit()).rejects.toMatchObject({ code: "invalid" });
    expect(await readFile(external, "utf8")).toBe("{\"external\":true}\n");
  });

  it("checks file and aggregate candidate byte limits before reading candidate content", async () => {
    const next = await begin();
    const path = await log(next);
    const handle = await open(path, "r+");
    try { await handle.truncate(DSH_NATIVE_SESSION_LIMITS.fileBytes + 1); }
    finally { await handle.close(); }
    await expect(next.commit()).rejects.toMatchObject({ code: "capacity" });
    expect((await head()).head).toBeNull();
  });

  it("retains recovery after rejecting an oversized candidate within the overall store allowance", async () => {
    const first = await accept();
    const failed = await begin();
    const path = await log(failed);
    const handle = await open(path, "r+");
    try { await handle.truncate(DSH_NATIVE_SESSION_LIMITS.fileBytes + 1); }
    finally { await handle.close(); }
    await expect(failed.commit()).rejects.toMatchObject({ code: "capacity" });
    await failed.release();
    expect((await begin()).sessionId).toBe(first.sessionId);
  });

  it("protects the aggregate generation byte limit even when each file is permitted", async () => {
    const next = await begin();
    for (let index = 0; index < 3; index++) {
      const handle = await open(join(next.root, `synthetic-${index}.jsonl`), "wx");
      try { await handle.truncate(DSH_NATIVE_SESSION_LIMITS.fileBytes); }
      finally { await handle.close(); }
    }
    await expect(next.commit()).rejects.toMatchObject({ code: "capacity" });
  });

  it("bounds candidate file counts", async () => {
    const next = await begin();
    await Promise.all(Array.from({ length: DSH_NATIVE_SESSION_LIMITS.files + 1 }, (_, index) =>
      writeFile(join(next.root, `${index}.jsonl`), "{}\n")));
    await expect(next.commit()).rejects.toMatchObject({ code: "capacity" });
  });

  it("rejects generation exhaustion without deleting any existing generation", async () => {
    const first = await begin();
    await first.release();
    const names = Array.from({ length: DSH_NATIVE_SESSION_LIMITS.generations - 1 }, () => `stage-${randomUUID()}`);
    await Promise.all(names.map((name) => mkdir(join(slotFor(), name))));
    await expect(begin()).rejects.toMatchObject({ code: "capacity" });
    expect((await readdir(slotFor())).filter((name) => name.startsWith("stage-")).length).toBe(DSH_NATIVE_SESSION_LIMITS.generations);
  });

  it("refuses lost lock ownership without unlinking the other owner's lock or accepted head", async () => {
    const next = await begin();
    await log(next);
    await next.commit();
    const previous = await head();
    await writeFile(join(slotFor(), ".lease.lock"), "foreign-owner");
    await expect(next.release()).rejects.toMatchObject({ code: "invalid" });
    expect(await readFile(join(slotFor(), ".lease.lock"), "utf8")).toBe("foreign-owner");
    expect(await head()).toEqual(previous);
  });

  it("refuses a candidate commit after its lease lock ownership is lost", async () => {
    await accept();
    const previous = await head();
    const next = await begin();
    await log(next, '{"turn":2}\n');
    await writeFile(join(slotFor(), ".lease.lock"), "foreign-owner");
    await expect(next.commit()).rejects.toMatchObject({ code: "invalid" });
    expect(await head()).toEqual(previous);
  });

  it("does not expose root paths, raw identities, or nested filesystem errors", async () => {
    const next = await begin();
    await log(next);
    faults.renameHead = true;
    const error = await next.commit().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(temporary);
    expect(String(error)).not.toContain("synthetic-private-path-and-secret");
    expect(String(error)).not.toContain(identity.conversationId);
  });
});
