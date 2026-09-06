import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StudioHeader } from "./StudioHeader";

describe("StudioHeader", () => {
  it("提供紧凑的工作区备份与恢复入口，并明确排除敏感原始数据", () => {
    const html = renderToStaticMarkup(<StudioHeader
      interfaces={[{
        id: "eds-analysis",
        label: "EDS 飞达异常分析",
        description: "导入工作簿并查看分析看板",
      }]}
      activeInterfaceId="eds-analysis"
      device="desktop"
      canUndo={false}
      saveLabel="已保存"
      role="editor"
      historyCount={3}
      historyButtonRef={createRef<HTMLButtonElement>()}
      publishButtonRef={createRef<HTMLButtonElement>()}
      pagesButtonRef={createRef<HTMLButtonElement>()}
      assistantButtonRef={createRef<HTMLButtonElement>()}
      onDeviceChange={() => undefined}
      onUndo={() => undefined}
      onRoleChange={() => undefined}
      onExportBackup={() => undefined}
      onChooseBackupFile={() => undefined}
      onInterfaceChange={() => undefined}
      onOpenHistory={() => undefined}
      onOpenPublish={() => undefined}
      onOpenPages={() => undefined}
      onOpenAssistant={() => undefined}
    />);

    expect(html).toContain("工作区备份");
    expect(html).toContain("下载备份");
    expect(html).toContain("从文件恢复");
    expect(html).toContain("不包含原始工作簿、逐行明细或 API Key");
    expect(html).toContain('class="header-more-menu"');
    expect(html).toContain("更多工作区操作");
    expect(html).toContain("切换工作界面");
    expect(html).toContain('aria-label="打开紧凑工作界面菜单"');
    expect(html).toContain("EDS 飞达异常分析");
    expect(html).toContain("后续新增的业务界面会自动加入此列表");
    expect(html).not.toContain("零售经营分析");
    expect(html).not.toContain("恢复演示数据");
    expect(html).toContain("撤销上一步");
    expect(html).toContain('aria-label="紧凑菜单中的界面演示角色"');
    expect(html).toContain('class="compact-panel-entry"');
    expect(html).toContain("AI 助手");
  });
});
