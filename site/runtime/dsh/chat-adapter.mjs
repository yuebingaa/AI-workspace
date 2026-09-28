import { createRequire, findPackageJSON } from 'node:module';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/**
 * DSH 0.1.7's direct DeepSeek adapter is Messages-only. Use its official pi-ai
 * adapter for the website's existing Chat Completions contract. Only this task's
 * exact model is registered; credentials, catalog discovery and retries remain
 * owned by the website. No provider plugin or ambient credential store is mounted.
 */
export async function createChatAdapter(manifestPath, model) {
  const resolver = createRequire(manifestPath);
  const implementation = await import(pathToFileURL(resolver.resolve('@deepseek-ai/dsh-llm-pi-ai')).href);
  const piManifestPath = findPackageJSON('@earendil-works/pi-ai', pathToFileURL(manifestPath));
  const piManifest = JSON.parse(await readFile(piManifestPath, 'utf8'));
  // Resolve the package's public import-only subpath through its published map;
  // createRequire.resolve cannot select an `import`-only export.
  const entry = piManifest.exports['./api/*'].import.replace('*', 'openai-completions.lazy');
  const { openAICompletionsApi } = await import(new URL(entry, pathToFileURL(piManifestPath)).href);
  const protocol = openAICompletionsApi();
  const provider = 'agentcanvas-managed';
  const descriptor = {
    id: model.model, name: model.model, provider, api: 'openai-completions',
    baseUrl: model.baseURL, input: ['text'], reasoning: false,
    contextWindow: model.contextWindow ?? 1_000_000,
    maxTokens: model.maxTokens ?? 32_768,
    // pi-ai requires catalog pricing. These placeholders are never billing
    // evidence; the website reports only provider-supplied token usage.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { maxTokensField: 'max_tokens', supportsStore: false,
      supportsDeveloperRole: false, supportsReasoningEffort: false },
  };
  const noCredentialMutation = async () => { throw new Error('DSH task credentials are read-only and supplied by the parent.'); };
  const piProvider = {
    id: provider, name: 'Website model', baseUrl: model.baseURL,
    auth: { apiKey: { name: 'Task API key', resolve: async () => ({ auth: { apiKey: model.apiKey }, source: 'task' }) } },
    getModels: () => [descriptor],
    stream: (...args) => protocol.stream(...args),
    streamSimple: (...args) => protocol.streamSimple(...args),
  };
  const profiles = new Map([[provider, {
    provider, displayName: 'Website model', api: 'openai-completions', piProvider,
    reasoning: 'off', streamIdleTimeoutMs: model.timeoutMs ?? 25_000,
    timeoutMs: model.timeoutMs ?? 25_000,
    maxRequestImageBytes: 20 * 1024 * 1024, requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy: { mode: 'normal', maxRetries: 0 },
    modelErrors: new Map(),
    configuredMaxTokens: new Map(model.maxTokens === undefined ? [] : [[model.model, model.maxTokens]]),
  }]]);
  return new implementation.PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => model.apiKey,
    auth: {
      credentials: { read: async () => undefined, list: async () => [],
        modify: noCredentialMutation, delete: noCredentialMutation },
      authContext: { env: async () => undefined, fileExists: async () => false },
    },
  });
}
