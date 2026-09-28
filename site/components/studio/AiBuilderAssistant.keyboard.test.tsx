import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { AiBuilderAssistant } from "./AiBuilderAssistant";
import { DshWebFrame } from "./dsh-web/DshWebFrame";

type AssistantProps = ComponentProps<typeof AiBuilderAssistant>;
type FrameProps = ComponentProps<typeof DshWebFrame>;

function findFrame(node: ReactNode): FrameProps | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === DshWebFrame) return (child as ReactElement<FrameProps>).props;
    const nested = findFrame(child.props.children);
    if (nested) return nested;
  }
}

function renderComposer(overrides: Partial<AssistantProps> = {}) {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  const onSubmitInstruction = vi.fn(async (_text: string, onAccepted: () => void) => { onAccepted(); });
  const onInstructionChange = vi.fn(), onCancelRequest = vi.fn();
  const props: AssistantProps = {
    pageTitle: "DSH 输入验收", changeSet: demoFixtureResult.data.repurchaseChangeSet,
    status: "pending", validationError: null, canApply: false, canPreview: false, aiMetadata: null,
    instruction: "合成问题", requestStatus: "idle", requestError: null, canRetry: false,
    harnessTask: null, conversationTurns: [], pendingInstruction: "", dataAnalysisMode: false,
    imageAttachments: [], onInstructionChange, onImageAttachmentsChange: vi.fn(), onSubmitInstruction,
    onCancelRequest, onRetry: vi.fn(), onPreview: vi.fn(), onApply: vi.fn(), onCancelPreview: vi.fn(),
    ...overrides,
  };
  let tree: ReactElement | null = null;
  function CaptureComposer() { tree = AiBuilderAssistant(props); return tree; }
  const html = renderToStaticMarkup(<CaptureComposer />);
  const frame = findFrame(tree);
  if (!frame) throw new Error("Official DSH frame was not rendered");
  return { html, frame, onSubmitInstruction, onInstructionChange, onCancelRequest };
}

// Actual Enter / Shift+Enter / IME handling belongs to the pinned DSH composer.
// verify-dsh-default.mjs exercises those keys in the real iframe; these tests
// ensure the parent delegates input without a second legacy keyboard handler.
describe.each(["sidebar", "workspace"] as const)("DSH input ownership in %s", (presentation) => {
  it("has one official frame and no competing textarea, send button or image picker", () => {
    const { html } = renderComposer({ presentation });
    expect(html.match(/aria-label="官方 DSH 对话界面"/gu)).toHaveLength(1);
    for (const retired of ["<textarea", 'aria-label="发送 AI 指令"', 'aria-label="上传图片"', 'class="prompt-box"']) {
      expect(html).not.toContain(retired);
    }
  });

  it.each(["单行", "第一行\n第二行", "中文输入确认"])("delegates accepted input %j exactly once without rewriting it", async text => {
    const { frame, onSubmitInstruction } = renderComposer({ presentation });
    const accepted = vi.fn();
    await frame.onSend(text, accepted);
    expect(onSubmitInstruction).toHaveBeenCalledExactlyOnceWith(text, accepted);
    expect(accepted).toHaveBeenCalledOnce();
  });

  it("leaves rejection unacknowledged and propagates the failure to the frame", async () => {
    const failure = new Error("未获网站接收");
    const onSubmitInstruction = vi.fn(async () => { throw failure; });
    const { frame } = renderComposer({ presentation, onSubmitInstruction });
    const accepted = vi.fn();
    await expect(frame.onSend("保留输入", accepted)).rejects.toBe(failure);
    expect(accepted).not.toHaveBeenCalled();
    expect(onSubmitInstruction).toHaveBeenCalledOnce();
  });

  it("projects busy state and delegates cancellation to the active request", () => {
    const { frame, onCancelRequest } = renderComposer({ presentation, requestStatus: "loading", pendingInstruction: "已提交问题" });
    expect(frame.snapshot.busy).toBe(true);
    expect(frame.snapshot.canSend).toBe(false);
    expect(frame.snapshot.pendingInstruction).toBe("已提交问题");
    frame.onCancel();
    expect(onCancelRequest).toHaveBeenCalledOnce();
  });

  it("restores the authoritative draft and delegates edits without submitting", () => {
    const { frame, onInstructionChange, onSubmitInstruction } = renderComposer({ presentation, instruction: "恢复的草稿\n下一行" });
    expect(frame.snapshot.draft).toBe("恢复的草稿\n下一行");
    frame.onDraft("新输入");
    expect(onInstructionChange).toHaveBeenCalledExactlyOnceWith("新输入");
    expect(onSubmitInstruction).not.toHaveBeenCalled();
  });

  it("blocks unsupported image-only input and retains a removal action", () => {
    const image = new File(["synthetic"], "synthetic.png", { type: "image/png" });
    const { html, frame } = renderComposer({ presentation, instruction: "", imageAttachments: [image] });
    expect(frame.snapshot.canSend).toBe(false);
    expect(html).toContain("移除待发送图片");
  });

  it("projects raw conversation text in order without leaking task or private fields", () => {
    const first = { id: "first", instruction: "**原文** <img src=x>", response: "## 结论\n**East**",
      createdAt: "2026-09-27T00:00:00.000Z", state: "success" as const, taskId: "private-task", privateValue: "PRIVATE_CANARY" };
    const second = { id: "second", instruction: "再试", response: "失败回执",
      createdAt: "2026-09-27T00:01:00.000Z", state: "failed" as const };
    const before = structuredClone([first, second]);
    const { html, frame } = renderComposer({ presentation, conversationTurns: [first, second] });
    expect(frame.snapshot.turns).toEqual([
      { id: first.id, instruction: first.instruction, response: first.response, createdAt: first.createdAt, state: first.state },
      second,
    ]);
    expect(JSON.stringify(frame.snapshot)).not.toMatch(/private-task|PRIVATE_CANARY/u);
    expect([first, second]).toEqual(before);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("assistant-answer");
  });
});
