import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

const mock = vi.hoisted(() => ({ query: vi.fn(), inspect: vi.fn() }));
vi.mock("@/core/connections/server/query", () => ({ executeConnectionSql: mock.query, inspectConnectionSchema: mock.inspect }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("STUDIO_SQL_CONNECTIONS", JSON.stringify([{ id: "sales", name: "Sales", kind: "postgresql", projects: ["local"], host: "private-host", database: "sales", user: "reader", passwordEnv: "PRIVATE_PASSWORD" }]));
  mock.query.mockResolvedValue({ fields: [], rows: [] }); mock.inspect.mockResolvedValue({ columns: [], truncated: false });
});
afterEach(() => vi.unstubAllEnvs());
function request(body: unknown, origin = "http://127.0.0.1:3001") { return new Request("http://127.0.0.1:3001/api/connections", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }); }
describe("local connection API", () => {
  it("lists only public descriptors with Agent disabled by default", async () => {
    const response = await GET(new Request("http://127.0.0.1:3001/api/connections"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connections: [{ id: "sales", name: "Sales", kind: "postgresql", allowAi: false }] });
  });
  it("rejects remote origins and client-supplied credentials before querying", async () => {
    const crossOrigin = await POST(request({ connectionId: "sales", action: "test" }, "https://untrusted.example"));
    expect(crossOrigin.ok).toBe(false);
    const credentials = await POST(request({ connectionId: "sales", action: "test", password: "never-accepted" }));
    expect(credentials.status).toBe(400); expect(mock.query).not.toHaveBeenCalled();
    expect((await GET(new Request("https://public.example/api/connections"))).status).toBe(403);
  });
  it("routes connection tests and schema reads to the project-scoped backend", async () => {
    expect((await POST(request({ connectionId: "sales", action: "test" }))).status).toBe(200);
    expect(mock.query).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "sales", project: null, sql: "SELECT 1 AS connected" }));
    expect((await POST(request({ connectionId: "sales", action: "schema" }))).status).toBe(200);
    expect(mock.inspect).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "sales", project: null }));
  });
});
