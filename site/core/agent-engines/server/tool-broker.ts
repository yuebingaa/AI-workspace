import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import type { DshDriverTool } from "./dsh-engine";
import { HarnessToolArgumentsError } from "@/core/harness/tool-registry";
import { sanitizeToolArgumentIssues } from "../../../runtime/dsh/tool-diagnostics.mjs";
import { catalogToolNames } from "../../../runtime/dsh/policy.mjs";
import { trustedNotebookSearchFailure } from "./tool-error-message";

const inputSchema = z.object({ name: z.string().min(1).max(100), args: z.unknown(), callId: z.string().min(1).max(200) }).strict();
const maxBytes = 512 * 1024;
class BrokerError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new BrokerError(415, "JSON required");
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) {
    throw new BrokerError(413, "Tool request too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new BrokerError(413, "Tool request too large");
    chunks.push(bytes);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
  catch { throw new BrokerError(400, "Invalid JSON"); }
}

/** One short-lived, token-bound loopback capability per DSH task; never a website route. */
export async function createDshToolBroker(input: {
  tools: DshDriverTool[];
  authorizeCurrentAccess(): void;
  onModelCall(): void;
  signal: AbortSignal;
}) {
  input.signal.throwIfAborted();
  const tools = new Map(input.tools.map((tool) => [tool.name, { name: tool.name, description: tool.description,
    parameters: structuredClone(tool.parameters), execute: tool.execute.bind(tool) }]));
  // The website broker and SDK child share the same closed capability sets.
  try { catalogToolNames(input.tools); }
  catch { throw new Error("DSH tool catalog mismatch"); }
  const token = randomBytes(32).toString("hex");
  const authorization = Buffer.from(`Bearer ${token}`);
  const calls = new Set<string>();
  const shutdown = new AbortController();
  let url = "", closed = false;

  function respond(response: ServerResponse, status: number, body: unknown) {
    if (response.destroyed || response.writableEnded) return;
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > maxBytes) throw new BrokerError(413, "Tool observation too large");
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store",
      "x-content-type-options": "nosniff", "connection": "close" });
    response.end(encoded);
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (closed || request.socket.remoteAddress !== "127.0.0.1" || request.headers.origin !== undefined
      || request.headers.host !== new URL(url).host || supplied.length !== authorization.length
      || !timingSafeEqual(supplied, authorization)) throw new BrokerError(403, "Unauthorized tool request");
    const disconnected = new AbortController();
    const onClose = () => { if (!response.writableEnded) disconnected.abort(); };
    response.once("close", onClose);
    const signal = AbortSignal.any([input.signal, shutdown.signal, disconnected.signal]);
    try {
      signal.throwIfAborted();
      input.authorizeCurrentAccess();
      if (request.method === "GET" && request.url === "/catalog") {
        respond(response, 200, { tools: [...tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })) });
      } else if (request.method === "POST" && request.url === "/authorize") {
        const body = await readJson(request);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new BrokerError(400, "Empty object required");
        signal.throwIfAborted();
        input.authorizeCurrentAccess();
        input.onModelCall();
        signal.throwIfAborted();
        input.authorizeCurrentAccess();
        respond(response, 200, { authorized: true });
      } else if (request.method === "POST" && request.url === "/execute") {
        const parsed = inputSchema.safeParse(await readJson(request));
        if (!parsed.success) throw new BrokerError(400, "Invalid tool request");
        const tool = tools.get(parsed.data.name);
        if (!tool) throw new BrokerError(403, "Tool not allowed");
        if (calls.has(parsed.data.callId)) throw new BrokerError(409, "Duplicate tool call");
        if (calls.size >= 128) throw new BrokerError(429, "Tool call ledger full");
        signal.throwIfAborted();
        input.authorizeCurrentAccess();
        calls.add(parsed.data.callId);
        let result: Awaited<ReturnType<DshDriverTool["execute"]>>;
        try { result = await tool.execute(parsed.data.args, signal); }
        catch (error) {
          // Only trusted validation and finite search codes may be exposed, after
          // a fresh permission check; arbitrary business exceptions stay generic.
          const searchFailure = trustedNotebookSearchFailure(tool.name, error);
          const argumentError = error instanceof HarnessToolArgumentsError && error.toolName === tool.name ? error : undefined;
          if (!searchFailure && !argumentError) throw error;
          signal.throwIfAborted();
          input.authorizeCurrentAccess();
          signal.throwIfAborted();
          respond(response, 422, searchFailure ?? { error: { code: "invalid_tool_arguments",
            issues: sanitizeToolArgumentIssues(argumentError?.issueSummary, tool.parameters) } });
          return;
        }
        signal.throwIfAborted();
        input.authorizeCurrentAccess();
        respond(response, 200, { summary: result.summary, data: result.data });
      } else throw new BrokerError(404, "Unknown broker operation");
    } finally { response.removeListener("close", onClose); }
  }

  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 8_192 }, (request, response) => {
    void handle(request, response).catch((error: unknown) => {
      respond(response, error instanceof BrokerError ? error.status : 422,
        { error: { message: error instanceof BrokerError ? error.message : "工具执行或授权验证失败，请检查输入或结束任务。" } });
    });
  });
  server.maxConnections = 8;
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("DSH broker unavailable"); }
  url = `http://127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closed = true;
    shutdown.abort();
    input.signal.removeEventListener("abort", onAbort);
    closing = new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    return closing;
  };
  const onAbort = () => { void close(); };
  input.signal.addEventListener("abort", onAbort, { once: true });
  if (input.signal.aborted) { await close(); input.signal.throwIfAborted(); }
  return { url, token, close };
}
