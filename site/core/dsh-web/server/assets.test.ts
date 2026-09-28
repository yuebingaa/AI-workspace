import { describe, expect, it, vi } from "vitest";
import { DSH_WEB_ASSET_BASE, dshWebAsset, dshWebDocument } from "./assets";

const base = "http://127.0.0.1:3001";
const request = (path = "/api/ai/dsh/web/document", init?: RequestInit) => new Request(base + path, init);
describe("controlled official Web resources", () => {
  const fixture = () => {
    const html = vi.fn(async ({ nonce }: { nonce: string; surface?: "chat" | "settings" }) => `<script nonce="${nonce}">/* synthetic */</script>`);
    const fetch = vi.fn(async () => new Response("/* synthetic asset */", { headers: { "content-type": "text/javascript" } }));
    return { html, fetch, load: vi.fn(async () => ({ html, fetch })) };
  };
  it("uses a unique trusted document nonce and disables direct network, camera and framing elsewhere", async () => {
    const assets = fixture(), result = await dshWebDocument(request(), assets.load);
    expect(result.status).toBe(200);
    const nonce = assets.html.mock.calls[0][0].nonce;
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(await result.text()).toContain(`nonce="${nonce}"`);
    expect(result.headers.get("content-security-policy")).toContain(`'nonce-${nonce}'`);
    expect(result.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(result.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(result.headers.get("permissions-policy")).toContain("microphone=()");
    await dshWebDocument(request(), assets.load);
    expect(assets.html.mock.calls[1][0].nonce).not.toBe(nonce);
  });
  it.each([dshWebDocument, dshWebAsset])("refuses cross-site and non-GET requests before SDK resources", async handler => {
    const assets = fixture();
    const requests: RequestInit[] = [{ headers: { origin: "https://attacker.invalid" } }, { headers: { "sec-fetch-site": "cross-site" } }, { method: "POST" }];
    for (const init of requests) {
      expect((await handler(request(`${DSH_WEB_ASSET_BASE}/index.js`, init), assets.load)).status).toBe(init.method ? 405 : 403);
    }
    expect(assets.load).not.toHaveBeenCalled();
  });
  it("preserves only the fixed asset URL path and module query, without using caller roots", async () => {
    const assets = fixture();
    const path = `${DSH_WEB_ASSET_BASE}/plugins/??m=synthetic`;
    const response = await dshWebAsset(request(path), assets.load);
    expect(assets.fetch).toHaveBeenCalledExactlyOnceWith(path);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("/* synthetic asset */");
    expect((await dshWebAsset(request("/private"), assets.load)).status).toBe(404);
  });
  it("only selects the fixed settings surface and retains the same security headers", async () => {
    const assets = fixture();
    const response = await dshWebDocument(request("/api/ai/dsh/web/document?surface=settings"), assets.load);
    expect(response.status).toBe(200);
    expect(assets.html.mock.calls[0][0].surface).toBe("settings");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'none'");
    for (const query of ["surface=chat", "surface=settings&root=outside", "surface=settings&surface=settings", "root=outside"]) {
      expect((await dshWebDocument(request("/api/ai/dsh/web/document?" + query), assets.load)).status).toBe(400);
    }
    expect(assets.load).toHaveBeenCalledTimes(1);
  });
  it.each([dshWebDocument, dshWebAsset])("does not disclose local paths or nested errors", async handler => {
    const response = await handler(request(`${DSH_WEB_ASSET_BASE}/index.js`), async () => { throw new Error("private-path-and-secret"); });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private-path-and-secret");
  });
});
