/**
 * A browser-only presentation adapter for the pinned official DSH Client.
 * This is NOT a Host, model log, execution engine, or persistence store. All
 * displayed text and admission decisions belong to the parent website.
 */
export function createDshWebProjectionBridge({ sendCommand, now = () => Date.now(), viewKey = 'view' }) {
  const listeners = new Set();
  const streams = new Set();
  const times = new Map();
  let snapshot;
  let records = [];
  let displayId;
  let epoch = 0;
  const success = (value) => ({ ok: true, value });
  const failure = (message, code = 'agentcanvas/unsupported') => ({ ok: false, error: { code, message, details: {} } });
  const current = () => snapshot;
  const getSessionId = () => displayId;
  const cursor = () => records.length - 1;
  const projections = () => ({
    asOfSeq: cursor(),
    values: {
      title: snapshot?.session.title ?? null,
      inbox: { 'next-turn': [], 'next-step': [] },
      sessionListMetadata: { blank: records.length === 0, lastPromptAt: records.at(-1)?.event.time ?? null },
    },
  });
  const summary = () => ({
    sessionId: displayId, agentAvailable: true, running: snapshot.busy,
    blank: records.length === 0, updatedAt: records.at(-1)?.event.time ?? 0,
    projections: { kind: 'sequenced', ...projections() },
  });
  function publish(endpoint, frame, sessionId) {
    for (const stream of streams) {
      if (stream.endpoint === endpoint && (sessionId === undefined || stream.sessionId === sessionId)) stream.push(frame);
    }
  }
  function event(name, ...args) { publish('$events', { type: 'emit', event: name, args }); }
  function project(value) {
    const result = [];
    const add = (type, data, time, surface = false) => result.push({ type: 'event', event: {
      type, seq: result.length, time, data, ...(surface ? { surfaceOp: 'append' } : {}),
    } });
    const turns = [...value.turns];
    if (value.pendingInstruction && !turns.some((turn) => value.pendingRequestId && turn.requestId === value.pendingRequestId)) {
      turns.push({ id: 'pending', instruction: value.pendingInstruction, response: '', state: 'running', requestId: value.pendingRequestId });
    }
    turns.forEach((turn, index) => {
      const key = turn.requestId ?? turn.id;
      const createdAt = typeof turn.createdAt === 'string' ? Date.parse(turn.createdAt) : turn.createdAt;
      if (!times.has(key)) times.set(key, Number.isFinite(createdAt) ? createdAt : now());
      const time = times.get(key);
      const turnNumber = index + 1;
      add('turn/start', { turn: turnNumber }, time);
      add('step/start', { turn: turnNumber, step: 1 }, time);
      add('user/message', {
        id: `user:${key}`, role: 'user', content: [{ type: 'text', text: turn.instruction }],
        source: { kind: 'user', ...(turn.requestId ? { rpcId: turn.requestId } : {}) },
      }, time, true);
      if (turn.state === 'running') return;
      if (turn.response) add('assistant/message', {
        turn: turnNumber, step: 1,
        message: {
          id: `assistant:${key}`, role: 'assistant', content: [{ type: 'text', text: turn.response }],
          // Explicit presentation provenance; never pretend this is a raw model response.
          source: { kind: 'model', provider: 'agentcanvas-display', model: 'verified-response' },
        }, stream: [],
      }, time, true);
      add('step/end', { turn: turnNumber, step: 1 }, time);
      const reason = turn.state === 'cancelled' ? { kind: 'aborted', reason: { kind: 'user' } }
        : turn.state === 'failed' ? { kind: 'error', error: { code: 'UNKNOWN', message: turn.response || '任务未完成' } }
          : turn.state === 'blocked' ? { kind: 'blocked' } : { kind: 'completed' };
      add('turn/end', { turn: turnNumber, reason }, time);
    });
    return result;
  }
  function update(value) {
    // Parent performs the public protocol's strict schema validation. Keep this
    // adapter explicit: do not copy unknown parent data into official RPC DTOs.
    const prior = snapshot;
    if (!value || value.version !== 1 || !value.session || typeof value.session.id !== 'string' || !Array.isArray(value.turns)) return false;
    if (prior?.session.id !== value.session.id) times.clear();
    const next = project(value);
    const replaced = prior?.session.id !== value.session.id || records.some((record, index) => JSON.stringify(record) !== JSON.stringify(next[index]));
    const oldId = displayId;
    if (replaced) { epoch += 1; displayId = `${value.session.id}:display:${viewKey}:${epoch}`; }
    snapshot = value;
    const previousLength = replaced ? 0 : records.length;
    records = next;
    if (oldId && oldId !== displayId) event('api-session/removed', oldId);
    if (oldId !== displayId) event('api-session/added', summary());
    else for (const record of records.slice(previousLength)) publish('session/follow', record, displayId);
    event('api-session/status', displayId, value.busy);
    event('api-session/activity', displayId, summary().updatedAt);
    for (const [key, projected] of Object.entries(projections().values)) {
      publish('session/control', { type: 'projection', sessionId: displayId, key, value: projected, seq: cursor() });
    }
    for (const listener of listeners) listener();
    return true;
  }
  function queue(endpoint, signal, initial, sessionId) {
    const items = [...initial];
    let wake;
    let closed = signal.aborted;
    const stream = { endpoint, sessionId, push(item) { if (!closed) { items.push(item); wake?.(); } } };
    const close = () => { closed = true; streams.delete(stream); wake?.(); };
    signal.addEventListener('abort', close, { once: true });
    if (!closed) streams.add(stream);
    return {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        while (!closed && items.length === 0) await new Promise((resolve) => { wake = resolve; });
        wake = undefined;
        return closed ? { done: true, value: undefined } : { done: false, value: items.shift() };
      },
      async return() { close(); signal.removeEventListener('abort', close); return { done: true, value: undefined }; },
    };
  }
  const rpc = {
    async call(channel, endpoint, payload, signal) {
      if (channel !== '/api' || signal?.aborted) return failure('请求不可用');
      const request = payload?.args?.request;
      if (endpoint === 'session/list') return success({ items: snapshot ? [summary()] : [] });
      if (endpoint === 'session/canOpenWorkspacePath') return success(false);
      if (!snapshot || request?.sessionId && request.sessionId !== displayId) return failure('会话已切换', 'agentcanvas/session-unavailable');
      if (endpoint === 'session/projections') return success(projections());
      if (endpoint === 'session/page') {
        if (request?.address?.kind !== 'session' || request.address.sessionId !== displayId) return failure('会话已切换');
        return success({ records: records.filter(({ event: row }) => row.seq <= request.throughSeq && (request.beforeSeq === undefined || row.seq < request.beforeSeq)), hasMore: false });
      }
      if (endpoint === 'session/prompt') {
        if (request?.sessionId !== displayId || snapshot.busy || !snapshot.canSend) return failure(snapshot.statusText || '当前不能发送', 'agentcanvas/busy');
        if (request.mode !== 'queue' || typeof request.requestId !== 'string' || !Array.isArray(request.content)
          || request.content.some((part) => part.type !== 'text' || typeof part.text !== 'string')) return failure('此入口仅支持普通文本对话');
        const text = request.content.map((part) => part.text).join('\n');
        if (!text.trim() || text.length > 1000) return failure('请输入 1 至 1000 字的消息');
        return sendCommand({ type: 'send', requestId: request.requestId, text }, signal);
      }
      if (endpoint === 'session/cancel') {
        if (request?.sessionId !== displayId || !snapshot.busy) return failure('没有运行中的任务');
        return sendCommand({ type: 'cancel', requestId: `cancel:${now()}:${Math.random().toString(36).slice(2)}` }, signal);
      }
      // No default success: model/filesystem/tools/config/queue operations have
      // no authority in this presentation adapter.
      return failure('此能力由网站管理，官方嵌入视图未启用');
    },
    open(channel, endpoint, payload, signal) {
      if (channel !== '/api') throw new Error('Unsupported presentation channel');
      if (endpoint === '$events') return queue(endpoint, signal, [{ type: 'ready', clientId: 'agentcanvas-presentation', host: { home: '' } }]);
      if (endpoint === 'session/control') return queue(endpoint, signal, [{ type: 'baseline', value: { projections: snapshot ? { [displayId]: projections() } : {} } }]);
      const request = payload?.args?.request;
      if (endpoint !== 'session/follow' || !snapshot || request?.address?.kind !== 'session' || request.address.sessionId !== displayId) throw new Error('Unsupported presentation stream');
      return queue(endpoint, signal, [{
        type: 'snapshot', header: { version: 1, id: displayId, createdAt: records[0]?.event.time ?? 0, isSeeded: false },
        cursor: cursor(), records: [...records], hasMore: false, projections: projections(),
        // An opted-in official reader requires an opening watermark even when
        // the website deliberately exposes no unverified model token stream.
        ...(request.assistantStream === true ? { assistantStream: { revision: 0 } } : {}),
      }], displayId);
    },
  };
  return { rpc, update, current, getSessionId, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}

