import { spawn } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, stat, realpath } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This utility owns only clusters created by setup in a previously absent directory.
// It never discovers, resets, registers, or removes another PostgreSQL instance.
export const OWNER_KIND = "agentcanvas-adventureworks-pg-v1";
export const CORE_TABLES = Object.freeze([
  "sales.salesorderheader", "sales.salesorderdetail", "sales.customer", "sales.salesterritory",
  "sales.specialoffer", "sales.specialofferproduct", "production.product", "production.productcategory",
  "production.productsubcategory", "production.productinventory",
]);
const EXPECTED_COUNTS = Object.freeze({
  "sales.salesorderheader": 31465, "sales.salesorderdetail": 121317, "sales.customer": 19820,
  "production.product": 504, "production.productinventory": 1069, "humanresources.employee": 290,
});
const DUMPS = Object.freeze({
  "adventureworks-schema.sql": { bytes: 255143, blob: "b10551bc7e9ccdc21bd47e14760b14ff2b9e689e" },
  "adventureworks-data.sql": { bytes: 85174984, blob: "523df05b8a0932fd4d06ea31b7a6a02d2118c0f5" },
});
const scriptPath = fileURLToPath(import.meta.url);
const workspace = path.resolve(path.dirname(scriptPath), "../../..");
const defaultDumpDir = path.join(workspace, "artifacts/test-databases/adventureworks-pg-2026-09-14");
const commands = new Set(["setup", "start", "status", "stop"]);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function assertPortablePath(value, label) {
  if (/[^\x20-\x7e]/.test(value)) {
    throw new Error(`${label} must use an ASCII-only path for this Windows PostgreSQL portable helper; its bootstrap can encode installation paths with the Windows code page instead of UTF-8. This restriction does not apply to the website, project names, or uploaded filenames.`);
  }
}

export function parseArguments(args) {
  const [command, ...rest] = args;
  if (!commands.has(command)) throw new Error("Use setup|start|status|stop --runtime-dir ABSOLUTE_PATH; setup also requires --bin-dir ABSOLUTE_PATH --port PORT.");
  const options = { command };
  const allowed = new Set(command === "setup" ? ["runtime-dir", "bin-dir", "port", "dump-dir"] : ["runtime-dir"]);
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]?.replace(/^--/, "");
    const value = rest[index + 1];
    if (!rest[index]?.startsWith("--") || !allowed.has(key) || !value || value.startsWith("--") || Object.hasOwn(options, key)) {
      throw new Error("Unknown, repeated, or incomplete option.");
    }
    options[key] = value;
  }
  if (!options["runtime-dir"] || !path.isAbsolute(options["runtime-dir"])) throw new Error("runtime-dir must be explicit and absolute.");
  options["runtime-dir"] = path.resolve(options["runtime-dir"]);
  if (samePath(options["runtime-dir"], path.parse(options["runtime-dir"]).root) || samePath(options["runtime-dir"], workspace)) {
    throw new Error("A filesystem or workspace root is not a test runtime directory.");
  }
  if (command === "setup") {
    if (!options["bin-dir"] || !path.isAbsolute(options["bin-dir"])) throw new Error("bin-dir must be explicit and absolute.");
    options["bin-dir"] = path.resolve(options["bin-dir"]);
    assertPortablePath(options["bin-dir"], "bin-dir");
    assertPortablePath(options["runtime-dir"], "runtime-dir");
    options["dump-dir"] = path.resolve(options["dump-dir"] ?? defaultDumpDir);
    options.port = Number(options.port);
    if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535 || [3000, 3001, 3198, 5432].includes(options.port)) {
      throw new Error("Choose an explicit unprivileged test port, not a website or default PostgreSQL port.");
    }
  }
  return options;
}

