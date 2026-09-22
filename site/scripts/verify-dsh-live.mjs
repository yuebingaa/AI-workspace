import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvironment } from './runtime/common.mjs';
import { createLiveModelGateway, liveModelLimits } from './dsh-live-model-gateway.mjs';
import { inspectDshRuntime } from '../runtime/dsh/driver.mjs';
import { verifyDshAdventureWorks } from './test-database/verify-dsh-adventureworks.mjs';

const site = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Deliberate paid acceptance only; never imported by application/test discovery. */
export function parseLiveArguments(args) {
  if (![3, 4].includes(args.length) || args[0] !== '--confirm-paid-model' || args[1] !== '--runtime-dir'
    || !isAbsolute(args[2]) || (args.length === 4 && args[3] !== '--delivery')) {
    throw new Error('Usage: node scripts/verify-dsh-live.mjs --confirm-paid-model --runtime-dir <owned absolute runtime> [--delivery]');
  }
  return { runtimeDir: resolve(args[2]), ...(args.length === 4 ? { profile: 'delivery' } : {}) };
}

async function main() {
  const { runtimeDir, profile = 'smoke' } = parseLiveArguments(process.argv.slice(2));
  assert.equal(resolve(process.cwd()), site, 'Run from site/');
  const runtime = await inspectDshRuntime();
  assert.equal(runtime.available, true, 'The reviewed isolated SDK must be ready');
  const settingsResponse = await fetch('http://127.0.0.1:3001/api/settings/ai', { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  assert.equal(settingsResponse.ok, true);
  const settings = await settingsResponse.json();
  assert.equal(settings.configured, true);
  assert.equal(settings.source, 'environment', 'Do not export website process-memory credentials');
  assert.equal(settings.model, 'deepseek-flash', 'This bounded acceptance was reviewed for the current model only');
  const location = JSON.parse(await readFile(join(site, '.runtime/runtime-location.json'), 'utf8'));
  const managed = JSON.parse(await readFile(join(location.root, 'config.json'), 'utf8'));
  assert.equal(resolve(managed.source).toLowerCase(), site.toLowerCase());
  const environment = { ...process.env, ...readEnvironment(join(location.root, 'config')), ...readEnvironment(site) };
  const apiKey = environment.DEEPSEEK_API_KEY?.trim();
  assert.ok(apiKey && apiKey.length >= 8 && apiKey.length <= 512 && !/\s|[\u0000-\u001f\u007f]/u.test(apiKey), 'A valid existing environment credential is required');
  // The real provider key stays in this process. The SDK receives only an ephemeral
  // loopback token; capture fetch before the DB verifier restricts parent networking.
  const gateway = await createLiveModelGateway({ apiKey, model: settings.model, profile, upstreamFetch: globalThis.fetch.bind(globalThis) });
  const evidenceDir = join(site, '.runtime', `dsh-live-model-${Date.now()}`);
  let acceptance, failed = false;
  try {
    // One task, no automatic paid retry. The verifier does not include the reference
    // SQL, oracle rows or fixture actions in this real model's instruction/context.
    acceptance = await verifyDshAdventureWorks({ runtimeDir, evidenceDir,
      modelConfig: { mode: 'deepseek', apiKey: gateway.apiKey, baseURL: gateway.baseURL,
        model: settings.model, maxTokens: 4096, timeoutMs: 60_000 } });
    if (!acceptance.passed) failed = true;
  } catch {
    failed = true; // Error text may include external data. The verifier records safe stages.
  } finally {
    await gateway.close();
    const counts = gateway.summary();
    const usageComplete = counts.usage.invalidResponses === 0 && counts.providerRequests > 0
      && counts.usage.verifiedResponses === counts.providerRequests;
    const estimate = (counts.usage.promptTokens * 0.30 + counts.usage.completionTokens * 1.20) / 1_000_000;
    const result = { passed: !failed && acceptance?.passed === true, model: settings.model, taskAttempts: 1, profile,
      realProvider: 'https://api.deepseek.com/chat/completions', usageComplete, ...counts,
      observedUsagePeakCacheMissEstimateUsd: Number(estimate.toFixed(8)),
      estimateIsInvoice: false, priceSource: 'https://api-docs.deepseek.com/quick_start/pricing/',
      estimateScope: usageComplete ? 'All observed requests; ignores cache/off-peak discounts.' : 'Only fully observed usage; not an upper bound for missing usage.',
      bounds: { modelRequests: liveModelLimits(profile).maxRequests, requestJsonBytes: liveModelLimits(profile).maxRequestBytes,
        totalJsonBytes: liveModelLimits(profile).maxInputBytes, outputTokensPerRequest: 4096 },
      changesProductQuotas: false, publishedToStable: false };
    // The verifier owns directory creation and its DB/task report. Fail if it never
    // reached that point; do not fall back to writing somewhere else.
    await writeFile(join(evidenceDir, 'model-usage.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ passed: result.passed, model: result.model, providerRequests: counts.providerRequests,
      usageComplete, report: relative(site, join(evidenceDir, 'report.json')).replaceAll('\\', '/'),
      usageReport: relative(site, join(evidenceDir, 'model-usage.json')).replaceAll('\\', '/') }));
    if (!result.passed) process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('DSH live acceptance stopped; no automatic retry. Review sanitized evidence if created.'); process.exitCode = 1; });
}
