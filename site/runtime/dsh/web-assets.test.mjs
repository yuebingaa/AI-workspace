import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { link, mkdtemp, mkdir, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createDshWebAssets, DSH_WEB_ASSET_LIMITS, DSH_WEB_BASE_PATH, DSH_WEB_BRIDGE_ID, DSH_WEB_CLIENT_PACKAGES, DSH_SETTINGS_CLIENT_PACKAGES, DSH_SETTINGS_BRIDGE_ID } from './web-assets.mjs';
import { VERSION } from './policy.mjs';
import { resolveDshInstallation } from './installation.mjs';

const NONCE = 'fixture_nonce_0123456789';
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'dsh-web-assets-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(runtimeRoot)), resolve(tmpdir()));
    assert.ok(basename(runtimeRoot).startsWith('dsh-web-assets-test-'));
    await rm(runtimeRoot, { recursive: true, force: true });
  });
  const root = join(runtimeRoot, 'dsh-runtime-deps');
  const write = async (path, content) => {
    const filename = join(root, path);
    await mkdir(dirname(filename), { recursive: true });
    await writeFile(filename, content);
  };
  await write('package.json', JSON.stringify({ type: 'module' }));
  await write('package-lock.json', '{}');
  for (const name of ['dsh-sdk-client', 'dsh-sdk-minimal', 'dsh']) {
    await write(`node_modules/@deepseek-ai/${name}/package.json`, JSON.stringify({
      name: `@deepseek-ai/${name}`, version: VERSION, main: 'index.js', bin: { dsh: 'index.js' },
    }));
    await write(`node_modules/@deepseek-ai/${name}/index.js`, 'export {};');
  }
  const frontend = 'node_modules/@deepseek-ai/dsh-web-frontend';
  await write(`${frontend}/package.json`, JSON.stringify({ name: '@deepseek-ai/dsh-web-frontend', version: VERSION, license: 'MIT' }));
  await write(`${frontend}/LICENSE`, 'MIT License\nCopyright (c) fixture\n');
  await write(`${frontend}/dist/index.html`, '<!doctype html><html><head><script type="module" src="./assets/index-fixture.js"></script><link rel="stylesheet" href="./assets/index-fixture.css"></head><body><div id="root"></div></body></html>');
  await write(`${frontend}/dist/assets/index-fixture.js`, 'window.fixtureOfficialShell=true;');
  await write(`${frontend}/dist/assets/index-fixture.css`, 'body{color:black}');
  await write(`${frontend}/dist/assets/langs/plain-fixture.js`, 'export default {};');
  await write(`${frontend}/dist/assets/fonts/font-fixture.woff2`, 'font');
  await write(`${frontend}/dist/assets/fonts/Montserrat-OFL.txt`, 'font license');
  for (const name of ['favicon.svg', 'favicon-dark.svg', 'manifest.webmanifest']) await write(`${frontend}/dist/${name}`, name.endsWith('svg') ? '<svg/>' : '{}');
  for (const name of [...DSH_WEB_CLIENT_PACKAGES, ...DSH_SETTINGS_CLIENT_PACKAGES]) {
    await write(`node_modules/@deepseek-ai/${name}/package.json`, JSON.stringify({
      name: `@deepseek-ai/${name}`, version: VERSION, license: 'MIT', type: 'module',
      dsh: { client: { platform: 'web', inject: [] } },
    }));
    await write(`node_modules/@deepseek-ai/${name}/lib/client.js`, `window.__ModuleLoader__.load({id:'@deepseek-ai/${name}',factory:()=>({apply(){}})});`);
  }
  // A tiny composer stand-in lets filesystem rejection tests avoid importing or
  // activating any official runtime. The final test reads the installed real one.
  await write('node_modules/@deepseek-ai/dsh-client-modules/lib/index.js', `
export function orderByModuleGraph(rows){return rows;}
export function bootInjections(graph){return [{kind:'script',placement:'head',text:'window.fixtureQueue=true;'},
{kind:'script-src',placement:'head',src:graph.batches[0].url},{kind:'global',name:'__DSH_BOOT__',value:graph}];}
`);
  await resolveDshInstallation(runtimeRoot);
  return { runtimeRoot, root, frontend, write };
}

