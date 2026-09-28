import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDshInstallation } from './installation.mjs';
import { createDshWebBootstrapScript, createDshWebClientModule, createDshWebProjectionBridge } from './web-client.mjs';

const snapshot = (overrides = {}) => ({
  version: 1, session: { id: 'website-session', title: '合成会话' }, turns: [],
  draft: '', busy: false, canSend: true, statusText: '', pendingInstruction: '', ...overrides,
});
const completed = { id: 'task-1', instruction: '测试问题', response: '已验证回答', createdAt: '2026-09-26T00:00:00.000Z', state: 'success', requestId: 'request-1' };
const bridge = (options = {}) => createDshWebProjectionBridge({ sendCommand: async () => ({ ok: true, value: { accepted: true } }), now: () => 123, ...options });
const follow = (value, signal = new AbortController().signal) => value.rpc.open('/api', 'session/follow', {
  args: { request: { address: { kind: 'session', sessionId: value.getSessionId() }, assistantStream: true } },
}, signal);

test('official Session DTOs validate against the installed pinned Remote codecs', async () => {
  const installation = await resolveDshInstallation();
  const { default: remote } = await import(pathToFileURL(join(installation.root, 'node_modules/@deepseek-ai/dsh-api-session-controller/lib/typert.remote-client.js')));
  const method = (name) => remote.descriptors.find((item) => `${item.namespace}/${item.method}` === name);
  const view = bridge();
  for (const value of [snapshot(), snapshot({ turns: [completed] })]) {
    view.update(value);
    const stream = follow(view);
    const frame = (await stream.next()).value;
    assert.equal(method('session/follow').result.create().safeParse(frame).success, true);
    const list = await view.rpc.call('/api', 'session/list', { args: { request: {} } });
    assert.equal(method('session/list').result.create().safeParse(list.value).success, true);
    const projections = await view.rpc.call('/api', 'session/projections', { args: { request: { sessionId: view.getSessionId() } } });
    assert.equal(method('session/projections').result.create().safeParse(projections.value).success, true);
    await stream.return();
  }
});

test('projection contains only public messages, honest provenance, contiguous events, and request identity', async () => {
  const view = bridge();
  view.update(snapshot({ turns: [{ ...completed, rawLog: 'PRIVATE_CANARY', toolResults: 'CREDENTIAL_CANARY' }], privateContext: 'APP_SPEC_CANARY' }));
  const stream = follow(view);
  const frame = (await stream.next()).value;
  assert.deepEqual(frame.records.map(({ event }) => event.seq), [0, 1, 2, 3, 4, 5]);
  assert.equal(frame.records[2].event.data.source.rpcId, completed.requestId);
  assert.equal(frame.records[3].event.data.message.content[0].text, completed.response);
  assert.equal(frame.records[0].event.time, Date.parse(completed.createdAt));
  assert.equal(frame.records[3].event.data.message.source.provider, 'agentcanvas-display');
  assert.equal(frame.records[3].event.data.usage, undefined);
  assert.deepEqual(frame.assistantStream, { revision: 0 });
  assert.equal(frame.records.some(({ event }) => event.type.startsWith('tool/')), false);
  assert.doesNotMatch(JSON.stringify(frame), /PRIVATE_CANARY|CREDENTIAL_CANARY|APP_SPEC_CANARY/);
  await stream.return();
});

test('pending request settles by appending response without duplicate user message or cursor rollback', async () => {
  const view = bridge();
  view.update(snapshot({ busy: true, pendingInstruction: completed.instruction, pendingRequestId: completed.requestId }));
  const id = view.getSessionId();
  const stream = follow(view);
  const opening = (await stream.next()).value;
  assert.equal(opening.records.length, 3);
  view.update(snapshot({ turns: [{ ...completed, createdAt: 999 }] }));
  assert.equal(view.getSessionId(), id);
  assert.equal((await stream.next()).value.event.type, 'assistant/message');
  assert.equal((await stream.next()).value.event.type, 'step/end');
  assert.equal((await stream.next()).value.event.type, 'turn/end');
  await stream.return();
});

