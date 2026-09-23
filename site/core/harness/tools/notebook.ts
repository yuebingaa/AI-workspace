import { defineTool } from "./contracts";
import { harnessAnalysisPlanDraftSchema } from "../analysis-plan-contracts";
import { createHarnessAnalysisPlanArtifact } from "../analysis-planner";
import { resolveHarnessPageDataSourceIds } from "../source-scope";
import { z } from "zod";
import { StudioValidationError } from "@/core/schemas/errors";
import { harnessNotebookDraftSchema } from "../notebook-contracts";
import { createHarnessNotebookArtifact } from "../notebook";
import { captureNotebookRunExpectation, parseNotebookRunReceipt } from "@/core/notebook/run-receipt";
import type { NotebookRun } from "@/core/notebook/contracts";
import { requiresSuccessfulNotebookTrial } from "@/core/notebook/cell-catalog";
import { notebookTextResults } from "../notebook-text-results";
import { cellSearchSchema, cellSearch, editNotebookCellsSchema, editNotebookCells, createPythonCellSchema, createPythonCell, notebookSessionVersionSchema, runNotebookCells, submitNotebookDraft } from "../notebook-cell-tools";

export const createAnalysisPlan = defineTool({
  name: "createAnalysisPlan",
  description: "把业务问题规划为可验证的分析步骤。支持 data、warehouseSql、sql、python、transform、semanticQuery、table、chart、text；SQL/Python 只描述转换目标，不在规划阶段写代码。字段用上游 fields.name 或已定义输出别名，不能用 label；中文放 title。服务端校验数据源、字段、模型版本、依赖和交付物。只生成计划，不修改 Notebook 或 AppSpec。",
  mode: "readOnly",
  schema: harnessAnalysisPlanDraftSchema,
  execute: (draft, context) => {
    const artifact = createHarnessAnalysisPlanArtifact(draft, {
      request: context.request,
      allowedDataSourceIds: resolveHarnessPageDataSourceIds(context.request),
      now: context.now,
      id: context.id,
    });
    context.analysisPlanStore?.set(artifact.id, artifact);
    return {
      summary: `Analysis Plan“${artifact.name}”已通过校验：${artifact.steps.length} 个步骤，目标是${artifact.objective}`,
      data: {
        analysisPlanArtifactId: artifact.id,
        name: artifact.name,
        status: artifact.status,
        objective: artifact.objective,
        questions: artifact.questions,
        steps: artifact.steps,
        deliverables: artifact.deliverables,
        assumptions: artifact.assumptions ?? [],
        executionOrder: artifact.executionOrder,
        sourceDataSourceIds: artifact.sourceDataSourceIds,
      },
      analysisPlanArtifact: artifact,
    };
  },
});

export const inspectConnectionSchema = defineTool({
  name: "inspectConnectionSchema",
  description: "检索当前 Notebook 已授权连接的版本化表/字段目录，不读取业务行。创建 warehouseSql 前确认表和列名。search 可按数据库、schema、表或字段名筛选；offset 对筛选结果分页。目录最多 500 列，truncated 表示远端仍有未加载部分，搜索无结果不证明对象不存在。目录时间不代表业务数据更新时间。",
  mode: "readOnly",
  schema: z.object({ connectionId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/u), offset: z.number().int().min(0).max(499).default(0), search: z.string().trim().max(160).optional() }).strict(),
  execute: async ({ connectionId, offset, search }, context) => {
    if (!context.request.notebookContext?.connections?.some((item) => item.id === connectionId && item.allowAi) || !context.connectionInspector) {
      throw new StudioValidationError("连接目录不可用", ["此连接未授权给当前 Agent 或未配置连接运行时"]);
    }
    const schema = await context.connectionInspector(connectionId, context.signal);
    const columns = schema.columns.filter((column) => !search || [column.table_catalog, column.table_schema, column.table_name, column.column_name].join(".").toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    return { summary: `已读取连接 ${connectionId} 的字段目录`, data: {
      connectionId, columns: columns.slice(offset, offset + 15), offset,
      nextOffset: offset + 15 < columns.length ? offset + 15 : null,
      truncated: schema.truncated,
      ...(schema.catalog ? { catalog: schema.catalog } : {}),
    } };
  },
});

