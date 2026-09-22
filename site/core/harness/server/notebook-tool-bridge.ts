import type { LocalDataRuntime } from "@/core/models";
import type { NotebookCell } from "@/core/notebook/definition";
import { DEFAULT_NOTEBOOK_CAPABILITIES } from "@/core/notebook/capabilities";
import { StudioValidationError } from "@/core/schemas/errors";
import { harnessRequestSchema, type HarnessRequest, type HarnessToolExecutionResult, type HarnessToolName } from "../contracts";
import type { HarnessNotebookArtifact } from "../notebook-contracts";
import { editNotebookCellsSchema, type NotebookCellSession } from "../notebook-cell-tools";
import { executeHarnessTool, harnessToolCatalog, type HarnessToolContext } from "../tool-registry";
import { shareToolSchemaPatterns, toolInputSchema } from "../tool-schema";
import { NotebookBridgePreflightError } from "./bridge-preflight";

const requiredToolNames = ["cellSearch", "editNotebookCells", "runNotebookCells", "submitNotebookDraft"] as const;
const csvCellKinds = ["data", "sql", "table", "chart"] as const;

export interface NotebookToolBridgeOptions {
  /** The HTTP boundary, not the model, owns identity and source authorization. */
  request: HarnessRequest;
  dataRuntime: LocalDataRuntime;
  notebookRunner: NonNullable<HarnessToolContext["notebookRunner"]>;
  authorizeCurrentAccess(): void;
  /** The historical CSV PoC remains deliberately narrower than website tasks. */
  profile?: "csv" | "notebook";
  rawWorkbook?: HarnessToolContext["rawWorkbook"];
  notebookCapabilities?: HarnessToolContext["notebookCapabilities"];
  pythonRuntimeInfo?: HarnessToolContext["pythonRuntimeInfo"];
  connectionInspector?: HarnessToolContext["connectionInspector"];
  signal?: AbortSignal;
  clock?: { now(): number; id(): string };
}

export interface NotebookToolBridge {
  catalog(): ReturnType<typeof harnessToolCatalog>;
  execute(name: string, args: unknown, callSignal?: AbortSignal): Promise<HarnessToolExecutionResult>;
  getVerifiedDraft(): HarnessNotebookArtifact | undefined;
  close(): void;
}

