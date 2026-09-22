import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionConfigSchema } from "../configuration";
import { listConnections, readConnectionConfigs, resolveConnection } from "./config";
import { LOCAL_CONNECTION_FILE, readLocalConnectionSettings, resolveConnectionCredential } from "./local-config";

const directories: string[] = [];
const connection = connectionConfigSchema.parse([{ id: "sample_local", name: "Local sample", kind: "postgresql",
  projects: ["local"], host: "127.0.0.1", database: "example", user: "reader", passwordEnv: "SAMPLE_DB_PASSWORD", ssl: false }])[0];
function directory() {
  const root = mkdtempSync(join(tmpdir(), "agentcanvas-connection-settings-"));
  directories.push(root); return root;
}
function write(root: string, connections = [connection], credentials = { SAMPLE_DB_PASSWORD: "synthetic-secret" }) {
  writeFileSync(join(root, LOCAL_CONNECTION_FILE), JSON.stringify({ version: 1, connections, credentials }), { mode: 0o600 });
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local connection settings adapter", () => {
  it("preserves the environment-only and unconfigured behavior without creating files", () => {
    const env = { NODE_ENV: "test" as const, STUDIO_LOCAL_STATE_DIR: directory() };
    expect(readLocalConnectionSettings(env)).toBeNull();
    expect(readConnectionConfigs(env)).toEqual([]);
    expect(readConnectionConfigs({ ...env, STUDIO_SQL_CONNECTIONS: JSON.stringify([connection]) })).toEqual([connection]);
  });

  it("reads private credentials only for their registered definition and keeps environment precedence", () => {
    const root = directory(); write(root);
    const env = { NODE_ENV: "test" as const, STUDIO_LOCAL_STATE_DIR: root };
    expect(readConnectionConfigs(env)).toEqual([connection]);
    expect(resolveConnectionCredential(connection, env)).toBe("synthetic-secret");
    expect(resolveConnectionCredential({ ...connection, host: "unexpected.example" }, env)).toBeUndefined();
    expect(resolveConnectionCredential(connection, { ...env, SAMPLE_DB_PASSWORD: "environment-secret" })).toBe("environment-secret");
    expect(resolveConnectionCredential(connection, { ...env, SAMPLE_DB_PASSWORD: "" })).toBe("");
  });

  it("reloads edits and revocations without a restart, and never publishes secrets or scope", () => {
    const root = directory(); write(root);
    vi.stubEnv("STUDIO_LOCAL_STATE_DIR", root); vi.stubEnv("STUDIO_SQL_CONNECTIONS", "");
    vi.stubEnv("SAMPLE_DB_PASSWORD", undefined);
    expect(listConnections(null)).toEqual([{ id: connection.id, name: connection.name, kind: "postgresql", allowAi: false }]);
    expect(listConnections(null, true)).toEqual([]);
    expect(listConnections("00000000-0000-4000-8000-000000000001")).toEqual([]);
    expect(() => resolveConnection(connection.id, null, true)).toThrow("未授权");
    expect(JSON.stringify(listConnections(null))).not.toMatch(/secret|host|password|user|projects|127\.0/u);
    write(root, [{ ...connection, allowAi: true }], { SAMPLE_DB_PASSWORD: "rotated-synthetic" });
    const authorized = resolveConnection(connection.id, null, true);
    expect(resolveConnectionCredential(authorized)).toBe("rotated-synthetic");
    write(root, []);
    expect(() => resolveConnection(connection.id, null, false)).toThrow("未授权");
    expect(resolveConnectionCredential(authorized)).toBeUndefined();
  });

  it("rejects duplicate IDs across stores instead of silently redirecting a connection", () => {
    const root = directory(); write(root);
    expect(() => readConnectionConfigs({ NODE_ENV: "test", STUDIO_LOCAL_STATE_DIR: root,
      STUDIO_SQL_CONNECTIONS: JSON.stringify([{ ...connection, host: "another.example" }]) })).toThrow("不可重复");
  });

  it("rejects corrupt, oversized and unknown configuration without echoing paths or credential values", () => {
    const root = directory();
    const env = { NODE_ENV: "test" as const, STUDIO_LOCAL_STATE_DIR: root };
    for (const value of ["{private-secret", JSON.stringify({ version: 2, privateSecret: "secret-value" }), "x".repeat(192 * 1024 + 1)]) {
      writeFileSync(join(root, LOCAL_CONNECTION_FILE), value);
      expect(() => readConnectionConfigs(env)).toThrow("本地数据库连接配置无效，请检查服务端私有连接文件");
      try { readConnectionConfigs(env); } catch (error) {
        expect(String(error)).not.toMatch(/private-secret|secret-value|agentcanvas-connection-settings-/u);
      }
    }
  });
});
