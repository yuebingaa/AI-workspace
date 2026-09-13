import { harnessStreamFrameSchema, type HarnessTaskSummary, type HarnessTraceEvent } from "./contracts";
import { sanitizeHarnessText } from "./security";

export const HARNESS_SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "private, no-store, no-transform",
  "x-accel-buffering": "no",
  "x-content-type-options": "nosniff",
};

export function encodeHarnessFrame(event: HarnessTraceEvent, task?: HarnessTaskSummary): string {
  const frame = harnessStreamFrameSchema.parse({ event, ...(task ? { task } : {}) });
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(frame)}\n\n`;
}

/** POST + fetch streaming: EventSource itself only supports GET. */
export function createHarnessStreamResponse(
  requestSignal: AbortSignal,
  run: (signal: AbortSignal, emit: (event: HarnessTraceEvent) => void) => Promise<HarnessTaskSummary>,
  headers: Record<string, string> = {},
): Response {
  const execution = new AbortController();
  let stopped = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const abort = () => execution.abort(requestSignal.reason);
  const cleanup = () => { clearInterval(heartbeat); requestSignal.removeEventListener("abort", abort); };
  if (requestSignal.aborted) abort();
  else requestSignal.addEventListener("abort", abort, { once: true });
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        if (stopped) return;
        try { controller.enqueue(encoder.encode(text)); } catch { stopped = true; cleanup(); execution.abort(); }
      };
      write(": connected\n\n");
      heartbeat = setInterval(() => write(": heartbeat\n\n"), 10_000);
      void Promise.resolve().then(() => {
        if (execution.signal.aborted) throw new Error("任务已取消，未启动执行。");
        return run(execution.signal, (event) => write(encodeHarnessFrame(event)));
      }).then((task) => {
        const sequence = (task.trace?.at(-1)?.sequence ?? 0) + 1;
        const terminal = task.trace?.at(-1)?.type === "completed" ? task.trace.at(-1)! : {
          id: `${task.id}:${sequence}`, sequence, taskId: task.id, timestamp: task.updatedAt,
          type: "completed" as const, taskState: task.state, message: "任务已结束。",
        };
        // The final answer is delivered only here, after runtime verification.
        write(encodeHarnessFrame(terminal, task));
      }).catch((error: unknown) => {
        write(`event: stream_error\ndata: ${JSON.stringify({ message: sanitizeHarnessText(error, "Harness 执行失败。") })}\n\n`);
      }).finally(() => {
        cleanup();
        if (!stopped) { stopped = true; controller.close(); }
      });
    },
    cancel() { stopped = true; cleanup(); execution.abort(new Error("Stream consumer disconnected")); },
  });
  return new Response(body, { headers: { ...headers, ...HARNESS_SSE_HEADERS } });
}

export async function readHarnessStream(
  response: Response,
  signal: AbortSignal,
  onEvent?: (event: HarnessTraceEvent) => void,
): Promise<{ task: HarnessTaskSummary }> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("响应不是事件流。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let bytes = 0;
  let sequence = 0;
  let taskId: string | undefined;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error("任务已取消。");
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("任务已取消。");
      bytes += value?.byteLength ?? 0;
      if (bytes > 8 * 1024 * 1024) throw new Error("事件流超过大小限制。");
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // Normalize only complete CRLF pairs; a split trailing CR stays buffered.
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = block.split("\n");
        const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
        if (eventName === "stream_error") {
          const error = JSON.parse(data) as { message?: unknown };
          throw new Error(typeof error.message === "string" ? error.message : "Harness 执行失败。");
        }
        const frame = harnessStreamFrameSchema.parse(JSON.parse(data));
        if (eventName !== frame.event.type || (taskId && frame.event.taskId !== taskId)
          || frame.event.sequence !== sequence + 1) throw new Error("事件流顺序或任务标识无效。");
        taskId = frame.event.taskId;
        sequence = frame.event.sequence;
        onEvent?.(frame.event);
        if (frame.task) return { task: frame.task };
      }
      if (buffer.length > 4 * 1024 * 1024) throw new Error("单个事件超过大小限制。");
      if (done) throw new Error("事件流中断，未收到最终任务结果。请检查连接后重试。");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
