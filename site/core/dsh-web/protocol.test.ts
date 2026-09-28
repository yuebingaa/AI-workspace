import { describe, expect, it } from "vitest";
import { DSH_WEB_CHANNEL, dshWebCommandSchema, dshWebSnapshotSchema, readDshWebCommand } from "./protocol";

const nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", source = {}, origin = "http://127.0.0.1:3001";
const envelope = { channel: DSH_WEB_CHANNEL, nonce };
describe("official UI display bridge boundary", () => {
  it("accepts only the exact frame, origin and per-mount nonce", () => {
    const event = { source, origin, data: { ...envelope, type: "ready" } };
    expect(readDshWebCommand(event, source, origin, nonce)?.type).toBe("ready");
    for (const wrong of [{ ...event, source: {} }, { ...event, origin: "http://localhost:3001" },
      { ...event, data: { ...event.data, nonce: crypto.randomUUID() } }]) expect(readDshWebCommand(wrong, source, origin, nonce)).toBeNull();
    expect(readDshWebCommand(event, null, origin, nonce)).toBeNull();
  });
  it.each(["execute", "apply", "delete", "configure", "shell", "switchProject"])("rejects unsupported %s commands", type => {
    expect(dshWebCommandSchema.safeParse({ ...envelope, type }).success).toBe(false);
  });
  it("only accepts bounded text input and rejects extra authority fields", () => {
    const send = { ...envelope, type: "send", requestId: "rpc-1", text: "你好" };
    expect(dshWebCommandSchema.parse(send)).toEqual(send);
    for (const more of [{ text: " " }, { text: "x".repeat(1001) }, { path: "private" }, { role: "admin" },
      { attachments: [{}] }, { project: "other" }, { requestId: "../id" }]) expect(dshWebCommandSchema.safeParse({ ...send, ...more }).success).toBe(false);
  });
  it("does not allow raw task/project configuration in a display snapshot", () => {
    const snapshot = { version: 1, session: { id: "display-one", title: "合成对话" }, turns: [], draft: "", busy: false, canSend: true, pendingInstruction: "", statusText: "" };
    expect(dshWebSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    for (const more of [{ appSpec: {} }, { apiKey: "synthetic" }, { projectHandle: "other" }, { tasks: [] }, { rawWorkbook: {} }]) {
      expect(dshWebSnapshotSchema.safeParse({ ...snapshot, ...more }).success).toBe(false);
    }
  });
});
