"use client";

import { useMemo, useState } from "react";
import { executeDataRecipe } from "@/core/data";
import type { ExcelExportArtifact } from "@/core/exports/contracts";
import type { HarnessTableArtifact } from "@/core/harness/contracts";
import type { DataRecipe, DataRow, DataSourceDefinition, DataValue } from "@/core/models";
import { ExcelDownloadButton } from "./ExcelDownloadButton";

const ROWS_PER_PAGE = 50;

type WorkspaceView = "source" | "recipe" | "ai";

interface TableView {
  id: WorkspaceView;
  label: string;
  name: string;
  fields: Array<{ name: string; label: string; type: string }>;
  rows: DataRow[];
  totalRowCount: number;
  note: string;
}

interface SpreadsheetWorkspaceProps {
  source?: DataSourceDefinition;
  rows: DataRow[];
  recipe?: DataRecipe;
  aiResult?: HarnessTableArtifact;
  resultFocusRevision?: number;
  exportArtifact?: ExcelExportArtifact;
  onImportSpreadsheet: () => void;
  onOpenDataSource: () => void;
}

function displayCell(value: DataValue | undefined): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return Number.isInteger(value)
    ? value.toLocaleString("zh-CN")
    : value.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
  return value;
}

export function SpreadsheetWorkspace({
  source,
  rows,
  recipe,
  aiResult,
  resultFocusRevision = 0,
  exportArtifact,
  onImportSpreadsheet,
  onOpenDataSource,
}: SpreadsheetWorkspaceProps) {
  const views = useMemo<TableView[]>(() => {
    if (!source) return [];
    const next: TableView[] = [{
      id: "source",
      label: "原始数据",
      name: source.name,
      fields: source.fields.map(({ name, label, type }) => ({ name, label, type })),
      rows,
      totalRowCount: rows.length,
      note: `${source.columnCount} 列 · 质量 ${source.qualityScore}%`,
    }];
    if (recipe) {
      const execution = executeDataRecipe(recipe, source, rows);
      if (execution.success) next.push({
        id: "recipe",
        label: "配方结果",
        name: recipe.name,
        fields: execution.fields.map(({ name, label, type }) => ({ name, label, type })),
        rows: execution.rows,
        totalRowCount: execution.rows.length,
        note: `${execution.steps.length} 个处理步骤`,
      });
    }
    if (aiResult?.sourceDataSourceId === source.id) next.push({
      id: "ai",
      label: "AI 处理结果",
      name: aiResult.name,
      fields: aiResult.fields,
      rows: aiResult.rows,
      totalRowCount: aiResult.totalRowCount,
      note: aiResult.truncated ? `展示前 ${aiResult.previewRowCount} 行预览` : `${aiResult.transformations.length} 个处理步骤`,
    });
    return next;
  }, [aiResult, recipe, rows, source]);
  const preferredView = aiResult?.sourceDataSourceId === source?.id ? "ai" : recipe ? "recipe" : "source";
  const viewScope = `${source?.id ?? "none"}:${recipe?.id ?? "none"}:${aiResult?.id ?? "none"}:${resultFocusRevision}`;
  const [selection, setSelection] = useState<{ scope: string; view: WorkspaceView; page: number }>(() => ({
    scope: viewScope,
    view: preferredView,
    page: 0,
  }));
  const activeView = selection.scope === viewScope ? selection.view : preferredView;

  const selected = views.find((view) => view.id === activeView) ?? views[0];
  const totalPages = Math.max(1, Math.ceil((selected?.rows.length ?? 0) / ROWS_PER_PAGE));
  const page = selection.scope === viewScope ? Math.min(selection.page, totalPages - 1) : 0;
  const visibleRows = selected?.rows.slice(page * ROWS_PER_PAGE, (page + 1) * ROWS_PER_PAGE) ?? [];
  const selectView = (view: WorkspaceView) => setSelection({ scope: viewScope, view, page: 0 });
  const selectPage = (nextPage: number) => setSelection({ scope: viewScope, view: selected?.id ?? preferredView, page: nextPage });

  return (
    <section className="spreadsheet-workspace" aria-label="表格工作区">
      <header className="spreadsheet-workspace-head">
        <div><span className="spreadsheet-workspace-mark">▦</span><div><small>SPREADSHEET WORKSPACE</small><h2>表格工作区</h2><p>原始数据、配方结果和 AI 处理结果统一放在这里。</p></div></div>
        <div className="spreadsheet-workspace-actions">
          {exportArtifact && <ExcelDownloadButton artifact={exportArtifact} label="下载处理结果" />}
          {source && <button type="button" onClick={onOpenDataSource}>数据源详情</button>}
          <button type="button" className="primary" onClick={onImportSpreadsheet}>导入本机表格</button>
        </div>
      </header>
      {!selected ? (
        <button type="button" className="spreadsheet-workspace-empty" onClick={onImportSpreadsheet}>
          <b>把 CSV 或 XLSX 放到这里</b>
          <span>点击选择电脑上的文件；导入后 Harness 可以检查字段并按指令处理。</span>
        </button>
      ) : (
        <>
          <div className="spreadsheet-workspace-tabs" role="tablist" aria-label="表格结果类型">
            {views.map((view) => <button key={view.id} type="button" role="tab" aria-selected={selected.id === view.id} onClick={() => selectView(view.id)}>{view.label}<span>{view.totalRowCount.toLocaleString("zh-CN")}</span></button>)}
          </div>
          <div className="spreadsheet-workspace-summary"><div><b>{selected.name}</b><span>{selected.totalRowCount.toLocaleString("zh-CN")} 行 · {selected.fields.length} 列 · {selected.note}</span></div>{selected.id === "ai" && <span className="spreadsheet-ai-badge">✦ Harness 结果</span>}</div>
          <div className="spreadsheet-grid-scroll" tabIndex={0} aria-label={`${selected.name} 横向滚动表格`}>
            <table>
              <thead><tr><th className="row-number">#</th>{selected.fields.map((field) => <th key={field.name}><b>{field.label}</b><small>{field.name} · {field.type}</small></th>)}</tr></thead>
              <tbody>{visibleRows.map((row, rowIndex) => <tr key={`${page}-${rowIndex}`}><td className="row-number">{page * ROWS_PER_PAGE + rowIndex + 1}</td>{selected.fields.map((field) => <td key={field.name} title={displayCell(row[field.name])}>{displayCell(row[field.name])}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <footer className="spreadsheet-workspace-footer"><span>当前显示 {visibleRows.length} 行{selected.totalRowCount > selected.rows.length ? `；任务产物仅保留 ${selected.rows.length} 行可视预览` : ""}</span><div><button type="button" disabled={page === 0} onClick={() => selectPage(Math.max(0, page - 1))}>上一页</button><span>{page + 1} / {totalPages}</span><button type="button" disabled={page + 1 >= totalPages} onClick={() => selectPage(Math.min(totalPages - 1, page + 1))}>下一页</button></div></footer>
        </>
      )}
    </section>
  );
}