function installDshWebBootstrap(createBridge) {
  const channel = 'agentcanvas-dsh-web';
  const hash = location.hash.slice(1);
  const nonce = new URLSearchParams(hash).get('nonce') ?? hash;
  if (!/^[A-Za-z0-9_-]{16,160}$/.test(nonce) || parent === window) return;
  const pending = new Map();
  const post = (message) => parent.postMessage({ channel, nonce, ...message }, location.origin);
  // Official draft/view preferences are non-authoritative. An iframe lifetime
  // gets fresh display identities so cached drafts can never seed a later frame.
  const bridge = createBridge({ viewKey: nonce, sendCommand(command, signal) {
    return new Promise((resolve) => {
      const finish = (result) => { clearTimeout(timeout); signal?.removeEventListener('abort', aborted); pending.delete(command.requestId); resolve(result); };
      const failed = (message) => ({ ok: false, error: { code: 'agentcanvas/admission-failed', message, details: {} } });
      const aborted = () => finish(failed('请求已取消'));
      const timeout = setTimeout(() => finish(failed('网站未确认接收，请检查任务状态后重试')), 15000);
      pending.set(command.requestId, finish);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted(); else post(command);
    });
  } });
  window.addEventListener('message', (event) => {
    const value = event.data;
    if (event.source !== parent || event.origin !== location.origin || !value || value.channel !== channel || value.nonce !== nonce) return;
    if (value.type === 'snapshot') bridge.update(value.snapshot);
    if (value.type === 'result' && typeof value.requestId === 'string' && typeof value.ok === 'boolean') {
      pending.get(value.requestId)?.(value.ok ? { ok: true, value: { accepted: true } } : { ok: false, error: { code: 'agentcanvas/admission-failed', message: typeof value.error === 'string' ? value.error : '网站未接收请求', details: {} } });
    }
  });
  // The official text composer remains intact, but byte/file intake has no
  // authority. Block the browser events before the optional upload path sees them.
  for (const name of ['drop', 'paste']) document.addEventListener(name, (event) => {
    if ((event.clipboardData ?? event.dataTransfer)?.files?.length) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('change', (event) => {
    if (event.target?.type === 'file') { event.stopImmediatePropagation(); event.target.value = ''; }
  }, true);
  window.__AGENTCANVAS_DSH_WEB__ = { ...bridge, post };
  window.__DSH_TRANSPORT__ = { rpc: bridge.rpc };
  post({ type: 'ready' });
}

export function createDshWebBootstrapScript() {
  return `(${installDshWebBootstrap.toString()})(${createDshWebProjectionBridge.toString()});`;
}

export function createDshWebClientModule() {
  return `window.__ModuleLoader__.load({id:'agentcanvas-dsh-web-bridge',factory:(require)=>{
    const React=require('react');
    return {inject:['slots','sessions','uiSession','uiConversation','conversation','layout'],apply(ctx){
      const bridge=window.__AGENTCANVAS_DSH_WEB__;
      if(!bridge) throw new Error('AgentCanvas presentation bridge unavailable');
      let reference, inputDispose, input, settingDraft=false, lastDraft, refreshRequestedFor, scheduled=false, disposed=false;
      let unconfirmedDrafts=[];
      const schedule=()=>{if(!scheduled&&!disposed){scheduled=true;queueMicrotask(()=>{scheduled=false;if(!disposed)reconcile();});}};
      const reconcile=()=>{
        const snapshot=bridge.current(); if(!snapshot) return;
        const id=bridge.getSessionId();
        if(!ctx.sessions.list.getSnapshot().byId[id]){
          if(refreshRequestedFor!==id){refreshRequestedFor=id;ctx.sessions.refresh().then(schedule).catch(()=>{});}
          return;
        }
        if(reference?.sessionId!==id){
          inputDispose?.(); inputDispose=undefined; input=undefined; reference?.release();
          unconfirmedDrafts=[];
          reference=ctx.sessions.retain(id,{source:'mainView'});
          const owned=reference;
          owned.ready.then((binding)=>{
            if(reference!==owned) return;
            input=ctx.conversation.input.for(binding.ctx);
            settingDraft=true; input.setDraft(bridge.current().draft); settingDraft=false;
            lastDraft=input.state.getSnapshot().draft;
            inputDispose=input.state.subscribe(()=>{
              const draft=input.state.getSnapshot().draft;
              if(!settingDraft&&draft!==lastDraft){
                lastDraft=draft;
                unconfirmedDrafts.push(draft);
                if(unconfirmedDrafts.length>32)unconfirmedDrafts.shift();
                bridge.post({type:'draft',text:draft});
              }
            });
          }).catch(()=>{});
        }
        ctx.conversation.blocks.set(id,snapshot.busy||!snapshot.canSend?{reason:snapshot.statusText||'当前不能发送'}:undefined);
        // postMessage draft echoes can lag behind a newer local keystroke.
        // Keep only a bounded in-flight window; unmatched echoes may have fallen
        // out of that window, so wait for the latest value instead of rewinding.
        // Admission (busy), a new Session, or a cleared display generation resets
        // this temporary guard and always restores the parent's authority.
        if(snapshot.busy)unconfirmedDrafts=[];
        else if(unconfirmedDrafts.length){
          const acknowledged=unconfirmedDrafts.lastIndexOf(snapshot.draft);
          if(acknowledged>=0)unconfirmedDrafts.splice(0,acknowledged+1);
          if(unconfirmedDrafts.length)return;
        }
        if(input&&snapshot.draft!==input.state.getSnapshot().draft){
          settingDraft=true; input.setDraft(snapshot.draft); lastDraft=input.state.getSnapshot().draft; settingDraft=false;
        }
      };
      const dispose=bridge.subscribe(schedule);
      const disposeList=ctx.sessions.list.subscribe(schedule); schedule();
      ctx.effect(()=>()=>{disposed=true;dispose();disposeList();inputDispose?.();reference?.release();});
      // This journal represents verified website messages, not native execution
      // steps or timings. Replace only the two official presentation seats that
      // would otherwise infer misleading statistics from these display events.
      ctx.slots.inject('conversation.composer.dock',()=>ctx.slots.register({name:'conversation.composer.dock',id:'stats',priority:-100},()=>null));
      ctx.slots.inject('conversation.chat.node',()=>ctx.slots.register({name:'conversation.chat.node',key:'turn-process',priority:-100},()=>null));
      function RunningStatus(){
        const snapshot=React.useSyncExternalStore(bridge.subscribe,bridge.current,bridge.current);
        if(!snapshot?.busy||!snapshot.statusText)return null;
        return React.createElement('div',{role:'status','data-agentcanvas-dsh-running-status':true,title:snapshot.statusText,
          style:{minWidth:0,padding:'0 12px',fontSize:'12px',lineHeight:'20px',color:'var(--dsw-alias-label-tertiary)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},snapshot.statusText);
      }
      // Website-owned status only: no synthesized tool steps, timings or idle hint.
      ctx.slots.inject('conversation.input.dock',()=>ctx.slots.register({name:'conversation.input.dock',id:'agentcanvas-running-status'},RunningStatus));
      function Root(props){
        const snapshot=React.useSyncExternalStore(bridge.subscribe,bridge.current,bridge.current);
        const root=React.useRef(null), announced=React.useRef(false);
        React.useEffect(()=>{
          if(!snapshot||announced.current||!root.current)return;
          const inspect=()=>{if(!announced.current&&root.current?.querySelector('[contenteditable]')){announced.current=true;bridge.post({type:'mounted'});observer.disconnect();}};
          const observer=new MutationObserver(inspect);
          observer.observe(root.current,{childList:true,subtree:true});inspect();
          return()=>observer.disconnect();
        },[snapshot?.session.id]);
        return React.createElement('section',{ref:root,'data-agentcanvas-dsh-native-web':'true',style:{height:'100%',minHeight:0,display:'flex',flexDirection:'column'}},
          snapshot?props.renderFactorySlot('conversation.content',{variant:'embedded',phase:'active',hero:false}):React.createElement('p',null,'正在连接网站会话…'));
      }
      ctx.slots.register({name:'root',priority:-100},Root);
    }};
  }});`;
}
