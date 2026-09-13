import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWecom, wecomEnvironment } from "./cli";

afterEach(() => vi.unstubAllEnvs());
it("真实官方 CLI 在隔离目录报告未授权，不读取宿主凭据或 AI 密钥", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentcanvas-wecom-native-"));
  const session = { directory, key: "a".repeat(64), expiresAt: Date.now() + 60_000 };
  try {
    vi.stubEnv("DEEPSEEK_API_KEY", "private-test-value"); vi.stubEnv("WECOM_CLI_ADDITIONAL_HEADERS", '{"Authorization":"private"}');
    const env = wecomEnvironment(session);
    expect(env.DEEPSEEK_API_KEY).toBeUndefined(); expect(env.WECOM_CLI_ADDITIONAL_HEADERS).toBeUndefined();
    expect(env.WECOM_CLI_CONFIG_DIR).toBe(join(directory, "config"));
    expect(await runWecom(session, ["auth", "show", "--status"])).toBe("unauthorized");
    const help = await runWecom(session, ["auth", "init", "--help"]);
    expect(help).toContain("--output-qrcode"); expect(help).toContain("--no-browser"); expect(help).toContain("--noninteractive");
    const controller = new AbortController(); controller.abort();
    await expect(runWecom(session, ["auth", "show", "--status"], controller.signal)).rejects.toThrow("取消");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
