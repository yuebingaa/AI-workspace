import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NotebookDocument } from "@/core/notebook/contracts";
import { NotebookPanel } from "./NotebookPanel";
import {
  DEFAULT_NOTEBOOK_PYTHON_CAPABILITY,
  parseNotebookPythonCapability,
  UNKNOWN_NOTEBOOK_PYTHON_CAPABILITY,
  type NotebookPythonCapabilitySnapshot,
} from "./useNotebookCapabilities";

const document: NotebookDocument = {
  name: "Capability notebook",
  revision: 0,
  cells: [
    { id: "data", kind: "data", title: "原数据", sourceDataSourceId: "source", outputName: "raw" },
    { id: "python", kind: "python", title: "Python 清洗", inputCellIds: ["data"], fileNames: [], outputName: "python_out", code: "python_out = raw.copy()" },
    { id: "table", kind: "table", title: "Python 下游", inputCellId: "python", columns: ["value"] },
    { id: "sql", kind: "sql", title: "独立 SQL", inputCellIds: ["data"], outputName: "sql_out", sql: "SELECT * FROM raw" },
  ],
};

const props: ComponentProps<typeof NotebookPanel> = {
  document,
  pageId: "page",
  sources: [{ id: "source", name: "Synthetic", rowCount: 1, columnCount: 1, qualityScore: 100,
    updatedAt: "2026-09-20T00:00:00.000Z", sourceType: "local-fixture",
    fields: [{ name: "value", label: "Value", type: "number", aggregatable: true, supportedAggregations: ["sum"] }] }],
  models: [],
  canEdit: true,
  externalBusy: false,
  hidden: false,
  instruction: "",
  onInstructionChange: () => {},
  onBrowseData: () => {},
  onChange: () => {},
  onImport: () => {},
  onAskAi: () => {},
  onSnapshot: () => {},
  onInteractionChange: () => {},
};

const disabledPython: NotebookPythonCapabilitySnapshot = {
  capabilities: { python: { enabled: false, reason: "Python Notebook 能力已通过服务器配置关闭" } },
  available: false,
  reason: "Python Notebook 能力已通过服务器配置关闭",
};

function article(html: string, label: string) {
  return html.match(new RegExp(`<article[^>]*aria-label="${label}"[\\s\\S]*?</article>`, "u"))?.[0] ?? "";
}

