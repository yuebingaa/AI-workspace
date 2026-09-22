import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, unlink, rmdir } from "node:fs/promises";
import { OWNER_KIND, CORE_TABLES, parseArguments, validateOwner, parsePostmasterPid, childEnvironment, readerGrantSql, assertPortablePath, run } from "./adventureworks.mjs";

const fixtureRoot = path.join(path.parse(process.cwd()).root, "agentcanvas-test-fixtures");
const runtimeDir = path.join(fixtureRoot, "fixture-exclusive-pg-runtime");
const binDir = path.join(fixtureRoot, "fixture-pg-bin");
const id = "11111111-2222-4333-8444-555555555555";
const owner = () => ({ kind: OWNER_KIND, id, runtimeDir, dataDir: path.join(runtimeDir, "data"), binDir,
  host: "127.0.0.1", port: 55432, database: "agentcanvas_adventureworks", adminUser: "agentcanvas_aw_owner",
  readerUser: "agentcanvas_aw_reader", clusterName: `agentcanvas_aw_${id.replaceAll("-", "")}` });

test("lifecycle commands require explicit absolute owned runtime paths", () => {
  assert.deepEqual(parseArguments(["status", "--runtime-dir", runtimeDir]), { command: "status", "runtime-dir": runtimeDir });
  for (const args of [[], ["destroy"], ["setup"], ["status", "--runtime-dir", "relative"],
    ["stop", "--runtime-dir", path.parse(runtimeDir).root], ["status", "--runtime-dir", runtimeDir, "--port", "55432"],
    ["status", "--runtime-dir", runtimeDir, "--runtime-dir", runtimeDir]]) assert.throws(() => parseArguments(args));
});

test("setup cannot use implicit, default database, website, or invalid ports", () => {
  const args = ["setup", "--runtime-dir", runtimeDir, "--bin-dir", binDir];
  for (const port of [undefined, "3000", "3001", "3198", "5432", "0", "65536", "x", "5432;echo"]) {
    assert.throws(() => parseArguments([...args, ...(port ? ["--port", port] : [])]));
  }
  assert.equal(parseArguments([...args, "--port", "55432"]).port, 55432);
});

test("portable setup rejects non-ASCII binary and runtime paths before invoking initdb", () => {
  const unicodePath = path.join(fixtureRoot, "晚间运行");
  const options = ["--port", "55432"];
  assert.throws(() => parseArguments(["setup", "--runtime-dir", runtimeDir, "--bin-dir", unicodePath, ...options]), /bin-dir must use an ASCII-only path/);
  assert.throws(() => parseArguments(["setup", "--runtime-dir", unicodePath, "--bin-dir", binDir, ...options]), /runtime-dir must use an ASCII-only path/);
  assert.throws(() => assertPortablePath(unicodePath, "Resolved bin-dir"), /does not apply to the website/);
  assert.doesNotThrow(() => assertPortablePath(path.join(fixtureRoot, "Program Files", "pgsql"), "bin-dir"));
  // The guard is intentionally scoped to the portable installation/runtime,
  // not the site workspace or downloaded SQL fixture paths.
  const actual = parseArguments(["setup", "--runtime-dir", runtimeDir, "--bin-dir", binDir, "--dump-dir", unicodePath, ...options]);
  assert.equal(actual["dump-dir"], unicodePath);
});

test("owner marker validation rejects unrelated directories, loopback aliases, role and cluster changes", () => {
  assert.equal(validateOwner(owner(), runtimeDir).id, id);
  for (const patch of [{ kind: "postgres" }, { runtimeDir: path.dirname(runtimeDir) }, { dataDir: path.dirname(runtimeDir) },
    { host: "localhost" }, { host: "0.0.0.0" }, { port: 3001 }, { port: "55432" }, { id: "x" },
    { binDir: "relative" }, { database: "production" }, { readerUser: "postgres" }, { clusterName: "another_cluster" }]) {
    assert.throws(() => validateOwner({ ...owner(), ...patch }, runtimeDir));
  }
});

