import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as plugin from './notebook-plugin/index.mjs';
import { resolveDshInstallation } from './installation.mjs';

const descriptor = (name = 'cellSearch') => ({ name, description: 'Synthetic Notebook tool.',
  parameters: { type: 'object', properties: {}, additionalProperties: false } });
function registry(existing = []) {
  const definitions = new Map(existing.map(tool => [tool.name, tool]));
  return { definitions, tools: { schemas: () => [...definitions.values()], register: tool => definitions.set(tool.name, tool) } };
}
const execution = signal => ({ callId: 'synthetic-call-1', signal: signal ?? new AbortController().signal });

test('plugin registers only supplied capabilities, snapshots schemas and preserves results/call identity', async () => {
  const ctx = registry();
  const catalog = [...plugin.NOTEBOOK_TOOL_NAMES, ...plugin.SOURCE_TOOL_NAMES].map(descriptor);
  const calls = [];
  const result = { summary: 'Synthetic rows', data: { rowCount: 2, truncated: false } };
  const config = { catalog, execute: async call => { calls.push(call); return result; } };
  plugin.apply(ctx, config);
  catalog[0].parameters.properties.changed = { type: 'string' };
  config.execute = () => assert.fail('Execution port must be captured at registration');
  assert.deepEqual([...ctx.definitions.keys()], [...plugin.NOTEBOOK_TOOL_NAMES, ...plugin.SOURCE_TOOL_NAMES]);
  for (const [name, tool] of ctx.definitions) {
    const exec = execution();
    const args = {};
    assert.equal(await tool.execute(args, exec), result);
    assert.deepEqual(calls.at(-1), { name, args, ...exec });
    assert.deepEqual(tool.parameters.properties, {});
    assert.deepEqual(tool.output.render(args, result), [{ type: 'text', text: JSON.stringify(result) }]);
  }
});

test('empty or read-only catalogs do not manufacture edit/run permissions or interfere with other tools', () => {
  for (const catalog of [[], [descriptor()]]) {
    const ctx = registry([{ name: 'otherHostTool' }]);
    plugin.apply(ctx, { catalog, execute: async () => ({}) });
    assert.deepEqual([...ctx.definitions.keys()], ['otherHostTool', ...catalog.map(tool => tool.name)]);
  }
});

test('invalid catalogs and missing ports fail before any registration', () => {
  const invalid = [undefined, {}, { catalog: [] }, { catalog: null, execute() {} },
    ...[[descriptor('bash')], [descriptor(), descriptor()], [null], new Array(2), [descriptor(), { ...descriptor('runNotebookCells'), parameters: [] }],
      [{ ...descriptor(), description: '' }]].map(catalog => ({ catalog, execute() {} }))];
  for (const config of invalid) {
    const ctx = registry();
    assert.throws(() => plugin.apply(ctx, config), TypeError);
    assert.equal(ctx.definitions.size, 0);
  }
  const ctx = registry([descriptor('runNotebookCells')]);
  assert.throws(() => plugin.apply(ctx, { catalog: [descriptor(), descriptor('runNotebookCells')], execute() {} }), /conflicting/);
  assert.deepEqual([...ctx.definitions.keys()], ['runNotebookCells']);
});

test('host errors retain their identity; cancellation stops dispatch and rejects late success', async () => {
  const error = new Error('Synthetic host rejection');
  const ctx = registry();
  const controller = new AbortController();
  let calls = 0;
  plugin.apply(ctx, { catalog: [descriptor()], execute: async () => { calls++; throw error; } });
  const tool = ctx.definitions.get('cellSearch');
  await assert.rejects(tool.execute({}, execution()), e => e === error);
  controller.abort();
  await assert.rejects(tool.execute({}, execution(controller.signal)), { name: 'AbortError' });
  assert.equal(calls, 1);
  const late = registry();
  const lateController = new AbortController();
  plugin.apply(late, { catalog: [descriptor()], execute: async () => { lateController.abort(); return { ok: true }; } });
  await assert.rejects(late.definitions.get('cellSearch').execute({}, execution(lateController.signal)), { name: 'AbortError' });
});

test('separate host instances never share catalogs, closures or results', async () => {
  const first = registry(), second = registry();
  plugin.apply(first, { catalog: [descriptor()], execute: async () => ({ host: 'first' }) });
  plugin.apply(second, { catalog: [descriptor('runNotebookCells')], execute: async () => ({ host: 'second' }) });
  assert.deepEqual(await first.definitions.get('cellSearch').execute({}, execution()), { host: 'first' });
  assert.deepEqual(await second.definitions.get('runNotebookCells').execute({}, execution()), { host: 'second' });
  assert.equal(second.definitions.has('cellSearch'), false);
});

test('copied package loads, executes and unloads in official DSH without the website or its broker', async () => {
  const temporaryRoot = resolve(tmpdir());
  const isolated = await mkdtemp(join(temporaryRoot, 'agentcanvas-notebook-plugin-'));
  const packageRoot = join(isolated, 'package');
  let ctx;
  try {
    const source = new URL('./notebook-plugin/', import.meta.url);
    await cp(source, packageRoot, { recursive: true, force: false, errorOnExist: true });
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    assert.deepEqual((await readdir(packageRoot)).sort(), ['package.json', ...manifest.files].sort());
    assert.equal(manifest.dependencies, undefined);
    const copied = await import(pathToFileURL(join(packageRoot, 'index.mjs')).href);
    const resolver = createRequire((await resolveDshInstallation()).manifestPath);
    const load = name => import(pathToFileURL(resolver.resolve(name)).href);
    const [cordis, prompts, tools] = await Promise.all([
      load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'),
    ]);
    ctx = new cordis.Context();
    await ctx.plugin(prompts.default);
    await ctx.plugin(tools.default, { mode: 'native' });
    const observed = [];
    const mounted = ctx.plugin(copied, { catalog: [descriptor()], execute: async call => {
      // Input Schemas describe the tool; strict business validation is the host's
      // responsibility, just as the website broker invokes the original validator.
      if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args) || Object.keys(call.args).length) {
        throw new Error('Synthetic host rejected invalid arguments');
      }
      observed.push(call); return { summary: 'Independent synthetic host', data: { cells: [{ id: 'data_1', kind: 'data' }] } };
    } });
    await mounted;
    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), ['cellSearch']);
    const result = await ctx.tools.execute({ name: 'cellSearch', arguments: {}, ...execution() });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.value.data, { cells: [{ id: 'data_1', kind: 'data' }] });
    assert.equal(observed.length, 1);
    const invalid = await ctx.tools.execute({ name: 'cellSearch', arguments: { unrecognized: true }, ...execution() });
    assert.equal(invalid.isError, true);
    const unknown = await ctx.tools.execute({ name: 'editNotebookCells', arguments: {}, ...execution() });
    assert.equal(unknown.isError, true);
    assert.equal(observed.length, 1);
    await mounted.dispose();
    assert.deepEqual(ctx.tools.schemas(), []);
  } finally {
    try { await ctx?.fiber.dispose(); }
    finally {
      if (dirname(resolve(isolated)) !== temporaryRoot || !isolated.startsWith(join(temporaryRoot, 'agentcanvas-notebook-plugin-'))) {
        throw new Error('Isolated package test escaped its owned temporary directory.');
      }
      await rm(isolated, { recursive: true, force: true });
    }
  }
});
