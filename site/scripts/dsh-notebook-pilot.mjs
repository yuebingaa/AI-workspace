import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// Explicit, offline-only experiment. Not imported by a route or the website.
const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(siteRoot, '.runtime', `dsh-notebook-pilot-${Date.now()}`);
await mkdir(directory, { recursive: false });
const previousEnvironment = process.env;
const previousFetch = globalThis.fetch;
const environmentNames = new Set(['systemroot', 'windir', 'path', 'temp', 'tmp', 'comspec', 'pathext', 'number_of_processors']);
process.env = Object.fromEntries(Object.entries(previousEnvironment).filter(([key]) => environmentNames.has(key.toLowerCase())));
process.env.STUDIO_LOCAL_STATE_DIR = join(directory, 'state');
let server, fixture, networkAttempts = 0;
const report = { version: 1, runtime: 'official-dsh-in-process-test-composition', dshVersion: '0.1.6-alpha.2',
  model: 'scripted-offline-fixture', startedAt: new Date().toISOString(), passed: false,
  websiteEngineChanged: false, sdkSubprocessVerified: false, modelQualityVerified: false };
globalThis.fetch = async () => { networkAttempts++; throw new Error('Network fetch is prohibited in the offline DSH pilot'); };
try {
  server = await createServer({ root: siteRoot, configFile: false, envFile: false, logLevel: 'error',
    cacheDir: join(directory, 'vite-cache'), resolve: { alias: { '@': siteRoot } },
    server: { middlewareMode: true, hmr: false, watch: null } });
  const { createDshNotebookFixture } = await server.ssrLoadModule('/scripts/dsh-notebook-fixture.ts');
  const { runDshFixture } = await import('./dsh-pilot/runner.mjs');
  const signal = AbortSignal.timeout(90_000);
  fixture = await createDshNotebookFixture(signal);
  const execution = await runDshFixture({ tools: fixture.tools, actions: fixture.actions, signal,
    instruction: 'Use the four provided Notebook tools to analyze synthetic sales and submit a draft. Do not adopt it.' });
  signal.throwIfAborted();
  assert.equal(execution.outcome, 'completed', 'DSH itself must finish successfully, not just its tools');
  assert.equal(execution.failedToolCount, 0);
  assert.equal(execution.modelCalls, fixture.actions.length + 1);
  report.businessChecks = fixture.verify();
  assert.equal(networkAttempts, 0);
  assert.equal(execution.networkAttempts, 0);
  assert.ok(execution.events.length > 0, 'Actual DSH session events must be recorded');
  report.execution = execution;
  fixture.close();
  fixture = await createDshNotebookFixture(signal);
  const cancel = new AbortController();
  const cancelled = await runDshFixture({ actions: fixture.actions, signal: cancel.signal,
    tools: fixture.tools.map((tool) => tool.name !== 'runNotebookCells' ? tool : { ...tool,
      execute(args, context) {
        const running = tool.execute(args, context);
        // This is NOT the outer fixture signal: cancellation must flow DSH -> bridge -> Notebook.
        cancel.abort();
        return running;
      },
    }),
  });
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(cancelled.networkAttempts, 0);
  report.cancellation = { ...fixture.verifyCancelled(), outcome: cancelled.outcome,
    eventTypes: cancelled.events.map((event) => event.type) };
  report.passed = true;
} catch (error) {
  // Fixed synthetic inputs only; do not serialize environment or absolute stacks.
  report.error = error instanceof Error ? error.name : 'UnknownError';
  console.error(error instanceof Error ? error.message : 'DSH pilot failed');
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  try {
    try { fixture?.close(); } catch (error) { cleanupErrors.push(error); }
    try { await server?.close(); } catch (error) { cleanupErrors.push(error); }
  } finally {
    globalThis.fetch = previousFetch;
    process.env = previousEnvironment;
  }
  if (cleanupErrors.length) {
    report.passed = false;
    report.cleanupErrors = cleanupErrors.map((error) => error instanceof Error ? error.name : 'UnknownError');
    process.exitCode = 1;
  }
  report.networkFetchAttempts = networkAttempts;
  report.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ passed: report.passed, report: `.runtime/${directory.split(/[\\/]/).at(-1)}/report.json`,
    businessChecks: report.businessChecks, error: report.error }));
}
