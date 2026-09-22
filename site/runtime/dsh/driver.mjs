import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { VERSION, assertBrokerAddress, controlledPatch } from './policy.mjs';
import { resolveDshInstallation } from './installation.mjs';

const sessionRoot = fileURLToPath(new URL('../../.runtime/dsh-runtime-sessions/', import.meta.url));

function validateSdk(sdk) {
  if (typeof sdk.DeepSeekHarness !== 'function') {
    const error = new Error('DSH SDK constructor unavailable.');
    error.code = 'DSH_SDK_EXPORT_MISSING';
    throw error;
  }
  return sdk;
}

async function loadSdk(installation) {
  const resolver = createRequire(installation.manifestPath);
  // Node 24 can require this pinned SDK's synchronous ESM graph. Keep package
  // resolution wholly in the captured installation, outside Vite/RSC import
  // rewriting and its module-failure cache. No alternate loader fallback.
  return validateSdk(resolver('@deepseek-ai/dsh-sdk-client'));
}

/** Import readiness only: no SDK constructor, child process, credential or model call. */
export async function inspectDshRuntime({ nodeVersion = process.versions.node,
  resolveInstallation = resolveDshInstallation, importSdk = loadSdk } = {}) {
  let phase = 'node';
  try {
    if (Number(nodeVersion.split('.')[0]) < 24) throw new Error('Node 24 or newer required.');
    phase = 'installation';
    const installation = await resolveInstallation();
    phase = 'sdk_import';
    validateSdk(await importSdk(installation));
    return { available: true, version: VERSION, phase: 'ready' };
  } catch (error) {
    const codes = { ERR_MODULE_NOT_FOUND: 'module_not_found', MODULE_NOT_FOUND: 'module_not_found',
      ERR_UNSUPPORTED_ESM_URL_SCHEME: 'unsupported_module_url',
      ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING: 'module_loader_unavailable',
      DSH_SDK_EXPORT_MISSING: 'sdk_export_missing' };
    const code = phase === 'node' ? 'node_unsupported' : phase === 'installation' ? 'installation_unavailable'
      : codes[error?.code] ?? 'sdk_import_failed';
    return { available: false, version: VERSION, phase, code,
      reason: `DSH runtime readiness failed (${phase}/${code}); no child or model request was started.` };
  }
}

/** One task owns one official SDK child; close always joins its process exit. */
export async function runDshSession({
  brokerUrl, brokerToken, modelConfig, instruction, sessionId, signal, onNotification,
}) {
  assertBrokerAddress(brokerUrl);
  if (!brokerToken || brokerToken.length < 32) throw new Error('Missing task broker token.');
  signal?.throwIfAborted();
  let installation;
  try {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 or newer required.');
    // Bind SDK import and child plugin resolution to the same captured tree.
    installation = await resolveDshInstallation();
  } catch { throw new Error('DSH runtime is missing or incompatible; run the explicit setup command.'); }
  const dependencyManifest = installation.manifestPath;
  if (!modelConfig || !['deepseek', 'fixture'].includes(modelConfig.mode)) throw new Error('Explicit DSH model mode required.');
  if (modelConfig.mode === 'deepseek') {
    const endpoint = new URL(modelConfig.baseURL);
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
      throw new Error('Invalid server-configured model endpoint.');
    }
  }
  const { DeepSeekHarness } = await loadSdk(installation);
  await mkdir(sessionRoot, { recursive: true });
  const directory = await mkdtemp(join(sessionRoot, 'task-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const patch = join(directory, 'controlled.patch.yml');
  await writeFile(patch, controlledPatch(new URL('./controlled-plugin.mjs', import.meta.url).href), { flag: 'wx' });
  const environment = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  Object.assign(environment, {
    AGENTCANVAS_DSH_BROKER: brokerUrl, AGENTCANVAS_DSH_TOKEN: brokerToken,
    AGENTCANVAS_DSH_MODEL: JSON.stringify(modelConfig), AGENTCANVAS_DSH_MANIFEST: dependencyManifest,
  });
  const harness = new DeepSeekHarness({
    profile: 'sdk-minimal', patches: [patch], dshHome: join(directory, 'home'),
    processCwd: workspace, cwd: workspace, env: environment,
    provider: 'agentcanvas-managed', model: modelConfig.mode === 'deepseek' ? modelConfig.model : 'fixed-actions',
    initializeTimeoutMs: 20_000, shutdownTimeoutMs: 1000,
    disposeEofGraceMs: 1000, disposeGraceMs: 1000,
    ...(modelConfig.mode === 'deepseek' && modelConfig.maxTokens !== undefined ? { maxTokens: modelConfig.maxTokens } : {}),
  });
  let closeTask;
  const close = () => closeTask ??= harness.close();
  const abort = () => { void close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  let result;
  try {
    if (signal?.aborted) { await close(); signal.throwIfAborted(); }
    await harness.start();
    signal?.throwIfAborted();
    result = await harness.run(instruction, { sessionId, onNotification });
    signal?.throwIfAborted();
    // The SDK resolves on idle even when the loop failed. An idle failed turn
    // must never turn an earlier submitNotebookDraft into a deliverable result.
    const terminals = result.events.filter((event) => event.type === 'turn/end');
    if (terminals.length !== 1 || terminals[0].data?.reason?.kind !== 'completed') {
      throw new Error('DSH did not complete its owned turn.');
    }
  } catch {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    // SDK errors may contain stderr; do not expose launch environment or provider diagnostics.
    throw new Error('DSH runtime failed; no fallback executor was started.');
  } finally {
    signal?.removeEventListener('abort', abort);
    try { await close(); }
    catch { throw new Error('DSH child cleanup failed; process exit was not confirmed.'); }
  }
  return { ...result, runtime: 'official-dsh-sdk', version: VERSION, mode: modelConfig.mode, reaped: true };
}
