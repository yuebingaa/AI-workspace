import type { DshWebSnapshot } from "./protocol";

/** Correlates only this frame's send with its first accepted website turn.
 * A later website retry of identical text must never reuse that RPC identity. */
export class DshWebRequestProjection {
  private requests = new Map<string, string>();
  private pending?: { id: string; text: string; previous: Set<string> };

  begin(id: string, text: string, turns: DshWebSnapshot["turns"]) {
    this.pending = { id, text, previous: new Set(turns.map(turn => turn.id)) };
  }
  reject(id: string) { if (this.pending?.id === id) this.pending = undefined; }
  project(input: DshWebSnapshot): DshWebSnapshot {
    const visible = new Set(input.turns.map(turn => turn.id));
    for (const id of this.requests.keys()) if (!visible.has(id)) this.requests.delete(id);
    const pending = this.pending;
    const matched = pending && input.turns.find(turn => !pending.previous.has(turn.id) && turn.instruction === pending.text);
    if (matched && pending) {
      this.requests.set(matched.id, pending.id);
      this.pending = undefined;
    }
    return { ...input,
      turns: input.turns.map(turn => {
        const requestId = this.requests.get(turn.id);
        return requestId ? { ...turn, requestId } : turn;
      }),
      ...(matched ? { pendingInstruction: "" } : {}),
      ...(this.pending && input.busy ? { pendingRequestId: this.pending.id } : {}),
    };
  }
}
