import { describe, expect, it } from "vitest";
import type { DshWebSnapshot } from "./protocol";
import { DshWebRequestProjection } from "./request-projection";

const snapshot = (turns: DshWebSnapshot["turns"] = [], busy = false): DshWebSnapshot => ({
  version: 1, session: { id: "session", title: "synthetic" }, turns, busy, canSend: !busy,
  draft: "", pendingInstruction: busy ? "question" : "", statusText: "",
});
const turn = (id: string) => ({ id, instruction: "question", response: "failed", state: "failed" as const, createdAt: new Date(0).toISOString() });
describe("official UI request correlation", () => {
  it("correlates pending then exactly the first new turn, not a website retry of identical text", () => {
    const projection = new DshWebRequestProjection();
    projection.begin("rpc-first", "question", []);
    expect(projection.project(snapshot([], true)).pendingRequestId).toBe("rpc-first");
    expect(projection.project(snapshot([turn("first")])).turns[0].requestId).toBe("rpc-first");
    const retry = projection.project(snapshot([turn("first"), turn("retry")]));
    expect(retry.turns.map(row => row.requestId)).toEqual(["rpc-first", undefined]);
    expect(projection.project(snapshot(retry.turns, true)).pendingRequestId).toBeUndefined();
  });
  it("does not associate pre-existing equal text and keeps distinct subsequent sends", () => {
    const projection = new DshWebRequestProjection(), prior = turn("prior");
    projection.begin("rpc-one", "question", [prior]);
    const first = projection.project(snapshot([prior, turn("one")]));
    projection.begin("rpc-two", "question", first.turns);
    expect(projection.project(snapshot([...first.turns, turn("two")])).turns.map(row => row.requestId)).toEqual([undefined, "rpc-one", "rpc-two"]);
  });
  it("drops rejected and cleared correlations and retires pending text when the turn arrives", () => {
    const projection = new DshWebRequestProjection();
    projection.begin("rejected", "question", []); projection.reject("rejected");
    expect(projection.project(snapshot([turn("a")])).turns[0].requestId).toBeUndefined();
    projection.begin("accepted", "question", []);
    expect(projection.project(snapshot([turn("b")], true)).pendingInstruction).toBe("");
    projection.project(snapshot());
    expect(projection.project(snapshot([turn("b")])).turns[0].requestId).toBeUndefined();
  });
});
