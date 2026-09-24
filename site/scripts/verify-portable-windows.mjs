// Deliberate isolated acceptance of an extracted distribution, not an app entry.
// Paid execution is opt-in, one task only; never retry a failed paid task here.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { readEnvironment, sleep, stopChild } from './runtime/common.mjs';

const site = resolve(fileURLToPath(new URL('..', import.meta.url)));
const expected = [{ region: 'East', revenue: 300 }, { region: 'South', revenue: 160 }];
const csv = 'region,amount\nEast,100\nEast,50\nSouth,80\n';
const filename = 'portable-synthetic-sales.csv';
const instruction = '请在当前 Notebook 保留已有的所有 Data、Python、SQL、图表单元及其内容，只新增一个标题为“AI汇总表”的表格单元，使用已有 totals 输出展示 region、revenue 两列。请先检查当前单元，试运行并核对结果，然后提交可采用的 Notebook 草稿。不要新增 Python 或 SQL，不要修改正式看板。';

export function parsePortableArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--allow-paid-model' && !options.paid) options.paid = true;
    else if (['--root', '--output'].includes(key) && !options[key.slice(2)] && isAbsolute(args[index + 1] ?? '')) {
      options[key.slice(2)] = resolve(args[++index]);
    } else throw new Error('Usage: --root <absolute extracted AgentCanvas> --output <new absolute private evidence directory> [--allow-paid-model]');
  }
  if (!options.root || !options.output) throw new Error('Both --root and --output are required.');
  for (const [parent, child] of [[options.root, options.output], [options.output, options.root]]) {
    const distance = relative(parent, child);
    if (!distance || (!distance.startsWith('..') && !isAbsolute(distance))) throw new Error('Bundle and evidence directories must be separate.');
  }
  return { ...options, paid: options.paid === true };
}

/** Do not inherit credentials, NODE_OPTIONS, npm paths, proxies or local projects. */
export function isolatedPortableEnvironment(source, output) {
  const systemRoot = source.SystemRoot || source.SYSTEMROOT || source.WINDIR;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error('Windows system directory is required.');
  return {
    SystemRoot: systemRoot, WINDIR: systemRoot,
    PATH: [join(systemRoot, 'System32'), systemRoot, join(systemRoot, 'System32', 'Wbem')].join(';'),
    TEMP: join(output, 'temp'), TMP: join(output, 'temp'),
    LOCALAPPDATA: join(output, 'localappdata'), APPDATA: join(output, 'appdata'), USERPROFILE: join(output, 'profile'),
    DSH_MAX_TOOL_CALLS: '16', DSH_TOTAL_EXECUTION_TIMEOUT_MS: '180000', DSH_TOOL_CALL_TIMEOUT_MS: '35000',
    HARNESS_MODEL_REQUEST_TIMEOUT_MS: '60000',
  };
}

export function validatePortableReady(message) {
  if (message?.type !== 'ready') return undefined;
  const url = new URL(message.url);
  const port = Number(url.port);
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
  assert.ok(port >= 3210 && port <= 3229, 'Only isolated portable ports are allowed.');
  assert.equal(url.pathname, '/'); assert.equal(url.search, ''); assert.equal(url.hash, '');
  assert.equal(url.username, ''); assert.equal(url.password, '');
  assert.ok(Number.isSafeInteger(message.serverPid) && message.serverPid > 0);
  return { base: url.origin, serverPid: message.serverPid };
}

async function startPortable(root, environment) {
  const child = spawn(join(root, 'runtime', 'node.exe'), [join(root, 'launcher.mjs'), '--no-browser'], {
    cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // Drain output without persisting arbitrary server diagnostics or local paths.
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  try {
    const ready = await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Portable startup timed out.')), 60000);
      const finish = (error, result) => { clearTimeout(timer); if (error) reject(error); else resolveReady(result); };
      child.once('error', () => finish(new Error('Portable process could not start.')));
      child.once('exit', () => finish(new Error('Portable process exited before readiness.')));
      child.on('message', message => {
        try { const result = validatePortableReady(message); if (result) finish(undefined, result); }
        catch { finish(new Error('Portable launcher returned invalid readiness.')); }
      });
    });
    return { child, ...ready };
  } catch (error) { await stopChild(child); throw error; }
}

