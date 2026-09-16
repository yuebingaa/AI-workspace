"use client";

import type { NotebookDatasetProvenance } from "@/core/datasets/provenance";

const labels = { data: "源数据", sql: "本地 SQL", python: "Python", warehouseSql: "数据库 SQL", semanticQuery: "语义查询", transform: "数据处理", table: "表格", chart: "图表", text: "说明" };
export function DatasetProvenance({ provenance }: { provenance?: NotebookDatasetProvenance }) {
  if (!provenance) return null;
  const lineage = provenance.lineage;
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(provenance, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "dataset-provenance.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
  return <details className="dataset-provenance"><summary>查看结果来源{lineage ? ` · ${lineage.steps.length} 个步骤` : ""}</summary>
    <p>Notebook v{provenance.revision} · {lineage ? new Date(lineage.recordedAt).toLocaleString("zh-CN") : "历史运行"}</p>
    <p>{lineage ? `${lineage.rowCount} 行${lineage.complete ? "完整结果" : "截断结果"} · ${lineage.accessMode === "ai" ? "AI 授权执行" : "手动执行"}` : "此历史结果只保留运行引用，没有详细步骤。"}</p>
    {lineage && <ol>{lineage.steps.map((step) => <li key={step.cellId}><b>{step.title}</b> <span>{labels[step.kind]}</span>
      <p>输入：{step.inputCellIds.map((id) => lineage.steps.find((item) => item.cellId === id)?.title ?? id).join("、") || "数据来源"}</p>
      {step.catalogRef && <p>连接 {step.catalogRef.connectionId} · 目录 v{step.catalogRef.revision}{step.catalogRef.complete ? "" : "（目录不完整）"} · {new Date(step.catalogRef.syncedAt).toLocaleString("zh-CN")}</p>}
      <details><summary>步骤定义{step.queryId ? ` · 查询 ${step.queryId.slice(-8)}` : ""}</summary><pre>{JSON.stringify(JSON.parse(step.definition), null, 2)}</pre></details>
    </li>)}</ol>}
    <p>运行：{provenance.runId}</p>
    {lineage?.sourceFiles?.map((file) => <p key={file.name}>原始文件：{file.name} · SHA-256 {file.sha256}</p>)}
    <p>来源记录用于核对本次分析；重新查询时，源数据和权限可能已经变化。</p>
    <button type="button" onClick={download}>下载来源记录</button>
  </details>;
}
