/** Website transport for the unmodified official settings UI. No Host or model. */
export function createSettingsTransport({ request }) {
  return {
    async call(channel, endpoint, payload, signal) {
      const denied = { ok: false, error: { code: 'agentcanvas/settings-unsupported', message: '此配置由网站管理，未开放该操作。', details: {} } };
      if (channel !== '/api' || signal?.aborted) return denied;
      if (endpoint === 'session/list') return { ok: true, value: { items: [] } };
      if (endpoint === 'settings/describe') return { ok: true, value: { writable: false, hasDocument: false, namespaces: [{
        ns: 'locale', autoGenerate: false, schema: { type: 'object', dict: { preference: { type: 'string' } } },
        value: { preference: 'zh-CN' }, applies: 'live', secrets: [], revision: 0,
      }] } };
      if (endpoint === 'pluginInventory/list') return request('inventory', signal);
      return denied;
    },
    open(channel, endpoint, payload, signal) {
      if (channel !== '/api' || !['$events', 'session/control'].includes(endpoint)) throw new Error('Unsupported settings stream');
      let sent = false, closed = false;
      const waiters = new Set();
      const close = () => { closed = true; signal.removeEventListener('abort', close); for (const resolve of waiters) resolve(); waiters.clear(); };
      signal.addEventListener('abort', close, { once: true });
      return { [Symbol.asyncIterator]() { return this; }, async next() {
        if (signal.aborted || closed) { close(); return { done: true }; }
        if (!sent) { sent = true; return { done: false, value: endpoint === '$events'
          ? { type: 'ready', clientId: 'agentcanvas-settings', host: { home: '' } }
          : { type: 'baseline', value: { projections: {} } } }; }
        await new Promise(resolve => waiters.add(resolve));
        return { done: true };
      }, async return() { close(); return { done: true }; } };
    },
  };
}

