import type { HarnessToolCatalogOptions } from "./contracts";
import { DEFAULT_NOTEBOOK_CAPABILITIES, isNotebookCellCapabilityEnabled, notebookCapabilityReason } from "@/core/notebook/capabilities";
import { harnessToolRegistry } from "./registry";
import { parametersAvailable, compactChangePreviewSchema, scopedToolParameters } from "./parameter-projection";
import { shareToolSchemaPatterns } from "../tool-schema";

// Offer optional instructions with their schema, not in unrelated SQL edits.
const parameterToolGuidance = "另支持 parameter：parameter.type/value，select 加非空唯一 options 且 value 属于其中。无依赖，输出一行 value 列的 outputName 表，计划与草稿配置一致。用 inputCellIds 传给 SQL/Python，不拼 SQL、不绑定 warehouseSql；SQL 日期显式 CAST(value AS DATE)，Python 为日期列。值会保存并进入上下文，勿放密码或密钥。";

const textReferenceGuidance = "text 可选 references:[{key,cellId,field}]，最多10个唯一ASCII key，markdown用{{key}}。引用本次成功、完整且恰好1行的参数/汇总表；先聚合，不取首行、不执行表达式。计划dependsOn与去重引用ID及草稿references一致；须真实试运行。无references的旧文本不插值。";

export function harnessToolCatalog(options: HarnessToolCatalogOptions = {}) {
  const names = options.names ? new Set(options.names) : null;
  const capabilities = options.notebookCapabilities ?? DEFAULT_NOTEBOOK_CAPABILITIES;
  const pythonEnabled = isNotebookCellCapabilityEnabled(capabilities, "python");
  const hasDisabledPython = !pythonEnabled
    && Boolean(options.request?.notebookContext?.document.cells.some((cell) => cell.kind === "python"));
  return Object.values(harnessToolRegistry).filter((tool) => (
    (!names || names.has(tool.name))
    && (pythonEnabled || !["createPythonCell", "getKernelPackagesInfo"].includes(tool.name))
    && (!hasDisabledPython || tool.name !== "createNotebookDraft")
    && (tool.name !== "callMcpTool" || Boolean(options.mcpTools?.length))
    && (tool.name !== "querySemanticModel" || Boolean(options.request?.semanticModel))
    && (tool.name !== "inspectConnectionSchema" || Boolean(options.request?.notebookContext?.connections?.some((connection) => connection.allowAi)))
    && (!["cellSearch", "editNotebookCells", "createPythonCell", "getKernelPackagesInfo", "runNotebookCells", "submitNotebookDraft"].includes(tool.name) || Boolean(options.request?.notebookContext))
  )).map((tool) => ({
    name: tool.name,
    description: tool.description + (parametersAvailable(options) && ["createAnalysisPlan", "createNotebookDraft", "editNotebookCells"].includes(tool.name)
      ? parameterToolGuidance : "") + (["createAnalysisPlan", "createNotebookDraft", "editNotebookCells"].includes(tool.name)
        ? textReferenceGuidance : "") + (!pythonEnabled && ["createAnalysisPlan", "createNotebookDraft", "editNotebookCells", "runNotebookCells"].includes(tool.name)
        ? ` 当前部署已关闭 Python 能力：不能规划、创建、编辑或运行 Python 单元；已有 Python 定义只读保留。${notebookCapabilityReason(capabilities, "python") ?? ""}` : ""),
    mode: tool.mode,
    parameters: tool.name === "createChangeSetPreview" && options.editableNodes
      ? compactChangePreviewSchema(options)
      : ["createAnalysisPlan", "createNotebookDraft", "editNotebookCells", "createPythonCell", "cellSearch"].includes(tool.name)
        ? shareToolSchemaPatterns(scopedToolParameters(tool, options, harnessToolRegistry.createNotebookDraft))
        : scopedToolParameters(tool, options, harnessToolRegistry.createNotebookDraft),
  }));
}