test('carrier exposes only the 22 fixed official browser faces and one audited bridge', async t => {
  const f = await fixture(t);
  const carrier = await createDshWebAssets({ runtimeRoot: f.runtimeRoot });
  assert.equal(carrier.version, VERSION);
  assert.equal(carrier.graph.entries.length, 23);
  assert.equal(new Set(carrier.graph.entries.map(row => row.id)).size, 23);
  assert.equal(carrier.graph.entries.at(-1).id, DSH_WEB_BRIDGE_ID);
  assert.equal(carrier.settingsGraph.entries.length, 26);
  assert.equal(carrier.settingsGraph.entries.some(row => row.id === DSH_WEB_BRIDGE_ID), false);
  assert.equal(carrier.settingsGraph.entries.at(-1).id, DSH_SETTINGS_BRIDGE_ID);
  assert.deepEqual(carrier.graph.batches.filter(batch => batch.phase === 'bootstrap').map(batch => batch.entries), [['@deepseek-ai/dsh-client-modules']]);
  for (const row of carrier.graph.entries) {
    const response = await carrier.fetch(row.url);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes(row.id));
    assert.equal(response.headers.get('etag'), `"${hash(body)}"`);
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  }
});

test('HTML relocates official resources, preserves licenses and nonces every script before the shell', async t => {
  const f = await fixture(t);
  const carrier = await createDshWebAssets({ runtimeRoot: f.runtimeRoot, basePath: '/embedded/resources' });
  const html = await carrier.html({ nonce: NONCE });
  const tags = html.match(/<script\b[^>]*>/g);
  assert.ok(tags.length >= 5);
  for (const tag of tags) assert.ok(tag.includes(`nonce="${NONCE}"`));
  assert.ok(html.includes('/embedded/resources/assets/index-fixture.js'));
  assert.ok(html.includes('/embedded/resources/licenses/dsh-MIT.txt'));
  assert.ok(html.indexOf('window.fixtureQueue') < html.indexOf('window.__DSH_BOOT__='));
  assert.ok(html.indexOf('window.__DSH_BOOT__=') < html.indexOf('type="module"'));
  assert.ok(!html.includes('<base'));
  assert.ok(!html.includes(f.root));
  assert.match(await (await carrier.fetch('licenses/dsh-MIT.txt')).text(), /MIT License/);
  assert.equal(await (await carrier.fetch('assets/fonts/Montserrat-OFL.txt')).text(), 'font license');
  await assert.rejects(carrier.html(), /resources are unavailable/);
  await assert.rejects(carrier.html({ nonce: '"/><script>bad' }), /resources are unavailable/);
});

