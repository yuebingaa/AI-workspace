// @vitest-environment happy-dom

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "@/test-support/render-themed";
import { describe, expect, it } from "vitest";
import { StudioHeader } from "./StudioHeader";
import { WorkspaceNavigation } from "./WorkspaceNavigation";
import { StudioTheme } from "@/components/ui/studio-theme";
import { markupRoot } from "@/test-support/markup";

const interfaces = [{ id: "analysis", label: "销售分析", description: "本地导入的数据" }];
function renderHeader(mode: "agent" | "notebook" | "canvas") {
  return renderToStaticMarkup(<StudioHeader
    interfaces={interfaces} activeInterfaceId="analysis" saveLabel="已保存" mode={mode} assistantOpen
    navigation={<WorkspaceNavigation buttonRef={createRef<HTMLButtonElement>()}
      interfaces={interfaces} activeInterfaceId="analysis" saveLabel="已保存" role="editor"
      canUndo={false} resourceBusy={false} historyCount={0}
      onInterfaceChange={() => undefined}
      onCreateInterface={() => undefined} onAction={() => undefined} />}
    assistantButtonRef={createRef<HTMLButtonElement>()}
    onInterfaceChange={() => undefined} onModeChange={() => undefined}
    onOpenAssistant={() => undefined} />);
}
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe("StudioHeader", () => {
  it("首屏只展示统一菜单、真实工作界面和三种模式，功能菜单按需展开", () => {
    const html = renderHeader("agent");
    expect(html).toContain('aria-label="打开工作区菜单"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('aria-label="工作区功能菜单"');
    expect(html).toContain("销售分析");
    expect(html).not.toContain("零售经营分析");
    for (const mode of ["agent", "notebook", "canvas"]) expect(html).toContain('id="workspace-tab-' + mode + '"');
    expect(html).not.toContain('class="studio-assistant-entry"');
    expect(html).not.toContain('class="publish"');
  });
  it("Notebook 保留可收起的 AI 助手入口，不显示发布操作", () => {
    const html = renderHeader("notebook");
    expect(html).toContain('aria-controls="studio-assistant-panel" aria-expanded="true"');
    expect(html).toContain("AI 助手");
    expect(html).not.toContain('class="publish"');
    const tab = markupRoot(html).querySelector('#workspace-tab-notebook');
    expect(tab?.getAttribute('role')).toBe('tab');
    expect(tab?.getAttribute('aria-selected')).toBe('true');
  });
  it("菜单保留工作区工具，不显示可视化测试和界面演示角色选择", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => root.render(<StudioTheme><WorkspaceNavigation buttonRef={createRef<HTMLButtonElement>()}
        interfaces={interfaces} activeInterfaceId="analysis" saveLabel="已保存" role="editor"
        canUndo={false} resourceBusy={false} historyCount={0}
        onInterfaceChange={() => undefined} onCreateInterface={() => undefined} onAction={() => undefined} /></StudioTheme>));
      act(() => container.querySelector<HTMLButtonElement>(".studio-navigation-toggle")!.click());
      const menu = document.querySelector<HTMLElement>('[aria-label="工作区功能菜单"]')!;
      act(() => menu.querySelector<HTMLElement>(".studio-navigation-settings summary")!.click());
      expect(menu.textContent).toContain("设置与备份");
      expect(menu.textContent).toContain("数据浏览器");
      expect(menu.textContent).toContain("任务与变更历史");
      expect(menu.textContent).not.toContain("可视化测试");
      expect(menu.querySelector('a[href="/visualization-lab"]')).toBeNull();
      expect(menu.textContent).not.toContain("界面演示角色");
      expect(menu.querySelector(".studio-navigation-settings select")).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
