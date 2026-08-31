import { describe, expect, it, vi } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { appSpecToPuckData } from "./appspec-puck-adapter";
import {
  appSpecRevision,
  initializePuckDraft,
  samePuckData,
  updatePuckDraft,
  type PuckDraftState,
} from "./puck-draft-state";

function fixture() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return structuredClone(demoFixtureResult.data.dataProduct.appSpec);
}

describe("Puck 草稿生命周期", () => {
  it("连续进入编辑模式不会重复初始化或形成状态更新循环", () => {
    const appSpec = fixture();
    const origin = { pageId: "page_home", appSpecRevision: appSpecRevision(appSpec) };
    const createData = vi.fn(() => appSpecToPuckData(appSpec, origin.pageId));
    let state: PuckDraftState = { data: null, origin: null };

    for (let toggle = 0; toggle < 5; toggle += 1) {
      const previous = state;
      state = initializePuckDraft(state, origin, createData);
      if (toggle > 0) expect(state).toBe(previous);
    }

    expect(createData).toHaveBeenCalledTimes(1);
  });

  it("只在页面或正式 AppSpec revision 变化时重新初始化", () => {
    const appSpec = fixture();
    const first = initializePuckDraft(
      { data: null, origin: null },
      { pageId: "page_home", appSpecRevision: appSpecRevision(appSpec) },
      () => appSpecToPuckData(appSpec, "page_home"),
    );
    const nextSpec = structuredClone(appSpec);
    nextSpec.pages[0].title = "更新后的页面";
    const second = initializePuckDraft(
      first,
      { pageId: "page_home", appSpecRevision: appSpecRevision(nextSpec) },
      () => appSpecToPuckData(nextSpec, "page_home"),
    );

    expect(second).not.toBe(first);
    expect(second.origin?.appSpecRevision).not.toBe(first.origin?.appSpecRevision);
  });

  it("忽略语义相同的 Puck onChange 数据", () => {
    const data = appSpecToPuckData(fixture(), "page_home");
    const sameData = structuredClone(data);

    expect(samePuckData(data, sameData)).toBe(true);
    expect(updatePuckDraft(data, sameData)).toBe(data);
  });
});
