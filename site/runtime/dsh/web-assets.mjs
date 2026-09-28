import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const revision = new URL(import.meta.url).search;
const { resolveDshInstallation, assertPlainPath } = await import(new URL(`./installation.mjs${revision}`, import.meta.url).href);
const { VERSION } = await import(new URL(`./policy.mjs${revision}`, import.meta.url).href);
const { createDshWebBootstrapScript, createDshWebClientModule } = await import(new URL(`./web-client.mjs${revision}`, import.meta.url).href);
const { createDshSettingsBootstrapScript, createDshSettingsClientModule } = await import(new URL(`./web-settings.mjs${revision}`, import.meta.url).href);

export const DSH_WEB_BASE_PATH = '/api/ai/dsh/web/assets';
export const DSH_WEB_BRIDGE_ID = 'agentcanvas-dsh-web-bridge';
export const DSH_SETTINGS_BRIDGE_ID = 'agentcanvas-dsh-settings-bridge';
export const DSH_SETTINGS_CLIENT_PACKAGES = Object.freeze([
  'dsh-client-ui-settings-general', 'dsh-client-ui-settings-plugins',
  'dsh-client-ui-settings-plugin-inventory',
]);
// Fixed published browser faces only. No Host/plugin preset is constructed.
export const DSH_WEB_CLIENT_PACKAGES = Object.freeze([
  'dsh-client-modules', 'dsh-client-connection', 'dsh-typert-registry', 'dsh-api-gateway',
  'dsh-api-remotes', 'dsh-client-file-upload', 'dsh-api-session-controller',
  'dsh-api-workspace-controller', 'dsh-client-ui-renderer', 'dsh-client-ui-settings',
  'dsh-client-locale', 'dsh-client-ui-theme', 'dsh-client-shortcuts', 'dsh-client-ui-session',
  'dsh-client-ui-layout', 'dsh-client-ui-sidebar', 'dsh-client-ui-workspace',
  'dsh-client-ui-conversation', 'dsh-client-ui-input-trigger', 'dsh-client-resources',
  'dsh-client-ui-sidebar-right', 'dsh-client-ui-chat',
]);
export const DSH_WEB_ASSET_LIMITS = Object.freeze({ files: 512, fileBytes: 20 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 });

const unavailable = () => new Error('DSH Web resources are unavailable.');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const htmlAttribute = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const inlineJson = (value) => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const inlineScript = (value) => value.replace(/<\/script/gi, '<\\/script');
const contentTypes = Object.freeze({
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
});
// Presentation-only overrides for pinned rc.2 CSS-module names. The empty
// conversation has no viewArea, so its sticky composer otherwise stays at the
// top; populated conversations already fill the space above it.
// Narrow gutters also keep a 260px sidebar readable. Scope both to this embed.
const embeddedPresentationCss = `[data-agentcanvas-dsh-native-web] .wSkVaW_composerSeat { margin-top: auto; }
@media (max-width: 480px) {
  [data-agentcanvas-dsh-native-web] .EvIC1a_scroll { padding-inline: 12px; }
  [data-agentcanvas-dsh-native-web] .Sixlwa_userStack { max-width: 100%; }
  [data-agentcanvas-dsh-native-web] .Sixlwa_bubble { padding-inline: 12px; }
}`;

function validateBasePath(value) {
  if (typeof value !== 'string' || value.length > 180 || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(value)) throw unavailable();
  return value;
}

