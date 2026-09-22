import { request as httpRequest, type OutgoingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DshDriverTool } from "./dsh-engine";
import { createDshToolBroker } from "./tool-broker";
import { HarnessToolArgumentsError } from "@/core/harness/tool-registry";
import { NotebookSearchError } from "@/core/notebook/search";
import { NotebookSearchStateError } from "@/core/harness/notebook-cell-search";

const toolNames = ["cellSearch", "editNotebookCells", "runNotebookCells", "submitNotebookDraft"];
const optionalToolNames = ["getKernelPackagesInfo", "inspectEdsRawWorkbook", "readEdsRawRows", "inspectConnectionSchema"];
const brokers: Array<Awaited<ReturnType<typeof createDshToolBroker>>> = [];
afterEach(async () => { await Promise.all(brokers.splice(0).map((broker) => broker.close())); });

function send(broker: Awaited<ReturnType<typeof createDshToolBroker>>, path: string,
  options: { method?: string; body?: string | Buffer; headers?: OutgoingHttpHeaders } = {}) {
  let connection: ReturnType<typeof httpRequest>;
  const response = new Promise<{ status: number; body: string; headers: OutgoingHttpHeaders }>((resolve, reject) => {
    connection = httpRequest(new URL(path, broker.url), { method: options.method ?? "GET",
      headers: { authorization: `Bearer ${broker.token}`, "content-type": "application/json", ...options.headers } }, (message) => {
      const chunks: Buffer[] = [];
      message.on("data", (chunk: Buffer) => chunks.push(chunk));
      message.on("end", () => resolve({ status: message.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: message.headers }));
      message.on("error", reject);
    });
    connection.on("error", reject);
    connection.end(options.body);
  });
  return { response, disconnect: () => connection.destroy(new Error("synthetic client disconnect")) };
}

async function fixture(overrides: Partial<Parameters<typeof createDshToolBroker>[0]> = {}) {
  const controller = new AbortController();
  const execute = vi.fn<DshDriverTool["execute"]>(async () => ({ summary: "safe tool observation", data: { status: "draft" } }));
  const tools: DshDriverTool[] = toolNames.map((name) => ({ name, description: name,
    parameters: { type: "object", additionalProperties: false }, execute }));
  const authorizeCurrentAccess = vi.fn(() => {}), onModelCall = vi.fn(() => {});
  const broker = await createDshToolBroker({ tools, authorizeCurrentAccess, onModelCall, signal: controller.signal, ...overrides });
  brokers.push(broker);
  return { broker, execute, tools, controller, authorizeCurrentAccess, onModelCall };
}

