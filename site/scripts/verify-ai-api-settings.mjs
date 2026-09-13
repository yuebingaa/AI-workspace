import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const baseUrl = process.env.AI_API_SETTINGS_TEST_BASE_URL || "http://localhost:3000";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const evidenceDirectory = resolve("evidence", "ai-api-settings");
const syntheticSecret = "sk-visual-verification-only";
await mkdir(evidenceDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 30_000 });
  const initialStatus = await (await page.request.get(`${baseUrl}/api/settings/ai`)).json();
  await page.getByRole("button", { name: "配置 AI API" }).click();
  const dialog = page.getByRole("dialog", { name: "AI 接口配置" });
  await dialog.waitFor({ state: "visible" });
  if (initialStatus.configured) await dialog.getByText("DeepSeek API 已配置", { exact: true }).waitFor({ state: "visible" });
  const configured = initialStatus.configured === true;
  if (configured) await dialog.getByRole("button", { name: "更换密钥" }).click();
  const input = dialog.getByLabel("DeepSeek API Key");
  await input.fill(syntheticSecret);
  if (await input.getAttribute("type") !== "password") throw new Error("API Key 输入框不是 password 类型。");
  if ((await dialog.innerText()).includes(syntheticSecret)) throw new Error("API Key 出现在可见页面文本中。");
  await page.screenshot({ path: resolve(evidenceDirectory, "api-settings-password-input.png"), fullPage: false });
  await dialog.getByRole("button", { name: "保存并隐藏" }).click();
  await dialog.getByText("DeepSeek API 已配置", { exact: true }).waitFor({ state: "visible" });
  if ((await dialog.innerText()).includes(syntheticSecret)) throw new Error("保存后 API Key 出现在可见页面文本中。");
  await page.screenshot({ path: resolve(evidenceDirectory, "api-settings-saved-hidden.png"), fullPage: false });
  console.log(JSON.stringify({ configuredOnLoad: configured, passwordInput: true, saved: true, secretVisibleInText: false }, null, 2));
} finally {
  await page.request.delete(`${baseUrl}/api/settings/ai`).catch(() => undefined);
  await browser.close();
}
