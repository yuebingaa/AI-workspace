import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StudioHeader } from "./StudioHeader";
import { WorkspaceNavigation } from "./WorkspaceNavigation";

const interfaces = [{ id: "analysis", label: "销售分析", description: "本地导入的数据" }];
function renderHeader(mode: "agent" | "notebook" | "canvas") {
  return renderToStaticMarkup(<StudioHeader
    interfaces={interfaces} activeInterfaceId="analysis" saveLabel="已保存" mode={mode} assistantOpen
    navigation={<WorkspaceNavigation buttonRef={createRef<HTMLButtonElement>()}
      interfaces={interfaces} activeInterfaceId="analysis" saveLabel="已保存" role="editor"
      canUndo={false} resourceBusy={false} historyCount={0}
      onRoleChange={() => undefined} onInterfaceChange={() => undefined}
      onCreateInterface={() => undefined} onAction={() => undefined} />}
    publishButtonRef={createRef<HTMLButtonElement>()} assistantButtonRef={createRef<HTMLButtonElement>()}
    onInterfaceChange={() => undefined} onModeChange={() => undefined}
    onOpenPublish={() => undefined} onOpenAssistant={() => undefined} />);
}
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
  });
  it("Notebook 保留可收起的 AI 助手入口和发布操作", () => {
    const html = renderHeader("notebook");
    expect(html).toContain('aria-controls="studio-assistant-panel" aria-expanded="true"');
    expect(html).toContain("AI 助手");
    expect(html).toContain('class="publish"');
    expect(html).toContain('id="workspace-tab-notebook" type="button" role="tab" aria-selected="true"');
  });
});
