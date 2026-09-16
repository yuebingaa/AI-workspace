import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectionCatalog } from "./catalog";
import type { ConnectionSchema } from "../contracts";

const configuration = { id: "sales", name: "销售库", kind: "postgresql", projects: ["local", "f560a52d-ab79-45e0-b5e3-206c9bf68f49"],
  allowAi: true, host: "synthetic-private-host", database: "sales", user: "reader", passwordEnv: "SYNTHETIC_DB_PASSWORD" };
afterEach(() => vi.unstubAllEnvs());
describe("connection catalog adapter", () => {
  it("isolates project/AI scopes, invalidates rotated credentials, and never returns configuration", async () => {
    vi.stubEnv("STUDIO_LOCAL_STATE_DIR", "");
    vi.stubEnv("STUDIO_SQL_CONNECTIONS", JSON.stringify([configuration]));
    vi.stubEnv("SYNTHETIC_DB_PASSWORD", "synthetic-credential-one");
    const source = vi.fn<() => Promise<ConnectionSchema>>().mockResolvedValue({ columns: [
      { table_schema: "public", table_name: "orders", column_name: "amount", data_type: "numeric" },
    ], truncated: false });
    const service = createConnectionCatalog(source); const access = { connectionId: "sales", project: null };
    const snapshot = await service.refresh(access);
    expect(snapshot.columns[0].catalog).toBe("sales");
    expect(JSON.stringify(snapshot)).not.toMatch(/synthetic-private-host|synthetic-credential|passwordEnv|reader/u);
    expect(service.read({ ...access, forAi: true })).toBeNull();
    expect(service.read({ ...access, project: configuration.projects[1] })).toBeNull();
    await service.refresh({ ...access, forAi: true });
    vi.stubEnv("STUDIO_SQL_CONNECTIONS", JSON.stringify([{ ...configuration, allowAi: false }]));
    expect(() => service.read({ ...access, forAi: true })).toThrow("未授权");
    expect(service.read(access)).toEqual(snapshot);
    vi.stubEnv("SYNTHETIC_DB_PASSWORD", "synthetic-credential-two");
    expect(service.read(access)).toBeNull();
  });
});