test('embedded chat pins an empty composer below the message area and keeps narrow bubbles readable', async t => {
  const f = await fixture(t);
  const html = await (await createDshWebAssets({ runtimeRoot: f.runtimeRoot })).html({ nonce: NONCE });
  const match = html.match(/<style nonce="([^"]+)" data-agentcanvas-dsh-embed>([\s\S]*?)<\/style>/);
  assert.ok(match);
  assert.equal(match[1], NONCE);
  assert.equal(match[2], `[data-agentcanvas-dsh-native-web] .wSkVaW_composerSeat { margin-top: auto; }
@media (max-width: 480px) {
  [data-agentcanvas-dsh-native-web] .EvIC1a_scroll { padding-inline: 12px; }
  [data-agentcanvas-dsh-native-web] .Sixlwa_userStack { max-width: 100%; }
  [data-agentcanvas-dsh-native-web] .Sixlwa_bubble { padding-inline: 12px; }
}`);
  // Guard the intentional pinned CSS dependency without modifying SDK bytes.
  const installation = await resolveDshInstallation();
  const officialChat = await readFile(join(installation.root, 'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js'), 'utf8');
  const officialConversation = await readFile(join(installation.root, 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'), 'utf8');
  assert.ok(officialConversation.includes('.wSkVaW_composerSeat{'));
  for (const name of ['EvIC1a_scroll', 'Sixlwa_userStack', 'Sixlwa_bubble']) assert.ok(officialChat.includes(`.${name}{`));
});

test('exact lookup rejects traversal, private and Host files, source maps, wrong revisions, and foreign mounts', async t => {
  const f = await fixture(t);
  await f.write(`${f.frontend}/dist/assets/index-fixture.js.map`, '{"sourcesContent":["private"]}');
  await f.write(`${f.frontend}/dist/.env`, 'PRIVATE');
  const carrier = await createDshWebAssets({ runtimeRoot: f.runtimeRoot });
  for (const path of [
    '../package.json', 'assets/../package.json', '../.env', '.env', 'package.json',
    'node_modules/@deepseek-ai/dsh-client-connection/lib/index.js', 'assets/index-fixture.js.map',
    'assets/%2e%2e/package.json', '%252e%252e/private', 'assets\\index-fixture.js',
    'https://elsewhere.test/assets/index-fixture.js', '/other/assets/index-fixture.js',
    '/api/ai/dsh/web/assets//assets/index-fixture.js', 'assets/index-fixture.js?private=1',
    carrier.graph.entries[0].url.replace(/rev=[a-f0-9]+/, 'rev=wrong'),
    'plugins/??@deepseek-ai/dsh-tool-pwsh/lib/index.js&rev=whatever',
  ]) assert.equal((await carrier.fetch(path)).status, 404, path);
  assert.equal((await carrier.fetch('assets/index-fixture.js', { method: 'POST' })).status, 405);
  const head = await carrier.fetch('assets/index-fixture.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.ok(Number(head.headers.get('content-length')) > 0);
});

test('router-normalized official combo queries resolve only exact advertised single bundles', async t => {
  const f = await fixture(t);
  const carrier = await createDshWebAssets({ runtimeRoot: f.runtimeRoot });
  for (const row of carrier.graph.entries) {
    const normalized = new URL(row.url, 'http://fixture.invalid');
    normalized.pathname = normalized.pathname.replace(/\/$/, '');
    normalized.searchParams.sort();
    const path = normalized.pathname + normalized.search;
    assert.equal((await carrier.fetch(path)).status, 200, path);
    assert.equal(await (await carrier.fetch(path)).text(), await (await carrier.fetch(row.url)).text());
    for (const invalid of [path + '&extra=1', path + '&rev=' + row.rev,
      path.replace('client.js=', 'client.js=private'), path.replace('%3F%40', '%253F%2540'),
      path.replace('client.js=', '..%2Findex.js='), path.replace('/plugins?', '/plugins/private?')]) {
      if (invalid !== path) assert.equal((await carrier.fetch(invalid)).status, 404, invalid);
    }
  }
});

test('asset snapshots do not reread later private/link substitutions', async t => {
  const f = await fixture(t);
  const carrier = await createDshWebAssets({ runtimeRoot: f.runtimeRoot });
  await f.write(`${f.frontend}/dist/assets/index-fixture.js`, 'PRIVATE-LATER');
  assert.equal(await (await carrier.fetch('assets/index-fixture.js')).text(), 'window.fixtureOfficialShell=true;');
});

test('dependency closure, fixed versions, and MIT declarations fail closed', async t => {
  for (const mutation of [
    { version: '999.0.0' }, { license: 'UNLICENSED' },
    { dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-tool-pwsh'] } } },
    { dsh: { client: { platform: 'web', external: ['node:fs'] } } },
  ]) {
    const f = await fixture(t);
    const filename = 'node_modules/@deepseek-ai/dsh-client-ui-chat/package.json';
    const manifest = JSON.parse(await readFile(join(f.root, filename), 'utf8'));
    await f.write(filename, JSON.stringify({ ...manifest, ...mutation }));
    await assert.rejects(createDshWebAssets({ runtimeRoot: f.runtimeRoot }), { message: 'DSH Web resources are unavailable.' });
  }
});

test('linked resources and junction directories are refused without disclosing paths', async t => {
  for (const directory of [false, true]) {
    const f = await fixture(t);
    const target = join(f.root, f.frontend, 'dist/assets', directory ? 'fonts' : 'index-fixture.js');
    const held = `${target}-held`;
    await rename(target, held);
    await symlink(held, target, directory ? 'junction' : 'file');
    await assert.rejects(createDshWebAssets({ runtimeRoot: f.runtimeRoot }), error => {
      assert.equal(error.message, 'DSH Web resources are unavailable.');
      assert.ok(!error.message.includes(f.root));
      return true;
    });
  }
});

test('oversized assets and malformed mount paths are rejected', async t => {
  const f = await fixture(t);
  await truncate(join(f.root, f.frontend, 'dist/assets/index-fixture.js'), DSH_WEB_ASSET_LIMITS.fileBytes + 1);
  await assert.rejects(createDshWebAssets({ runtimeRoot: f.runtimeRoot }), /resources are unavailable/);
  for (const basePath of ['/', '/safe/../private', '//outside.test', '/safe?x=1', '/safe/<script>', '/safe\\path']) {
    await assert.rejects(createDshWebAssets({ runtimeRoot: f.runtimeRoot, basePath }), /resources are unavailable/);
  }
});

test('aggregate byte and file-count budgets also bound the private snapshot cache', async t => {
  const large = await fixture(t);
  for (let index = 0; index < 4; index += 1) {
    const name = `${large.frontend}/dist/assets/large-${index}.js`;
    await large.write(name, '');
    await truncate(join(large.root, name), 17 * 1024 * 1024);
  }
  await assert.rejects(createDshWebAssets({ runtimeRoot: large.runtimeRoot }), /resources are unavailable/);
  const many = await fixture(t);
  for (let index = 0; index <= DSH_WEB_ASSET_LIMITS.files; index += 1) await many.write(`${many.frontend}/dist/assets/tiny-${index}.js`, '');
  await assert.rejects(createDshWebAssets({ runtimeRoot: many.runtimeRoot }), /resources are unavailable/);
});

test('hard-linked resources and absent installs are refused with a path-free error', async t => {
  const f = await fixture(t);
  const source = join(f.root, f.frontend, 'dist/assets/index-fixture.js');
  await link(source, `${source}-alias`);
  await assert.rejects(createDshWebAssets({ runtimeRoot: f.runtimeRoot }), { message: 'DSH Web resources are unavailable.' });
  await assert.rejects(createDshWebAssets({ runtimeRoot: join(f.runtimeRoot, 'missing') }), { message: 'DSH Web resources are unavailable.' });
});

test('real fixed SDK boot graph serves untouched official browser bundles without starting a Host', { timeout: 30_000 }, async () => {
  const carrier = await createDshWebAssets();
  assert.equal(carrier.graph.entries.length, 23);
  const installation = await resolveDshInstallation();
  for (const row of carrier.graph.entries.filter(row => row.id !== DSH_WEB_BRIDGE_ID)) {
    const actual = await readFile(join(installation.root, 'node_modules', row.id, 'lib/client.js'));
    assert.equal(row.rev, hash(actual));
    assert.deepEqual(Buffer.from(await (await carrier.fetch(row.url)).arrayBuffer()), actual);
    for (const dependency of row.inject ?? []) assert.ok(carrier.graph.entries.some(candidate => candidate.id === dependency));
  }
  const html = await carrier.html({ nonce: NONCE });
  assert.match(html, /window\.__ModuleLoader__/);
  assert.match(html, /window\.__DSH_BOOT__/);
  assert.match(html, /assets\/index-[A-Za-z0-9_-]+\.js/);
  assert.ok(html.includes(DSH_WEB_BASE_PATH));
  assert.match(await (await carrier.fetch('licenses/dsh-MIT.txt')).text(), /MIT License/);
  const settingsHtml = await carrier.html({ nonce: NONCE, surface: 'settings' });
  assert.match(settingsHtml, /agentcanvas-dsh-settings-bridge/);
  assert.doesNotMatch(settingsHtml, /agentcanvas-dsh-web-bridge/);
  for (const row of carrier.settingsGraph.entries.filter(row => row.id !== DSH_SETTINGS_BRIDGE_ID)) {
    const actual = await readFile(join(installation.root, 'node_modules', row.id, 'lib/client.js'));
    assert.deepEqual(Buffer.from(await (await carrier.fetch(row.url)).arrayBuffer()), actual);
  }
});