export function validateOwner(owner, runtimeDir) {
  if (owner?.kind !== OWNER_KIND || !/^[0-9a-f-]{36}$/.test(owner.id ?? "") || owner.host !== "127.0.0.1"
    || !samePath(owner.runtimeDir ?? "", runtimeDir) || !samePath(owner.dataDir ?? "", path.join(runtimeDir, "data"))
    || !path.isAbsolute(owner.binDir ?? "") || owner.database !== "agentcanvas_adventureworks"
    || owner.adminUser !== "agentcanvas_aw_owner" || owner.readerUser !== "agentcanvas_aw_reader"
    || owner.clusterName !== `agentcanvas_aw_${owner.id.replaceAll("-", "")}`
    || !Number.isInteger(owner.port) || owner.port < 1024 || owner.port > 65535 || [3000, 3001, 3198, 5432].includes(owner.port)) {
    throw new Error("Runtime ownership marker is missing, invalid, or belongs to another location.");
  }
  return owner;
}

export function parsePostmasterPid(text, owner) {
  const lines = text.trim().split(/\r?\n/);
  const pid = Number(lines[0]);
  if (!Number.isSafeInteger(pid) || pid < 1 || !samePath(lines[1] ?? "", owner.dataDir)
    || Number(lines[3]) !== owner.port || lines[5]?.trim() !== "127.0.0.1") {
    throw new Error("Postmaster PID file does not match this isolated cluster.");
  }
  return pid;
}

export function childEnvironment(extra = {}) {
  // Never inherit an unrelated PGHOST/PGSERVICE/PGOPTIONS/PGPASSFILE into restore.
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG/i.test(key))), ...extra };
}

export function run(executable, args, { env, timeoutMs = 60000, input, detachOutputOnExit = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, env: env ?? childEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    let settled = false;
    const capture = (chunk) => { if (output.length < 1024 * 1024) output += chunk.toString(); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.stdin.on("error", () => { /* Spawn/close errors are handled on the child itself. */ });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (detachOutputOnExit) {
        // On Windows, the long-lived postgres descendant can inherit pg_ctl's
        // pipes. pg_ctl has already exited after -w, so waiting for `close`
        // would wait for the database itself to stop. Its logs use -l instead.
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
      }
      if (timedOut || code !== 0) {
        // Never include a command, credentials, SQL text, or dump data in the public error.
        const error = new Error(`${path.basename(executable)} ${timedOut ? "timed out" : `exited with code ${code}`}.`);
        error.privateOutput = output;
        reject(error);
      } else resolve(output);
    };
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(error); }
    });
    child.once(detachOutputOnExit ? "exit" : "close", finish);
    child.stdin.end(input);
  });
}

async function optionalRead(file) {
  try { return await readFile(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

async function requireVacantPort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error("The requested test port is occupied; no process was stopped.")));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(resolve));
  });
}