export const createNotebookDraft = defineTool({
  name: "createNotebookDraft",
  description: "创建完整待确认 Notebook 草稿。支持 data、warehouseSql、sql、python、transform、semanticQuery、table、chart、text。SQL 单条 SELECT/WITH，只引用 inputCellIds 的 outputName。Python 用 code/inputCellIds/fileNames/outputName，pd/np 已提供，结果必须为 DataFrame；原始附件用 files[文件名]，不联网安装包。transform 用 DataRecipe steps 处理完整上游。warehouseSql 用授权 connectionId，先查结构。语义模型优先 semanticQuery，上游必须为 data。保留其他单元 ID。服务端真实试运行，采用前不修改 Notebook 或 AppSpec。",
  mode: "readOnly",
  schema: harnessNotebookDraftSchema,
  execute: async (draft, context) => {
    const analysisPlan = draft.analysisPlanId ? context.analysisPlanStore?.get(draft.analysisPlanId) : undefined;
    if (context.analysisPlanStore && context.analysisPlanStore.size > 0 && !draft.analysisPlanId) {
      throw new StudioValidationError("Notebook 草稿校验失败", ["必须引用本次 Analysis Planner 返回的 analysisPlanArtifactId。"]);
    }
    const artifact = createHarnessNotebookArtifact(draft, {
      request: context.request,
      allowedDataSourceIds: resolveHarnessPageDataSourceIds(context.request),
      now: context.now,
      id: context.id,
      ...(analysisPlan ? { analysisPlan } : {}),
    });
    if (context.request.notebookContext) artifact.baseRevision = context.request.notebookContext.document.revision;
    const expected = captureNotebookRunExpectation({ name: artifact.name, revision: artifact.baseRevision ?? 0, cells: artifact.cells }, "ai");
    const diagnosticGeneration = context.notebookDiagnostics?.begin(artifact);
    // An adapter receives its own copy; its mutations cannot replace the reviewed draft.
    const runner = context.notebookRunner;
    const rawRun = runner ? await runner(structuredClone(artifact), context) : undefined;
    context.signal?.throwIfAborted();
    let run: NotebookRun | undefined;
    if (runner) {
      try { run = parseNotebookRunReceipt(rawRun, expected); }
      catch { throw new StudioValidationError("Notebook 草稿校验失败", ["执行回执与本次草稿不一致，不能作为验证证据。"]); }
    }
    if (run && diagnosticGeneration !== undefined) context.notebookDiagnostics?.recordRun(diagnosticGeneration, run);
    if (draft.cells.some(requiresSuccessfulNotebookTrial) && !run) throw new StudioValidationError(
      draft.cells.some((cell) => cell.kind === "text" && cell.references?.length) ? "Notebook 文本引用运行时未配置"
        : draft.cells.some((cell) => cell.kind === "parameter") ? "Notebook 计算 / 参数运行时未配置" : "Notebook SQL / Python / DataRecipe 运行时未配置",
      ["不能仅凭生成步骤就报告验证通过"],
    );
    if (run?.status === "failure") throw new StudioValidationError("Notebook 试运行失败", run.cells.filter((cell) => cell.status !== "success").map((cell) => `${cell.cellId}: ${cell.error}`));
    if (run) artifact.executionEvidence = { runId: run.runId, status: run.status,
      completedCellIds: run.cells.filter((cell) => cell.status === "success").map((cell) => cell.cellId),
      summary: `${run.cells.length} 个单元已试运行；图表尚待用户在 Notebook 中查看渲染结果。` };
    return {
      summary: `Notebook 草稿“${artifact.name}”已通过校验：${artifact.cells.length} 个单元、${artifact.lineage.filter((item) => item.dependsOn.length > 0).length} 条依赖；正式 AppSpec 尚未修改。`,
      data: {
        notebookArtifactId: artifact.id,
        name: artifact.name,
        status: artifact.status,
        cellCount: artifact.cells.length,
        cellTypes: artifact.cells.map((cell) => cell.kind),
        executionOrder: artifact.executionOrder,
        lineage: artifact.lineage,
        sourceDataSourceIds: artifact.sourceDataSourceIds,
        ...(artifact.analysisPlanId ? { analysisPlanId: artifact.analysisPlanId } : {}),
        ...(run ? { execution: artifact.executionEvidence, notice: run.notice, ...notebookTextResults(run),
          results: run.cells.filter((cell) => cell.table && draft.cells.find((item) => item.id === cell.cellId)?.kind !== "data")
            .slice(-3).map((cell) => ({ cellId: cell.cellId, resultRef: cell.resultRef, rows: cell.table!.rows.slice(0, 5), fields: cell.table!.fields,
              returnedRows: cell.table!.rows.length, truncated: cell.table!.truncated })) } : {}),
      },
      notebookArtifact: artifact,
    };
  },
});

