import { z } from "zod";
import { configuredSnapshotAdapter, type SnapshotAdapter } from "@/core/persistence/server/json-file-snapshot";
import { harnessRequestSchema, type HarnessRequest, type HarnessTaskSummary } from "../contracts";
import { sanitizeHarnessText } from "../security";

const contextSchema = harnessRequestSchema.shape.conversationContext.unwrap();
const entrySchema = z.object({ key: z.string().max(600), updatedAt: z.number(), context: contextSchema }).strict();
const snapshotSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(100) }).strict();
type Snapshot = z.infer<typeof snapshotSchema>;
type Context = z.infer<typeof contextSchema>;
const ttl = 30 * 24 * 60 * 60 * 1_000;

function safeText(value: string, max = 1_000) { return sanitizeHarnessText(value, "（空）").slice(0, max); }
function safeContext(context: Context): Context {
  // Recursively redact known credentials; never store screenshots, workbook bytes, or tool rows.
  return contextSchema.parse(JSON.parse(JSON.stringify(context), (_key, value: unknown) =>
    typeof value === "string" ? safeText(value) : value));
}

export class HarnessConversationStore {
  private entries = new Map<string, z.infer<typeof entrySchema>>();
  private active = new Set<string>();
  private loaded = false;
  constructor(private readonly adapter?: SnapshotAdapter<Snapshot>, private readonly now = Date.now) {}

  private load() {
    if (this.loaded) return;
    const saved = this.adapter?.load();
    if (saved) this.entries = new Map(saved.entries.map((entry) => [entry.key, entry]));
    this.loaded = true;
  }
  private key(namespace: string, conversationId: string, pageId: string) {
    return JSON.stringify([namespace, conversationId, pageId]);
  }
  private persist() { this.adapter?.save({ version: 1, entries: [...this.entries.values()] }); }

  begin(request: HarnessRequest, namespace: string) {
    if (!request.conversation_id) return { context: request.conversationContext, commit: () => {}, release: () => {} };
    this.load();
    for (const [key, entry] of this.entries) {
      if (this.now() - entry.updatedAt > ttl && !this.active.has(key)) this.entries.delete(key);
    }
    const key = this.key(namespace, request.conversation_id, request.pageId);
    if (this.active.has(key)) throw new Error("当前会话已有任务执行中，请等待结束后再发送。");
    if (this.active.size >= 100) throw new Error("并行会话数量达到上限，请稍后再试。");
    if (!this.entries.has(key) && this.entries.size >= 100) {
      const evictable = [...this.entries.keys()].find((candidate) => !this.active.has(candidate));
      if (!evictable) throw new Error("会话存储已满，请稍后再试。");
      this.entries.delete(evictable);
    }
    // A known conversation is server-authoritative. Client history is migration/bootstrap only.
    const previous = safeContext(this.entries.get(key)?.context ?? request.conversationContext ?? {});
    const context: Context = { ...previous,
      selectedContext: [request.pageId, ...(request.dataSourceId ? [request.dataSourceId] : []),
        ...(request.semanticModel ? [`${request.semanticModel.id}@v${request.semanticModel.version}`] : []),
        ...request.recipes.filter((recipe) => recipe.sourceDatasetId === request.dataSourceId).map((recipe) => recipe.id)].slice(0, 20),
    };
    this.active.add(key);
    let released = false;
    return {
      context,
      commit: (task: HarnessTaskSummary) => {
        if (released) return;
        const messages = [...(previous.recentMessages ?? []), {
          instruction: safeText(request.instruction), response: safeText(task.resultMessage ?? task.error ?? "任务未完成。"),
        }];
        // Deterministic rolling extract, explicitly not a fresh fact or a hidden reasoning summary.
        const evicted = messages.slice(0, Math.max(0, messages.length - 10));
        const summary = [previous.summary ?? "", ...evicted.map((turn) =>
          `历史目标：${turn.instruction.slice(0, 120)}；当时回复（待复核）：${turn.response.slice(0, 180)}`)].filter(Boolean).join("\n").slice(-2_000);
        const nextContext = contextSchema.parse({ ...context,
          previousInstruction: safeText(request.instruction),
          previousAssistantMessage: safeText(task.resultMessage ?? task.error ?? "任务未完成。"),
          recentMessages: messages.slice(-10), summary,
          ...(task.workingMemory ? { workingMemory: safeContext({ workingMemory: task.workingMemory }).workingMemory } : {}),
          taskHistory: [...(previous.taskHistory ?? []), { id: task.id, state: task.state, goal: safeText(request.instruction, 240) }].slice(-10),
        });
        this.entries.delete(key);
        this.entries.set(key, { key, updatedAt: this.now(), context: nextContext });
        while (this.entries.size > 100) {
          const oldest = [...this.entries.keys()].find((candidate) => !this.active.has(candidate));
          if (!oldest) break;
          this.entries.delete(oldest);
        }
        try { this.persist(); task.conversationStorage = this.adapter ? "persistent" : "memory"; }
        catch { task.conversationStorage = "unavailable"; }
      },
      release: () => { released = true; this.active.delete(key); },
    };
  }

  clear(namespace: string, conversationId: string, pageId: string) {
    this.load();
    const key = this.key(namespace, conversationId, pageId);
    if (this.active.has(key)) throw new Error("请先停止当前会话任务，再清除上下文。");
    const prior = this.entries.get(key);
    this.entries.delete(key);
    try { this.persist(); } catch (error) { if (prior) this.entries.set(key, prior); throw error; }
  }
}

export const harnessConversationStore = new HarnessConversationStore(
  configuredSnapshotAdapter("harness-conversations.json", snapshotSchema, 16 * 1024 * 1024),
);
