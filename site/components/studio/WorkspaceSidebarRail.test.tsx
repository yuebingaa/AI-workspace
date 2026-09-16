import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceSidebarRail } from "./WorkspaceSidebarRail";

describe("WorkspaceSidebarRail", () => {
  it("折叠时只提供真实可执行的工作区快捷入口", () => {
    const html = renderToStaticMarkup(<WorkspaceSidebarRail
      toggleButtonRef={createRef<HTMLButtonElement>()}
      filesOpen={false}
      filesButtonRef={createRef<HTMLButtonElement>()}
      onExpand={() => undefined}
      onUploadCsv={() => undefined}
      onOpenOriginalWorkbook={() => undefined}
    />);

    expect(html).toContain('aria-label="打开侧边栏"');
    expect(html).not.toContain('aria-label="EDS 分析"');
    expect(html).toContain('aria-label="导入表格"');
    expect(html).toContain('aria-label="原始文件"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("disabled");
  });

  it("文件面板展开时暴露选中状态和面板关联", () => {
    const html = renderToStaticMarkup(<WorkspaceSidebarRail
      toggleButtonRef={createRef<HTMLButtonElement>()}
      filesOpen
      filesButtonRef={createRef<HTMLButtonElement>()}
      onExpand={() => undefined}
      onUploadCsv={() => undefined}
      onOpenOriginalWorkbook={() => undefined}
    />);

    expect(html).toContain('aria-label="原始文件"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="studio-files-panel"');
  });
});
