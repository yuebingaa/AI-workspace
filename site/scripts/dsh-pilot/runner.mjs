import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolveDshInstallation } from '../../runtime/dsh/installation.mjs';
import { VERSION as DSH_VERSION } from '../../runtime/dsh/policy.mjs';
import { randomUUID } from 'node:crypto';

export { DSH_VERSION };
export const DSH_RELEASE = `dsh-v${DSH_VERSION}`;
const roots = [
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop',
];
let running = false;

async function loadKernel() {
  const installation = await resolveDshInstallation();
  const resolver = createRequire(installation.manifestPath);
  for (const name of roots) {
    const expected = name === '@deepseek-ai/cordis' ? '4.0.4' : DSH_VERSION;
    const packageJson = JSON.parse(await readFile(resolver.resolve(`${name}/package.json`), 'utf8'));
    if (packageJson.version !== expected) throw new Error(`Unexpected installed DSH version: ${name}`);
  }
  return Promise.all(roots.map((name) => import(pathToFileURL(resolver.resolve(name)).href)));
}
function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

/**
 * Test-only composition of the real official kernel, matching its AgentLoop tests.
 * It is NOT an official production application launcher or a model-quality test.
 * No CLI/profile, persistence, HTTP model, shell, filesystem, PTC or subagent plugin
 * is mounted. Registered callbacks are trusted local code, not an OS sandbox.
 */
export async function runDshFixture({
  tools, actions, signal, instruction = 'Run the controlled analysis fixture.',
  sessionId = `dsh-pilot-${randomUUID()}`, timeoutMs = 60_000,
}) {
  if (running) throw new Error('DSH pilot runs must be serial (process-local fetch guard).');
  if (!Array.isArray(tools) || !Array.isArray(actions)) throw new TypeError('tools/actions must be arrays');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new RangeError('Pilot timeout must be 1..120000 ms');
  }
  const toolNames = tools.map((tool) => tool.name);
  if (new Set(toolNames).size !== toolNames.length) throw new Error('Duplicate pilot tool');
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  running = true;
  const previousFetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = async () => {
    networkAttempts += 1;
    throw new Error('Network fetch is forbidden in the offline DSH pilot.');
  };
  let ctx;
  let handle;
  let timer;
  let abort;
  let cancelled = false;
  const toolResults = [];
  let modelCalls = 0;
  try {
    const [cordis, llm, sessions, projections, prompts, registry, agents, loop] = await loadKernel();
    class FixtureAdapter extends llm.LlmAdapter {
      async *stream(options) {
        options.signal?.throwIfAborted();
        const index = modelCalls++;
        const action = actions[index];
        if (!action) {
          if (index !== actions.length) throw new Error('Fixture model script exhausted');
          yield* textChunks('Controlled analysis fixture completed.');
          return;
        }
        const args = typeof action.args === 'function'
          ? await action.args(structuredClone(toolResults)) : action.args;
        options.signal?.throwIfAborted();
        const callId = llm.ToolCallId(`dsh-pilot-call-${index + 1}`);
        const argumentsJson = JSON.stringify(args);
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id: callId, name: action.name, argumentsDelta: argumentsJson };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: action.name, arguments: argumentsJson } };
        yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    }
    ctx = new cordis.Context();
    await ctx.plugin(llm.default);
    await ctx.plugin(sessions.default);
    await ctx.plugin(projections.default);
    await ctx.plugin(prompts.default, {
      personaPrefix: 'Controlled offline analysis fixture. Use only the registered tools.',
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
    });
    await ctx.plugin(registry.default, { mode: 'native' });
    await ctx.plugin(agents.default);
    await ctx.plugin(loop.default, { agents: [] });
    ctx.llm.registerAdapter(['agentcanvas-fixture'], new FixtureAdapter());
    ctx.tools.guard((execution) => toolNames.includes(execution.name)
      ? undefined : 'Tool is outside the offline pilot allowlist.');
    ctx.on('tools/result', (execution, result) => {
      if (!result.isError) {
        toolResults.push({ name: execution.name, value: structuredClone(result.value) });
      }
    });
    for (const tool of tools) {
      if (typeof tool.execute !== 'function') throw new TypeError(`Missing execution for ${tool.name}`);
      ctx.tools.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        output: {
          schema: tool.outputSchema ?? { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, execution) {
          execution.signal.throwIfAborted();
          // The bridge owns business argument validation and project authorization.
          const value = await tool.execute(args, { signal: execution.signal, callId: execution.callId });
          execution.signal.throwIfAborted();
          return value;
        },
      });
    }
    handle = await ctx.agents.create({
      sessionId: sessions.SessionId(sessionId),
      agentOptions: { provider: 'agentcanvas-fixture', model: 'fixed-actions' },
    });
    abort = () => { cancelled = true; handle.agent.cancel({ kind: 'user' }); };
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      cancelled = true;
      handle.agent.cancel({ kind: 'hook', reason: 'offline-pilot-timeout' });
    }, timeoutMs);
    handle.agent.followup(llm.createUserMessage({
      content: [{ type: 'text', text: instruction }], source: { kind: 'user' },
    }));
    if (signal?.aborted) abort();
    await handle.agent.whenIdle();
    const events = structuredClone(handle.agent.session.snapshotEvents());
    const assistant = events.findLast((event) => event.type === 'assistant/message');
    const finalResponse = assistant?.data.message?.content
      ?.filter((block) => block.type === 'text').map((block) => block.text).join('') ?? '';
    const failures = events.filter((event) => event.type === 'tool/result'
      && event.data.message.isError === true);
    const turnEnd = events.findLast((event) => event.type === 'turn/end');
    const outcome = cancelled || turnEnd?.data.reason.kind === 'aborted' ? 'cancelled'
      : failures.length || turnEnd?.data.reason.kind !== 'completed'
        || modelCalls !== actions.length + 1 ? 'failed' : 'completed';
    return {
      runtime: 'official-dsh-in-process-test-composition', version: DSH_VERSION, release: DSH_RELEASE,
      sessionId, outcome, events, finalResponse, modelCalls, toolNames, toolResults,
      failedToolCount: failures.length, networkAttempts, realModel: false,
      persistence: 'memory-only', cancellation: 'cooperative-agent-cancel-and-drain',
    };
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
    try {
      try {
        if (handle) await handle.dispose();
      } finally {
        if (ctx) await ctx.fiber.dispose();
      }
    } finally {
      globalThis.fetch = previousFetch;
      running = false;
    }
  }
}
