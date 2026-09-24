import type { AgentEngineId, AgentEngineSettings } from "../contracts";

export class AgentEngineSelectionError extends Error {
  readonly status = 409;
}

/** Process-owned selection, separate from model credentials and project documents. */
export class AgentEngineSelection {
  private engine: AgentEngineId;
  private revision = 0;
  private activeTasks = 0;

  constructor(initialEngine: AgentEngineId = "harness") {
    this.engine = initialEngine;
  }

  status(dsh: AgentEngineSettings["dsh"]): AgentEngineSettings {
    return { engine: this.engine, revision: this.revision, activeTasks: this.activeTasks,
      persistence: "process-memory", dsh: { ...dsh }, plugins: [{
        id: "dsh-notebook", name: "Notebook 数据分析", description: "已选授权数据源的 Data / SQL / 整理 / 表格 / 图表 / 说明 / 参数；说明可引用本轮完整单行结果，参数以单行表传入本地 SQL 或 Python。选择单表语义模型后可用语义查询，沿用固定指标口径。草稿需人工采用。",
        tools: ["cellSearch", "editNotebookCells", "runNotebookCells", "submitNotebookDraft"],
      }, {
        id: "dsh-excel-python", name: "Excel 原件与 Python", description: "按本次附件开放原件检查与有限预览；Python 通过 Notebook 沙箱执行，须部署能力可用。",
        tools: ["inspectEdsRawWorkbook", "readEdsRawRows", "getKernelPackagesInfo"],
      }, {
        id: "dsh-database", name: "只读数据库分析", description: "按服务端 AI 授权连接开放 Schema 检查；查询通过 warehouseSql 单元执行，不向 DSH 提供数据库凭据。",
        tools: ["inspectConnectionSchema"],
      }] };
  }

  select(input: { engine: AgentEngineId; revision: number }, dsh: AgentEngineSettings["dsh"]): AgentEngineSettings {
    if (input.revision !== this.revision) throw new AgentEngineSelectionError("执行引擎设置已变化，请刷新后重新选择。");
    if (this.activeTasks) throw new AgentEngineSelectionError("仍有分析任务正在执行，请等待完成或取消后再切换。");
    if (input.engine === "dsh" && !dsh.available) throw new AgentEngineSelectionError("DSH 运行组件尚不可用，当前执行引擎未改变。");
    if (input.engine !== this.engine) { this.engine = input.engine; this.revision++; }
    return this.status(dsh);
  }

  acquire(forced?: AgentEngineId): { engine: AgentEngineId; release(): void } {
    const engine = forced ?? this.engine;
    this.activeTasks++;
    let released = false;
    return { engine, release: () => {
      if (released) return;
      released = true;
      this.activeTasks--;
    } };
  }
}

const selectionKey = Symbol.for("agentcanvas.execution-engine-selection.v1");
const shared = globalThis as typeof globalThis & { [key: symbol]: unknown };
/** Deployment startup default, never a browser request or a persisted user choice. */
export function configuredInitialEngine(value: string | undefined): AgentEngineId {
  if (value === undefined || value === "harness") return "harness";
  if (value === "dsh") return "dsh";
  throw new Error("AGENTCANVAS_DEFAULT_ENGINE must be harness or dsh.");
}
export const agentEngineSelection = (shared[selectionKey] ??= new AgentEngineSelection(
  configuredInitialEngine(process.env.AGENTCANVAS_DEFAULT_ENGINE),
)) as AgentEngineSelection;
// Development hot reload must refresh behavior/catalog without replacing the
// process-owned selection or invalidating active leases and their release hooks.
Object.setPrototypeOf(agentEngineSelection, AgentEngineSelection.prototype);
