import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentEngineSettings as AgentEngineStatus } from "@/core/agent-engines/contracts";
import { AgentEngineSettings, AgentEngineSettingsContent, readAgentEngineSettingsResponse } from "./AgentEngineSettings";

const status: AgentEngineStatus = {
  engine: "harness", revision: 3, activeTasks: 0, persistence: "process-memory",
  dsh: { available: true, version: "0.1.6-alpha.2" },
  plugins: [{ id: "notebook", name: "Notebook 工具桥", description: "真实试运行与待采用草稿。",
    tools: ["cellSearch", "editNotebookCells", "runNotebookCells", "submitNotebookDraft"] }],
};
const callbacks = { onEngineChange: () => {}, onRefresh: () => {}, onApply: () => {}, onClose: () => {} };
function content(options: Partial<Parameters<typeof AgentEngineSettingsContent>[0]> = {}) {
  return renderToStaticMarkup(<AgentEngineSettingsContent status={status} selectedEngine="harness" loading={false} busy={false} {...callbacks} {...options} />);
}
function applyButton(html: string) { return html.match(/<button[^>]*>应用执行引擎<\/button>/)?.[0]; }
function dshRadio(html: string) { return html.match(/<input[^>]*value="dsh"[^>]*>/)?.[0]; }

describe("Agent 执行与插件设置", () => {
  it("展示真实引擎范围、进程内保存及四工具目录，不伪装插件安装管理", () => {
    const html = content();
    expect(html).toContain("原版 Harness");
    expect(html).toContain("DeepSeek Harness");
    expect(html).toContain("0.1.6-alpha.2");
    expect(html).toContain("只读目录");
    for (const tool of status.plugins[0].tools) expect(html).toContain(`<code>${tool}</code>`);
    expect(html).toContain("本次附带的 Excel 原件");
    expect(html).toContain("连接须允许 AI 使用");
    expect(html).toContain("不代表全部已启用");
    expect(html).toContain("不提供安装、卸载或独立启停");
    expect(html).toContain("不自动切换引擎");
    expect(html).toContain("重启后恢复原版");
    expect(html).toContain("不会运行数据或调用模型");
    expect(html).not.toContain('type="password"');
    expect(applyButton(html)).toContain('disabled=""');
  });

  it("仅选择不同且可用的引擎后才开放显式应用", () => {
    expect(applyButton(content({ selectedEngine: "dsh" }))).not.toContain("disabled");
    expect(dshRadio(content({ selectedEngine: "dsh" }))).toContain('checked=""');
    expect(applyButton(content({ status: { ...status, engine: "dsh" }, selectedEngine: "harness" }))).not.toContain("disabled");
  });

  it("组件不可用显示原因并禁选 DSH，仍可返回原版", () => {
    const unavailable = { ...status, dsh: { available: false, reason: "本机未安装固定版本组件。" } };
    const html = content({ status: unavailable, selectedEngine: "dsh" });
    expect(html).toContain("当前不可用");
    expect(html).toContain("本机未安装固定版本组件。");
    expect(dshRadio(html)).toContain('disabled=""');
    expect(applyButton(html)).toContain('disabled=""');
    expect(applyButton(content({ status: { ...unavailable, engine: "dsh" }, selectedEngine: "harness" }))).not.toContain("disabled");
  });

  it.each([{ disabled: true }, { status: { ...status, activeTasks: 1 } }])("窗口或服务端存在任务时禁止切换", options => {
    const html = content({ selectedEngine: "dsh", ...options });
    expect(html).toContain("有任务正在执行");
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(applyButton(html)).toContain('disabled=""');
  });

  it("加载失败仅允许刷新；不展示未经确认的可用性", () => {
    const html = content({ status: null, needsRefresh: true, error: "读取失败" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("读取失败");
    expect(html).toContain("请先刷新状态再操作");
    expect(html).not.toContain("本机组件可用");
    expect(applyButton(html)).toContain('disabled=""');
    expect(html).toContain('<button type="button">刷新状态</button>');
  });

  it("应用中锁定选择和关闭；失败或未确认回执必须先刷新", () => {
    const busy = content({ selectedEngine: "dsh", busy: true });
    expect(busy).toContain("正在应用…");
    expect(busy).toMatch(/aria-label="关闭 Agent 执行与插件" disabled=""/);
    expect(busy).toContain('<button type="button" disabled="">取消</button>');
    expect(applyButton(content({ selectedEngine: "dsh", needsRefresh: true }))).toContain('disabled=""');
  });

  it("加载、应用成功和空目录有真实文字状态，服务端文本按文本转义", () => {
    expect(content({ status: null, loading: true })).toContain("正在读取执行引擎状态…");
    expect(content({ notice: "已切换为原版 Harness，仅对后续任务生效。" })).toContain('role="status"');
    expect(content({ status: { ...status, plugins: [] } })).toContain("当前没有已接入的工具插件");
    const html = content({ status: { ...status, dsh: { available: false, reason: "<img src=x onerror=alert(1)>" } } });
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
  });

  it("支持菜单受控入口；默认不挂载弹窗或发出设置请求", () => {
    expect(renderToStaticMarkup(<AgentEngineSettings />)).toContain('aria-label="Agent 执行与插件"');
    expect(renderToStaticMarkup(<AgentEngineSettings hideTrigger />)).toBe("");
    const html = renderToStaticMarkup(<AgentEngineSettings hideTrigger open disabled />);
    expect(html).toContain('aria-labelledby="agent-engine-settings-heading"');
    expect(html).toContain("正在读取执行引擎状态…");
    expect(html).not.toContain('aria-label="Agent 执行与插件"');
  });

  it("设置读取严格使用共享 DTO，拒绝坏响应且保留服务端冲突原因", async () => {
    await expect(readAgentEngineSettingsResponse(Response.json(status))).resolves.toEqual(status);
    await expect(readAgentEngineSettingsResponse(Response.json({ ...status, engine: "unknown" }))).rejects.toThrow("响应格式无效");
    await expect(readAgentEngineSettingsResponse(new Response("<html>private internal page</html>"))).rejects.toThrow("响应格式无效");
    await expect(readAgentEngineSettingsResponse(Response.json({ error: { message: "设置已变化，请刷新。" } }, { status: 409 }))).rejects.toThrow("设置已变化");
    await expect(readAgentEngineSettingsResponse(Response.json({}, { status: 503 }))).rejects.toThrow("无法读取或更新");
  });
});
