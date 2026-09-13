import { describe, expect, it } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import type { AiPlanRequest } from "./contracts";
import { buildModelPlanJsonSchema, compileModelPlanDraft, modelPlanDraftSchema } from "./operation-output";

function request(role: AiPlanRequest["role"]): AiPlanRequest {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return {
    instruction: "将本月收入指标标题改为月度总收入，不要应用。",
    pageId: "page_home",
    appSpec: structuredClone(demoFixtureResult.data.dataProduct.appSpec),
    role,
  };
}

describe("AI operations 输出约束与服务端编译", () => {
  it("admin Schema 只定义执行器支持的七种操作和可信目录枚举", () => {
    const serialized = JSON.stringify(buildModelPlanJsonSchema(request("admin")));
    for (const type of ["addPage", "deletePage", "addNode", "updateNodeProps", "removeNode", "moveNode", "updatePage"]) {
      expect(serialized).toContain(`\"${type}\"`);
    }
    expect(serialized).toContain("page_home");
    expect(serialized).toContain("page_home_revenue");
    expect(serialized).toContain("dataset_retail_orders");
    expect(serialized).toContain("order_date");
    expect(serialized).not.toContain("operationId");
    expect(serialized).not.toContain("changeSetId");
  });

  it("editor Schema 提供工作界面管理，但不提供删除内部组件", () => {
    const serialized = JSON.stringify(buildModelPlanJsonSchema(request("editor")));
    expect(serialized).toContain("addNode");
    expect(serialized).toContain("updateNodeProps");
    expect(serialized).toContain("moveNode");
    expect(serialized).toContain("addPage");
    expect(serialized).toContain("deletePage");
    expect(serialized).toContain("updatePage");
    expect(serialized).not.toContain('"removeNode"');
  });

  it("服务端为 AI 新增工作界面生成可信页面、导航和根节点 ID", () => {
    const changeSet = compileModelPlanDraft({
      message: "已准备新增界面。",
      operations: [{ type: "addPage", title: "质量分析" }],
    }, "新增一个质量分析工作界面", {
      now: () => 1_888,
      idFactory: () => "pageop",
    });
    expect(changeSet.operations[0]).toMatchObject({
      type: "addPage",
      pageId: "page_workspace_operation_ai_1_pageop",
      page: { title: "质量分析", root: { type: "PageRoot" } },
      navigationItem: { title: "质量分析", pageId: "page_workspace_operation_ai_1_pageop" },
    });
  });

  it("模型不能自由填写 ChangeSet 或操作可信字段", () => {
    const parsed = modelPlanDraftSchema.safeParse({
      message: "修改标题",
      changeSetId: "model_owned",
      operations: [{
        id: "model_operation",
        type: "updateNodeProps",
        pageId: "page_home",
        nodeId: "page_home_revenue",
        props: { label: "月度总收入" },
      }],
    });
    expect(parsed.success).toBe(false);
  });

  it("服务端将精确标题修改草稿编译为正式 updateNodeProps", () => {
    const changeSet = compileModelPlanDraft({
      message: "已准备标题修改。",
      operations: [{
        type: "updateNodeProps",
        pageId: "page_home",
        nodeId: "page_home_revenue",
        props: { label: "月度总收入" },
      }],
    }, request("editor").instruction, {
      now: () => 1_777,
      idFactory: () => "serverid",
    });
    expect(changeSet).toMatchObject({
      id: "changeset_ai_1777_serverid",
      status: "ready",
      operations: [{
        id: "operation_ai_1_serverid",
        type: "updateNodeProps",
        nodeId: "page_home_revenue",
        props: { label: "月度总收入" },
      }],
    });
  });
});