describe("DSH 任务级 loopback 工具 capability", () => {
  it.each([
    new NotebookSearchError("notebook_search_anchor_not_found"),
    new NotebookSearchError("notebook_search_anchor_required"),
    new NotebookSearchStateError("notebook_search_version_stale"),
    new NotebookSearchStateError("notebook_search_run_stale"),
    new NotebookSearchStateError("notebook_search_budget_exceeded"),
  ])("业务检索错误 $code 仅返回固定code，不传原始消息", async error => {
    error.message = "SYNTHETIC_PRIVATE_BUSINESS_MESSAGE";
    const execute = vi.fn(async () => { throw error; });
    const { broker } = await fixture({ tools: toolNames.map(name => ({ name, description: name,
      parameters: { type: "object" }, execute })) });
    const response = await send(broker, "/execute", { method: "POST", body: JSON.stringify({ name: "cellSearch", args: {}, callId: "search-failed" }) }).response;
    expect(response.status).toBe(422);
    expect(JSON.parse(response.body)).toEqual({ error: { code: error.code } });
    expect(response.body).not.toContain("SYNTHETIC_PRIVATE");
  });

  it.each(["spoofed", "wrong-tool", "revoked"])("业务检索 %s 仍仅返回通用失败", async kind => {
    const error = kind === "spoofed" ? Object.assign(new Error("SYNTHETIC_PRIVATE"),
      { name: "NotebookSearchError", code: "notebook_search_anchor_not_found" }) : new NotebookSearchError("notebook_search_anchor_not_found");
    let allowed = true;
    const execute = vi.fn(async () => { if (kind === "revoked") allowed = false; throw error; });
    const { broker } = await fixture({ authorizeCurrentAccess: () => { if (!allowed) throw new Error("SYNTHETIC_PRIVATE"); },
      tools: toolNames.map(name => ({ name, description: name, parameters: { type: "object" }, execute })) });
    const response = await send(broker, "/execute", { method: "POST", body: JSON.stringify({
      name: kind === "wrong-tool" ? "editNotebookCells" : "cellSearch", args: {}, callId: "search-denied" }) }).response;
    expect(response.status).toBe(422);
    expect(response.body).not.toContain("notebook_search_");
    expect(response.body).not.toContain("SYNTHETIC_PRIVATE");
  });

  it.each([["cellSearch"], ["cellSearch", "runNotebookCells"]])("只读目录 %j 在传输层拒绝编辑和提交", async (...readNames) => {
    const execute = vi.fn(async () => ({ summary: "只读回执", data: { totalCells: 0 } }));
    const { broker } = await fixture({ tools: readNames.map(name => ({ name, description: name, parameters: {}, execute })) });
    const catalog = await send(broker, "/catalog").response;
    expect(JSON.parse(catalog.body).tools.map((tool: { name: string }) => tool.name)).toEqual(readNames);
    for (const name of ["editNotebookCells", "submitNotebookDraft"]) {
      expect((await send(broker, "/execute", { method: "POST", body: JSON.stringify({ name, args: {}, callId: name }) }).response).status).toBe(403);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("真实参数异常只返回有界 Schema 字段和代码，不泄漏值、消息或字典键", async () => {
    const secret = "SYNTHETIC_PRIVATE_KEY_DO_NOT_EXPORT";
    const parameters = { type: "object", properties: {
      query: { type: "string" }, bindings: { type: "object", additionalProperties: { type: "string" } },
      cells: { type: "array", items: { $ref: "#/$defs/cell" } },
    }, $defs: { cell: { anyOf: [{ type: "object", properties: { code: { type: "string" } } }] } } };
    const execute = vi.fn(async () => { throw new HarnessToolArgumentsError("cellSearch", [
      `query:invalid_type；要求 ${secret}`,
      `bindings.${secret}:invalid_type；要求 ${secret}`,
      `cells.0.code:invalid_format；要求 ${secret}`,
      `${secret}:custom；${secret}`,
      `query:${secret}`,
      `query:invalid_value；允许 ${secret}`,
      "query:too_big",
    ]); });
    const { broker } = await fixture({ tools: toolNames.map((name) => ({ name, description: name, parameters, execute })) });
    const response = await send(broker, "/execute", { method: "POST", body: JSON.stringify({ name: "cellSearch", args: {}, callId: "invalid" }) }).response;
    expect(response.status).toBe(422);
    expect(JSON.parse(response.body)).toEqual({ error: { code: "invalid_tool_arguments", issues: [
      { path: "query", code: "invalid_type" }, { path: "bindings", code: "invalid_type" },
      { path: "cells.0.code", code: "invalid_format" }, { path: "$", code: "custom" },
      { path: "query", code: "invalid_value" },
    ] } });
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain("message");
    expect(response.body).not.toContain("too_big");
    expect((await send(broker, "/execute", { method: "POST", body: JSON.stringify({ name: "cellSearch", args: {}, callId: "invalid" }) }).response).status).toBe(409);
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(["spoofed", "wrong-tool", "authorization"])("%s 异常不能伪装为可公开参数诊断", async (kind) => {
    const secret = "SYNTHETIC_PRIVATE_MESSAGE";
    const failure = kind === "spoofed"
      ? Object.assign(new Error(secret), { name: "HarnessToolArgumentsError", toolName: "cellSearch", issueSummary: ["query:invalid_type"] })
      : new HarnessToolArgumentsError(kind === "wrong-tool" ? "runNotebookCells" : "cellSearch", [`query:invalid_type；${secret}`]);
    const execute = vi.fn(async () => { throw failure; });
    const { broker } = await fixture({
      ...(kind === "authorization" ? { authorizeCurrentAccess: () => { throw failure; } } : {}),
      tools: toolNames.map((name) => ({ name, description: name, parameters: {}, execute })),
    });
    const response = await send(broker, "/execute", { method: "POST", body: JSON.stringify({ name: "cellSearch", args: {}, callId: "generic" }) }).response;
    expect(response.status).toBe(422);
    expect(response.body).not.toContain("invalid_tool_arguments");
    expect(response.body).not.toContain(secret);
    expect(JSON.parse(response.body)).toEqual({ error: { message: "工具执行或授权验证失败，请检查输入或结束任务。" } });
    if (kind === "authorization") expect(execute).not.toHaveBeenCalled();
  });

  it("参数错误返回之前撤权时不发布诊断", async () => {
    let allowed = true;
    const execute = vi.fn(async () => { allowed = false; throw new HarnessToolArgumentsError("cellSearch", ["query:invalid_type"]); });
    const { broker } = await fixture({ authorizeCurrentAccess: () => { if (!allowed) throw new Error("revoked-private-context"); },
      tools: toolNames.map((name) => ({ name, description: name, parameters: {}, execute })),
    });
    const response = await send(broker, "/execute", { method: "POST", body: JSON.stringify({ name: "cellSearch", args: {}, callId: "invalid-revoked" }) }).response;
    expect(response.status).toBe(422);
    expect(response.body).not.toContain("invalid_tool_arguments");
    expect(response.body).not.toContain("revoked-private-context");
  });

  it("目录只有四工具、不可变参数快照，不导出 token 或执行函数", async () => {
    const { broker, tools, execute, onModelCall } = await fixture();
    tools[0].name = "bash"; tools[0].parameters.extra = "caller mutation";
    tools.push({ ...tools[0], name: "network" });
    const response = await send(broker, "/catalog").response;
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).tools.map((tool: { name: string }) => tool.name)).toEqual(toolNames);
    expect(response.body).not.toContain("caller mutation");
    expect(response.body).not.toContain(broker.token);
    expect(response.body).not.toContain("execute");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(execute).not.toHaveBeenCalled();
    expect(onModelCall).not.toHaveBeenCalled();
  });

  it.each(optionalToolNames)("%s 仅在本任务目录公开时可执行，不自动开放其余可选工具", async (name) => {
    const execute = vi.fn<DshDriverTool["execute"]>(async () => ({ summary: "safe optional observation", data: { allowed: true } }));
    const names = [...toolNames, name];
    const { broker } = await fixture({ tools: names.map((tool) => ({ name: tool, description: tool,
      parameters: { type: "object", additionalProperties: false }, execute })) });
    const catalog = await send(broker, "/catalog").response;
    expect(catalog.status).toBe(200);
    expect(JSON.parse(catalog.body).tools.map((tool: { name: string }) => tool.name)).toEqual(names);
    const response = await send(broker, "/execute", { method: "POST", body: JSON.stringify({
      name, args: {}, callId: "optional_call",
    }) }).response;
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ summary: "safe optional observation", data: { allowed: true } });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    for (const denied of optionalToolNames.filter((tool) => tool !== name)) {
      expect((await send(broker, "/execute", { method: "POST", body: JSON.stringify({
        name: denied, args: {}, callId: `denied_${denied}`,
      }) }).response).status).toBe(403);
    }
    expect(execute).toHaveBeenCalledOnce();
  });

  it("未公开任何可选工具时全部拒绝，白名单不是本任务授权", async () => {
    const { broker, execute } = await fixture();
    for (const name of optionalToolNames) {
      expect((await send(broker, "/execute", { method: "POST", body: JSON.stringify({
        name, args: {}, callId: `not_advertised_${name}`,
      }) }).response).status).toBe(403);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["missing token", { authorization: "" }],
    ["wrong token", { authorization: "Bearer invalid-capability" }],
    ["origin", { origin: "https://example.invalid" }],
    ["empty origin", { origin: "" }],
    ["wrong host", { host: "example.invalid" }],
  ] satisfies Array<[string, OutgoingHttpHeaders]>)("拒绝 %s，不调用授权或业务工具", async (_label, headers) => {
    const { broker, execute, authorizeCurrentAccess } = await fixture();
    const response = await send(broker, "/catalog", { headers }).response;
    expect(response.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
    expect(authorizeCurrentAccess).not.toHaveBeenCalled();
  });

  it("未注册工具、未知协议和额外字段拒绝", async () => {
    const { broker, execute } = await fixture();
    const denied = await send(broker, "/execute", { method: "POST", body: JSON.stringify({ name: "bash", args: {}, callId: "denied" }) }).response;
    expect(denied.status).toBe(403);
    expect((await send(broker, "/unknown").response).status).toBe(404);
    const extra = await send(broker, "/execute", { method: "POST", body: JSON.stringify({
      name: "cellSearch", args: {}, callId: "extra", notebookArtifact: { status: "success" },
    }) }).response;
    expect(extra.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("同一 callId 在途或已完成都不重复执行，artifact 不穿过 broker", async () => {
    let started: () => void = () => {}, finish: () => void = () => {};
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const execute = vi.fn(async () => { started(); await gate; return { summary: "submitted", data: { notebookArtifactId: "draft_id" },
      notebookArtifact: { cells: ["private definition"], executionEvidence: { status: "success" } } }; });
    const { broker } = await fixture({ tools: toolNames.map((name) => ({ name, description: name, parameters: {}, execute })) });
    const body = JSON.stringify({ name: "submitNotebookDraft", args: { editVersion: 1 }, callId: "same_call" });
    const first = send(broker, "/execute", { method: "POST", body }).response;
    await entered;
    expect((await send(broker, "/execute", { method: "POST", body }).response).status).toBe(409);
    finish();
    const response = await first;
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ summary: "submitted", data: { notebookArtifactId: "draft_id" } });
    expect(response.body).not.toContain("private definition");
    expect((await send(broker, "/execute", { method: "POST", body }).response).status).toBe(409);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("授权在真实工具返回前撤销时不能返回观察或重执行同一调用", async () => {
    let allowed = true;
    const execute = vi.fn(async () => { allowed = false; return { summary: "not public", data: { secretResult: "synthetic withheld" } }; });
    const { broker } = await fixture({ authorizeCurrentAccess: () => {
      if (!allowed) throw new Error("C:\\private\\runtime-config sk-synthetic-secret-secret");
    }, tools: toolNames.map((name) => ({ name, description: name, parameters: {}, execute })) });
    const response = await send(broker, "/execute", { method: "POST", body: JSON.stringify({ name: "cellSearch", args: {}, callId: "revoke" }) }).response;
    expect(response.status).toBe(422);
    expect(response.body).not.toContain("withheld");
    expect(response.body).not.toContain("private");
    expect(response.body).not.toContain("sk-");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("每次模型授权只接受空对象并在回调前后复查", async () => {
    const sequence: string[] = [];
    const { broker } = await fixture({ authorizeCurrentAccess: () => { sequence.push("authorize"); },
      onModelCall: () => { sequence.push("model"); } });
    const response = await send(broker, "/authorize", { method: "POST", body: "{}" }).response;
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ authorized: true });
    expect(sequence).toEqual(["authorize", "authorize", "model", "authorize"]);
    sequence.length = 0;
    expect((await send(broker, "/authorize", { method: "POST", body: '{"override":true}' }).response).status).toBe(400);
    expect(sequence).toEqual(["authorize"]);
  });

  it("模型回调期间撤权或取消不发布 authorized:true", async () => {
    let allowed = true;
    const { broker } = await fixture({ authorizeCurrentAccess: () => { if (!allowed) throw new Error("revoked"); },
      onModelCall: () => { allowed = false; } });
    const response = await send(broker, "/authorize", { method: "POST", body: "{}" }).response;
    expect(response.status).toBe(422);
    expect(response.body).not.toContain('"authorized":true');
  });

  it.each(["client", "task", "close"])("%s 取消传入工具且关闭连接不泄漏晚结果", async (kind) => {
    let started: (signal: AbortSignal) => void = () => {};
    const entered = new Promise<AbortSignal>((resolve) => { started = resolve; });
    const execute: DshDriverTool["execute"] = (_args, signal) => {
      if (!signal) throw new Error("Signal missing");
      started(signal);
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
    };
    const { broker, controller } = await fixture({ tools: toolNames.map((name) => ({ name, description: name, parameters: {}, execute })) });
    const pending = send(broker, "/execute", { method: "POST", body: JSON.stringify({ name: "runNotebookCells", args: {}, callId: "cancel" }) });
    const rejected = expect(pending.response).rejects.toThrow();
    const signal = await entered;
    const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    if (kind === "client") pending.disconnect();
    else if (kind === "task") controller.abort();
    else await broker.close();
    await aborted;
    await rejected;
    expect(signal.aborted).toBe(true);
    await broker.close();
    await expect(send(broker, "/catalog").response).rejects.toThrow();
  });

  it("错误 MIME、JSON、UTF-8 与已声明超大请求在工具前拒绝", async () => {
    const { broker, execute } = await fixture();
    expect((await send(broker, "/execute", { method: "POST", body: "{}", headers: { "content-type": "text/plain" } }).response).status).toBe(415);
    expect((await send(broker, "/execute", { method: "POST", body: "{" }).response).status).toBe(400);
    const malformed = Buffer.concat([Buffer.from('{"name":"cellSearch","args":{"value":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"},"callId":"bad_encoding"}')]);
    expect((await send(broker, "/execute", { method: "POST", body: malformed }).response).status).toBe(400);
    expect((await send(broker, "/execute", { method: "POST", headers: { "content-length": 512 * 1024 + 1 } }).response).status).toBe(413);
    expect(execute).not.toHaveBeenCalled();
  });

  it("过大工具观察返回安全错误且没有部分结果", async () => {
    const execute = async () => ({ summary: "large", data: { value: "s".repeat(512 * 1024) } });
    const { broker } = await fixture({ tools: toolNames.map((name) => ({ name, description: name, parameters: {}, execute })) });
    const response = await send(broker, "/execute", { method: "POST", body: JSON.stringify({ name: "cellSearch", args: {}, callId: "large_result" }) }).response;
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({ error: { message: "Tool observation too large" } });
  });

  it("分块超大正文返回 413，不执行任何工具", async () => {
    const { broker, execute } = await fixture();
    const body = JSON.stringify({ name: "cellSearch", args: { value: "s".repeat(512 * 1024) }, callId: "chunked_large" });
    const response = await send(broker, "/execute", { method: "POST", body,
      headers: { "transfer-encoding": "chunked" },
    }).response;
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({ error: { message: "Tool request too large" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("任务调用账本有界且失败调用也不允许复用", async () => {
    const execute = vi.fn(async () => { throw new Error("synthetic failed tool"); });
    const { broker } = await fixture({ tools: toolNames.map((name) => ({ name, description: name, parameters: {}, execute })) });
    for (let index = 0; index < 128; index += 1) {
      expect((await send(broker, "/execute", { method: "POST",
        body: JSON.stringify({ name: "cellSearch", args: {}, callId: `failed_${index}` }),
      }).response).status).toBe(422);
    }
    expect((await send(broker, "/execute", { method: "POST",
      body: JSON.stringify({ name: "cellSearch", args: {}, callId: "failed_0" }),
    }).response).status).toBe(409);
    expect((await send(broker, "/execute", { method: "POST",
      body: JSON.stringify({ name: "cellSearch", args: {}, callId: "overflow" }),
    }).response).status).toBe(429);
    expect(execute).toHaveBeenCalledTimes(128);
  });

  it("禁止重复注册工具、额外工具和预取消的 broker", async () => {
    const { tools, controller } = await fixture();
    const input = { tools: [...tools, tools[0]], authorizeCurrentAccess: () => {}, onModelCall: () => {}, signal: controller.signal };
    await expect(createDshToolBroker(input)).rejects.toThrow("catalog mismatch");
    await expect(createDshToolBroker({ ...input, tools: tools.map((tool, index) => index ? tool : { ...tool, name: "bash" }) })).rejects.toThrow("catalog mismatch");
    await expect(createDshToolBroker({ ...input, tools: [...tools, { ...tools[0], name: "bash" }] })).rejects.toThrow("catalog mismatch");
    const optional = { ...tools[0], name: optionalToolNames[0] };
    await expect(createDshToolBroker({ ...input, tools: [...tools, optional, optional] })).rejects.toThrow("catalog mismatch");
    await expect(createDshToolBroker({ ...input, tools: [...tools.slice(1), optional] })).rejects.toThrow("catalog mismatch");
    controller.abort();
    await expect(createDshToolBroker({ ...input, tools })).rejects.toThrow();
  });
});