function resourceKey(path, basePath) {
  if (typeof path !== 'string' || path.length > 2048 || /[\\\u0000-\u0020#]/.test(path)) return undefined;
  const local = path.startsWith(`${basePath}/`) ? path.slice(basePath.length + 1) : path;
  const question = local.indexOf('?');
  const pathname = question < 0 ? local : local.slice(0, question);
  if (question >= 0 && (pathname === 'plugins' || pathname === 'plugins/')) {
    // The website router canonicalizes /plugins/??@scope/name/client.js&rev=x
    // into /plugins?%3F%40scope%2Fname%2Fclient.js=&rev=x. Accept only those
    // equivalent, exact single-bundle descriptors, never arbitrary decoded paths.
    const fields = [...new URLSearchParams(local.slice(question))];
    if (fields.length !== 2) return undefined;
    const bundle = fields.find(([key]) => key !== 'rev');
    const version = fields.find(([key]) => key === 'rev');
    if (!bundle || !version || bundle[1] !== '' || !/^\?(?:@deepseek-ai\/dsh-[a-z-]+|agentcanvas-dsh-(?:web|settings)-bridge)\/client\.js$/.test(bundle[0])
      || !/^[a-f0-9]{64}$/.test(version[1])) return undefined;
    return `plugins/?${bundle[0]}&rev=${version[1]}`;
  }
  return local.includes('%') ? undefined : local;
}

/** Read a bounded, plain, installation-contained immutable snapshot. */
async function readPlainFile(root, filename, maximum = DSH_WEB_ASSET_LIMITS.fileBytes) {
  const target = resolve(root, filename);
  await assertPlainPath(root, target);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw unavailable();
  const actual = await realpath(target);
  const suffix = relative(root, actual);
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) throw unavailable();
  const handle = await open(target, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw unavailable();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    await assertPlainPath(root, target);
    if (bytes.length > maximum || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw unavailable();
    return bytes;
  } finally { await handle.close(); }
}

function renderInjections(rows, nonce) {
  return rows.map(row => {
    if (row.kind === 'script') return `<script nonce="${nonce}">${inlineScript(row.text)}</script>`;
    if (row.kind === 'script-src') return `<script nonce="${nonce}" src="${htmlAttribute(row.src)}"></script>`;
    if (row.kind === 'script-preload') return `<link rel="preload" as="script" href="${htmlAttribute(row.src)}">`;
    if (row.kind === 'global' && row.name === '__DSH_BOOT__') return `<script nonce="${nonce}">window.__DSH_BOOT__=${inlineJson(row.value)};</script>`;
    throw unavailable();
  }).join('\n');
}

/**
 * Fixed official Web distribution for the existing website's HTTP carrier.
 * runtimeRoot is server/test-owned; never populate it from request data.
 * No listener, Host, native-session log, model configuration, or plugin preset is opened.
 */
export async function createDshWebAssets({ runtimeRoot, basePath = DSH_WEB_BASE_PATH } = {}) {
  try {
    basePath = validateBasePath(basePath);
    const installation = await resolveDshInstallation(runtimeRoot);
    // Windows temporary roots can use their 8.3 spelling; compare canonical paths.
    const root = await realpath(installation.root);
    const scope = 'node_modules/@deepseek-ai';
    const frontend = `${scope}/dsh-web-frontend`;
    const frontendManifest = JSON.parse((await readPlainFile(root, `${frontend}/package.json`, 128 * 1024)).toString('utf8'));
    if (frontendManifest.name !== '@deepseek-ai/dsh-web-frontend' || frontendManifest.version !== VERSION || frontendManifest.license !== 'MIT') throw unavailable();
    const resources = new Map();
    let totalBytes = 0;
    const add = (key, bytes, contentType) => {
      if (resources.has(key) || resources.size >= DSH_WEB_ASSET_LIMITS.files || bytes.length > DSH_WEB_ASSET_LIMITS.fileBytes) throw unavailable();
      totalBytes += bytes.length;
      if (totalBytes > DSH_WEB_ASSET_LIMITS.totalBytes) throw unavailable();
      resources.set(key, Object.freeze({ bytes, contentType, etag: `"${sha256(bytes)}"` }));
    };
    const addFile = async (key, filename, contentType) => add(key, await readPlainFile(root, filename), contentType);

    // Enumerate only the fixed distribution's published static categories, never
    // node_modules generally or any runtime/private state. Unknown kinds are not served.
    for (const [directory, pattern] of [
      ['assets', /^[A-Za-z0-9_-]+\.(?:js|css)$/],
      ['assets/langs', /^[A-Za-z0-9_-]+\.js$/],
      ['assets/fonts', /^(?:[A-Za-z0-9_-]+\.(?:woff2?|ttf)|Montserrat-OFL\.txt)$/],
    ]) {
      const dir = `${frontend}/dist/${directory}`;
      await assertPlainPath(root, join(root, dir));
      for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
        if (!pattern.test(entry.name)) continue;
        if (!entry.isFile() || entry.isSymbolicLink()) throw unavailable();
        const extension = entry.name.slice(entry.name.lastIndexOf('.'));
        await addFile(`${directory}/${entry.name}`, `${dir}/${entry.name}`, contentTypes[extension]);
      }
    }
    for (const filename of ['favicon.svg', 'favicon-dark.svg', 'manifest.webmanifest']) {
      await addFile(filename, `${frontend}/dist/${filename}`, contentTypes[filename.slice(filename.lastIndexOf('.'))]);
    }
    await addFile('licenses/dsh-MIT.txt', `${frontend}/LICENSE`, contentTypes['.txt']);
    const originalHtml = (await readPlainFile(root, `${frontend}/dist/index.html`, 64 * 1024)).toString('utf8');
    if (!originalHtml.includes('<head>') || !originalHtml.includes('</head>') || !originalHtml.includes('id="root"')) throw unavailable();

    const packageIds = new Set([...DSH_WEB_CLIENT_PACKAGES, ...DSH_SETTINGS_CLIENT_PACKAGES].map(name => `@deepseek-ai/${name}`));
    const rows = [];
    for (const name of [...DSH_WEB_CLIENT_PACKAGES, ...DSH_SETTINGS_CLIENT_PACKAGES]) {
      const id = `@deepseek-ai/${name}`;
      const manifest = JSON.parse((await readPlainFile(root, `${scope}/${name}/package.json`, 128 * 1024)).toString('utf8'));
      const client = manifest.dsh?.client;
      if (manifest.name !== id || manifest.version !== VERSION || manifest.license !== 'MIT' || client?.platform !== 'web') throw unavailable();
      // rc.2 inventory only consults the preset owner's locale dictionary, not
      // its services. Our named website preset needs no official Host editor.
      // Keep that optional display-copy dependency out of this composition.
      const inject = (client.inject ?? []).filter(dep => name !== 'dsh-client-ui-settings-plugin-inventory' || dep !== '@deepseek-ai/dsh-client-ui-agent-preset');
      const external = client.external ?? [];
      if (!Array.isArray(inject) || inject.some(dep => !packageIds.has(dep)) || !Array.isArray(external)
        || external.some(dep => typeof dep !== 'string' || !packageIds.has(dep.replace(/\/client$/, '')))
        || (client.immediately !== undefined && typeof client.immediately !== 'boolean')) throw unavailable();
      const bytes = await readPlainFile(root, `${scope}/${name}/lib/client.js`);
      const rev = sha256(bytes);
      const key = `plugins/??${id}/client.js&rev=${rev}`;
      add(key, bytes, contentTypes['.js']);
      rows.push({ id, url: `${basePath}/${key}`, rev, inject, external, ...(client.immediately ? { immediately: true } : {}) });
    }
    const bridgeBytes = Buffer.from(createDshWebClientModule(), 'utf8');
    const bridgeRevision = sha256(bridgeBytes);
    const bridgeKey = `plugins/??${DSH_WEB_BRIDGE_ID}/client.js&rev=${bridgeRevision}`;
    add(bridgeKey, bridgeBytes, contentTypes['.js']);
    rows.push({ id: DSH_WEB_BRIDGE_ID, url: `${basePath}/${bridgeKey}`, rev: bridgeRevision,
      inject: ['@deepseek-ai/dsh-client-ui-chat'], external: [] });
    const settingsBytes = Buffer.from(createDshSettingsClientModule(), 'utf8');
    const settingsRevision = sha256(settingsBytes);
    const settingsKey = `plugins/??${DSH_SETTINGS_BRIDGE_ID}/client.js&rev=${settingsRevision}`;
    add(settingsKey, settingsBytes, contentTypes['.js']);
    rows.push({ id: DSH_SETTINGS_BRIDGE_ID, url: `${basePath}/${settingsKey}`, rev: settingsRevision,
      inject: DSH_SETTINGS_CLIENT_PACKAGES.map(name => `@deepseek-ai/${name}`), external: [] });

    // Pure official composers only: importing this package does not instantiate
    // ClientModuleRegistry or activate any Node/Host plugin body.
    const composerPath = join(root, scope, 'dsh-client-modules/lib/index.js');
    await readPlainFile(root, relative(root, composerPath));
    const { bootInjections, orderByModuleGraph } = await import(pathToFileURL(composerPath).href);
    if (typeof bootInjections !== 'function' || typeof orderByModuleGraph !== 'function') throw unavailable();
    const makeGraph = settings => {
      const entries = orderByModuleGraph(rows.filter(row => settings ? row.id !== DSH_WEB_BRIDGE_ID
        : row.id !== DSH_SETTINGS_BRIDGE_ID && !DSH_SETTINGS_CLIENT_PACKAGES.some(name => row.id === `@deepseek-ai/${name}`)));
      const batches = entries.map(row => ({ phase: row.id === '@deepseek-ai/dsh-client-modules' ? 'bootstrap' : 'application',
        url: row.url, rev: row.rev, entries: [row.id] }));
      return { rev: sha256(JSON.stringify({ entries, batches })), entries, batches };
    };
    const graph = makeGraph(false), settingsGraph = makeGraph(true);
    const relocatedHtml = originalHtml.replace(/\b(src|href)="\.\/([^"<>]+)"/g, (_match, attribute, path) => {
      if (!resources.has(path)) throw unavailable();
      return `${attribute}="${htmlAttribute(`${basePath}/${path}`)}"`;
    });

    return Object.freeze({
      version: VERSION,
      graph: structuredClone(graph),
      settingsGraph: structuredClone(settingsGraph),
      /** Server-owned CSP nonce only; callers cannot inject arbitrary script content. */
      async html({ nonce, surface = 'chat' } = {}) {
        if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw unavailable();
        if (!['chat', 'settings'].includes(surface)) throw unavailable();
        const injections = bootInjections(surface === 'settings' ? settingsGraph : graph);
        const bootstrap = surface === 'settings' ? createDshSettingsBootstrapScript() : createDshWebBootstrapScript();
        const injected = `${renderInjections(injections, nonce)}\n<script nonce="${nonce}">${inlineScript(bootstrap)}</script>\n`
          + `<style nonce="${nonce}" data-agentcanvas-dsh-embed>${surface === 'settings' ? 'html,body,#root{background:transparent!important}#root{display:none}.agentcanvas-settings-form :is(h2,p){margin:0}' : embeddedPresentationCss}</style>\n`
          + `<!-- Official DeepSeek Harness ${VERSION}; MIT license retained below. -->\n<link rel="license" href="${basePath}/licenses/dsh-MIT.txt">\n`;
        // Classic bootstrap executes before the deferred official module shell.
        return relocatedHtml.replace('<head>', `<head>\n${injected}`)
          .replace(/<script\b(?![^>]*\bnonce=)([^>]*)>/g, `<script nonce="${nonce}"$1>`);
      },
      /** Exact advertised resource lookup. Pass the request pathname AND search. */
      async fetch(path, { method = 'GET' } = {}) {
        const headers = { 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' };
        if (!['GET', 'HEAD'].includes(method)) return new Response(null, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } });
        const key = resourceKey(path, basePath);
        const resource = resources.get(key);
        if (!resource) return new Response(null, { status: 404, headers });
        return new Response(method === 'HEAD' ? null : new Uint8Array(resource.bytes), { headers: {
          ...headers, 'content-type': resource.contentType, 'content-length': String(resource.bytes.length),
          'cache-control': 'private, max-age=31536000, immutable', etag: resource.etag,
        } });
      },
    });
  } catch { throw unavailable(); }
}
