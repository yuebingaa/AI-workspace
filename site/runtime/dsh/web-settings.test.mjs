import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createSettingsTransport, createDshSettingsBootstrapScript, createDshSettingsClientModule } from './web-settings.mjs';
import { resolveDshInstallation } from './installation.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('settings transport only admits explicit read methods, never arbitrary Host capabilities', async () => {
  let calls = 0;
  const rpc = createSettingsTransport({ request: async type => { assert.equal(type, 'inventory'); calls++; return { ok: true, value: {} }; } });
  for (const name of ['settings/mutate', 'credentials/set', 'session/prompt', 'agentPresets/update', 'settings/openSettingsDocument', 'shell/run']) {
    assert.equal((await rpc.call('/api', name, { args: {} })).ok, false);
  }
  assert.equal((await rpc.call('/outside', 'pluginInventory/list')).ok, false);
  assert.equal((await rpc.call('/api', 'pluginInventory/list', {}, AbortSignal.abort())).ok, false);
  assert.equal(calls, 0);
  assert.equal((await rpc.call('/api', 'pluginInventory/list')).ok, true); assert.equal(calls, 1);
});
test('view-local read-only configuration validates against real pinned official Remote codec', async () => {
  const installation = await resolveDshInstallation();
  const { default: remote } = await import(pathToFileURL(join(installation.root, 'node_modules/@deepseek-ai/dsh-api-settings-controller/lib/typert.remote-client.js')));
  const descriptor = remote.descriptors.find(row => row.namespace === 'settings' && row.method === 'describe');
  const rpc = createSettingsTransport({ request() { throw new Error('unexpected'); } });
  const response = await rpc.call('/api', 'settings/describe');
  assert.equal(descriptor.result.create().safeParse(response.value).success, true);
  assert.equal(response.value.writable, false); assert.equal(response.value.hasDocument, false);
  assert.deepEqual(response.value.namespaces.map(row => row.ns), ['locale']);
});
test('settings session projections are empty, cancelled event stream terminates', async () => {
  const rpc = createSettingsTransport({ request() { throw new Error('unexpected'); } });
  assert.deepEqual((await rpc.call('/api', 'session/list')).value, { items: [] });
  const controller = new AbortController(), stream = rpc.open('/api', 'session/control', {}, controller.signal);
  assert.deepEqual((await stream.next()).value, { type: 'baseline', value: { projections: {} } });
  const pending = stream.next(); controller.abort(); assert.equal((await pending).done, true);
  assert.throws(() => rpc.open('/api', 'session/follow', {}, controller.signal), /Unsupported/);
});
test('browser modules are syntactically self-contained and never replace the official root', () => {
  new vm.Script(createDshSettingsBootstrapScript()); new vm.Script(createDshSettingsClientModule());
  const clientModule = createDshSettingsClientModule();
  assert.match(clientModule, /dsh-client-ui-primitives/); assert.match(clientModule, /shell.overlay/);
  assert.doesNotMatch(clientModule, /name: ['"]root['"]|fetch\(|innerHTML|dangerouslySetInnerHTML/);
});

test('closing the settings stream resolves pending reads without waiting for abort', async () => {
  const rpc = createSettingsTransport({ request() { throw new Error('unexpected'); } });
  const controller = new AbortController(), stream = rpc.open('/api', '$events', {}, controller.signal);
  assert.equal((await stream.next()).value.type, 'ready');
  const pending = stream.next();
  await stream.return(); assert.equal((await pending).done, true); assert.equal((await stream.next()).done, true);
});
