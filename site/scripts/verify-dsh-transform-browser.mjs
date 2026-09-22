// Dedicated entry point for the shared, isolated browser acceptance runner.
// Prepare: node scripts/verify-dsh-transform-browser.mjs
// One paid request, only when explicitly authorized:
// node scripts/verify-dsh-transform-browser.mjs --allow-paid-model <owned-directory>
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = spawn(process.execPath, [fileURLToPath(new URL('./verify-dsh-readonly-browser.mjs', import.meta.url)), '--transform', ...process.argv.slice(2)], {
  stdio: 'inherit', windowsHide: true,
});
child.on('error', () => { console.error('Unable to start the isolated transform browser acceptance.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
