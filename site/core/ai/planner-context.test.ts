import { describe, expect, it } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { buildPlannerContext, DEEPSEEK_CHANGESET_SYSTEM_PROMPT } from "./planner-context";

describe("DeepSeek 最小规划上下文", () => {
  it("只包含规划所需 AppSpec、组件、字段与权限信息", () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    const context = buildPlannerContext({
      instruction: "修改指标标题",
      pageId: "page_home",
      appSpec: structuredClone(demoFixtureResult.data.dataProduct.appSpec),
      role: "editor",
    });
    const serialized = JSON.stringify(context);
    expect(serialized).toContain("page_home_revenue");
    expect(serialized).toContain("dataset_retail_orders");
    expect(serialized).toContain("updateNodeProps");
    expect(serialized).not.toContain("localStorage");
    expect(serialized).not.toContain("auditRecords");
    expect(serialized).not.toContain("DEEPSEEK_API_KEY");
    expect(serialized).not.toContain("order_001");
  });

  it("系统提示明确限制 JSON 和五种 ChangeOperation 字段结构", () => {
    expect(DEEPSEEK_CHANGESET_SYSTEM_PROMPT).toContain("只返回");
    expect(DEEPSEEK_CHANGESET_SYSTEM_PROMPT).toContain("updateNodeProps");
    expect(DEEPSEEK_CHANGESET_SYSTEM_PROMPT).toContain("addNode");
    expect(DEEPSEEK_CHANGESET_SYSTEM_PROMPT).toContain("removeNode");
    expect(DEEPSEEK_CHANGESET_SYSTEM_PROMPT).toContain("moveNode");
    expect(DEEPSEEK_CHANGESET_SYSTEM_PROMPT).toContain("updatePage");
  });
});
