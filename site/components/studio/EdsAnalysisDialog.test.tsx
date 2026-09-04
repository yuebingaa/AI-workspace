// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EDS_RULE_VERSION, EDS_TEMPLATE_VERSION, type EdsAnalysisResponse } from "@/core/eds";
import { analyzeEdsFiles, EdsSelectionRequiredClientError } from "@/core/eds/client";
import {
  canApplyEdsRequestResult,
  canChooseEdsFile,
  EdsAnalysisDialog,
  EdsAnalysisResultView,
  EdsErrorMessage,
  EdsWorkbookPicker,
  shouldHandleEdsDialogEscape,
  validateEdsFileSelection,
  wrappedEdsDialogFocusIndex,
} from "./EdsAnalysisDialog";

vi.mock("@/core/eds/client", () => ({
  analyzeEdsFiles: vi.fn(),
  EdsClientError: class EdsClientError extends Error {},
  EdsSelectionRequiredClientError: class EdsSelectionRequiredClientError extends Error {
    constructor(readonly selections: Array<{ date: string; shift: string }>, message: string) {
      super(message);
    }
  },
}));

const mountedRoots: Root[] = [];
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  while (mountedRoots.length) act(() => mountedRoots.pop()!.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const result: EdsAnalysisResponse = {
  summary: {
    date: "2026-08-25",
    shift: "白班",
    inputRows: 4_651,
    matchedRows: 321,
    issueCount: 14,
    channelCount: 20,
    totalOccurrences: 321,
    totalMinutes: 654.5,
    sourceSheets: ["合成32-33明细", "合成35-36明细"],
  },
  issueSummary: Array.from({ length: 14 }, (_, index) => ({ label: `合成异常 ${index + 1}`, count: index + 1, minutes: index + 0.5 })),
  lineSummary: Array.from({ length: 10 }, (_, index) => ({ label: `合成线体 ${index + 1}`, count: index + 2, minutes: index + 1.25 })),
  configuration: { templateVersion: EDS_TEMPLATE_VERSION, ruleVersion: EDS_RULE_VERSION, comparisonMode: "custom_template" },
  comparison: { coreMatched: 560, coreTotal: 560, reportMatched: 660, reportTotal: 660, mismatchCount: 0, mismatches: [] },
  exportArtifact: {
    id: "1234567890abcdef",
    status: "ready",
    fileName: "EDS飞达异常统计_2026-08-25_白班.xlsx",
    downloadUrl: "/api/exports/1234567890abcdef",
    rowCount: 30,
    fieldCount: 20,
    sizeBytes: 24_000,
    createdAt: "2026-09-04T00:00:00.000Z",
    expiresAt: "2026-09-04T00:10:00.000Z",
  },
  warnings: [],
};

const standardResult: EdsAnalysisResponse = {
  ...result,
  configuration: { ...result.configuration, comparisonMode: "not_requested" },
  comparison: null,
};

describe("EdsAnalysisDialog", () => {
  it("只允许仍挂载、身份匹配且未取消的请求写回", () => {
    expect(canApplyEdsRequestResult({ mounted: true, activeRequestId: 2, requestId: 2, aborted: false })).toBe(true);
    expect(canApplyEdsRequestResult({ mounted: false, activeRequestId: 2, requestId: 2, aborted: false })).toBe(false);
    expect(canApplyEdsRequestResult({ mounted: true, activeRequestId: 3, requestId: 2, aborted: false })).toBe(false);
    expect(canApplyEdsRequestResult({ mounted: true, activeRequestId: 2, requestId: 2, aborted: true })).toBe(false);
  });

  it("运行状态或同步活动请求都会锁定文件选择", () => {
    expect(canChooseEdsFile(false, false)).toBe(true);
    expect(canChooseEdsFile(true, false)).toBe(false);
    expect(canChooseEdsFile(false, true)).toBe(false);
  });

  it("无效替换会清空旧文件而不是继续分析旧选择", () => {
    const valid = new File(["xlsx"], "input.xlsx");
    const invalid = new File(["csv"], "input.csv");

    expect(validateEdsFileSelection(valid)).toEqual({ file: valid, error: null });
    expect(validateEdsFileSelection(invalid)).toEqual({ file: null, error: "当前仅支持 .xlsx 工作簿。" });
  });

  it("仅在非输入法合成态处理 Escape", () => {
    expect(shouldHandleEdsDialogEscape("Escape", false)).toBe(true);
    expect(shouldHandleEdsDialogEscape("Escape", true)).toBe(false);
    expect(shouldHandleEdsDialogEscape("Enter", false)).toBe(false);
  });

  it("只在 Tab 越过首尾时给出模态框内循环目标", () => {
    expect(wrappedEdsDialogFocusIndex(0, 3, true)).toBe(2);
    expect(wrappedEdsDialogFocusIndex(2, 3, false)).toBe(0);
    expect(wrappedEdsDialogFocusIndex(-1, 3, false)).toBe(0);
    expect(wrappedEdsDialogFocusIndex(1, 3, false)).toBeNull();
    expect(wrappedEdsDialogFocusIndex(0, 0, false)).toBeNull();
  });

  it("默认只呈现单工作簿导入、内置版本、隐私边界与自动分析入口", () => {
    const html = renderToStaticMarkup(<EdsAnalysisDialog onClose={() => undefined} onCreateWorkspace={() => undefined} />);
    expect(html).toContain("飞达异常自动分析");
    expect(html).toContain("输入工作簿");
    expect(html).not.toContain("验收基准（可选）");
    expect(html).toContain(EDS_TEMPLATE_VERSION);
    expect(html).toContain(EDS_RULE_VERSION);
    expect(html).toContain("高级验收");
    expect((html.match(/type="file"/gu) ?? [])).toHaveLength(1);
    expect(html).toContain("accept=\".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\"");
    expect(html).toContain("不进入 AI 上下文");
    expect(html).toContain("导入并自动分析");
    expect(html).toContain('aria-label="选择输入工作簿"');
    expect(html).toContain('aria-labelledby="eds-dialog-title"');
    expect(html).toContain('aria-describedby="eds-dialog-description"');
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain('tabindex="-1"');
  });

  it("分析运行期间同时禁用文件按钮与隐藏 input", () => {
    const html = renderToStaticMarkup(
      <EdsWorkbookPicker
        label="输入工作簿"
        description="测试"
        file={new File(["xlsx"], "input.xlsx")}
        disabled
        onSelect={() => undefined}
      />,
    );

    expect((html.match(/disabled=""/gu) ?? [])).toHaveLength(2);
    expect(html).not.toMatch(/<button(?:(?!<\/button>)[\s\S])*<input/gu);
  });

  it("错误使用即时播报且不改变消息正文", () => {
    const html = renderToStaticMarkup(<EdsErrorMessage message="工作簿解析失败" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain("工作簿解析失败");
  });

  it("结果视图呈现 560/560、660/660、双图表与下载证据", () => {
    const html = renderToStaticMarkup(<EdsAnalysisResultView result={result} />);
    expect(html).toContain("验收基准比对全部一致");
    expect(html).toContain("核心统计 560/560");
    expect(html).toContain("整表数字 660/660");
    expect(html).toContain("各线体异常次数");
    expect(html).toContain("14 类异常时长");
    expect(html).toContain("下载分析结果");
    expect(html).toContain(result.exportArtifact.downloadUrl);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("普通分析结果不伪造目标表比对并展示可追溯版本", () => {
    const html = renderToStaticMarkup(<EdsAnalysisResultView result={standardResult} />);
    expect(html).toContain("分析与报表已生成");
    expect(html).toContain("标准自动分析");
    expect(html).toContain(EDS_TEMPLATE_VERSION);
    expect(html).toContain(EDS_RULE_VERSION);
    expect(html).not.toContain("560/560");
    expect(html).not.toContain("比对全部一致");
  });

  it("分析完成后由用户显式生成主界面看板，并传递已校验结果", async () => {
    vi.mocked(analyzeEdsFiles).mockResolvedValue(standardResult);
    const onCreateWorkspace = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => root.render(<EdsAnalysisDialog onClose={() => undefined} onCreateWorkspace={onCreateWorkspace} />));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;

    act(() => {
      Object.defineProperty(input, "files", { configurable: true, value: [new File(["source"], "input.xlsx")] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "导入并自动分析")!.click();
      await Promise.resolve();
    });
    const createButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "生成 EDS 分析看板")!;
    expect(createButton).toBeDefined();
    expect(container.textContent).toContain("仅派生汇总会进入 AI 上下文、localStorage 和审计正文");

    act(() => createButton.click());
    expect(onCreateWorkspace).toHaveBeenCalledTimes(1);
    expect(onCreateWorkspace).toHaveBeenCalledWith([standardResult], 0);
  });

  it("零值柱不伪造可见宽度并提供机器可读数值语义", () => {
    const zeroResult = structuredClone(result);
    zeroResult.lineSummary[0].count = 0;
    const html = renderToStaticMarkup(<EdsAnalysisResultView result={zeroResult} />);

    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="0"');
    expect(html).toContain('aria-valuetext="0 次"');
    expect(html).toContain("width:0%");
  });

  it("单文件生成结果后重新选择会清空旧文件并重新锁定运行按钮", async () => {
    vi.mocked(analyzeEdsFiles).mockResolvedValue(standardResult);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => root.render(<EdsAnalysisDialog onClose={() => undefined} onCreateWorkspace={() => undefined} />));
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');

    act(() => {
      Object.defineProperty(inputs[0], "files", { configurable: true, value: [new File(["source"], "input.xlsx")] });
      inputs[0].dispatchEvent(new Event("change", { bubbles: true }));
    });
    const runButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "导入并自动分析")!;
    expect(runButton.disabled).toBe(false);

    await act(async () => {
      runButton.click();
      await Promise.resolve();
    });
    const resetButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "重新选择工作簿")!;
    expect(resetButton).toBeDefined();
    expect(analyzeEdsFiles).toHaveBeenCalledWith(expect.any(File), null, expect.any(AbortSignal), undefined);

    act(() => resetButton.click());
    const nextRunButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "导入并自动分析")!;
    expect(nextRunButton.disabled).toBe(true);
    expect(container.textContent).not.toContain("input.xlsx");
    expect(container.querySelector('.eds-result')).toBeNull();
  });

  it("高级验收展开后才提供可选基准，并随请求提交", async () => {
    vi.mocked(analyzeEdsFiles).mockResolvedValue(result);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => root.render(<EdsAnalysisDialog onClose={() => undefined} onCreateWorkspace={() => undefined} />));

    const advanced = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "高级验收")!;
    act(() => advanced.click());
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
    expect(inputs).toHaveLength(2);
    expect(container.textContent).toContain("验收基准（可选）");
    act(() => {
      Object.defineProperty(inputs[0], "files", { configurable: true, value: [new File(["source"], "input.xlsx")] });
      inputs[0].dispatchEvent(new Event("change", { bubbles: true }));
      Object.defineProperty(inputs[1], "files", { configurable: true, value: [new File(["template"], "output.xlsx")] });
      inputs[1].dispatchEvent(new Event("change", { bubbles: true }));
    });
    const runButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "导入并自动分析")!;
    await act(async () => {
      runButton.click();
      await Promise.resolve();
    });
    expect(analyzeEdsFiles).toHaveBeenCalledWith(expect.any(File), expect.objectContaining({ name: "output.xlsx" }), expect.any(AbortSignal), undefined);
    expect(container.textContent).toContain("验收基准比对全部一致");
  });

  it("检测到多班次后允许选择分别生成，并在两份报告间切换", async () => {
    const selections = [
      { date: "2026-09-03", shift: "白班" },
      { date: "2026-09-03", shift: "夜班" },
    ];
    const whiteResult = structuredClone(standardResult);
    whiteResult.summary.date = selections[0].date;
    whiteResult.summary.shift = selections[0].shift;
    const nightResult = structuredClone(standardResult);
    nightResult.summary.date = selections[1].date;
    nightResult.summary.shift = selections[1].shift;
    nightResult.summary.matchedRows = 173;
    nightResult.summary.totalOccurrences = 173;
    vi.mocked(analyzeEdsFiles)
      .mockRejectedValueOnce(new EdsSelectionRequiredClientError(selections, "请选择分析范围。"))
      .mockResolvedValueOnce(whiteResult)
      .mockResolvedValueOnce(nightResult);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const onCreateWorkspace = vi.fn();
    act(() => root.render(<EdsAnalysisDialog onClose={() => undefined} onCreateWorkspace={onCreateWorkspace} />));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    act(() => {
      Object.defineProperty(input, "files", { configurable: true, value: [new File(["source"], "multi-shift.xlsx")] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => {
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "导入并自动分析")!.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("检测到多个日期或班次");
    const choices = container.querySelectorAll<HTMLInputElement>('input[name="eds-analysis-scope"]');
    expect(choices).toHaveLength(3);
    expect(Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "请选择分析范围")!.disabled).toBe(true);

    act(() => choices[2].click());
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "分别生成 2 份报告")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(analyzeEdsFiles).toHaveBeenCalledTimes(3);
    expect(analyzeEdsFiles).toHaveBeenNthCalledWith(2, expect.any(File), null, expect.any(AbortSignal), selections[0]);
    expect(analyzeEdsFiles).toHaveBeenNthCalledWith(3, expect.any(File), null, expect.any(AbortSignal), selections[1]);
    expect(container.textContent).toContain("已分别生成 2 份报告");
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    act(() => tabs[1].click());
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("2026-09-03 · 夜班");
    expect(container.textContent).toContain("把 2 份报告一起生成到主看板");
    const createButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "生成可切换的 EDS 看板（2 份）")!;
    act(() => createButton.click());
    expect(onCreateWorkspace).toHaveBeenCalledWith([whiteResult, nightResult], 1);
  });

  it("真实文件 change 事件中的无效替换会移除旧文件并禁用分析", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => root.render(<EdsAnalysisDialog onClose={() => undefined} onCreateWorkspace={() => undefined} />));
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');

    act(() => {
      Object.defineProperty(inputs[0], "files", { configurable: true, value: [new File(["source"], "input.xlsx")] });
      inputs[0].dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("input.xlsx");
    expect(Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "导入并自动分析")!.disabled).toBe(false);

    act(() => {
      Object.defineProperty(inputs[0], "files", { configurable: true, value: [new File(["csv"], "replacement.csv")] });
      inputs[0].dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).not.toContain("input.xlsx");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("当前仅支持 .xlsx 工作簿。");
    expect(Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "导入并自动分析")!.disabled).toBe(true);
  });

  it("StrictMode 的 effect 双执行后仍允许当前分析结果写回", async () => {
    vi.mocked(analyzeEdsFiles).mockResolvedValue(standardResult);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => root.render(<StrictMode><EdsAnalysisDialog onClose={() => undefined} onCreateWorkspace={() => undefined} /></StrictMode>));
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');

    act(() => {
      Object.defineProperty(inputs[0], "files", { configurable: true, value: [new File(["source"], "input.xlsx")] });
      inputs[0].dispatchEvent(new Event("change", { bubbles: true }));
    });
    const runButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "导入并自动分析")!;
    await act(async () => {
      runButton.click();
      await Promise.resolve();
    });

    expect(container.querySelector('.eds-result')).not.toBeNull();
    expect(container.textContent).toContain("分析与报表已生成");
  });
});
