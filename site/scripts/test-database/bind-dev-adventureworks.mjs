import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { validateOwner, run, childEnvironment } from "./adventureworks.mjs";
import { readEnvironment } from "../runtime/common.mjs";

const script = fileURLToPath(import.meta.url);
const site = resolve(dirname(script), "../..");
export const CONNECTION_ID = "adventureworks_local";
const credentialKey = "AGENTCANVAS_ADVENTUREWORKS_READER_PASSWORD";
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

export function assertNoEnvironmentConflict(connections, environment, readerPassword) {
  assert.ok(!connections.some((connection) => connection.id === CONNECTION_ID), "The test connection ID already exists in environment configuration");
  assert.ok(environment[credentialKey] === undefined || environment[credentialKey] === readerPassword,
    "An environment credential would override the test reader; registration refused");
}

export function assertPrivateWindowsDirectory(rules, sid) {
  const allowed = new Set([sid, "S-1-5-18", "S-1-5-32-544", "S-1-3-0"]);
  assert.ok(Array.isArray(rules) && rules.length > 0 && rules.every((rule) => rule.type === "Deny"
    || rule.type === "Allow" && allowed.has(rule.sid)), "Development state directory is shared; refusing to write credentials before its ACL is private");
}

async function verifyPrivateDirectory(directory) {
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o077, 0, "Development state directory must be private before writing credentials");
    return undefined;
  }
  const identity = await run("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  const sid = identity.match(/S-1-5-[0-9-]+/u)?.[0];
  assert.ok(sid, "Unable to resolve current Windows identity for private-file ACL");
  const script = "$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath $env:AGENTCANVAS_BIND_STATE; @($acl.Access | ForEach-Object { @{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;type=$_.AccessControlType.ToString()} }) | ConvertTo-Json -Compress";
  const raw = JSON.parse(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { env: childEnvironment({ AGENTCANVAS_BIND_STATE: directory }) }));
  assertPrivateWindowsDirectory(Array.isArray(raw) ? raw : [raw], sid);
  return sid;
}

/** Explicit local test setup only. Does not edit .env, stable settings, or restart services. */
export async function bindAdventureWorks(runtimeDir, project = "local") {
  assert.ok(project === "local" || /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(project), "Invalid project handle");
  const owner = validateOwner(await json(join(runtimeDir, "owner.json")), runtimeDir);
  assert.equal(owner.phase, "ready", "Restore must be verified before registration");
  const credentials = await json(join(runtimeDir, "credentials.private.json"));
  assert.equal(credentials.ownerId, owner.id);
  assert.equal(credentials.username, owner.readerUser);
  assert.equal(credentials.host, owner.host);
  assert.equal(credentials.port, owner.port);
  assert.equal(credentials.database, owner.database);
  const location = await json(join(site, ".runtime/runtime-location.json"));
  const managed = await json(join(location.root, "config.json"));
  assert.ok(same(managed.source, site), "Managed runtime belongs to another workspace");
  assert.ok(same(managed.devState, join(location.root, "state/dev")) && !same(managed.devState, managed.stableState), "Refusing a non-development state directory");
  const sid = await verifyPrivateDirectory(managed.devState);
  const environment = { ...process.env, ...readEnvironment(join(location.root, "config")), ...readEnvironment(managed.source) };
  const vite = await createServer({ root: site, configFile: false, envFile: false, logLevel: "silent",
    cacheDir: join(managed.devState, "test-tools-vite-cache"),
    server: { middlewareMode: true, hmr: false, watch: null }, resolve: { alias: { "@": site } } });
  try {
    const { LOCAL_CONNECTION_FILE, localConnectionSettingsSchema } = await vite.ssrLoadModule("/core/connections/server/local-config.ts");
    const { JsonFileSnapshotAdapter } = await vite.ssrLoadModule("/core/persistence/server/json-file-snapshot.ts");
    const { connectionConfigSchema } = await vite.ssrLoadModule("/core/connections/configuration.ts");
    let configured;
    try { configured = connectionConfigSchema.parse(environment.STUDIO_SQL_CONNECTIONS ? JSON.parse(environment.STUDIO_SQL_CONNECTIONS) : []); }
    catch { throw new Error("Invalid environment connection configuration; registration refused"); }
    assertNoEnvironmentConflict(configured, environment, credentials.password);
    const adapter = new JsonFileSnapshotAdapter({ rootDirectory: managed.devState, fileName: LOCAL_CONNECTION_FILE,
      schema: localConnectionSettingsSchema, maxBytes: 192 * 1024 });
    const current = adapter.load() ?? { version: 1, connections: [], credentials: {} };
    const expected = { id: CONNECTION_ID, name: "AdventureWorks 本地测试", kind: "postgresql", host: owner.host,
      port: owner.port, database: owner.database, user: owner.readerUser, passwordEnv: credentialKey, ssl: false, allowAi: false };
    const existing = current.connections.find((connection) => connection.id === CONNECTION_ID);
    if (existing) {
      const { projects, ...configuration } = existing;
      // Never overwrite a user-repurposed connection or rotate its credentials implicitly.
      assert.deepEqual(configuration, expected, "Existing test connection changed; registration refused");
      assert.ok(current.credentials[credentialKey] === credentials.password, "Existing test credential changed; registration refused");
      if (!projects.includes(project)) projects.push(project);
    } else {
      assert.ok(!Object.hasOwn(current.credentials, credentialKey), "Credential reference already belongs to another setup");
      current.connections.push({ ...expected, projects: [project] });
      current.credentials[credentialKey] = credentials.password;
    }
    // Check the merged capacity too; the product applies this same bound.
    connectionConfigSchema.parse([...configured, ...current.connections]);
    adapter.save(current);
    if (process.platform === "win32") {
      await run("icacls.exe", [join(managed.devState, LOCAL_CONNECTION_FILE), "/inheritance:r", "/grant:r", `*${sid}:(F)`, "*S-1-5-18:(F)"]);
    }
    return { connectionId: CONNECTION_ID, project, allowAi: false, site: "http://127.0.0.1:3001" };
  } finally { await vite.close(); }
}

if (process.argv[1] && same(process.argv[1], script)) {
  const [runtimeDir, project = "local", ...extra] = process.argv.slice(2);
  assert.ok(runtimeDir && !extra.length, "Usage: node scripts/test-database/bind-dev-adventureworks.mjs ABS_RUNTIME_DIR [PROJECT_HANDLE]");
  console.log(JSON.stringify(await bindAdventureWorks(resolve(runtimeDir), project), null, 2));
}
