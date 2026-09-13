import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ChildProcess } from "node:child_process";

const TTL = 30 * 24 * 60 * 60 * 1_000;
export const WECOM_SERVER_ID = "wecom";
export function acceptsWecomRequest(request: Request, mutation = false): boolean {
  const url = new URL(request.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return false;
  const origin = request.headers.get("origin");
  if ((mutation && !origin) || (origin && origin !== url.origin)) return false;
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}
export function sessionCookieName(request: Request) {
  return `agentcanvas_wecom_${createHash("sha256").update(new URL(request.url).origin).digest("hex").slice(0, 12)}`;
}
export function sessionKey(request: Request): string | undefined {
  if (!acceptsWecomRequest(request)) return;
  const name = sessionCookieName(request);
  const token = request.headers.get("cookie")?.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? createHash("sha256").update(token).digest("hex") : undefined;
}
export function wecomOwnershipNamespace(request: Request, base: string) {
  const key = sessionKey(request);
  return key ? `${base}:wecom:${key}` : base;
}
export interface WecomSession { key: string; directory: string; expiresAt: number }
interface Metadata { expiresAt: number; consent: true }
export interface AuthJob { child: ChildProcess; startedAt: number; failed: boolean; finished: boolean }
const globalState = globalThis as typeof globalThis & { __agentcanvasWecomJobs?: Map<string, AuthJob> };
export const authJobs = globalState.__agentcanvasWecomJobs ??= new Map();

function directoryFor(key: string) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("连接标识无效。");
  const root = process.env.STUDIO_LOCAL_STATE_DIR?.trim();
  if (!root) throw new Error("企业微信连接需要本机持久化服务，请使用 3001 开发站或 3000 稳定站。");
  return join(resolve(root), "wecom", key);
}
export async function getWecomSession(request: Request): Promise<WecomSession | undefined> {
  const key = sessionKey(request);
  if (!key) return;
  try {
    const directory = directoryFor(key);
    const metadata = JSON.parse(await readFile(join(directory, "session.json"), "utf8")) as Metadata;
    if (metadata.consent !== true || !Number.isFinite(metadata.expiresAt) || metadata.expiresAt <= Date.now()) return;
    return { key, directory, expiresAt: metadata.expiresAt };
  } catch { return; }
}
export async function createWecomSession(request: Request) {
  const token = randomBytes(32).toString("hex");
  const key = createHash("sha256").update(token).digest("hex");
  const session = { key, directory: directoryFor(key), expiresAt: Date.now() + TTL };
  await mkdir(session.directory, { recursive: true, mode: 0o700 });
  await writeFile(join(session.directory, "session.json"), JSON.stringify({ expiresAt: session.expiresAt, consent: true }), { mode: 0o600, flag: "wx" });
  return { session, cookie: `${sessionCookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL / 1_000}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}` };
}
export async function revokeWecomSession(session: WecomSession) {
  // Directory is re-derived from a validated hash, never accepted from browser input.
  const directory = directoryFor(session.key);
  await writeFile(join(directory, "session.json"), JSON.stringify({ consent: false, expiresAt: 0 }), { mode: 0o600 });
  const job = authJobs.get(session.key);
  if (job && !job.finished) {
    await new Promise<void>((done) => { job.child.once("close", () => done()); job.child.kill(); });
  }
  authJobs.delete(session.key);
  await rm(directory, { recursive: true, force: true });
}