function bootstrap(createTransport) {
  const channel = 'agentcanvas-dsh-settings', nonce = location.hash.slice(1);
  if (parent === window || !/^[A-Za-z0-9_-]{16,160}$/.test(nonce)) return;
  const listeners = new Set(), pending = new Map();
  let snapshot;
  const post = value => parent.postMessage({ channel, nonce, ...value }, location.origin);
  const request = (type, signal) => new Promise(resolve => {
    const requestId = crypto.randomUUID();
    const finish = value => { clearTimeout(timer); pending.delete(requestId); signal?.removeEventListener('abort', abort); resolve(value); };
    const abort = () => finish({ ok: false, error: { code: 'agentcanvas/cancelled', message: '读取已取消或超时。', details: {} } });
    const timer = setTimeout(abort, 20000);
    pending.set(requestId, finish); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else post({ type, requestId });
  });
  window.addEventListener('message', event => {
    const value = event.data;
    if (event.source !== parent || event.origin !== location.origin || value?.channel !== channel || value.nonce !== nonce) return;
    if (value.type === 'snapshot') { snapshot = value.snapshot; for (const listener of listeners) listener(); }
    if (value.type === 'result') pending.get(value.requestId)?.(value.result);
  });
  window.__AGENTCANVAS_DSH_SETTINGS__ = { post, current: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  window.__DSH_TRANSPORT__ = { rpc: createTransport({ request }) };
  post({ type: 'ready' });
}

export function createDshSettingsBootstrapScript() {
  return `(${bootstrap.toString()})(${createSettingsTransport.toString()});`;
}

/** Use official settings shell, inventory, modal, switch and buttons; only the
 * website's bounded configuration form and lifecycle are bridge-owned. */
function settingsPlugin(require) {
  const React = require('react'), { Button, Switch, Modal, SegmentedControl } = require('@deepseek-ai/dsh-client-ui-primitives');
  const h = React.createElement;
  return { inject: ['slots', 'locale', 'sessions'], apply(ctx) {
    try {
    const bridge = window.__AGENTCANVAS_DSH_SETTINGS__;
    if (!bridge) throw new Error('Settings bridge unavailable');
    const useSnapshot = () => React.useSyncExternalStore(bridge.subscribe, bridge.current, bridge.current);
    const action = (type, extra = {}) => bridge.post({ type, ...extra });
    const button = (label, type, disabled = false) => h(Button, { disabled, onClick: () => action(type) }, label);
    // This is an explicitly labelled configuration/install projection, not a
    // fabricated Loader tree. Unknown installed modules never say "enabled".
    // Public language-pack extension, with read-only view-local locale. Existing
    // official dictionaries/bundles are not overwritten, nor user settings saved.
    ctx.effect(() => ctx.locale.register('settings.pluginInventory', 'zh-CN', {
      presetTitle: '网站能力配置', presetSubtitle: '打开时的保存配置快照；修改后重新打开此设置更新',
        globalTitle: '已安装组件', globalSubtitle: '打开时的受管安装快照；不是官方 Host 全局实例',
        enabledTag: '网站已配置', disabledTag: '查看接入说明', conditionalTag: '按任务或说明提供',
        presetEnabledTag: '网站预设已配置', presetProvidedDetail: '由网站任务配置提供；运行状态未核实',
        unobserved: '尚未核实', tab: '插件列表', configuration: '网站接入标注',
    }));
    ctx.effect(() => ctx.locale.addLanguage({ id: 'zh-CN', label: '简体中文（网站适配）', fallback: 'zh' }));
    function Launcher({ settingsOpen, openSettings }) {
      const started = React.useRef(false), wasOpen = React.useRef(false);
      React.useEffect(() => {
        if (settingsOpen) { wasOpen.current = true; action('mounted'); return; }
        if (wasOpen.current) { wasOpen.current = false; action('close'); openSettings(); }
        else if (!started.current) { started.current = true; openSettings(); }
      }, [settingsOpen, openSettings]);
      return null;
    }
    function Configuration({ preset = false }) {
      const s = useSnapshot();
      if (!s) return h('p', { role: 'status' }, '正在读取网站配置…');
      return h('section', { className: 'agentcanvas-settings-form', style: { display: 'grid', gap: 16, minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere', fontSize: 13, lineHeight: 1.6, alignContent: 'start' } },
        h('h2', null, preset ? 'Agent 预设' : '网站能力配置'),
        h('p', null, '使用官方设置组件；网站保留配置、数据授权和草稿确认。保存不会运行数据或调用模型。'),
        h('p', null, s.status?.dsh.available ? '本机 DSH 组件可用' : '本机 DSH 组件状态待确认'),
        preset ? h(SegmentedControl, { id: 'website-preset', value: s.skills ? 'skills' : 'basic', label: '网站能力组合', disabled: !s.canConfigure,
          options: [{ value: 'basic', label: '基础分析' }, { value: 'skills', label: '分析 + Skill' }], onChange: value => action('skills', { skills: value === 'skills' }) })
        : h('div', { style: { display: 'flex', alignItems: 'center', gap: 14 } },
          h(Switch, { checked: s.skills, label: '启用内置 Skill', disabled: !s.canConfigure,
            onChange: skills => action('skills', { skills }) }), h('span', null, '内置 Skill')),
        h('p', null, 'data-inspection、notebook-analysis。仅加载说明，不增加文件或数据权限。'),
        h('p', null, '终端、任意文件、上下文压缩等未在此接入；安装包存在不代表能力可用。'),
        s.active && h('p', { role: 'status' }, '有任务正在执行，暂不能修改插件设置。'),
        s.needsRefresh && h('p', { role: 'status' }, '状态待确认；请刷新后再保存。未保存的选择仍保留。'),
        s.error && h('p', { role: 'alert' }, s.error),
        s.notice && h('p', { role: 'status' }, s.notice),
        h('p', null, s.dirty ? '有未保存的修改' : '配置未更改'),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
          button('刷新状态', 'refresh', s.loading || s.saving), button(s.saving ? '保存中…' : '保存配置', 'save', s.locked || !s.dirty),
          s.modelsAvailable && button('模型配置', 'models', s.dirty || s.saving)));
    }
    function Discard() {
      const s = useSnapshot();
      return h(Modal, { open: Boolean(s?.discard), title: '放弃未保存的修改？', closeLabel: '继续编辑',
        onClose: () => action('keep'), footer: h(React.Fragment, null, button('继续编辑', 'keep'), button('放弃并关闭', 'discard')) },
        '未保存的 Skill 选择不会写入配置。');
    }
    ctx.slots.inject('settings.launcher', () => ctx.slots.register({ name: 'settings.launcher', priority: -100 }, Launcher));
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({ name: 'settings.general.item', id: 'website-scope', order: -100 },
      () => h('p', { style: { fontSize: 12, lineHeight: 1.6 } }, '此处为官方 Web 客户端偏好，作用于官方嵌入界面，不控制 Notebook、模型或插件权限。工作步骤与代码工具仍受网站已接入能力限制；语言由网站固定。')));
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'website', order: 5, label: '网站能力' }, Configuration));
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'agent-presets', order: 20, label: 'Agent 预设' }, () => h(Configuration, { preset: true })));
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'website-settings-feedback' }, Discard));
    } catch (error) { console.error('Official settings adapter setup failed', error); throw error; }
  } };
}
export function createDshSettingsClientModule() {
  return `window.__ModuleLoader__.load({id:'agentcanvas-dsh-settings-bridge',factory:(${settingsPlugin.toString()})});`;
}