async function stopPortable(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.send({ type: 'shutdown' }, () => {});
  for (let count = 0; count < 30 && child.exitCode === null && child.signalCode === null; count++) await sleep(100);
  await stopChild(child);
}

async function privateCredential() {
  const location = JSON.parse(await readFile(join(site, '.runtime/runtime-location.json'), 'utf8'));
  const managed = JSON.parse(await readFile(join(location.root, 'config.json'), 'utf8'));
  assert.equal(resolve(managed.source).toLowerCase(), site.toLowerCase());
  const environment = { ...process.env, ...readEnvironment(join(location.root, 'config')), ...readEnvironment(site) };
  const key = environment.DEEPSEEK_API_KEY?.trim();
  assert.ok(key && key.length >= 8 && key.length <= 512 && !/\s|[\u0000-\u001f\u007f]/u.test(key), 'Existing private credential is required.');
  return key;
}

async function childExecutables(serverPid, systemRoot) {
  // Strict integer PID is from our own launcher's IPC, never a discovered service.
  assert.ok(Number.isSafeInteger(serverPid) && serverPid > 0);
  const command = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${serverPid}' | Select-Object -ExpandProperty ExecutablePath | ConvertTo-Json -Compress`;
  return new Promise(resolvePaths => {
    const child = spawn(join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    const timer = setTimeout(() => { child.kill(); resolvePaths([]); }, 10000);
    child.stdout.on('data', chunk => { if (output.length < 64000) output += chunk.toString(); });
    child.once('error', () => { clearTimeout(timer); resolvePaths([]); });
    child.once('exit', () => {
      clearTimeout(timer);
      try { const value = JSON.parse(output || '[]'); resolvePaths(Array.isArray(value) ? value : [value]); }
      catch { resolvePaths([]); }
    });
  });
}

export async function verifyPortableWindows(options) {
  assert.equal(process.platform, 'win32', 'Windows x64 acceptance must run on Windows.');
  assert.equal(process.arch, 'x64');
  const { root, output, paid } = options;
  assert.equal((await lstat(root)).isSymbolicLink(), false);
  assert.equal((await realpath(root)).toLowerCase(), root.toLowerCase());
  assert.equal((await lstat(join(root, 'runtime/node.exe'))).isFile(), true);
  const browserExecutable = join(root, 'runtime/browser/chrome-headless-shell.exe');
  assert.equal((await lstat(browserExecutable)).isFile(), true, 'Complete package browser is required.');
  // Refuse a used copy: this also prevents accidental automatic paid retries.
  await assert.rejects(lstat(join(root, 'data')), { code: 'ENOENT' });
  await mkdir(output, { recursive: false });
  const environment = isolatedPortableEnvironment(process.env, output);
  for (const key of ['TEMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE']) await mkdir(environment[key], { recursive: true });
  const report = { passed: false, paidAuthorized: paid, startedAt: new Date().toISOString(),
    scope: 'Extracted Windows distribution, synthetic data, isolated project and browser. No global Node/npm PATH. No application response mocks.',
    checks: [], screenshots: [], pageErrors: [], blockedRequests: [], modelTaskAttempts: 0,
    usage: paid ? 'Not yet observed' : 'No model task authorized or executed.', visualReview: 'Pending actual screenshot review.', stablePublished: false };
  const projectPath = join(output, 'project');
  let runtime, browser, context, page, handle, pageId, stage = 'startup', allowAi = false;
  const json = async (path, init) => {
    const response = await fetch(`${runtime.base}${path}`, { ...init, signal: AbortSignal.timeout(60000) });
    assert.ok(response.ok, `HTTP ${response.status} at ${path}`); return response.json();
  };
  const book = value => value.state.dataProduct.notebooks[pageId];
  const editor = () => page.locator('.notebook-editor');
  const dataBrowser = () => page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
  const manifest = () => json('/api/projects', { headers: { 'x-agentcanvas-project': handle } }).then(value => value.manifest);
  async function saved(predicate = () => true) {
    const deadline = Date.now() + 30000; let revision, unchanged;
    while (Date.now() < deadline) {
      const value = await manifest();
      if (predicate(value)) {
        if (revision !== value.stateRevision) { revision = value.stateRevision; unchanged = Date.now(); }
        if (Date.now() - unchanged > 900) return value;
      } else { revision = undefined; unchanged = undefined; }
      await sleep(150);
    }
    throw new Error('Local project did not reach expected saved state.');
  }
  async function shot(name, evidence, locator) {
    if (locator) await locator.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, name), fullPage: false, animations: 'disabled' });
    report.screenshots.push({ name, evidence, reviewed: false });
  }
  async function navigation(name) {
    await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click();
    const menu = page.getByRole('navigation', { name: '工作区功能菜单', exact: true });
    await menu.getByRole('textbox', { name: '查找功能或工作界面' }).fill(name);
    await menu.getByRole('button', { name, exact: true }).click();
  }
  async function projectDialog() {
    await navigation('数据浏览器'); await dataBrowser().waitFor();
    await dataBrowser().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: /项目文件夹/u }).click();
    await dataBrowser().getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  }
  async function saveCell() {
    await editor().getByRole('button', { name: '保存单元', exact: true }).click();
    const rename = page.getByRole('region', { name: '确认输出变量改名', exact: true });
    if (await rename.isVisible()) await rename.getByRole('button', { name: '确认改名并保存', exact: true }).click();
    await editor().waitFor({ state: 'hidden' });
  }
  async function addCell(kind, title, outputName) {
    await page.getByRole('group', { name: '添加分析单元', exact: true }).getByRole('button', { name: `＋ ${kind}`, exact: true }).click();
    await editor().getByLabel('单元名称', { exact: true }).fill(title);
    if (outputName) await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill(outputName);
  }
  async function runAll() {
    const pending = page.waitForResponse(response => response.url() === `${runtime.base}/api/notebook/run`, { timeout: 90000 });
    let finished = false, observed = false;
    const observer = (async () => {
      while (!finished) {
        const paths = await childExecutables(runtime.serverPid, environment.SystemRoot);
        report.pythonBrowserObservations ??= [];
        report.pythonBrowserObservations.push({ childNames: paths.filter(path => typeof path === 'string').map(path => basename(path)) });
        observed ||= paths.some(path => typeof path === 'string' && resolve(path).toLowerCase() === browserExecutable.toLowerCase());
        if (observed) break;
        await sleep(100);
      }
    })();
    try {
      await page.getByRole('button', { name: '▶ 全部运行', exact: true }).click();
      const response = await pending, value = await response.json();
      assert.equal(response.status(), 200); assert.equal(value.run.status, 'success');
      const totals = value.run.cells.filter(cell => cell.table?.rows?.[0]?.revenue !== undefined);
      assert.ok(totals.length > 0);
      for (const total of totals) assert.deepEqual([...total.table.rows].sort((a, b) => a.region.localeCompare(b.region)), expected);
      report.runs ??= []; report.runs.push({ status: value.run.status, cells: value.run.cells.map(cell => ({ cellId: cell.cellId, status: cell.status })) });
      await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' });
      return value;
    } finally { finished = true; await observer; report.packagedPythonBrowserObserved ||= observed; }
  }
  try {
    runtime = await startPortable(root, environment); report.port = Number(new URL(runtime.base).port);
    const health = await json('/api/health'); assert.equal(health.status, 'ok'); assert.equal(health.persistence.configured, true);
    const engine = await json('/api/settings/agent-engine');
    assert.equal(engine.dsh.available, true); assert.equal(engine.engine, 'dsh'); assert.equal(engine.activeTasks, 0);
    report.dsh = { available: true, version: engine.dsh.version, engine: engine.engine };
    assert.equal((await json('/api/notebook/python')).available, true);
    assert.equal((await json('/api/settings/ai')).configured, false, 'The package must not inherit a model key.');
    report.checks.push('Bundled Node launched with Windows-only PATH; HTTP health, default DSH readiness and Python resources passed; AI starts unconfigured.');
    browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (...input) => {
        const response = await original(...input);
        if (new URL(response.url).pathname === '/api/ai/harness/stream') {
          window.__portableStream = { state: 'streaming' };
          void response.clone().text().then(body => { window.__portableStream = { state: 'complete', body }; }, () => { window.__portableStream = { state: 'failed' }; });
        }
        return response;
      };
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.href === 'https://rsms.me/inter/inter.css') return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      if (url.origin !== runtime.base) { report.blockedRequests.push({ reason: 'external-origin' }); return route.abort(); }
      if (url.pathname.startsWith('/api/ai/')) {
        if (!allowAi || !paid || request.method() !== 'POST' || url.pathname !== '/api/ai/harness/stream' || ++report.modelTaskAttempts > 1) {
          report.blockedRequests.push({ reason: 'unapproved-model-task' }); return route.abort();
        }
      }
      return route.continue();
    });
    page = await context.newPage(); page.setDefaultTimeout(25000);
    page.on('pageerror', error => report.pageErrors.push({ kind: error.name }));
    await page.goto(runtime.base, { waitUntil: 'networkidle', timeout: 60000 });
    stage = 'missing-key-ui'; await navigation('AI 接口配置');
    await page.getByRole('dialog', { name: 'AI 接口配置', exact: true }).getByLabel('DeepSeek API Key', { exact: true }).waitFor();
    await shot('01-no-credentials.png', 'Fresh portable installation requests the user key; no credentials bundled.');
    await page.getByRole('button', { name: '关闭 AI API 配置', exact: true }).click();
    stage = 'synthetic-project'; await projectDialog();
    await dataBrowser().getByLabel('项目名称', { exact: true }).fill('便携完整包合成验收');
    const creation = page.waitForResponse(response => response.url() === `${runtime.base}/api/projects` && response.request().method() === 'POST');
    await dataBrowser().getByRole('button', { name: '新建本地项目', exact: true }).click();
    const createdResponse = await creation; assert.equal(createdResponse.status(), 200);
    const created = await createdResponse.json(); handle = created.handle;
    await dataBrowser().waitFor({ state: 'hidden' });
    const initialized = await saved(value => value.state?.appSpec.pages.length > 0); pageId = initialized.state.appSpec.pages[0].id;
    await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
    const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
    await upload.locator('input[type="file"]').setInputFiles({ name: filename, mimeType: 'text/csv', buffer: Buffer.from(csv) });
    const parsed = page.waitForResponse(response => response.url() === `${runtime.base}/api/datasets` && response.request().method() === 'POST');
    await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click();
    const parsedResponse = await parsed; assert.equal(parsedResponse.status(), 201);
    const datasetId = (await parsedResponse.json()).dataset.datasetId;
    await upload.waitFor({ state: 'hidden' }); await saved(value => value.tables.length === 1 && value.files.length === 1);
    await addCell('Data', '合成销售数据', 'sales_data');
    await editor().getByLabel('数据源', { exact: true }).selectOption(datasetId); await saveCell();
    await addCell('Python', 'Python 倍增金额', 'cleaned');
    await editor().getByRole('checkbox').first().check();
    await editor().getByLabel('Python', { exact: true }).fill("import time\ncleaned = sales_data.assign(amount=sales_data['amount'] * 2)\ntime.sleep(2)  # Allow host process observation during portable acceptance.\nprint('3 synthetic records doubled')"); await saveCell();
    await addCell('SQL', '地区销售总计', 'totals');
    const inputs = editor().getByRole('checkbox');
    const labels = await inputs.evaluateAll(items => items.map(item => item.closest('label')?.textContent ?? ''));
    const cleanedIndex = labels.findIndex(label => label.includes('cleaned')); assert.ok(cleanedIndex >= 0);
    await inputs.nth(cleanedIndex).check();
    await editor().getByLabel('SQL', { exact: true }).fill('SELECT region, SUM(amount) AS revenue FROM cleaned GROUP BY region ORDER BY region'); await saveCell();
    // The current chart editor deliberately requires an actual upstream result.
    stage = 'python-sql'; await runAll();
    assert.equal(report.packagedPythonBrowserObserved, true, 'Notebook Python must actually launch the bundled browser.');
    stage = 'create-chart';
    await addCell('图表', '地区销售图');
    const options = await editor().getByLabel('上游输出', { exact: true }).locator('option').evaluateAll(items => items.map(item => ({ value: item.value, text: item.textContent })));
    await editor().getByLabel('上游输出', { exact: true }).selectOption(options.find(item => item.text.includes('totals')).value);
    await editor().getByLabel('分类字段', { exact: true }).fill('region');
    await editor().getByLabel('数值字段（逗号分隔，最多 4 个）', { exact: true }).fill('revenue'); await saveCell();
    stage = 'python-sql-chart'; await runAll();
    assert.equal(report.packagedPythonBrowserObserved, true, 'Notebook Python must actually launch the bundled browser.');
    const chart = page.getByRole('article', { name: '图表单元 地区销售图', exact: true });
    await shot('02-python-sql-chart.png', 'Real CSV → bundled Python → DuckDB SQL → chart; exact East 300 and South 160 checked.', chart);
    report.checks.push('Actual CSV import, DataFrame calculation, DuckDB aggregation and chart output passed; bundled browser child process observed.');
    if (paid) {
      stage = 'configure-paid-model'; await navigation('AI 接口配置');
      const api = page.getByRole('dialog', { name: 'AI 接口配置', exact: true });
      await api.getByLabel('DeepSeek API Key', { exact: true }).fill(await privateCredential());
      const discovery = page.waitForResponse(response => response.url() === `${runtime.base}/api/settings/ai` && response.request().method() === 'POST', { timeout: 60000 });
      await api.getByRole('button', { name: '验证密钥并识别模型', exact: true }).click();
      const discoveredResponse = await discovery; assert.equal(discoveredResponse.status(), 200);
      const discovered = await discoveredResponse.json();
      const chosen = discovered.availableModels.find(model => model.id === 'deepseek-flash')?.id ?? discovered.model;
      if (chosen !== discovered.model) {
        await api.getByLabel('选择模型', { exact: true }).selectOption(chosen);
        const applied = page.waitForResponse(response => response.url() === `${runtime.base}/api/settings/ai` && response.request().method() === 'PATCH');
        await api.getByRole('button', { name: '应用模型', exact: true }).click(); assert.equal((await applied).status(), 200);
      }
      report.model = chosen;
      await page.getByRole('button', { name: '关闭 AI API 配置', exact: true }).click();
      const before = await saved(value => book(value)?.cells.length === 4);
      stage = 'single-paid-dsh-task'; await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
      await page.getByRole('textbox', { name: 'AI 指令', exact: true }).fill(instruction);
      allowAi = true;
      await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click();
      await page.waitForFunction(() => ['complete', 'failed'].includes(window.__portableStream?.state), undefined, { timeout: 240000 });
      allowAi = false;
      const stream = await page.evaluate(() => window.__portableStream); assert.equal(stream.state, 'complete');
      const frames = stream.body.split(/\r?\n\r?\n/u).flatMap(block => {
        const line = block.split(/\r?\n/u).find(item => item.startsWith('data: ')); return line ? [JSON.parse(line.slice(6))] : [];
      });
      const task = frames.findLast(frame => frame.task)?.task; assert.ok(task);
      report.task = { state: task.state, counters: task.counters, modelUsage: task.modelUsage };
      report.usage = task.modelUsage ?? 'Task counters observed; provider token totals and invoice amount were not independently captured.';
      await writeFile(join(output, 'synthetic-paid-task.json'), JSON.stringify({ task, frames }, null, 2), { flag: 'wx' });
      await page.getByRole('button', { name: '取消 AI 请求', exact: true }).waitFor({ state: 'hidden' });
      await shot('03-real-dsh-task.png', 'Single actual paid DSH task; no response replay or automatic paid retry.');
      assert.equal(task.state, 'awaitingConfirmation'); assert.ok(task.notebookArtifact);
      assert.deepEqual(book(await saved()).cells, book(before).cells, 'Unadopted AI draft must not replace formal Notebook.');
      stage = 'adopt-paid-draft'; await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
      const draft = page.getByLabel('AI Notebook 草稿', { exact: true }); await draft.waitFor();
      await shot('04-ai-draft-before-adoption.png', 'Real DSH-produced draft awaiting explicit confirmation.', draft);
      await draft.getByRole('button', { name: '采用草稿', exact: true }).click(); await draft.waitFor({ state: 'hidden' });
      await saved(value => book(value).lastDraftId === task.notebookArtifact.id);
      await runAll(); await shot('05-adopted-ai-table.png', 'AI draft explicitly adopted; real downstream result values independently checked.', page.getByRole('article', { name: '表格单元 AI汇总表', exact: true }));
      assert.equal(report.modelTaskAttempts, 1);
      report.checks.push('One real paid DSH task submitted a draft; formal Notebook unchanged until explicit adoption; adopted results match independent expected values.');
    }
    stage = 'save-reopen';
    const completed = await saved(value => book(value)?.cells.length >= 4);
    await page.reload({ waitUntil: 'networkidle' }); await projectDialog();
    const opening = page.waitForResponse(response => response.url() === `${runtime.base}/api/projects` && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'open');
    await dataBrowser().getByRole('button', { name: '打开已有项目', exact: true }).click(); assert.equal((await opening).status(), 200);
    await dataBrowser().waitFor({ state: 'hidden' }); await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
    const reopened = await saved(value => book(value)?.cells.length === book(completed).cells.length);
    assert.deepEqual(book(reopened), book(completed));
    await shot('06-saved-project-reopened.png', 'Persisted synthetic local project and exact Notebook definitions reopened after browser reload.');
    report.checks.push('Saved local project reopened; exact Notebook definitions retained without automatic model execution.');
    assert.equal((await json('/api/settings/agent-engine')).activeTasks, 0);
    assert.equal(report.pageErrors.length, 0); assert.equal(report.blockedRequests.length, 0);
    report.passed = true;
  } catch (error) {
    report.failure = { stage, kind: error instanceof Error ? error.name : 'UnknownError', code: typeof error?.code === 'string' ? error.code : undefined };
    // No raw exception or request bodies: credentials may be in a failed form.
    if (page && stage !== 'configure-paid-model') await shot('failure.png', `Actual failed acceptance stage: ${stage}`).catch(() => {});
  } finally {
    await browser?.close().catch(() => {});
    await stopPortable(runtime?.child);
    report.finishedAt = new Date().toISOString();
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await verifyPortableWindows(parsePortableArguments(process.argv.slice(2)));
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks, failure: report.failure, modelTaskAttempts: report.modelTaskAttempts }));
    if (!report.passed) process.exitCode = 1;
  } catch {
    console.error('Portable acceptance could not start safely. Use a fresh extracted bundle and a new private evidence directory.');
    process.exitCode = 1;
  }
}
