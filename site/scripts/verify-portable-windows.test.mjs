import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { isolatedPortableEnvironment, parsePortableArguments, validatePortableReady } from './verify-portable-windows.mjs';

test('portable acceptance requires explicit separate absolute roots and paid opt-in', () => {
  const root = resolve('bundle/AgentCanvas'), output = resolve('evidence/run');
  assert.deepEqual(parsePortableArguments(['--root', root, '--output', output]), { root, output, paid: false });
  assert.equal(parsePortableArguments(['--root', root, '--output', output, '--allow-paid-model']).paid, true);
  for (const args of [[], ['--root', 'relative', '--output', output], ['--root', root, '--output', root],
    ['--root', root, '--output', resolve(root, 'evidence')], ['--root', root, '--output', output, '--allow-paid-model', '--allow-paid-model'],
    ['--root', root, '--output', output, '--unknown']]) assert.throws(() => parsePortableArguments(args));
});

test('portable environment excludes global Node/npm, inherited credentials and options', () => {
  const output = resolve('private-evidence'), system = resolve('Windows');
  const environment = isolatedPortableEnvironment({ SystemRoot: system, PATH: 'private-node;private-npm',
    DEEPSEEK_API_KEY: 'not-a-real-key', NODE_OPTIONS: '--import=private', STUDIO_LOCAL_STATE_DIR: 'production', HTTP_PROXY: 'private' }, output);
  assert.equal(environment.DEEPSEEK_API_KEY, undefined); assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.STUDIO_LOCAL_STATE_DIR, undefined); assert.equal(environment.HTTP_PROXY, undefined);
  assert.equal(environment.PATH.includes('private-node'), false); assert.equal(environment.PATH.includes('private-npm'), false);
  assert.equal(environment.DSH_MAX_TOOL_CALLS, '16'); assert.equal(environment.DSH_TOTAL_EXECUTION_TIMEOUT_MS, '180000');
  assert.throws(() => isolatedPortableEnvironment({}, output));
});

test('readiness only accepts own portable loopback port range and integer child PID', () => {
  assert.deepEqual(validatePortableReady({ type: 'ready', url: 'http://127.0.0.1:3210', serverPid: 100 }), { base: 'http://127.0.0.1:3210', serverPid: 100 });
  assert.equal(validatePortableReady({ type: 'other' }), undefined);
  for (const url of ['http://127.0.0.1:3000', 'http://127.0.0.1:3001', 'http://127.0.0.1:3198',
    'http://localhost:3210', 'https://127.0.0.1:3210', 'http://127.0.0.1:3230', 'http://127.0.0.1:3210/path',
    'http://x:y@127.0.0.1:3210']) assert.throws(() => validatePortableReady({ type: 'ready', url, serverPid: 100 }));
  assert.throws(() => validatePortableReady({ type: 'ready', url: 'http://127.0.0.1:3210', serverPid: '100' }));
});