test('clear or history replacement gets a local display generation; stale sends are rejected', async () => {
  const view = bridge();
  view.update(snapshot({ turns: [completed] }));
  const oldId = view.getSessionId();
  view.update(snapshot());
  assert.notEqual(view.getSessionId(), oldId);
  assert.equal(view.current().session.id, 'website-session');
  const result = await view.rpc.call('/api', 'session/prompt', { args: { request: { sessionId: oldId } } });
  assert.equal(result.ok, false);
});

test('new iframe lifetimes cannot restore a former official draft/view cache key', () => {
  const first = bridge({ viewKey: 'first-frame' });
  const next = bridge({ viewKey: 'next-frame' });
  first.update(snapshot()); next.update(snapshot());
  assert.notEqual(first.getSessionId(), next.getSessionId());
  assert.equal(first.current().session.id, next.current().session.id);
});

test('official plugin waits for catalog before retaining and restores only parent draft', async () => {
  const view = bridge();
  view.update(snapshot({ draft: '父网站草稿' }));
  let exported, listListener, inputListener, finishRefresh, retained = 0;
  const disposers = [];
  let list = { byId: {} };
  let inputState = { draft: '' };
  const input = { setDraft(text) { inputState = { draft: text }; inputListener?.(); }, state: { getSnapshot: () => inputState, subscribe(fn) { inputListener = fn; return () => {}; } } };
  const ctx = {
    slots: { register() {}, inject() {} },
    sessions: {
      list: { getSnapshot: () => list, subscribe(fn) { listListener = fn; return () => {}; } },
      refresh: () => new Promise((resolve) => { finishRefresh = resolve; }),
      retain(id, options) {
        assert.ok(list.byId[id]); assert.equal(options.source, 'mainView'); retained += 1;
        return { sessionId: id, ready: Promise.resolve({ ctx: {} }), release() {} };
      },
    },
    conversation: { input: { for: () => input }, blocks: { set() {} } },
    effect(fn) { disposers.push(fn()); },
  };
  const frame = { __AGENTCANVAS_DSH_WEB__: { ...view, post() {} }, __ModuleLoader__: { load(value) { exported = value.factory(() => ({})); } } };
  vm.runInNewContext(createDshWebClientModule(), { window: frame, queueMicrotask });
  exported.apply(ctx);
  await new Promise(setImmediate);
  assert.equal(retained, 0);
  list = { byId: { [view.getSessionId()]: {} } }; finishRefresh(); listListener();
  await new Promise(setImmediate);
  assert.equal(retained, 1);
  assert.equal(inputState.draft, '父网站草稿');
  view.update(snapshot({ draft: '' }));
  await new Promise(setImmediate);
  assert.equal(inputState.draft, '');
  for (const dispose of disposers) dispose();
});

async function inputFacadeHarness(initial = snapshot()) {
  const view = bridge(); view.update(initial);
  let exported, inputListener;
  let inputState = { draft: '' };
  const posts = [], disposers = [];
  const input = {
    setDraft(text) { inputState = { draft: text }; inputListener?.(); },
    state: { getSnapshot: () => inputState, subscribe(fn) { inputListener = fn; return () => { inputListener = undefined; }; } },
  };
  const ctx = {
    slots: { register() {}, inject() {} },
    sessions: {
      list: { getSnapshot: () => ({ byId: { [view.getSessionId()]: {} } }), subscribe: () => () => {} },
      retain: (sessionId) => ({ sessionId, ready: Promise.resolve({ ctx: {} }), release() {} }),
    },
    conversation: { input: { for: () => input }, blocks: { set() {} } },
    effect(fn) { disposers.push(fn()); },
  };
  const frame = { __AGENTCANVAS_DSH_WEB__: { ...view, post: (value) => posts.push(value) }, __ModuleLoader__: { load(value) { exported = value.factory(() => ({})); } } };
  vm.runInNewContext(createDshWebClientModule(), { window: frame, queueMicrotask });
  exported.apply(ctx);
  await new Promise(setImmediate);
  return {
    input, posts, draft: () => inputState.draft,
    async update(value) { view.update(value); await new Promise(setImmediate); },
    dispose() { for (const dispose of disposers) dispose(); },
  };
}

