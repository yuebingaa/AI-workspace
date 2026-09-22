import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DISABLED_ROWS, assertBrokerAddress, catalogToolNames } from './policy.mjs';
import { createWireFetch } from './wire-policy.mjs';
import { notebookSearchFailureMessage, toolArgumentFailureMessage } from './tool-diagnostics.mjs';

export const name = 'agentcanvas-controlled';
export const inject = ['llm', 'tools', 'loader'];

export async function apply(ctx) {
  const broker = assertBrokerAddress(process.env.AGENTCANVAS_DSH_BROKER);
  const token = process.env.AGENTCANVAS_DSH_TOKEN;
  if (!token || token.length < 32) throw new Error('Missing task-owned broker credential.');
  const model = JSON.parse(process.env.AGENTCANVAS_DSH_MODEL ?? 'null');
  if (!model || !['deepseek', 'fixture'].includes(model.mode)) throw new Error('Explicit DSH model mode required.');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createWireFetch(originalFetch, { brokerUrl: broker.href, brokerToken: token, modelConfig: model });
  ctx.effect(() => () => { globalThis.fetch = originalFetch; });
  const resolver = createRequire(pathToFileURL(process.env.AGENTCANVAS_DSH_MANIFEST));
  const llm = await import(pathToFileURL(resolver.resolve('@deepseek-ai/dsh-llm')).href);
  const request = async (path, body, signal, parameters) => {
    const response = await fetch(new URL(path, broker), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      if (path === '/execute' && response.status === 422 && parameters) {
        const failure = await response.json().catch(() => undefined);
        const message = toolArgumentFailureMessage(failure, parameters) ?? notebookSearchFailureMessage(failure, body?.name);
        if (message) throw new Error(message);
      }
      throw new Error(`Task broker rejected ${path} (${response.status}).`);
    }
    return response.json();
  };
  const catalog = await request('/catalog', undefined, AbortSignal.timeout(10_000));
  const taskToolNames = catalogToolNames(catalog.tools);
  for (const id of DISABLED_ROWS) {
    const row = [...ctx.loader.entries()].find((entry) => entry.options.id === id);
    if (!row || !row.disabled) throw new Error(`Unsafe DSH profile entry: ${id}`);
  }
  for (const tool of catalog.tools) {
    ctx.tools.register({
      name: tool.name, description: tool.description, parameters: tool.parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: (args, execution) => request('/execute', {
        name: tool.name, args, callId: execution.callId,
      }, execution.signal, tool.parameters),
    });
  }
  ctx.tools.guard((execution) => taskToolNames.includes(execution.name)
    ? undefined : 'Tool is not in the task-owned Notebook allowlist.');
  const activeNames = ctx.tools.schemas().map((tool) => tool.name).sort();
  if (JSON.stringify(activeNames) !== JSON.stringify([...taskToolNames].sort())) {
    throw new Error('Unexpected DSH tool capability.');
  }
  let adapter;
  if (model.mode === 'deepseek') {
    if (!model.apiKey || !model.model) throw new Error('Explicit DeepSeek credentials/model required.');
    const implementation = await import(pathToFileURL(resolver.resolve('@deepseek-ai/dsh-llm-deepseek')).href);
    const options = implementation.resolveAdapterOptions({
      protocol: 'chat-completions', baseURL: model.baseURL,
      thinking: 'disabled', reasoningEffort: 'off',
      models: [{ id: model.model, inputModalities: ['text'] }],
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.contextWindow === undefined ? {} : { defaultContextWindow: model.contextWindow }),
      ...(model.timeoutMs === undefined ? {} : { streamIdleTimeoutMs: model.timeoutMs }),
    });
    const anonymousId = randomUUID();
    adapter = new implementation.DeepSeekAdapter({
      options: () => options,
      resolveApiKey: async () => model.apiKey,
      resolveUserId: () => anonymousId,
      prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    });
  }
  let fixtureIndex = 0;
  class AuthorizedAdapter extends llm.LlmAdapter {
    resolveModel(provider, modelName, signal) {
      return adapter ? adapter.resolveModel(provider, modelName, signal)
        : Promise.resolve({ provider, id: modelName, name: modelName });
    }
    async *stream(options) {
      const authorization = await request('/authorize', {}, options.signal);
      if (authorization.authorized !== true) throw new Error('Task authorization is no longer valid.');
      if (adapter) {
        yield* adapter.stream(options);
        return;
      }
      const index = fixtureIndex++;
      const action = model.actions[index];
      if (action) {
        const callId = llm.ToolCallId(`dsh-sdk-call-${index + 1}`);
        const args = JSON.stringify(action.args);
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id: callId, name: action.name, argumentsDelta: args };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: action.name, arguments: args } };
        yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        if (index !== model.actions.length) throw new Error('Fixture model exhausted.');
        const text = model.finalText ?? 'Controlled Notebook task completed.';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }
  ctx.llm.registerAdapter(['agentcanvas-managed'], new AuthorizedAdapter());
}
