import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { authJobs, type WecomSession } from "./session";

const MAX_OUTPUT_BYTES = 128 * 1024;
export function wecomBinary(): string {
  const binary = process.platform === "win32" ? "wecom-cli.exe" : "wecom-cli";
  const bundled = join(process.cwd(), "vendor", "wecom", binary);
  if (existsSync(bundled)) return bundled;
  const require = createRequire(join(process.cwd(), "package.json"));
  const cliRequire = createRequire(require.resolve("@wecom/cli/package.json"));
  return join(dirname(cliRequire.resolve(`@wecom/cli-${process.platform}-${process.arch}/package.json`)), "bin", binary);
}
export function wecomEnvironment(session: WecomSession): NodeJS.ProcessEnv {
  // Do not inherit API keys, user-supplied WeCom headers or credentials from the host.
  const allowed = /^(?:PATH|SystemRoot|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|HOME|LANG|LC_ALL|SSL_CERT_FILE|SSL_CERT_DIR)$/i;
  return { NODE_ENV: process.env.NODE_ENV, ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key))),
    WECOM_CLI_CONFIG_DIR: join(session.directory, "config"), WECOM_CLI_TMP_DIR: join(session.directory, "tmp") };
}
export async function runWecom(session: WecomSession, args: string[], signal?: AbortSignal, timeoutMs = 9_000): Promise<string> {
  if (signal?.aborted) throw new Error("企业微信调用已取消。");
  return new Promise((resolve, reject) => {
    const child = spawn(wecomBinary(), args, { cwd: session.directory, env: wecomEnvironment(session), windowsHide: true, shell: false, stdio: ["ignore", "pipe", "ignore"] });
    let output = ""; let bytes = 0; let failure: string | undefined;
    const stop = (message: string) => { failure = message; child.kill(); };
    const abort = () => stop("企业微信调用已取消。");
    const timer = setTimeout(() => stop("企业微信调用超时，请缩小范围后重试。"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) stop("返回数据过大，请缩小表格区域或分页读取；尚未获得完整结果。");
      else output += chunk;
    });
    child.once("error", () => { cleanup(); reject(new Error("无法启动企业微信组件，请检查本机 CLI 安装。")); });
    child.once("close", (code) => {
      cleanup();
      if (failure) reject(new Error(failure));
      else if (code !== 0) reject(new Error("企业微信调用失败，请检查授权、文档权限及网络后重试。"));
      else resolve(output.trim());
    });
  });
}
export async function authorized(session: WecomSession) {
  return (await runWecom(session, ["auth", "show", "--status"], undefined, 3_000)) === "authorized";
}
export async function startWecomAuth(session: WecomSession) {
  const current = authJobs.get(session.key);
  if (current && !current.finished) return;
  if ([...authJobs.values()].filter((job) => !job.finished).length >= 3) throw new Error("正在等待授权的连接较多，请稍后重试。");
  await mkdir(join(session.directory, "tmp"), { recursive: true, mode: 0o700 });
  await rm(join(session.directory, "qr.png"), { force: true });
  const child = spawn(wecomBinary(), ["auth", "init", "--noninteractive", "--no-browser", "--output-qrcode", "qr.png"], {
    cwd: session.directory, env: wecomEnvironment(session), windowsHide: true, shell: false, stdio: "ignore",
  });
  const job = { child, startedAt: Date.now(), failed: false, finished: false };
  authJobs.set(session.key, job);
  const timer = setTimeout(() => { job.failed = true; child.kill(); }, 310_000);
  timer.unref();
  child.once("error", () => { clearTimeout(timer); job.failed = true; job.finished = true; });
  child.once("close", (code) => { clearTimeout(timer); job.failed ||= code !== 0; job.finished = true; });
}
export async function readWecomQr(session: WecomSession): Promise<Buffer | undefined> {
  const job = authJobs.get(session.key);
  if (!job || job.finished || Date.now() - job.startedAt > 300_000) return;
  try {
    const buffer = await readFile(join(session.directory, "qr.png"));
    return buffer.length <= 512 * 1024 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? buffer : undefined;
  } catch { return; }
}
