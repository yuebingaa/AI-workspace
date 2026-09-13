import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AppNode } from "@/core/models";
import { AppSpecRenderer } from "./AppSpecRenderer";

const header: AppNode = {
  id: "page_header_test",
  type: "PageHeader",
  props: {
    eyebrow: "测试页面",
    title: "变更目标",
    description: "验证画布反馈属性",
    dateRange: "本月",
  },
};

describe("AppSpecRenderer 变更反馈", () => {
  it("只给 ChangeSet 命中的组件添加预览高亮证据", () => {
    const highlighted = renderToStaticMarkup(<AppSpecRenderer node={header} context={{
      dataSources: [],
      dataRuntime: { rowsByDataSourceId: {} },
      pageId: "page_test",
      queryRevision: "preview:1",
      highlightedNodeIds: [header.id],
      changeFeedback: "preview",
    }} />);
    const untouched = renderToStaticMarkup(<AppSpecRenderer node={header} context={{
      dataSources: [],
      dataRuntime: { rowsByDataSourceId: {} },
      pageId: "page_test",
      queryRevision: "formal:1",
    }} />);

    expect(highlighted).toContain('data-node-id="page_header_test"');
    expect(highlighted).toContain('data-change-feedback="preview"');
    expect(untouched).not.toContain("data-change-feedback");
  });
});
