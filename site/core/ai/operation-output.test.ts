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
  it("admin Schema 只定义执行器支持的五种操作和可信目录枚举", () => {
    const serialized = JSON.stringify(buildModelPlanJsonSchema(request("admin")));
    for (const type of ["addNode", "updateNodeProps", "removeNode", "moveNode", "updatePage"]) {
      expect(serialized).toContain(`\"${type}\"`);
    }
    expect(serialized).toContain("page_home");
    expect(serialized).toContain("page_home_revenue");
    expect(serialized).toContain("dataset_retail_orders");
    expect(serialized).toContain("order_date");
    expect(serialized).not.toContain("operationId");
    expect(serialized).not.toContain("changeSetId");
  });

  it("editor Schema 不提供删除组件和修改页面结构操作", () => {
    const serialized = JSON.stringify(buildModelPlanJsonSchema(request("editor")));
    expect(serialized).toContain("addNode");
    expect(serialized).toContain("updateNodeProps");
    expect(serialized).toContain("moveNode");
    expect(serialized).not.toContain('"removeNode"');
    expect(serialized).not.toContain('"updatePage"');
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
