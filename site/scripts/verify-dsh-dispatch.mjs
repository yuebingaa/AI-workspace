import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createServer } from 'vite';
import { runDshSession } from '../runtime/dsh/driver.mjs';

if (process.argv.length !== 2) throw new Error('This offline dispatch check accepts no model/project input.');
const siteRoot = process.cwd(), directory = resolve('.runtime', `dsh-dispatch-${Date.now()}`);
await mkdir(directory);
const previousEnvironment = process.env;
const allowed = new Set(['systemroot', 'windir', 'path', 'temp', 'tmp', 'comspec', 'pathext', 'number_of_processors']);
process.env = Object.fromEntries(Object.entries(previousEnvironment).filter(([key]) => allowed.has(key.toLowerCase())));
process.env.STUDIO_LOCAL_STATE_DIR = join(directory, 'state');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Parent fetch is prohibited in the offline dispatch fixture.'); };
let server, report = { passed: false };
try {
  server = await createServer({ root: siteRoot, configFile: false, envFile: false, logLevel: 'error',
    cacheDir: join(directory, 'vite-cache'), resolve: { alias: { '@': siteRoot } },
    server: { middlewareMode: true, hmr: false, watch: null } });
  const { verifyDshDispatch } = await server.ssrLoadModule('/scripts/dsh-dispatch-fixture.ts');
  report = await verifyDshDispatch(runDshSession);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Offline dispatch check failed.');
  report = { passed: false, error: error instanceof Error ? error.name : 'UnknownError' }; process.exitCode = 1;
} finally {
  await server?.close(); globalThis.fetch = originalFetch; process.env = previousEnvironment;
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, report: relative(siteRoot, join(directory, 'report.json')).replaceAll('\\', '/') }));
}
