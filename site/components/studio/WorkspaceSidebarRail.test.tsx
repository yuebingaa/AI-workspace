import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceSidebarRail } from "./WorkspaceSidebarRail";

describe("WorkspaceSidebarRail", () => {
  it("折叠时只提供真实可执行的工作区快捷入口", () => {
    const html = renderToStaticMarkup(<WorkspaceSidebarRail
      toggleButtonRef={createRef<HTMLButtonElement>()}
      hasOriginalWorkbook={false}
      onExpand={() => undefined}
      onOpenEdsAnalysis={() => undefined}
      onUploadCsv={() => undefined}
      onOpenOriginalWorkbook={() => undefined}
    />);

    expect(html).toContain('aria-label="打开侧边栏"');
    expect(html).toContain('aria-label="EDS 分析"');
    expect(html).toContain('aria-label="上传 CSV"');
    expect(html).toContain('aria-label="放置原始表格"');
    expect(html).not.toContain("disabled");
  });

  it("原始工作簿存在时把快捷入口改为打开操作", () => {
    const html = renderToStaticMarkup(<WorkspaceSidebarRail
      toggleButtonRef={createRef<HTMLButtonElement>()}
      hasOriginalWorkbook
      onExpand={() => undefined}
      onOpenEdsAnalysis={() => undefined}
      onUploadCsv={() => undefined}
      onOpenOriginalWorkbook={() => undefined}
    />);

    expect(html).toContain('aria-label="打开原始表格"');
    expect(html).not.toContain('aria-label="放置原始表格"');
  });
});