test('stale parent draft echo cannot overwrite newer local input', async () => {
  const ui = await inputFacadeHarness();
  try {
    ui.input.setDraft('a'); ui.input.setDraft('ab');
    assert.deepEqual(ui.posts.map((message) => message.text), ['a', 'ab']);
    await ui.update(snapshot({ draft: 'a' }));
    assert.equal(ui.draft(), 'ab');
    await ui.update(snapshot({ draft: 'ab' }));
    assert.equal(ui.draft(), 'ab');
    await ui.update(snapshot({ draft: '父网站新草稿' }));
    assert.equal(ui.draft(), '父网站新草稿');
  } finally { ui.dispose(); }
});

test('a draft burst beyond the bounded echo window preserves the newest text until its acknowledgement', async () => {
  const ui = await inputFacadeHarness();
  try {
    for (let index = 0; index < 80; index += 1) ui.input.setDraft(`draft-${index}`);
    await ui.update(snapshot({ draft: 'draft-0' }));
    assert.equal(ui.draft(), 'draft-79');
    await ui.update(snapshot({ draft: 'draft-70' }));
    assert.equal(ui.draft(), 'draft-79');
    await ui.update(snapshot({ draft: 'draft-79' }));
    await ui.update(snapshot({ draft: '' }));
    assert.equal(ui.draft(), '');
  } finally { ui.dispose(); }
});

test('busy admission overrides unconfirmed drafts with the authoritative parent draft', async () => {
  const ui = await inputFacadeHarness();
  try {
    ui.input.setDraft('a'); ui.input.setDraft('ab');
    await ui.update(snapshot({ busy: true, draft: '' }));
    assert.equal(ui.draft(), '');
    await ui.update(snapshot({ draft: '父网站恢复草稿' }));
    assert.equal(ui.draft(), '父网站恢复草稿');
  } finally { ui.dispose(); }
});

test('session change and history clear discard pending draft echoes before restoring the parent draft', async () => {
  const ui = await inputFacadeHarness(snapshot({ turns: [completed] }));
  try {
    ui.input.setDraft('a'); ui.input.setDraft('ab');
    await ui.update(snapshot({ turns: [completed], session: { id: 'next-session', title: '新会话' }, draft: '新会话草稿' }));
    assert.equal(ui.draft(), '新会话草稿');
    ui.input.setDraft('c'); ui.input.setDraft('cd');
    await ui.update(snapshot({ session: { id: 'next-session', title: '新会话' }, draft: '' }));
    assert.equal(ui.draft(), '');
  } finally { ui.dispose(); }
});

test('mounted acknowledgement requires the actual official composer DOM, not just bridge readiness', () => {
  const view = bridge(); view.update(snapshot());
  let exported, Root, observe, composerPresent = false;
  const messages = [], effects = [];
  const react = {
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useRef: (current) => ({ current }), useEffect: (effect) => effects.push(effect),
    createElement: (type, props, children) => ({ type, props, children }),
  };
  const frame = { __AGENTCANVAS_DSH_WEB__: { ...view, post: (value) => messages.push(value) }, __ModuleLoader__: { load(value) { exported = value.factory(() => react); } } };
  vm.runInNewContext(createDshWebClientModule(), { window: frame, queueMicrotask() {}, MutationObserver: class { constructor(callback) { observe = callback; } observe() {} disconnect() {} } });
  exported.apply({ slots: { register(_options, component) { Root = component; }, inject() {} }, sessions: { list: { subscribe: () => () => {} } }, effect() {} });
  const tree = Root({ renderFactorySlot: () => 'official-content' });
  tree.props.ref.current = { querySelector: () => composerPresent ? {} : null };
  const cleanup = effects[0]();
  assert.deepEqual(messages, []);
  composerPresent = true; observe(); observe();
  assert.equal(messages.length, 1); assert.equal(messages[0].type, 'mounted');
  cleanup();
});