test("postmaster PID must match the owned data path, explicit port, and IPv4 address", () => {
  const lines = ["42123", owner().dataDir, "1234567890", "55432", "", "127.0.0.1", "0", "ready"];
  assert.equal(parsePostmasterPid(lines.join("\n"), owner()), 42123);
  for (const [index, replacement] of [[0, "0"], [0, "xyz"], [1, binDir], [3, "5432"], [5, "*"], [5, "localhost"]]) {
    const modified = [...lines]; modified[index] = replacement;
    assert.throws(() => parsePostmasterPid(modified.join("\n"), owner()));
  }
});

test("child process environment cannot accidentally target inherited database services", () => {
  const previous = process.env.PGSERVICE;
  process.env.PGSERVICE = "unrelated-production-service";
  try {
    const actual = childEnvironment({ PGSSLMODE: "disable" });
    assert.equal(actual.PGSERVICE, undefined);
    assert.equal(actual.PGSSLMODE, "disable");
    assert.ok(Object.keys(actual).some((key) => key.toLowerCase() === "path"));
  } finally { if (previous === undefined) delete process.env.PGSERVICE; else process.env.PGSERVICE = previous; }
});

test("reader SQL grants only the ten selected business tables and keeps database restrictions", () => {
  const sql = readerGrantSql("a".repeat(64));
  assert.equal(CORE_TABLES.length, 10);
  assert.equal(new Set(CORE_TABLES).size, 10);
  assert.match(sql, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT/);
  assert.match(sql, /REVOKE ALL ON DATABASE agentcanvas_adventureworks FROM PUBLIC/);
  assert.match(sql, /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC/);
  assert.match(sql, /default_transaction_read_only = on/);
  assert.match(sql, /statement_timeout = '12s'/);
  const grant = sql.split("\n").find((line) => line.startsWith("GRANT SELECT ON "));
  for (const table of CORE_TABLES) assert.ok(grant.includes(table));
  assert.doesNotMatch(grant, /humanresources|person\.|creditcard|password|ALL TABLES/);
  for (const unsafe of ["", "x", "' OR true;--", "a".repeat(63), "a".repeat(65)]) assert.throws(() => readerGrantSql(unsafe));
});

test("pg_ctl-style launcher exit is not blocked by a descendant holding inherited pipes", { timeout: 10000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "agentcanvas-pg-pipe-test-"));
  const pidFile = path.join(temporary, "owned-holder.pid");
  // This child belongs exclusively to the test and self-expires as a fallback.
  // Do not use process-name termination: cleanup targets its exact recorded PID.
  const launcher = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e',"setTimeout(()=>{},15000); process.send('ready'); process.disconnect();"],{stdio:['ignore','inherit','inherit','ipc'],windowsHide:true,detached:true}); child.on('message',()=>{fs.writeFileSync(process.argv[1],String(child.pid),{flag:'wx'}); child.unref();});`;
  try {
    const started = Date.now();
    await run(process.execPath, ["-e", launcher, pidFile], { detachOutputOnExit: true, timeoutMs: 5000 });
    assert.ok(Date.now() - started < 5000, "should finish on launcher exit, not on descendant pipe close");
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    process.kill(pid, 0); // The inherited-pipe holder is still alive when run returns.
  } finally {
    try {
      const pid = Number(await readFile(pidFile, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid); } catch (error) { if (error.code !== "ESRCH") throw error; }
        let exited = false;
        for (let attempt = 0; attempt < 40; attempt++) {
          try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") { exited = true; break; } throw error; }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.ok(exited, "the test-owned inherited-pipe holder must be gone before cleanup finishes");
      }
      await unlink(pidFile);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await rmdir(temporary);
  }
});

test("ordinary commands still drain their output and report nonzero exits", async () => {
  assert.equal(await run(process.execPath, ["-e", "process.stdout.write('complete output')"]), "complete output");
  await assert.rejects(run(process.execPath, ["-e", "process.exitCode=7"]), /exited with code 7/);
});