export const cellSearchTool = defineTool({ name: "cellSearch", mode: "readOnly", schema: cellSearchSchema,
  description: "query 搜名称/声明变量；searchIn=source 搜源码；kind 筛类型。cellId/variable 互斥，非 self 遍历须锚点。分页带 editVersion 和返回的 next*，output 再带 runId。output 只读本任务有效 AI 回执：未运行/过期不是空表，截断有标记，不解析 Python 变量。默认值/范围见 Schema。", execute: cellSearch });

export const editNotebookCellsTool = defineTool({ name: "editNotebookCells", mode: "readOnly", schema: editNotebookCellsSchema,
  description: "按 editVersion 编辑任务草稿：同 ID 完整替换，新 ID 新增，其他单元保留。afterCellId 指定新增位置（null=开头，省略=末尾）；removeCellIds 仅响应明确删除要求。SQL 只读 inputCellIds 对应 outputName，可同批创建依赖链，数组引用不得重复。改输出名时结构化 ID 引用保留，SQL/Python 不自动改写；按回执 outputRenames.codeChecks 检查输入引用和 Python 输出赋值。Python 用专用工具。编辑后须试运行成功再提交；不改正式文档。", execute: editNotebookCells });

export const createPythonCellTool = defineTool({ name: "createPythonCell", mode: "readOnly", schema: createPythonCellSchema,
  description: "CreatePythonCell：按 editVersion 在任务草稿创建或更新一个 Python 单元。cell 含 id/kind=python/title/inputCellIds/fileNames/outputName/code。输入表按 outputName 成为 pandas DataFrame；pd、np 已提供。结果必须赋给输出名并为 DataFrame。改输出名时检查回执 outputRenames.codeChecks，代码不会自动改写。fileNames 只能选本次附件，files[文件名] 给出虚拟路径供 pd.read_excel 使用。保存后仍须 runNotebookCells、submitNotebookDraft，不自动采用。", execute: createPythonCell });

export const getKernelPackagesInfoTool = defineTool({ name: "getKernelPackagesInfo", mode: "readOnly", schema: z.object({}).strict(),
  description: "GetKernelPackagesInfo：查询本机 Python Runtime、Python 版本、固定包版本及运行限制。不安装包或执行代码。pandas、numpy、openpyxl 已预置；不支持在分析中联网 pip 安装。",
  execute: async (_args, context) => {
    if (!context.pythonRuntimeInfo) throw new StudioValidationError("Python Runtime 不可用", ["运行环境信息接口未配置"]);
    const data = await context.pythonRuntimeInfo();
    return { summary: data.available ? "Python Runtime 已安装；包版本见回执。" : "Python Runtime 尚未就绪，不能报告 Python 已运行。", data };
  } });

export const runNotebookCellsTool = defineTool({ name: "runNotebookCells", mode: "readOnly", schema: notebookSessionVersionSchema,
  description: "按 editVersion 实际试运行当前整个草稿，等待执行器返回，提供状态、错误、有限结果和来源。failure 时用 editNotebookCells 修正并重新运行；success 后用 submitNotebookDraft 提交。受现有任务/工具超时限制，不是后台任务。", execute: runNotebookCells });

export const submitNotebookDraftTool = defineTool({ name: "submitNotebookDraft", mode: "readOnly", schema: notebookSessionVersionSchema,
  description: "提交当前 editVersion 草稿供用户采用；要求全部单元试运行成功且未再编辑，不自动保存或修改看板。", execute: submitNotebookDraft });