test('public slot overrides suppress only inferred display statistics while retaining native messages and actions', () => {
  const view = bridge();
  let exported;
  const registrations = [];
  const slots = {
    register(options, component) { registrations.push({ options, component }); return () => {}; },
    inject(_name, install) { install(); },
  };
  const frame = { __AGENTCANVAS_DSH_WEB__: { ...view, post() {} }, __ModuleLoader__: { load(value) { exported = value.factory(() => ({})); } } };
  vm.runInNewContext(createDshWebClientModule(), { window: frame, queueMicrotask() {} });
  exported.apply({ slots, sessions: { list: { subscribe: () => () => {} } }, effect() {} });
  const overrides = registrations.filter(({ options }) => options.name !== 'root' && options.id !== 'agentcanvas-running-status');
  assert.deepEqual(overrides.map(({ options }) => JSON.parse(JSON.stringify(options))), [
    { name: 'conversation.composer.dock', id: 'stats', priority: -100 },
    { name: 'conversation.chat.node', key: 'turn-process', priority: -100 },
  ]);
  for (const { component } of overrides) assert.equal(component(), null);
  assert.equal(registrations.some(({ options }) => ['turn-tail', 'assistant', 'user', 'turn-error'].includes(options.key)), false);
  assert.match(createDshWebClientModule(), /renderFactorySlot\('conversation.content'/);
});

test('official input dock shows only live website status, clears on finish, and preserves messages and stop', async () => {
  const commands = [];
  const view = bridge({ sendCommand: async (command) => { commands.push(command); return { ok: true, value: { accepted: true } }; } });
  let exported, Status;
  const react = {
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    createElement: (type, props, children) => ({ type, props, children }),
  };
  const slots = {
    register(options, component) {
      if (options.id === 'agentcanvas-running-status') { assert.equal(options.name, 'conversation.input.dock'); Status = component; }
      return () => {};
    },
    inject(_name, install) { install(); },
  };
  const frame = { __AGENTCANVAS_DSH_WEB__: { ...view, post() {} }, __ModuleLoader__: { load(value) { exported = value.factory(() => react); } } };
  vm.runInNewContext(createDshWebClientModule(), { window: frame, queueMicrotask() {} });
  exported.apply({ slots, sessions: { list: { subscribe: () => () => {} } }, effect() {} });
  assert.equal(Status(), null);
  view.update(snapshot({ statusText: '已完成的旧状态' }));
  assert.equal(Status(), null);
  view.update(snapshot({ busy: true, statusText: '正在校验已授权结果 <不是 HTML>', turns: [completed] }));
  const node = Status();
  assert.equal(node.type, 'div');
  assert.equal(node.props.role, 'status');
  assert.equal(node.props.style.whiteSpace, 'nowrap');
  assert.equal(node.children, view.current().statusText);
  assert.equal(node.props.title, node.children);
  assert.equal(node.props.dangerouslySetInnerHTML, undefined);
  const stream = follow(view);
  assert.equal((await stream.next()).value.records[3].event.data.message.content[0].text, completed.response);
  await stream.return();
  assert.equal((await view.rpc.call('/api', 'session/cancel', { args: { request: { sessionId: view.getSessionId() } } })).ok, true);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'cancel');
  view.update(snapshot({ busy: true, statusText: '正在完成校验', turns: [completed] }));
  assert.equal(Status().children, '正在完成校验');
  view.update(snapshot({ statusText: '正在完成校验', turns: [completed] }));
  assert.equal(Status(), null);
  view.update(snapshot({ busy: true }));
  assert.equal(Status(), null);
});

test('only text send and active cancellation cross to parent, and admission failures remain failures', async () => {
  const commands = [];
  const view = bridge({ sendCommand: async (command) => { commands.push(command); return { ok: false, error: { code: 'denied', message: '拒绝', details: {} } }; } });
  view.update(snapshot());
  const call = (request) => view.rpc.call('/api', 'session/prompt', { args: { request: { sessionId: view.getSessionId(), mode: 'queue', requestId: 'request', content: [{ type: 'text', text: '问题' }], ...request } } });
  assert.equal((await call({})).error.code, 'denied');
  assert.deepEqual(commands, [{ type: 'send', requestId: 'request', text: '问题' }]);
  for (const request of [{ mode: 'steer' }, { content: [{ type: 'file', receiptId: 'receipt' }] }, { content: [{ type: 'text', text: '  ' }] }, { content: [{ type: 'text', text: 'a'.repeat(1001) }] }]) assert.equal((await call(request)).ok, false);
  view.update(snapshot({ busy: true }));
  assert.equal((await call({})).ok, false);
  await view.rpc.call('/api', 'session/cancel', { args: { request: { sessionId: view.getSessionId() } } });
  assert.equal(commands.length, 2);
  assert.equal(commands[1].type, 'cancel');
});