describe("Notebook Python capability UI", () => {
  it("keeps the backward-compatible enabled default and parses explicit states", () => {
    expect(parseNotebookPythonCapability({ available: true })).toEqual(DEFAULT_NOTEBOOK_PYTHON_CAPABILITY);
    expect(parseNotebookPythonCapability({ enabled: false, available: false, reason: "disabled" })).toEqual({
      capabilities: { python: { enabled: false, reason: "disabled" } },
      available: false,
      reason: "disabled",
    });
    expect(parseNotebookPythonCapability({ enabled: true, available: false, reason: "runtime missing" })).toMatchObject({
      capabilities: { python: { enabled: true, reason: "runtime missing" } },
      available: false,
    });
    expect(parseNotebookPythonCapability(null)).toBe(DEFAULT_NOTEBOOK_PYTHON_CAPABILITY);
  });

  it("keeps Python controls closed until the server capability has been resolved", () => {
    const html = renderToStaticMarkup(<NotebookPanel {...props} />);
    expect(UNKNOWN_NOTEBOOK_PYTHON_CAPABILITY.resolved).toBe(false);
    expect(html).not.toContain('aria-label="＋ Python"');
    expect(html).toContain("正在确认 Python 能力，定义已保留");
  });

  it("hides creation, preserves a read-only Python definition, and blocks only its dependency branch", () => {
    const html = renderToStaticMarkup(<NotebookPanel {...props} pythonCapability={disabledPython} />);
    expect(html).not.toContain('aria-label="＋ Python"');
    expect(html).toContain("Python 能力已关闭，定义已保留");
    expect(html).toContain("上游 Python 能力已关闭，本步骤已阻塞；定义已保留");

    const python = article(html, "Python单元 Python 清洗");
    expect(python).toContain("python_out = raw.copy()");
    expect(python).toMatch(/<button type="button" disabled="" title="Python 能力已关闭，定义已保留/iu);
    expect(python).toContain('<button type="button" data-delete-cell-id="python">删除</button>');
    expect(python).toMatch(/<button type="button" disabled="" title="Python 能力已关闭[^>]*>▶ 运行<\/button>/iu);

    const downstream = article(html, "表格单元 Python 下游");
    expect(downstream).toContain("上游能力阻塞");
    expect(downstream).toMatch(/title="上游 Python 能力已关闭，本步骤暂不能运行。"[^>]*>▶ 运行<\/button>/iu);

    const sql = article(html, "SQL单元 独立 SQL");
    expect(sql).toContain('<button type="button">编辑</button>');
    expect(sql).toContain('<button type="button">▶ 运行</button>');
    expect(html).toMatch(/disabled="" title="Python 能力已关闭[^>]*>▶ 全部运行<\/button>/iu);
  });

  it("restores the original creation and cell actions when Python is enabled and available", () => {
    const html = renderToStaticMarkup(<NotebookPanel {...props} pythonCapability={DEFAULT_NOTEBOOK_PYTHON_CAPABILITY} />);
    expect(html).toContain('aria-label="＋ Python"');
    expect(html).not.toContain("Python 能力已关闭，定义已保留");
    const python = article(html, "Python单元 Python 清洗");
    expect(python).toContain('<button type="button">编辑</button>');
    expect(python).toContain('<button type="button">▶ 运行</button>');
  });

  it("shows the server's missing-resource reason while preserving code and independent SQL actions", () => {
    const reason = "当前安装未包含 Python 资源，请安装资源后重试。";
    const snapshot = parseNotebookPythonCapability({ enabled: false, available: false, reason });
    const html = renderToStaticMarkup(<NotebookPanel {...props} pythonCapability={snapshot} />);
    const python = article(html, "Python单元 Python 清洗");
    expect(python).toContain(`role="status">Python 能力已关闭，定义已保留。 ${reason}`);
    expect(python).toContain("python_out = raw.copy()");
    expect(python).toMatch(/<button type="button" disabled="" title="Python 能力已关闭[^>]*>▶ 运行<\/button>/iu);
    expect(html).not.toContain('aria-label="＋ Python"');
    expect(article(html, "SQL单元 独立 SQL")).toContain('<button type="button">▶ 运行</button>');
  });

  it("renders capability reasons as text instead of markup", () => {
    const reason = '<script>alert("resource")</script>';
    const snapshot = parseNotebookPythonCapability({ enabled: false, available: false, reason });
    const html = renderToStaticMarkup(<NotebookPanel {...props} pythonCapability={snapshot} />);
    expect(html).not.toContain(reason);
    expect(article(html, "Python单元 Python 清洗")).toContain('&lt;script&gt;alert(&quot;resource&quot;)&lt;/script&gt;');
  });

  it("does not adopt an older draft that changes a now-disabled Python definition", () => {
    const changed = document.cells.map((cell) => cell.kind === "python" ? { ...cell, code: "python_out = raw" } : cell);
    const draft = {
      id: "draft_capability",
      version: 1 as const,
      status: "draft" as const,
      name: document.name,
      cells: changed,
      executionOrder: changed.map((cell) => cell.id),
      lineage: changed.map((cell) => ({ cellId: cell.id, dependsOn: "inputCellIds" in cell ? cell.inputCellIds
        : "inputCellId" in cell ? [cell.inputCellId] : [] })),
      sourceDataSourceIds: ["source"],
      createdAt: "2026-09-20T00:00:00.000Z",
      baseRevision: document.revision,
    };
    const html = renderToStaticMarkup(<NotebookPanel {...props} draft={draft} pythonCapability={disabledPython} />);
    const review = html.match(/<section class="notebook-draft"[\s\S]*?<\/section>/u)?.[0] ?? "";
    expect(review).toContain("能力关闭期间不能修改");
    expect(review).toMatch(/<button type="button" class="notebook-primary" disabled="">采用草稿<\/button>/u);
  });
});
