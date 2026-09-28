import type { DshPluginDocument, DshPluginEntry } from "../plugin-settings";

export type DshPackageInventory = Record<string, { installed: boolean; version?: string }>;
/** This is the website integration catalog, not a claim to list all upstream packages. */
export function buildDshPluginCatalog(document: DshPluginDocument, packages: DshPackageInventory): DshPluginEntry[] {
  const official = (id: string, name: string, description: string, scope: DshPluginEntry["scope"],
    state: DshPluginEntry["state"], reason: string, tools: string[] = [], configurable = false): DshPluginEntry => ({
    id, name, description, scope, origin: "official", state: packages[id]?.installed ? state : "unavailable",
    reason: packages[id]?.installed ? reason : "当前固定安装中缺少此组件；不会自动安装或换版本。",
    ...(packages[id]?.version ? { version: packages[id].version } : {}), tools, configurable: configurable && Boolean(packages[id]?.installed),
  });
  const skillReady = packages["dsh-skill"]?.installed && packages["dsh-tool-skill"]?.installed;
  return [
    official("dsh-tool-skill", "Skill 加载", "按需加载内置的数据检查和 Notebook 分析说明。", "session",
      !skillReady ? "unavailable" : document.config.skills ? "configured" : "disabled",
      !skillReady ? "Skill 注册服务或工具组件缺失，不能启用。" : "官方 Skill registry + tool；只加载网站内置说明，不扫描本机文件。保存后下一轮任务生效。", ["skill"], Boolean(skillReady)),
    { id: "agentcanvas-notebook", name: "Notebook 数据分析", description: "读取、编辑、试运行与提交分析草稿。", scope: "session", origin: "website",
      state: "conditional", reason: "按本轮数据授权与 Notebook 状态提供；草稿仍须确认采用。", configurable: false,
      tools: ["cellSearch", "editNotebookCells", "runNotebookCells", "submitNotebookDraft"] },
    { id: "agentcanvas-sources", name: "Excel、Python 与数据库", description: "原件结构、Python 环境与已授权连接 Schema。", scope: "session", origin: "website",
      state: "conditional", reason: "依本轮附件、部署能力和连接授权提供，不在这里扩大数据访问范围。", configurable: false,
      tools: ["inspectEdsRawWorkbook", "readEdsRawRows", "getKernelPackagesInfo", "inspectConnectionSchema"] },
    official("dsh-agent-loop", "Agent 执行循环", "官方 DSH 负责模型调用与工具决策。", "global", "configured", "执行时由最小 SDK 组装；运行组件就绪不代表模型任务必定成功。"),
    official("dsh-tools", "工具注册与调度", "注册本轮业务工具，校验允许的工具集合。", "global", "configured", "网站必需基础组件，不提供独立关闭。"),
    official("dsh-session-persistence-jsonl", "原生会话记录", "持久保存已验证并接受的会话代。", "global", "conditional", "仅部署持久化可用时启用；失败或取消的候选不进入后续历史。"),
    official("dsh-skill-filesystem", "本机 Skill 目录", "从本地目录发现 Skill。", "session", "not-integrated", "本批使用内置说明，不扫描用户目录；目录范围配置尚未接入。"),
    official("dsh-compaction-basic", "上下文压缩", "整理长会话上下文。", "session", "not-integrated", "尚未接入压缩依赖及历史验证；不显示无效开关。"),
    official("dsh-tool-ask-user", "提问澄清", "结构化提问后等待用户回答。", "session", "not-integrated", "尚未接入问答等待、恢复和取消交互；普通文字澄清仍可用。"),
    official("dsh-tool-pwsh", "PowerShell 终端", "执行本机命令。", "session", "disabled", "本网站尚未提供可授权的终端执行范围，当前策略禁用。"),
    official("dsh-tool-fs", "文件读写", "直接读写本机文件。", "session", "disabled", "未接入受控文件范围；现有项目导入、保存走网站业务能力。"),
  ];
}
