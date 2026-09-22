import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createServer } from 'vite';

if (process.argv.length !== 2) throw new Error('This offline fixture accepts no project/model input.');
const siteRoot = process.cwd(), directory = resolve('.runtime', `dsh-capabilities-${Date.now()}`);
await mkdir(directory);
const savedEnvironment = process.env;
const allowed = new Set(['systemroot', 'windir', 'path', 'temp', 'tmp', 'comspec', 'pathext', 'number_of_processors']);
process.env = Object.fromEntries(Object.entries(savedEnvironment).filter(([key]) => allowed.has(key.toLowerCase())));
process.env.STUDIO_LOCAL_STATE_DIR = join(directory, 'state');
const originalFetch = globalThis.fetch;
let brokerRequests = 0, rejectedNetworkRequests = 0, server;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || !['/catalog', '/execute', '/authorize'].includes(url.pathname)) {
    rejectedNetworkRequests++; throw new Error('External fetch prohibited in DSH capability fixture');
  }
  brokerRequests++; return originalFetch(input, { ...init, redirect: 'error' });
};
let report = { passed: false };
try {
  server = await createServer({ root: siteRoot, configFile: false, envFile: false, logLevel: 'error',
    cacheDir: join(directory, 'vite-cache'), resolve: { alias: { '@': siteRoot } },
    server: { middlewareMode: true, hmr: false, watch: null } });
  const { verifyDshCapabilities } = await server.ssrLoadModule('/scripts/dsh-capabilities-fixture.ts');
  report = await verifyDshCapabilities();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'DSH capabilities failed');
  report = { passed: false, error: error instanceof Error ? error.name : 'UnknownError' }; process.exitCode = 1;
} finally {
  await server?.close(); globalThis.fetch = originalFetch; process.env = savedEnvironment;
  await writeFile(join(directory, 'report.json'), JSON.stringify({ ...report, parentLoopbackFetches: brokerRequests,
    rejectedParentFetches: rejectedNetworkRequests,
    networkScope: 'Counters cover parent only. SDK fixture child never calls a model; Python uses its existing isolated browser with locally intercepted runtime assets.',
  }, null, 2));
  console.log(JSON.stringify({ passed: report.passed, report: relative(siteRoot, join(directory, 'report.json')).replaceAll('\\', '/') }));
}