async function secureDirectory(runtimeDir) {
  const identity = await run("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  const sid = identity.match(/S-1-[0-9-]+/)?.[0];
  if (!sid) throw new Error("Could not resolve current Windows identity for private test credentials.");
  await run("icacls.exe", [runtimeDir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"]);
}

async function saveOwner(owner) {
  await writeFile(path.join(owner.runtimeDir, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
}

async function loadOwnedRuntime(runtimeDir) {
  const owner = validateOwner(JSON.parse(await readFile(path.join(runtimeDir, "owner.json"), "utf8")), runtimeDir);
  if (!samePath(await realpath(runtimeDir), runtimeDir) || !samePath(await realpath(owner.dataDir), owner.dataDir)) {
    throw new Error("Runtime and data directories must not be symlink or junction aliases.");
  }
  const credentials = JSON.parse(await readFile(path.join(runtimeDir, "credentials.private.json"), "utf8"));
  if (credentials.ownerId !== owner.id || !/^[0-9a-f]{64}$/.test(credentials.adminPassword ?? "") || !/^[0-9a-f]{64}$/.test(credentials.password ?? "")) {
    throw new Error("Private credentials do not match the owned runtime.");
  }
  return { owner, credentials };
}

async function clientFor(owner, password, { reader = false, database = owner.database } = {}) {
  const { Client } = await import("pg");
  const client = new Client({ host: owner.host, port: owner.port, database, user: reader ? owner.readerUser : owner.adminUser,
    password, ssl: false, connectionTimeoutMillis: 5000, query_timeout: 15000, application_name: "agentcanvas-aw-lifecycle" });
  await client.connect();
  return client;
}

async function assertRunningOwnership(owner, credentials) {
  const pidText = await optionalRead(path.join(owner.dataDir, "postmaster.pid"));
  if (pidText === undefined) return undefined;
  const pid = parsePostmasterPid(pidText, owner);
  // Read only executable identity and listener ownership; never collect process command lines.
  const check = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; $ports=@(Get-NetTCPConnection -State Listen -LocalPort ${owner.port} -ErrorAction Stop | Select-Object LocalAddress,OwningProcess); @{ executable=$p.ExecutablePath; listeners=$ports } | ConvertTo-Json -Compress`;
  const identity = JSON.parse(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", check]));
  if (!identity.executable || !samePath(identity.executable, path.join(owner.binDir, "postgres.exe"))
    || identity.listeners.length === 0 || identity.listeners.some((item) => item.LocalAddress !== "127.0.0.1" || item.OwningProcess !== pid)) {
    throw new Error("The listener or executable does not belong to this test cluster; refusing control.");
  }
  const client = await clientFor(owner, credentials.adminPassword, { database: "postgres" });
  try {
    const { rows: [identityRow] } = await client.query("SELECT current_setting('data_directory') AS data_dir, current_setting('cluster_name') AS cluster_name, inet_server_port() AS port");
    if (!samePath(identityRow.data_dir, owner.dataDir) || identityRow.cluster_name !== owner.clusterName || identityRow.port !== owner.port) {
      throw new Error("Connected server identity does not match the ownership marker.");
    }
  } finally { await client.end(); }
  return pid;
}

async function startOwned(owner, credentials) {
  assertPortablePath(owner.binDir, "bin-dir");
  assertPortablePath(owner.runtimeDir, "runtime-dir");
  const existingPid = await assertRunningOwnership(owner, credentials);
  if (existingPid) return existingPid;
  if ((await readFile(path.join(owner.dataDir, "PG_VERSION"), "utf8")).trim() !== "16") throw new Error("This helper only controls its PostgreSQL 16 cluster.");
  await requireVacantPort(owner.port);
  await run(path.join(owner.binDir, "pg_ctl.exe"), ["start", "-D", owner.dataDir, "-l", path.join(owner.runtimeDir, "postgres.private.log"),
    "-w", "-t", "45", "-o", `-h 127.0.0.1 -p ${owner.port} -c cluster_name=${owner.clusterName} -c timezone=UTC`], { detachOutputOnExit: true });
  return assertRunningOwnership(owner, credentials);
}

export function readerGrantSql(readerPassword) {
  if (!/^[0-9a-f]{64}$/.test(readerPassword)) throw new Error("Reader password must be generated hex, not SQL input.");
  return `
CREATE ROLE agentcanvas_aw_reader LOGIN PASSWORD '${readerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
REVOKE ALL ON DATABASE agentcanvas_adventureworks FROM PUBLIC;
GRANT CONNECT ON DATABASE agentcanvas_adventureworks TO agentcanvas_aw_reader;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA humanresources, person, production, purchasing, sales, hr, pe, pr, pu, sa FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA sales, production TO agentcanvas_aw_reader;
GRANT SELECT ON ${CORE_TABLES.join(", ")} TO agentcanvas_aw_reader;
ALTER ROLE agentcanvas_aw_reader SET statement_timeout = '12s';
ALTER ROLE agentcanvas_aw_reader SET lock_timeout = '3s';
ALTER ROLE agentcanvas_aw_reader SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE agentcanvas_aw_reader SET default_transaction_read_only = on;
ALTER ROLE agentcanvas_aw_reader SET search_path = pg_catalog, sales, production;
`;
}

async function verifyRestored(owner, credentials) {
  const admin = await clientFor(owner, credentials.adminPassword);
  try {
    const tableCount = await admin.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname IN ('humanresources','person','production','purchasing','sales')");
    if (tableCount.rows[0].count !== 68) throw new Error("Restored table count does not match the fixed fixture.");
    for (const [table, expected] of Object.entries(EXPECTED_COUNTS)) {
      const actual = await admin.query(`SELECT count(*)::int AS count FROM ${table}`);
      if (actual.rows[0].count !== expected) throw new Error(`Restored count mismatch for ${table}.`);
    }
    const constraints = await admin.query("SELECT count(*) FILTER (WHERE contype='p')::int AS primary_keys, count(*) FILTER (WHERE contype='f')::int AS foreign_keys, count(*) FILTER (WHERE NOT convalidated)::int AS unvalidated FROM pg_constraint WHERE connamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('humanresources','person','production','purchasing','sales'))");
    if (constraints.rows[0].primary_keys !== 68 || constraints.rows[0].foreign_keys !== 90 || constraints.rows[0].unvalidated !== 0) throw new Error("Restored constraints differ from the fixed fixture.");
    await admin.query(readerGrantSql(credentials.password));
  } finally { await admin.end(); }
  const reader = await clientFor(owner, credentials.password, { reader: true });
  try {
    const permission = await reader.query("SELECT current_setting('statement_timeout') AS timeout, current_setting('default_transaction_read_only') AS readonly, has_database_privilege(current_database(),'TEMP') AS temp, has_schema_privilege('public','CREATE') AS public_create, has_table_privilege('sales.salesorderheader','INSERT,UPDATE,DELETE,TRUNCATE') AS writes");
    const row = permission.rows[0];
    if (row.timeout !== "12s" || row.readonly !== "on" || row.temp || row.public_create || row.writes) throw new Error("Reader role permissions are not restricted as expected.");
    const actual = await reader.query("SELECT count(*)::int AS count FROM sales.salesorderheader");
    if (actual.rows[0].count !== EXPECTED_COUNTS["sales.salesorderheader"]) throw new Error("Reader query did not return the expected baseline.");
    // Prove database privileges, not merely default_transaction_read_only, reject a zero-row write.
    await reader.query("BEGIN READ WRITE");
    let denied = false;
    try { await reader.query("DELETE FROM sales.salesorderheader WHERE false"); } catch (error) { denied = error.code === "42501"; }
    await reader.query("ROLLBACK");
    if (!denied) throw new Error("Reader privileges did not reject a write independently of read-only defaults.");
  } finally { await reader.end(); }
}

async function verifyDumps(dumpDir) {
  for (const [name, expected] of Object.entries(DUMPS)) {
    const file = path.join(dumpDir, name);
    const { size } = await stat(file);
    if (size !== expected.bytes) throw new Error(`Unexpected fixed fixture size: ${name}.`);
    const hash = createHash("sha1").update(`blob ${size}\0`);
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest("hex") !== expected.blob) throw new Error(`Fixed fixture hash mismatch: ${name}.`);
  }
}

async function setup(options) {
  const runtimeDir = options["runtime-dir"];
  const binDir = await realpath(options["bin-dir"]);
  // Also inspect canonical paths: an ASCII junction must not hide a non-ASCII
  // installation/data location from the Windows bootstrap process.
  assertPortablePath(binDir, "Resolved bin-dir");
  assertPortablePath(await realpath(path.dirname(runtimeDir)), "Resolved runtime parent");
  for (const executable of ["postgres.exe", "initdb.exe", "pg_ctl.exe", "psql.exe"]) {
    if (!(await stat(path.join(binDir, executable))).isFile()) throw new Error("Missing PostgreSQL binary.");
  }
  const version = await run(path.join(binDir, "postgres.exe"), ["--version"]);
  if (!/PostgreSQL\) 16\./.test(version)) throw new Error("Use the reviewed PostgreSQL 16 binary distribution.");
  await verifyDumps(options["dump-dir"]);
  await requireVacantPort(options.port);
  // mkdir is intentionally non-recursive: an existing directory is never reset or adopted.
  await mkdir(runtimeDir, { mode: 0o700 });
  await secureDirectory(runtimeDir);
  const id = randomUUID();
  const owner = { kind: OWNER_KIND, id, runtimeDir, binDir, dataDir: path.join(runtimeDir, "data"), port: options.port,
    host: "127.0.0.1", database: "agentcanvas_adventureworks", adminUser: "agentcanvas_aw_owner", readerUser: "agentcanvas_aw_reader",
    clusterName: `agentcanvas_aw_${id.replaceAll("-", "")}`, createdAt: new Date().toISOString(), phase: "preparing" };
  const credentials = { ownerId: id, host: owner.host, port: owner.port, database: owner.database, username: owner.readerUser,
    password: randomBytes(32).toString("hex"), adminUsername: owner.adminUser, adminPassword: randomBytes(32).toString("hex") };
  await saveOwner(owner);
  await writeFile(path.join(runtimeDir, "credentials.private.json"), `${JSON.stringify(credentials, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const pwfile = path.join(runtimeDir, "initdb-password.private.txt");
  await writeFile(pwfile, `${credentials.adminPassword}\n`, { flag: "wx", mode: 0o600 });
  try {
    await run(path.join(binDir, "initdb.exe"), ["-D", owner.dataDir, "-U", owner.adminUser, "--encoding=UTF8", "--locale=C", "--auth=scram-sha-256", `--pwfile=${pwfile}`]);
    owner.phase = "initialized";
    await saveOwner(owner);
    await startOwned(owner, credentials);
    const admin = await clientFor(owner, credentials.adminPassword, { database: "postgres" });
    try {
      await admin.query("CREATE DATABASE agentcanvas_adventureworks TEMPLATE template0 ENCODING 'UTF8'");
      // The reader must not regain TEMP/CONNECT privileges through another database
      // in this freshly created, wholly task-owned cluster.
      await admin.query("REVOKE ALL ON DATABASE postgres FROM PUBLIC; REVOKE ALL ON DATABASE template1 FROM PUBLIC");
    } finally { await admin.end(); }
    owner.phase = "restoring";
    await saveOwner(owner);
    await run(path.join(binDir, "psql.exe"), ["-X", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-h", owner.host, "-p", String(owner.port),
      "-U", owner.adminUser, "-d", owner.database, "-f", path.join(options["dump-dir"], "adventureworks-schema.sql"),
      "-f", path.join(options["dump-dir"], "adventureworks-data.sql")], {
      timeoutMs: 10 * 60 * 1000, env: childEnvironment({ PGPASSWORD: credentials.adminPassword, PGSSLMODE: "disable", PGCONNECT_TIMEOUT: "5" }),
    });
    await verifyRestored(owner, credentials);
    owner.phase = "ready";
    owner.verifiedAt = new Date().toISOString();
    await saveOwner(owner);
    return { status: "running", phase: owner.phase, host: owner.host, port: owner.port, database: owner.database, readonlyTables: CORE_TABLES.length,
      credentialsFile: path.join(runtimeDir, "credentials.private.json"), restoredTables: 68, primaryKeys: 68, foreignKeys: 90 };
  } catch (error) {
    owner.phase = "failed";
    await saveOwner(owner);
    await writeFile(path.join(runtimeDir, "failure.private.log"), `${error.message}\n${error.privateOutput ?? ""}`, { mode: 0o600 });
    throw new Error(`Setup failed; owned files and any running test server were preserved. Inspect private runtime logs. ${error.message}`);
  }
}

export async function main(args) {
  const options = parseArguments(args);
  if (process.platform !== "win32") throw new Error("This portable lifecycle helper currently supports Windows only.");
  if (options.command === "setup") return setup(options);
  const { owner, credentials } = await loadOwnedRuntime(options["runtime-dir"]);
  const pid = await assertRunningOwnership(owner, credentials);
  if (options.command === "status") return { status: pid ? "running" : "stopped", phase: owner.phase, host: owner.host, port: owner.port, database: owner.database, ...(pid ? { pid } : {}) };
  if (options.command === "start") {
    const runningPid = await startOwned(owner, credentials);
    return { status: "running", phase: owner.phase, pid: runningPid, port: owner.port };
  }
  if (pid) await run(path.join(owner.binDir, "pg_ctl.exe"), ["stop", "-D", owner.dataDir, "-m", "fast", "-w", "-t", "45"]);
  return { status: "stopped", phase: owner.phase, dataPreserved: true };
}

if (process.argv[1] && samePath(process.argv[1], scriptPath)) {
  main(process.argv.slice(2)).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
