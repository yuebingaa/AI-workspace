import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const name = 'agentcanvas-session-server';
export const inject = ['agents', 'sessions', 'sessionPersistence', 'loader', 'sdkAppStartup'];

/** A task owns one prompt and one fresh agent scope, even when its log is resumed.
 * Uses only the public agent factory: the official SDK server has create-only
 * session wiring, so no upstream implementation or registry is patched.
 */
export function createNativeSessionController({ ctx, sessionId, mode, createUserMessage }) {
  let route;
  let handle;
  let creation;
  let prompted = false;
  let closing = false;
  let disposal;
  const dispose = () => disposal ??= (async () => {
    closing = true;
    await creation?.catch(() => {});
    await handle?.dispose();
  })();
  return {
    configure(params) {
      if (route || closing) throw new Error('Native session is already initialized or closed.');
      route = { provider: params.provider, model: params.model,
        ...(params.reasoningEffort === undefined ? {} : { reasoningEffort: params.reasoningEffort }),
        ...(params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens }) };
    },
    async prompt(params) {
      if (!route || closing || prompted || params.sessionId !== sessionId
        || !Array.isArray(params.contentBlocks) || params.contentBlocks.length === 0
        || params.contentBlocks.some(block => !block || block.type !== 'text' || typeof block.text !== 'string')) {
        throw new Error('Invalid task-owned native session prompt.');
      }
      prompted = true;
      creation = mode === 'resume'
        ? ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: route })
        : ctx.agents.create({ sessionId, agentOptions: route });
      handle = await creation;
      if (closing) { await handle.dispose(); throw new Error('Native session closed during creation.'); }
      const message = createUserMessage({ content: params.contentBlocks, source: { kind: 'user' } });
      handle.agent.followup(message);
      return { messageId: message.id };
    },
    async checkpoint() {
      if (!handle || !prompted || closing) throw new Error('Native session cannot be checkpointed.');
      await ctx.sessions.flush(handle.agent.session);
      // Dispose drains the closing events and releases the backend writer too.
      // A flush or disposer failure never produces a durable-success receipt.
      await dispose();
      return { persisted: true, sessionId };
    },
    dispose,
  };
}

export async function apply(ctx) {
  const native = JSON.parse(process.env.AGENTCANVAS_DSH_NATIVE_SESSION ?? 'null');
  if (!native || !['create', 'resume'].includes(native.mode)
    || typeof native.sessionId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(native.sessionId)) {
    throw new Error('Missing task-owned native session identity.');
  }
  const resolver = createRequire(process.env.AGENTCANVAS_DSH_MANIFEST);
  const load = name => import(pathToFileURL(resolver.resolve(name)).href);
  const [{ JsonRpcLineTransport }, { HarnessSdkJsonRpcServer }, { createUserMessage }] = await Promise.all([
    load('@deepseek-ai/dsh-sdk-protocol'), load('@deepseek-ai/dsh-sdk-jsonrpc-server'), load('@deepseek-ai/dsh-llm'),
  ]);
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
  // This public peer owns route validation and the official event/status stream.
  // Its create-only prompt handler is intentionally never invoked here.
  const peer = new HarnessSdkJsonRpcServer(ctx, transport, { maxTokensAsSuccess: false });
  const owned = createNativeSessionController({ ctx, ...native, createUserMessage });
  let initialized = false;
  let shutdown;
  const close = () => shutdown ??= (async () => { await owned.dispose(); await peer.shutdown(); })();
  transport.onRequest(async (method, params) => {
    if (method === 'initialize') {
      if (initialized) throw new Error('Native session initialization is not repeatable.');
      await ctx.loader.await();
      const result = await peer.initialize(params);
      owned.configure(params);
      initialized = true;
      return result;
    }
    if (method === 'session/prompt') return owned.prompt(params);
    if (method === 'agentcanvas/checkpoint') return owned.checkpoint();
    if (method !== 'shutdown') throw new Error('Unknown controlled session method.');
    await close();
    setImmediate(() => {
      void (async () => {
        try { await transport.flush(); await ctx.root.fiber.dispose(); process.exit(0); }
        catch { process.exit(1); }
      })();
    });
    return {};
  });
  ctx.effect(() => {
    transport.start();
    return async () => {
      try { await close(); } finally { transport.close(); }
    };
  }, 'agentcanvas.native-session-stdio');
}