function reject(message: string): never {
  throw new StudioValidationError("Notebook 工具桥拒绝请求", [message]);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

async function untilCancelled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  const cancelled = new Promise<never>((_resolve, rejectPromise) => {
    abort = () => rejectPromise(new Error("Notebook 工具会话已关闭或取消。"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Narrow the canonical input schema; do not invent a second cell definition. */
function editParameters(cellKinds: ReadonlySet<string>): Record<string, unknown> {
  const schema = toolInputSchema(editNotebookCellsSchema);
  const items = object(object(object(schema.properties)?.cells)?.items);
  if (!items || !Array.isArray(items.oneOf)) throw new Error("Notebook 编辑目录结构不可用。");
  const allowed = items.oneOf.filter((variant) => {
    const kind = object(object(object(variant)?.properties)?.kind)?.const;
    return typeof kind === "string" && cellKinds.has(kind);
  });
  if (allowed.length !== cellKinds.size) throw new Error("Notebook 编辑目录类型不完整。");
  items.oneOf = allowed;
  return shareToolSchemaPatterns(schema);
}

/** The shared Harness catalog includes capabilities outside this bridge's profile. */
function editDescription(cellKinds: ReadonlySet<string>): string {
  return "按 cellSearch 返回的 editVersion 编辑本任务草稿。同 ID 单元须完整替换，新 ID 新增，其他单元保留。"
    + "afterCellId 指定新增位置（null=开头，省略=末尾）；removeCellIds 仅响应明确删除要求。既有 Data 单元及其 ID、来源必须保留。"
    + "本地 SQL 只读 inputCellIds 对应的 outputName，可同批创建依赖链，数组引用不得重复。"
    + "图表 valueFields 必须引用 number 字段；数据库 bigint/numeric 为保精度可能返回 string，不能仅凭字段名判断。"
    + "需绘图时先确认聚合结果的范围与精度允许，再在 SQL 中显式转换；不要自动把任意高精度值转浮点数。"
    + "改输出名时结构化 ID 引用保留，SQL/Python 源码不会自动改写；须检查回执 outputRenames.codeChecks 中的输入引用及输出赋值，再真实试运行。"
    + (cellKinds.has("warehouseSql") ? "warehouseSql 仅使用本次已授权的 connectionId。" : "")
    + (cellKinds.has("transform") ? "transform 只整理 inputCellId 引用的上游表，steps 沿用原数据配方 Schema 校验与执行；不能通过步骤读取其他来源、文件或连接。" : "")
    + (cellKinds.has("python") ? "Python 直接通过本工具的 cells 提供完整 python 单元定义：id/kind=python/title/inputCellIds/fileNames/outputName/code。"
      + "上游表按 outputName 成为 pandas DataFrame，pd/np 已提供；结果必须赋给 outputName 且为 DataFrame。"
      + "fileNames 只能选本次授权附件，files[文件名] 提供沙箱内读取路径，无跨次隐藏变量。" : "")
    + `本任务仅允许 ${[...cellKinds].join("/")}；仅使用本次授权来源、连接与原件文件。`
    + "编辑后必须 runNotebookCells 真实试运行成功，再 submitNotebookDraft 供用户采用；不修改正式文档或看板。";
}

/** Experimental, task-local business tool adapter. No model loop or persistence. */
export function createNotebookToolBridge(options: NotebookToolBridgeOptions): NotebookToolBridge {
  options.signal?.throwIfAborted();
  options.authorizeCurrentAccess();
  const request = harnessRequestSchema.parse(structuredClone(options.request));
  const notebook = request.notebookContext;
  const profile = options.profile ?? "csv";
  const capabilities = structuredClone(options.notebookCapabilities ?? (profile === "csv"
    ? DEFAULT_NOTEBOOK_CAPABILITIES : { python: { enabled: false, reason: "未提供服务端 Python 能力授权" } }));
  const cellKinds = new Set<string>(csvCellKinds);
  if (profile === "notebook") {
    cellKinds.add("warehouseSql");
    cellKinds.add("transform");
    if (capabilities.python.enabled) cellKinds.add("python");
  }
  if (!notebook) throw new NotebookBridgePreflightError("missing_notebook_context");
  if (request.imageAttachmentManifest?.length || request.userImageEvidence || request.mcpTools?.length
    || request.semanticModel || request.edsWorkspace) {
    throw new NotebookBridgePreflightError("unsupported_task_context");
  }
  if (profile === "csv" && (notebook.sourceIds.length !== 1 || notebook.connections?.length
    || request.rawWorkbookManifest || options.rawWorkbook)) {
    throw new NotebookBridgePreflightError("unsupported_csv_profile");
  }
  const sourceIds = new Set(notebook.sourceIds);
  if (sourceIds.size !== notebook.sourceIds.length || (request.dataSourceId && !sourceIds.has(request.dataSourceId))
    || notebook.sourceIds.some((sourceId) => {
      const source = request.appSpec.dataSources.find((item) => item.id === sourceId);
      return !source || (profile === "csv" && source.sourceType !== "csv") || source.aiAccessPolicy === "pending"
        || !Object.hasOwn(options.dataRuntime.rowsByDataSourceId, sourceId);
    })) {
    throw new NotebookBridgePreflightError("source_unavailable");
  }
  // Only parsed, request-bound workbook data crosses this port. Original bytes
  // and access to the project filesystem stay in the HTTP runner closure.
  const rawWorkbook = options.rawWorkbook ? structuredClone({ fileName: options.rawWorkbook.fileName,
    contentHash: options.rawWorkbook.contentHash, sheets: options.rawWorkbook.sheets }) : undefined;
  const manifest = request.rawWorkbookManifest;
  if (manifest || rawWorkbook) {
    if (!manifest || !rawWorkbook || manifest.fileName !== rawWorkbook.fileName || manifest.contentHash !== rawWorkbook.contentHash
      || JSON.stringify(manifest.sheets) !== JSON.stringify(rawWorkbook.sheets.map((sheet) => ({ name: sheet.sheet,
        rowCount: sheet.data.length, columnCount: sheet.data.reduce((maximum, row) => Math.max(maximum, row.length), 0) })))) {
      throw new NotebookBridgePreflightError("workbook_context_mismatch");
    }
  }
  const connectionIds = new Set(notebook.connections?.filter((connection) => connection.allowAi).map((connection) => connection.id));
  if (profile === "notebook" && !sourceIds.size && !rawWorkbook && !connectionIds.size) {
    throw new NotebookBridgePreflightError("missing_data_context");
  }
  if (!request.appSpec.pages.some((page) => page.id === request.pageId)) throw new NotebookBridgePreflightError("workspace_unavailable");
  const dataCells = notebook.document.cells.filter((cell) => cell.kind === "data");
  if (profile === "csv" && (dataCells.length !== 1 || dataCells[0].sourceDataSourceId !== notebook.sourceIds[0]
    || notebook.document.cells.some((cell) => !cellKinds.has(cell.kind)))) {
    throw new NotebookBridgePreflightError("notebook_cell_unsupported");
  }
  const originalDataSources = new Map(dataCells.map((cell) => [cell.id, cell.sourceDataSourceId]));
  const cellAllowed = (cell: NotebookCell) => cellKinds.has(cell.kind)
    && (cell.kind !== "data" || (sourceIds.has(cell.sourceDataSourceId)
      && (profile !== "csv" || originalDataSources.has(cell.id))))
    && (cell.kind !== "warehouseSql" || connectionIds.has(cell.connectionId))
    && (cell.kind !== "python" || cell.fileNames.every((name) => rawWorkbook && name === rawWorkbook.fileName));
  for (const cell of notebook.document.cells) {
    if (cell.kind === "python" && !capabilities.python.enabled) throw new NotebookBridgePreflightError("python_unavailable");
    if (!cellKinds.has(cell.kind)) throw new NotebookBridgePreflightError("notebook_cell_unsupported");
    if (!cellAllowed(cell)) throw new NotebookBridgePreflightError("notebook_reference_unavailable");
  }
  const toolNames = new Set<HarnessToolName>(requiredToolNames);
  if (profile === "notebook") {
    if (capabilities.python.enabled && options.pythonRuntimeInfo) toolNames.add("getKernelPackagesInfo");
    if (rawWorkbook) { toolNames.add("inspectEdsRawWorkbook"); toolNames.add("readEdsRawRows"); }
    if (connectionIds.size && options.connectionInspector) toolNames.add("inspectConnectionSchema");
  }
  const state: NotebookCellSession = { document: structuredClone(notebook.document), editVersion: 0 };
  const dataRuntime: LocalDataRuntime = {
    rowsByDataSourceId: Object.fromEntries([...sourceIds].map((id) => [id, structuredClone(options.dataRuntime.rowsByDataSourceId[id])])),
  };
  const controller = new AbortController();
  let closed = false;
  let busy = false;
  let verifiedDraft: HarnessNotebookArtifact | undefined;
  const close = () => {
    closed = true;
    verifiedDraft = undefined;
    state.run = undefined;
    state.runVersion = undefined;
    controller.abort(new Error("Notebook 工具会话已关闭。"));
    options.signal?.removeEventListener("abort", close);
  };
  options.signal?.addEventListener("abort", close, { once: true });
  if (options.signal?.aborted) close();
  const check = () => {
    if (closed) reject("Notebook 工具会话已关闭或取消。");
    controller.signal.throwIfAborted();
    try { options.authorizeCurrentAccess(); }
    catch (error) { close(); throw error; }
  };
  const context: HarnessToolContext = {
    request, dataRuntime, notebookCellSession: state,
    now: options.clock?.now ?? Date.now,
    id: options.clock?.id ?? (() => crypto.randomUUID()),
    signal: controller.signal,
    rawWorkbook,
    notebookCapabilities: capabilities,
    pythonRuntimeInfo: options.pythonRuntimeInfo,
    connectionInspector: options.connectionInspector,
    notebookRunner: (artifact) => options.notebookRunner(structuredClone(artifact), {
      request: structuredClone(request), dataRuntime: structuredClone(dataRuntime),
      notebookCapabilities: structuredClone(capabilities),
      now: context.now, id: context.id, signal: controller.signal,
    }),
  };

  return {
    catalog() {
      check();
      return harnessToolCatalog({ request, names: [...toolNames], notebookCapabilities: capabilities }).map((tool) => ({ ...tool,
        ...(tool.name === "cellSearch" ? { description: `${tool.description} 首次读取或列出当前单元可直接传 {}，空 Notebook 也会返回 editVersion。`
          + "后续编辑使用检索结果的 editVersion，不是 document.revision / baseRevision。"
          + "不定位具体单元时省略 cellId、variable；不需要的可选筛选字段也应省略，不要填 null 或空 ID。" } : {}),
        ...(tool.name === "editNotebookCells" ? { parameters: editParameters(cellKinds),
          description: editDescription(cellKinds) } : {}),
      }));
    },
    async execute(name, args, callSignal) {
      check();
      if (![...toolNames].some((allowed) => allowed === name)) reject("本任务不允许调用该工具。");
      if (busy) reject("同一任务的 Notebook 工具不能并行执行。");
      const input = structuredClone(args);
      if (name === "editNotebookCells") {
        const parsed = editNotebookCellsSchema.safeParse(input);
        // Invalid arguments still go through the canonical tool error formatter.
        if (parsed.success && (parsed.data.removeCellIds.some((id) => originalDataSources.has(id))
          || parsed.data.cells.some((cell) => !cellAllowed(cell)
            || (originalDataSources.has(cell.id) && (cell.kind !== "data" || cell.sourceDataSourceId !== originalDataSources.get(cell.id)))))) {
          reject("本实验不能变更原始 Data 来源或使用未授权的来源、连接、原件文件及单元能力。");
        }
      }
      // A rejected concurrent call must never cancel the call that already owns
      // this task. Bind its signal only after the concurrency/argument guards.
      if (callSignal?.aborted) { close(); check(); }
      callSignal?.addEventListener("abort", close, { once: true });
      busy = true;
      if (name === "editNotebookCells" || name === "runNotebookCells") verifiedDraft = undefined;
      try {
        check();
        const result = await untilCancelled(executeHarnessTool(name, input, context), controller.signal);
        check(); // Never publish a late or revoked result, including a submitted draft.
        if (name === "submitNotebookDraft" && result.notebookArtifact) {
          verifiedDraft = structuredClone(result.notebookArtifact);
        }
        return structuredClone(result);
      } finally {
        busy = false;
        callSignal?.removeEventListener("abort", close);
      }
    },
    getVerifiedDraft() {
      check();
      return busy || !verifiedDraft ? undefined : structuredClone(verifiedDraft);
    },
    close,
  };
}
