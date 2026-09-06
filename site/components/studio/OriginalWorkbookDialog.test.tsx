// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSheet, type SheetData } from "read-excel-file/browser";
import { formatOriginalWorkbookCell, OriginalWorkbookDialog, originalWorkbookColumnLabel } from "./OriginalWorkbookDialog";

vi.mock("read-excel-file/browser", () => ({ readSheet: vi.fn() }));

const roots: Root[] = [];
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  while (roots.length) act(() => roots.pop()!.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("OriginalWorkbookDialog", () => {
  it("生成 Excel 列标并限制异常长单元格的页面文本", () => {
    expect([0, 25, 26, 51, 52].map(originalWorkbookColumnLabel)).toEqual(["A", "Z", "AA", "AZ", "BA"]);
    expect(formatOriginalWorkbookCell("x".repeat(700))).toHaveLength(501);
    expect(formatOriginalWorkbookCell(null)).toBe("");
  });

  it("按来源工作表加载并以 50 行分页只读展示", async () => {
    const mockedReadSheet = vi.mocked(readSheet as unknown as (input: File, sheet: string, options: { trim: boolean }) => Promise<SheetData>);
    mockedReadSheet.mockResolvedValue(Array.from({ length: 51 }, (_, index) => [`记录 ${index + 1}`, index + 1]));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const file = new File(["xlsx"], "EDS异常0903.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    await act(async () => {
      root.render(<OriginalWorkbookDialog file={file} sheetNames={["白班明细", "夜班明细"]} onClose={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readSheet).toHaveBeenCalledWith(file, "白班明细", { trim: false });
    expect(container.querySelectorAll("tbody tr")).toHaveLength(50);
    expect(container.textContent).toContain("51 行 × 2 列");
    expect(container.textContent).toContain("1 / 2");
    expect(container.textContent).toContain("不进入 AI 上下文、localStorage、工作区备份或审计正文");

    const next = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "下一页")!;
    act(() => next.click());
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(container.textContent).toContain("2 / 2");
    expect(container.textContent).toContain("记录 51");
  });
});
