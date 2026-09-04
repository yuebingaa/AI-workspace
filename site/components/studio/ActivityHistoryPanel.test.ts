// @vitest-environment happy-dom

import { act, Component, createElement, createRef, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendHarnessEvent, createHarnessTask } from "@/core/harness";
import type { ChangeSetAuditRecord } from "@/core/models";
import { ActivityHistoryPanel, focusDialogControl, keepFocusInsideDialog, restoreDialogTrigger, restoreDialogTriggerUnlessOpen } from "./ActivityHistoryPanel";

let eventSequence = 0;
const mountedRoots: Root[] = [];
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const clock = {
  now: () => new Date("2026-09-02T03:00:00.000Z"),
  id: () => `history_event_${++eventSequence}`,
};

class InteractiveHistoryHarness extends Component<Record<string, never>, { open: boolean }> {
  state = { open: false };
  private readonly triggerRef = createRef<HTMLButtonElement>();

  render() {
    return createElement(Fragment, null,
      createElement("button", { ref: this.triggerRef, type: "button", onClick: () => this.setState({ open: true }) }, "任务历史"),
      createElement(ActivityHistoryPanel, {
        open: this.state.open,
        harnessTasks: [],
        auditRecords: [],
        onRestoreFocus: () => restoreDialogTrigger(this.triggerRef.current),
        onClose: () => this.setState({ open: false }),
      }),
    );
  }
}

function mountInteractiveHistory() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() => root.render(createElement(InteractiveHistoryHarness)));
  const trigger = container.querySelector("button")!;
  return { container, trigger };
}

function openHistory(trigger: HTMLButtonElement) {
  act(() => trigger.click());
  return document.querySelector<HTMLElement>("[role='dialog']")!;
}

afterEach(() => {
  while (mountedRoots.length) act(() => mountedRoots.pop()!.unmount());
  document.body.replaceChildren();
});

function renderTaskHistory() {
  const initial = createHarnessTask("history_task_001", "检查订单字段并导出结果", "page_home", "editor", clock);
  const task = appendHarnessEvent(initial, {
    type: "toolCall",
    state: "failed",
    message: "导出工具执行失败。",
    toolCall: {
      id: "tool_call_001",
      name: "exportDataRecipeToExcel",
      status: "failure",
      durationMs: 1_250,
    },
  }, clock, {
    error: "临时导出文件已过期。",
    totalDurationMs: 3_200,
    usage: { promptTokens: 800, completionTokens: 200, totalTokens: 1_000 },
    executionTiming: {
      phase: "failed",
      activeElapsedMs: 3_200,
      remainingMs: 86_800,
      totalBudgetMs: 90_000,
      modelRequestTimeoutMs: 25_000,
      toolCallTimeoutMs: 10_000,
      modelDurationMs: 1_500,
      toolDurationMs: 1_250,
      otherDurationMs: 450,
      retainedObservationCount: 1,
    },
    contextUsage: {
      totalInputChars: 4_000,
      totalPromptTokens: 800,
      complexity: "multiStep",
      limits: {
        maxRequestInputChars: 20_000,
        maxToolResultChars: 10_000,
        maxToolResultEntries: 100,
        maxTotalInputChars: 40_000,
        maxTotalPromptTokens: 8_000,
      },
      requests: [],
    },
  });

  return renderToStaticMarkup(createElement(ActivityHistoryPanel, { open: true, harnessTasks: [task], auditRecords: [], onRestoreFocus: () => {}, onClose: () => {} }));
}