test('all other mutations and unknown namespaces fail closed without parent commands', async () => {
  let calls = 0;
  const view = bridge({ sendCommand: () => { calls += 1; } });
  view.update(snapshot());
  for (const endpoint of ['session/create', 'session/fork', 'session/rename', 'session/updateQueue', 'session/selectModel', 'workspace/open', 'files/read', 'commands/execute', 'settings/update']) {
    assert.equal((await view.rpc.call('/api', endpoint, { args: {} })).ok, false, endpoint);
  }
  assert.equal(calls, 0);
  assert.throws(() => view.rpc.open('/api', 'files/follow', {}, new AbortController().signal), /Unsupported/);
});

test('streams open with exact baselines, broadcast running state, and abort blocked reads', async () => {
  const view = bridge();
  const abort = new AbortController();
  const stream = view.rpc.open('/api', '$events', { args: {} }, abort.signal);
  assert.deepEqual((await stream.next()).value, { type: 'ready', clientId: 'agentcanvas-presentation', host: { home: '' } });
  view.update(snapshot({ busy: true }));
  assert.equal((await stream.next()).value.event, 'api-session/added');
  assert.deepEqual((await stream.next()).value, { type: 'emit', event: 'api-session/status', args: [view.getSessionId(), true] });
  await stream.next();
  const waiting = stream.next();
  abort.abort();
  assert.equal((await waiting).done, true);
});

test('bootstrap accepts only matching parent/source/origin/nonce and waits for command acknowledgement', async () => {
  const handlers = new Map();
  const posted = [];
  const nonce = 'synthetic_nonce_123456';
  const parent = { postMessage: (message, origin) => posted.push({ message, origin }) };
  const window = { addEventListener: (name, callback) => handlers.set(name, callback) };
  const context = vm.createContext({ window, parent, location: { hash: `#${nonce}`, origin: 'http://127.0.0.1:3001' }, document: { addEventListener() {} }, URLSearchParams, setTimeout, clearTimeout, AbortController, console });
  vm.runInContext(createDshWebBootstrapScript(), context);
  const receive = (data, changes = {}) => handlers.get('message')({ source: parent, origin: 'http://127.0.0.1:3001', data: { channel: 'agentcanvas-dsh-web', nonce, ...data }, ...changes });
  receive({ type: 'snapshot', snapshot: snapshot() }, { source: {} });
  receive({ type: 'snapshot', snapshot: snapshot() }, { origin: 'http://evil.invalid' });
  receive({ type: 'snapshot', snapshot: snapshot(), nonce: 'wrong' });
  assert.equal(window.__AGENTCANVAS_DSH_WEB__.current(), undefined);
  receive({ type: 'snapshot', snapshot: snapshot() });
  const view = window.__AGENTCANVAS_DSH_WEB__;
  const result = view.rpc.call('/api', 'session/prompt', { args: { request: { sessionId: view.getSessionId(), requestId: 'request', mode: 'queue', content: [{ type: 'text', text: '问题' }] } } });
  assert.equal(posted.at(-1).message.type, 'send');
  receive({ type: 'result', requestId: 'request', ok: false, error: '父网站拒绝' });
  assert.equal((await result).error.message, '父网站拒绝');
  assert.ok(posted.every(({ origin }) => origin === 'http://127.0.0.1:3001'));
  assert.doesNotMatch(createDshWebBootstrapScript(), /fetch\(|WebSocket\(|localStorage|indexedDB/);
  assert.match(createDshWebClientModule(), /renderFactorySlot\('conversation.content'/);
});