describe("任务与变更历史面板", () => {
  it("展示 Harness 状态、工具调用、失败原因、预算和耗时", () => {
    const html = renderTaskHistory();
    expect(html).toContain("任务与变更历史");
    expect(html).toContain("失败原因");
    expect(html).toContain("临时导出文件已过期");
    expect(html).toContain("exportDataRecipeToExcel");
    expect(html).toContain("预算与耗时");
    expect(html).toContain("3.2s / 90s");
    expect(html).toContain("4,000 / 40,000");
  });

  it("展示 ChangeSet 的预览、应用、撤销和失败记录", () => {
    const statuses: ChangeSetAuditRecord["status"][] = ["previewed", "applied", "undone", "failed"];
    const records = statuses.map((status, index): ChangeSetAuditRecord => ({
      id: `audit_${index}`,
      changeSetId: `changeset_${index}`,
      role: "editor",
      source: "ai",
      operationSummary: `测试变更 ${index}`,
      status,
      timestamp: `2026-09-02T03:0${index}:00.000Z`,
      ...(status === "failed" ? { error: "目标组件不存在。" } : {}),
    }));
    const html = renderToStaticMarkup(createElement(ActivityHistoryPanel, { open: true, initialTab: "changesets", harnessTasks: [], auditRecords: records, onRestoreFocus: () => {}, onClose: () => {} }));
    expect(html).toContain("已预览");
    expect(html).toContain("已应用");
    expect(html).toContain("已撤销");
    expect(html).toContain("失败原因");
    expect(html).toContain("目标组件不存在");
  });

  it("覆盖空状态和加载状态", () => {
    const empty = renderToStaticMarkup(createElement(ActivityHistoryPanel, { open: true, initialTab: "changesets", harnessTasks: [], auditRecords: [], onRestoreFocus: () => {}, onClose: () => {} }));
    const loading = renderToStaticMarkup(createElement(ActivityHistoryPanel, { open: true, loading: true, harnessTasks: [], auditRecords: [], onRestoreFocus: () => {}, onClose: () => {} }));
    expect(empty).toContain("还没有 ChangeSet 记录");
    expect(loading).toContain("正在读取任务历史");
  });

  it("正向和反向 Tab 都保持在弹层焦点范围内", () => {
    const first = { focus: vi.fn() } as unknown as HTMLElement;
    const middle = { focus: vi.fn() } as unknown as HTMLElement;
    const last = { focus: vi.fn() } as unknown as HTMLElement;
    const forward = { key: "Tab", shiftKey: false, preventDefault: vi.fn() };
    const backward = { key: "Tab", shiftKey: true, preventDefault: vi.fn() };

    keepFocusInsideDialog(forward, [first, middle, last], last);
    expect(forward.preventDefault).toHaveBeenCalledOnce();
    expect(first.focus).toHaveBeenCalledOnce();

    keepFocusInsideDialog(backward, [first, middle, last], first);
    expect(backward.preventDefault).toHaveBeenCalledOnce();
    expect(last.focus).toHaveBeenCalledOnce();
  });

  it("真实弹层打开后聚焦内部，正向和反向 Tab 都不会逃到背景", () => {
    const { trigger } = mountInteractiveHistory();
    const dialog = openHistory(trigger);
    const closeButton = dialog.querySelector<HTMLButtonElement>("button[aria-label='关闭任务历史']")!;
    const focusable = dialog.querySelectorAll<HTMLElement>("button:not([disabled]), summary");
    const last = focusable.item(focusable.length - 1);
    expect(document.activeElement).toBe(closeButton);

    act(() => {
      last.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.activeElement).toBe(closeButton);

    act(() => {
      closeButton.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(last);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("Escape、关闭按钮和遮罩共用关闭流程并恢复触发按钮焦点", () => {
    const { trigger } = mountInteractiveHistory();

    openHistory(trigger);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    const dialog = openHistory(trigger);
    act(() => dialog.querySelector<HTMLButtonElement>("button[aria-label='关闭任务历史']")!.click());
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    openHistory(trigger);
    const overlay = document.querySelector<HTMLElement>(".history-overlay")!;
    act(() => overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("打开时聚焦弹层控件，关闭时恢复已连接的触发按钮", () => {
    const closeButton = { focus: vi.fn() } as unknown as HTMLElement;
    const triggerButton = { focus: vi.fn(), isConnected: true } as unknown as HTMLElement;
    focusDialogControl(closeButton);
    restoreDialogTrigger(triggerButton);
    expect(closeButton.focus).toHaveBeenCalledOnce();
    expect(triggerButton.focus).toHaveBeenCalledOnce();
  });

  it("对话框在延迟回焦前重新打开时不把焦点移回背景", () => {
    const triggerButton = { focus: vi.fn(), isConnected: true } as unknown as HTMLElement;

    restoreDialogTriggerUnlessOpen(triggerButton, true);
    expect(triggerButton.focus).not.toHaveBeenCalled();

    restoreDialogTriggerUnlessOpen(triggerButton, false);
    expect(triggerButton.focus).toHaveBeenCalledOnce();
  });

  it("已取消任务显示中性取消原因，真正失败仍显示红色失败原因", () => {
    const base = createHarnessTask("cancelled_history_task", "刷新中断任务", "page_home", "editor", clock);
    const cancelled = appendHarnessEvent(base, {
      type: "error",
      state: "cancelled",
      message: "页面刷新后已安全终止未完成任务。",
    }, clock, { error: "任务因页面刷新而终止。" });
    const cancelledHtml = renderToStaticMarkup(createElement(ActivityHistoryPanel, { open: true, harnessTasks: [cancelled], auditRecords: [], onRestoreFocus: () => {}, onClose: () => {} }));
    const failedHtml = renderTaskHistory();
    expect(cancelledHtml).toContain("取消原因");
    expect(cancelledHtml).toContain("history-failure cancelled");
    expect(cancelledHtml).not.toContain("history-failure failed");
    expect(failedHtml).toContain("失败原因");
    expect(failedHtml).toContain("history-failure failed");
  });
});
