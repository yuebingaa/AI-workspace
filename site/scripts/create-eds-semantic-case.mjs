// Scoped, persistent input/output semantic demo on managed 3001. Paid calls require --ai.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:3001', header = 'x-agentcanvas-project';
const phase = process.argv[2] ?? 'prepare';
assert.ok(['prepare', 'model', '--ai', '--explain', 'adopt', 'review', 'verify'].includes(phase));
const aiAttempt = Number(process.argv[3] ?? 1); assert.ok([1, 2, 3].includes(aiAttempt));
const sentMarker = phase === '--explain' ? 'paid-explanation-sent.json' : aiAttempt === 1 ? 'paid-request-sent.json' : `paid-request-sent-${aiAttempt}.json`;
const directory = resolve('.runtime/eds-semantic-case-20260923');
const projectPath = resolve('../outputs/semantic-input-output-2026-09-23/project');
const ownerPath = join(directory, 'owner.json'), attempt = Date.now();
await mkdir(directory, { recursive: true });
await mkdir(resolve(projectPath, '..'), { recursive: true });
const report = { phase, startedAt: attempt, passed: false, checks: [], screenshots: [], errors: [], runs: [] };
let owner = existsSync(ownerPath) ? JSON.parse(await readFile(ownerPath, 'utf8')) : {};
if (owner.projectPath) assert.equal(owner.projectPath, projectPath);
let handle = owner.handle, pageId, stage = 'open', aiAllowed = false;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN', reducedMotion: 'reduce' });
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
  if (url.origin !== base) return route.abort();
  if (!url.pathname.startsWith('/api/')) return route.continue();
  if (request.method() === 'GET') return route.continue();
  try {
    const body = request.headers()['content-type']?.includes('application/json') ? request.postDataJSON() : null;
    if (url.pathname === '/api/projects' && ['create', 'open'].includes(body?.action)) {
      assert.equal(resolve(body.path), projectPath);
      if (body.action === 'create') assert.ok(!handle && !existsSync(join(projectPath, 'agentcanvas.project.json')));
      const response = await route.fetch(); assert.equal(response.status(), 200, await response.text());
      handle = (await response.json()).handle; owner.handle = handle; owner.projectPath = projectPath;
      await writeFile(ownerPath, JSON.stringify(owner, null, 2)); return route.fulfill({ response });
    }
    assert.equal(request.headers()[header], handle, `Unscoped write: ${url.pathname}`); assert.ok(handle);
    assert.ok(['/api/projects', '/api/datasets', '/api/projects/files', '/api/notebook/run', '/api/ai/harness/stream', '/api/ai/conversations'].includes(url.pathname)
      || /^\/api\/datasets\/dataset_upload_[A-Za-z0-9_-]+\/consent$/u.test(url.pathname), `Unexpected write ${url.pathname}`);
    if (url.pathname === '/api/projects') assert.equal(body.action, 'save');
    if (url.pathname === '/api/ai/harness/stream') {
      assert.ok(aiAllowed, 'Paid request is not enabled');
      assert.equal(body.pageId, owner.analysisPageId); assert.equal(body.dataSourceId, owner.datasetId);
      assert.equal(body.semanticModel?.id, owner.modelId); assert.ok(body.notebookContext.sourceIds.includes(owner.datasetId));
      report.publicContext = { pageId: body.pageId, datasetId: body.dataSourceId, modelId: body.semanticModel.id, sourceIds: body.notebookContext.sourceIds };
      await writeFile(join(directory, sentMarker), JSON.stringify({ at: new Date().toISOString(), ...report.publicContext }), { flag: 'wx' });
    }
    return route.continue();
  } catch (error) { report.errors.push({ stage, message: error.message }); return route.abort(); }
});
let page = await context.newPage(); page.setDefaultTimeout(25000);
await page.addLocatorHandler(page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true }), async button => {
  if (await page.locator('[role="dialog"]:visible, dialog[open]').count() === 0) await button.click();
}, { noWaitAfter: true });
page.on('pageerror', error => report.errors.push({ stage, message: error.message }));
const dialog = () => page.getByRole('dialog', { name: 'Data Browser 数据浏览器', exact: true });
const editor = () => page.locator('.notebook-editor');
async function manifest() {
  const response = await context.request.get(`${base}/api/projects`, { headers: { [header]: handle } });
  assert.equal(response.status(), 200); const data = await response.json(); assert.equal(resolve(data.path), projectPath); return data.manifest;
}
async function saved(predicate = () => true) {
  const until = Date.now() + 30000; let last, stable;
  while (Date.now() < until) {
    const value = await manifest();
    if (predicate(value) && /已保存到本地项目|已打开本地项目|已确认上次修改保存/u.test(await page.locator('.top-actions').textContent())) {
      if (last !== value.stateRevision) { last = value.stateRevision; stable = Date.now(); }
      if (Date.now() - stable > 650) return value;
    } else last = undefined;
    await page.waitForTimeout(120);
  }
  throw new Error(`Save did not settle: ${stage}`);
}
async function menu() { await page.getByRole('button', { name: '打开工作区菜单', exact: true }).click(); return page.getByRole('navigation', { name: '工作区功能菜单', exact: true }); }
async function browse(category) {
  const nav = await menu(); await nav.getByRole('textbox', { name: '查找功能或工作界面' }).fill('Data Browser');
  await nav.getByRole('button', { name: '数据浏览器', exact: true }).click();
  if (category) await dialog().getByRole('navigation', { name: '数据资源分类' }).getByRole('button', { name: new RegExp(category, 'u') }).click();
}
async function notebook() {
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  const button = page.locator('.persistence-notice').getByRole('button', { name: '知道了', exact: true }); if (await button.isVisible()) await button.click();
}
async function shot(name, locator) {
  if (locator) await locator.scrollIntoViewIfNeeded(); await page.mouse.move(1, 1);
  const file = `${attempt}-${name}.png`; await page.screenshot({ path: join(directory, file), animations: 'disabled' });
  report.screenshots.push(file);
}
async function saveEditor() {
  await editor().getByRole('button', { name: '保存单元', exact: true }).click();
  const rename = page.getByRole('button', { name: '确认改名并保存', exact: true }); if (await rename.isVisible()) await rename.click();
  await editor().waitFor({ state: 'hidden' }); await saved();
}
async function add(kind, title, configure) {
  const m = await manifest(), existing = m.state.dataProduct.notebooks?.[pageId]?.cells.find(c => c.title === title);
  if (existing) return existing;
  const label = { text: '说明', python: 'Python', data: 'Data', semanticQuery: '语义查询', table: '表格', chart: '图表' }[kind];
  await page.getByRole('group', { name: '添加分析单元', exact: true }).getByRole('button', { name: `＋ ${label}`, exact: true }).click();
  await editor().getByLabel('单元名称', { exact: true }).fill(title); await configure(); await saveEditor();
  return (await manifest()).state.dataProduct.notebooks[pageId].cells.find(c => c.title === title);
}
async function switchPage(id) {
  const m = await manifest(), title = m.state.appSpec.pages.find(p => p.id === id).title;
  const nav = await menu(); await nav.getByRole('button', { name: new RegExp(`^${title}`, 'u') }).click(); pageId = id; await notebook(); await saved();
}
async function run(target) {
  const pending = page.waitForResponse(r => r.url() === `${base}/api/notebook/run`, { timeout: 60000 });
  await (target ? target.getByRole('button', { name: '▶ 运行', exact: true }) : page.getByRole('button', { name: '▶ 全部运行', exact: true })).click();
  const response = await pending, value = await response.json(); assert.equal(response.status(), 200, JSON.stringify(value));
  assert.equal(value.run.status, 'success', JSON.stringify(value)); report.runs.push(value.run);
  await page.getByRole('button', { name: '停止运行', exact: true }).waitFor({ state: 'hidden' }); return value.run;
}
async function adoptVerifiedTask(task, beforeAi) {
  assert.equal(task.state, 'awaitingConfirmation', `Actual task state: ${task.state}`);
  assert.equal(task.verification?.status, 'passed'); assert.equal(task.notebookArtifact?.executionEvidence?.status, 'success');
  const artifact = task.notebookArtifact;
  for (const original of beforeAi.cells) assert.deepEqual(artifact.cells.find(c => c.id === original.id), original);
  const additions = artifact.cells.filter(c => !beforeAi.cells.some(old => old.id === c.id));
  assert.deepEqual(additions.map(c => c.kind).sort(), ['semanticQuery', 'table']);
  const totalQuery = additions.find(c => c.kind === 'semanticQuery');
  assert.equal(totalQuery.modelId, owner.modelId); assert.equal(totalQuery.modelVersion, 1);
  assert.equal(totalQuery.inputCellId, owner.dataCellId); assert.deepEqual(totalQuery.dimensions, []);
  assert.deepEqual([...totalQuery.measures].sort(), ['alarm_count', 'alarm_minutes', 'alarm_seconds']);
  for (const name of ['editNotebookCells', 'runNotebookCells', 'submitNotebookDraft']) assert.ok(task.trace.some(e => e.type === 'tool_completed' && e.toolCall?.name === name), `Missing real tool success: ${name}`);
  await notebook(); const draft = page.getByRole('region', { name: 'AI Notebook 草稿', exact: true });
  await draft.getByRole('button', { name: '采用草稿', exact: true }).click(); await draft.waitFor({ state: 'hidden' });
  const persisted = await saved(m => m.state.dataProduct.notebooks[pageId].lastDraftId === artifact.id);
  owner.adoptedDraftId = artifact.id; owner.totalQueryId = totalQuery.id;
  owner.adoptedCells = persisted.state.dataProduct.notebooks[pageId].cells;
  owner.persistedModel = persisted.state.dataProduct.semanticLayer.models.find(m => m.id === owner.modelId);
  await notebook(); const ran = await run();
  checkTotals(ran); await shot('06-adopted-semantic-totals', page.getByRole('article', { name: '表格单元 异常总次数与累计时长', exact: true }));
}
function checkTotals(ran) {
  const total = ran.cells.find(c => c.cellId === owner.totalQueryId)?.table?.rows[0];
  assert.ok(total); assert.equal(total.alarm_count, 293);
  assert.ok(Math.abs(total.alarm_minutes - 231.7773166666667) < 1e-8);
  assert.ok(Math.abs(total.alarm_seconds - 13906.639) < 1e-7);
  report.checks.push({ aiSemanticTotals: total });
}
try {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  await browse('项目文件夹'); await dialog().getByLabel('项目文件夹绝对路径', { exact: true }).fill(projectPath);
  if (!handle) await dialog().getByLabel('项目名称', { exact: true }).fill('案例 01 · EDS input-output 语义分析');
  await dialog().getByRole('button', { name: handle ? '打开已有项目' : '新建本地项目', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' }); const initial = await saved(m => !!m.state);
  owner.preparationPageId ??= initial.state.appSpec.pages[0].id;
  pageId = owner.preparationPageId; await switchPage(pageId);
  if (phase === 'prepare') {
    stage = 'import originals';
    for (const name of ['input.xlsx', 'output.xlsx']) {
      if ((await manifest()).files.some(f => f.name === name)) continue;
      await page.locator('.notebook-heading').getByRole('button', { name: '导入数据', exact: true }).click();
      const upload = page.getByRole('dialog', { name: '导入本机表格', exact: true });
      await upload.locator('input[type="file"]').setInputFiles(resolve('../EDS', name));
      await upload.getByRole('button', { name: '导入 1 份文件', exact: true }).click(); await upload.waitFor({ state: 'hidden' }); await saved(m => m.files.some(f => f.name === name));
    }
    for (const file of (await manifest()).files) {
      const source = await readFile(resolve('../EDS', file.name)), stored = await readFile(join(projectPath, 'files', file.file));
      assert.deepEqual(stored, source); report.checks.push(`${file.name}: source bytes preserved; sha256 ${createHash('sha256').update(source).digest('hex')}`);
    }
    stage = 'preparation notebook';
    await add('text', '案例说明：input 到 output 的业务关系', async () => editor().getByLabel('分析说明').fill(
      '# 首个真实语义分析案例\ninput.xlsx 包含两张报警明细，output.xlsx 是固定 EDS 报表，不是两张投入/产出数量表。按工作日、班次、14 类异常完整文本、10 条线体及20个通道筛选，每条命中记录计1次，持续秒数除60得到分钟。\n\n本案例从 output 的隐藏辅助字段读取匹配口径，计算仍只读取 input 明细；output 缓存数值只作独立对照。保留原始重复报警，不擅自去重。\n\n本项目使用 2026-08-25 白班。后续语义模型绑定已保存的事实表快照，不会随原文件自动刷新；更换文件或日期时应重跑、保存新 Dataset 并显式重新绑定模型。累计报警时长不是设备净停机时长或停机率，重叠报警可能重复计时。'));
    await add('python', '01 从 input 提取 EDS 命中事实', async () => {
      await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('eds_facts');
      await editor().getByRole('textbox', { name: 'Python 原始文件', exact: true }).fill('input.xlsx\noutput.xlsx');
      await editor().getByRole('textbox', { name: 'Python', exact: true }).fill(await readFile(join(directory, 'facts-cell.py'), 'utf8'));
    });
    await add('python', '02 对照 output 全部报表统计值', async () => {
      await editor().getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('eds_check');
      await editor().getByRole('checkbox', { name: /eds_facts/u }).check();
      await editor().getByRole('textbox', { name: 'Python 原始文件', exact: true }).fill('output.xlsx');
      await editor().getByRole('textbox', { name: 'Python', exact: true }).fill(await readFile(join(directory, 'check-cell.py'), 'utf8'));
    });
    const ran = await run(), check = ran.cells.find(c => c.table?.rows?.[0]?.core_checked === 560);
    assert.ok(check, 'Missing reconciliation output'); assert.equal(check.table.rows[0].mismatches, 0);
    report.checks.push(check.table.rows[0]);
    await shot('01-reconciliation', page.getByRole('article', { name: 'Python单元 02 对照 output 全部报表统计值', exact: true }));
    owner.datasetId ??= (await manifest()).tables.find(t => t.descriptor.source.rowCount === 293)?.descriptor.datasetId;
    if (!owner.datasetId) {
      const cell = page.getByRole('article', { name: 'Python单元 01 从 input 提取 EDS 命中事实', exact: true });
      const pending = page.waitForResponse(r => r.url() === `${base}/api/notebook/run`, { timeout: 60000 });
      await cell.getByRole('button', { name: '保存为 Dataset', exact: true }).click();
      const response = await pending, result = await response.json(); assert.equal(response.status(), 200, JSON.stringify(result));
      const m = await saved(v => v.tables.some(t => t.descriptor.source.rowCount === 293));
      owner.datasetId = m.tables.find(t => t.descriptor.source.rowCount === 293).descriptor.datasetId;
    }
  }
  if (phase === 'model') {
    assert.ok(owner.datasetId);
    if (!owner.analysisPageId) {
      const nav = await menu(); await nav.getByRole('button', { name: '新建界面', exact: true }).click();
      await nav.getByLabel('工作界面名称').fill('AI 语义分析案例'); await nav.getByRole('button', { name: '创建', exact: true }).click();
      const m = await saved(v => v.state.appSpec.pages.length === 2); owner.analysisPageId = m.state.appSpec.pages.find(p => p.id !== owner.preparationPageId).id;
    }
    await switchPage(owner.analysisPageId); stage = 'use facts';
    const reference = (await manifest()).tables.find(t => t.descriptor.originalFileName.startsWith('output-'));
    if (reference?.descriptor.aiAccessPolicy === 'pending') {
      await browse('数据表');
      await dialog().getByRole('textbox', { name: '搜索数据表', exact: true }).fill(reference.descriptor.source.name);
      await dialog().getByRole('button', { name: '预览数据 / 字段', exact: true }).click(); await dialog().waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '排除敏感样本', exact: true }).click(); await saved();
      await page.getByRole('button', { name: '关闭数据源详情', exact: true }).click();
      report.checks.push('Reference output consent through visible UI: exclude-sensitive-samples in owned copy only; no raw sensitive sample authorization.');
    }
    const sourcePolicy = (await manifest()).tables.find(t => t.descriptor.datasetId === owner.datasetId).descriptor;
    if (sourcePolicy.aiAccessPolicy === 'pending' && sourcePolicy.sensitiveFields.length === 0) {
      const consent = await context.request.post(`${base}/api/datasets/${owner.datasetId}/consent`, {
        headers: { [header]: handle, origin: base }, data: { policy: 'exclude-sensitive-samples' },
      });
      assert.equal(consent.status(), 200, await consent.text());
      report.checks.push('Normal consent API: only this owned derived Dataset, exclude-sensitive-samples; originals unchanged.');
    }
    await browse('已保存结果'); const facts = (await manifest()).tables.find(t => t.descriptor.datasetId === owner.datasetId);
    await dialog().getByRole('textbox', { name: '搜索数据表', exact: true }).fill(facts.descriptor.source.name);
    await dialog().getByRole('button', { name: '预览数据 / 字段', exact: true }).click(); await dialog().waitFor({ state: 'hidden' });
    const policy = page.getByRole('button', { name: '排除敏感样本', exact: true });
    if (await policy.isVisible()) { await policy.click(); await saved(); }
    const details = page.getByRole('dialog', { name: /数据源|数据工作区/u });
    if (await details.isVisible()) await details.getByRole('button', { name: /关闭/u }).click();
    else { const close = page.getByRole('button', { name: '关闭数据源详情', exact: true }); if (await close.isVisible()) await close.click(); }
    await notebook();
    stage = 'create semantic model';
    if (!(await manifest()).state.dataProduct.semanticLayer?.models.length) {
      await page.getByRole('button', { name: '语义模型', exact: true }).click(); const manager = page.getByRole('dialog', { name: '语义模型管理', exact: true });
      await manager.getByLabel('模型名称', { exact: true }).fill('EDS input→output 异常分析口径');
      await manager.locator('.semantic-basics select').selectOption(owner.datasetId);
      await manager.getByLabel('业务说明', { exact: true }).fill('由 input.xlsx 两表按 output.xlsx 固定14类异常、10条线/20通道规则提取的293条报警事实。范围2026-08-25白班；一条报警一行。次数SUM(occurrences)，累计分钟SUM(duration_minutes)，秒SUM(duration_seconds)。line为报表显示线体。累计报警时长不是去重停机时长，不计算停机率。已对照output全部660统计格；来源是已保存快照，不自动刷新。');
      for (const [i, [field, key, label]] of [['work_date', 'report_date', '工作日'], ['shift', 'work_shift', '班次'], ['area', 'work_area', '区域'], ['line', 'line_name', '显示线体'], ['channel', 'channel_name', '通道'], ['issue', 'issue_name', '异常类型']].entries()) {
        await manager.getByRole('button', { name: '＋ 添加维度', exact: true }).click();
        await manager.getByLabel(`维度${i + 1}名称`, { exact: true }).fill(label); await manager.getByLabel(`维度${i + 1}标识`, { exact: true }).fill(key); await manager.getByLabel(`维度${i + 1}字段`, { exact: true }).selectOption(field);
      }
      for (const [i, [field, key, label]] of [['occurrences', 'alarm_count', '异常次数'], ['duration_minutes', 'alarm_minutes', '累计异常分钟'], ['duration_seconds', 'alarm_seconds', '累计异常秒数']].entries()) {
        await manager.getByRole('button', { name: '＋ 添加指标', exact: true }).click();
        await manager.getByLabel(`指标${i + 1}名称`, { exact: true }).fill(label); await manager.getByLabel(`指标${i + 1}标识`, { exact: true }).fill(key); await manager.getByLabel(`指标${i + 1}字段`, { exact: true }).selectOption(field);
        await manager.getByLabel(`指标${i + 1}计算方式`, { exact: true }).selectOption('sum');
      }
      await manager.getByRole('button', { name: '预览计算', exact: true }).click();
      if (await manager.locator('.semantic-error').count()) throw new Error(await manager.locator('.semantic-error').innerText());
      await manager.locator('.semantic-preview').waitFor();
      await shot('02-semantic-model', manager.locator('.semantic-preview'));
      await manager.getByRole('button', { name: '保存并选择', exact: true }).click(); await manager.waitFor({ state: 'hidden' }); await saved();
    }
    owner.modelId = (await manifest()).state.dataProduct.semanticLayer.models[0].id;
    await add('text', '案例使用说明', async () => editor().getByLabel('分析说明').fill('# input → 语义模型 → AI 分析\n本页仅使用已核对的 EDS 报警事实快照。原件、提取代码和660格对照过程保留在第一个工作界面的 Notebook。模型范围为2026-08-25白班，共293条命中报警，累计时长约231.7773分钟。\n\n语义模型统一异常次数、累计异常秒数/分钟的口径；下面的语义查询按显示线体汇总。累计时长可能含重叠报警，不等于设备净停机时间。没有命中报警的线体不出现在事实分组中，output 报表的零值在核对时补齐。\n\n可以向AI提问：请使用选中的语义模型核算总次数、总分钟，并说明次数最多的线体。不自行修改统计规则。'));
    const source = await add('data', 'EDS 命中事实快照', async () => { await editor().getByLabel('输出表名（SQL 中使用）').fill('semantic_facts'); await editor().getByLabel('数据源', { exact: true }).selectOption(owner.datasetId); });
    owner.dataCellId = source.id;
    const query = await add('semanticQuery', '固定口径：各线体异常次数与分钟', async () => {
      await editor().getByLabel('输出表名（SQL 中使用）').fill('semantic_by_line');
      await editor().getByLabel('维度标识（逗号分隔）').fill('line_name'); await editor().getByLabel('指标标识（逗号分隔）').fill('alarm_count, alarm_minutes');
    });
    await run();
    await add('table', '各线体语义结果表', async () => editor().getByLabel('展示字段（逗号分隔，使用结果中的字段名）').fill('line_name, alarm_count, alarm_minutes'));
    await add('chart', '各线体异常次数', async () => { await editor().getByLabel('分类字段').fill('line_name'); await editor().getByLabel('数值字段（逗号分隔，最多 4 个）').fill('alarm_count'); });
    const ran = await run(), rows = ran.cells.find(c => c.cellId === query.id).table.rows;
    assert.equal(rows.reduce((s, r) => s + r.alarm_count, 0), 293); assert.ok(Math.abs(rows.reduce((s, r) => s + r.alarm_minutes, 0) - 231.7773166666667) < 1e-8);
    report.checks.push({ semanticRows: rows }); await shot('03-semantic-chart', page.getByRole('article', { name: '图表单元 各线体异常次数', exact: true }));
  }
  if (['--ai', '--explain', 'adopt', 'review', 'verify'].includes(phase)) {
    await switchPage(owner.analysisPageId);
    if (phase === 'review') {
      stage = 'explicit independent review note';
      const reviewText = '# 案例复核备注（由建模测试流程补充，不是原始对话回答）\n实际语义查询的293次、231.7773分钟及10条线体汇总与原件对照一致。已保留真实AI草稿生成、采用及只读追问过程。\n\nAI回答中的“报警少，表现明显优于其他线体”不能由现有数据证明：缺少开机时长、产量和采集完整性，不能评价线体绩效。\n\n“每次短时/单次更长”只能改述为平均每条报警时长差异：A5FSL06约31.83秒，A5FSL01约59.24秒；不能代表每次报警，也不能等同一次故障的持续时间。\n\n累计报警时长可能重复计时，不是净停机时间。工具验证通过证明计算链路和运行证据有效，不代表逐句业务解释都正确。语义模型源为已保存快照，不自动刷新。';
      const previousNote = page.getByRole('article', { name: '说明单元 人工复核：AI 结论的适用边界', exact: true });
      if (await previousNote.count()) {
        await previousNote.getByRole('button', { name: '编辑', exact: true }).click();
        await editor().getByLabel('单元名称', { exact: true }).fill('案例复核：AI 结论的适用边界');
        await editor().getByLabel('分析说明').fill(reviewText); await saveEditor();
      }
      await add('text', '案例复核：AI 结论的适用边界', async () => editor().getByLabel('分析说明').fill(reviewText));
      const current = await saved();
      owner.adoptedCells = current.state.dataProduct.notebooks[pageId].cells;
      checkTotals(await run());
      await shot('09-independent-review-note', page.getByRole('article', { name: '说明单元 案例复核：AI 结论的适用边界', exact: true }));
    }
    if (phase === 'adopt') {
      stage = 'adopt existing verified paid task';
      const evidence = JSON.parse(await readFile(join(directory, 'real-public-task.json'), 'utf8'));
      const task = evidence.frames.findLast(f => f.task)?.task; assert.ok(task);
      const beforeAi = (await saved()).state.dataProduct.notebooks[pageId];
      assert.notEqual(beforeAi.lastDraftId, task.notebookArtifact?.id, 'Already adopted; use verify instead');
      await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
      await shot('04-real-ai-answer', page.locator('.conversation-turn').last());
      const trace = page.locator('.conversation-turn').last().locator('.harness-trace');
      if (await trace.getAttribute('open') === null) await trace.locator('summary').first().click();
      await shot('05-real-ai-trace', trace); await adoptVerifiedTask(task, beforeAi);
    }
    if (phase === '--ai' || phase === '--explain') {
      stage = 'real paid semantic task';
      assert.ok(!existsSync(join(directory, sentMarker)), 'This explicit attempt already sent; no automatic paid retry');
      if (phase === '--explain') checkTotals(await run());
      await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
      if (phase === '--ai' && aiAttempt > 1) { await page.getByRole('button', { name: '新建会话', exact: true }).click(); await saved(); }
      await page.locator('.semantic-context').getByText(/EDS input→output 异常分析口径/u).waitFor();
      const beforeAi = (await saved()).state.dataProduct.notebooks[pageId];
      await page.evaluate(() => {
        const original = window.fetch.bind(window); window.__semanticCase = { state: 'idle' };
        window.fetch = async (...args) => { let response; try { response = await original(...args); } catch (error) {
          if (String(args[0]).includes('/api/ai/harness/stream')) window.__semanticCase = { state: 'failed', error: String(error) }; throw error;
        } if (String(args[0]).includes('/api/ai/harness/stream')) {
          window.__semanticCase.state = 'running'; response.clone().text().then(body => { window.__semanticCase = { state: 'complete', body, httpStatus: response.status }; }).catch(error => { window.__semanticCase = { state: 'failed', error: String(error) }; });
        } return response; };
      });
      const instruction = phase === '--explain' ? '请根据现有结果给出一个分析结论。' : '这是 input.xlsx 到 output.xlsx 的 EDS 语义分析首例。保留当前 Notebook 所有已有单元不变。请使用本次选中的语义模型，新增一个 semanticQuery 单元：引用已有 Data 单元 semantic_facts，dimensions=[]，measures=[alarm_count,alarm_minutes,alarm_seconds]，输出 semantic_totals；再新增一个展示这三个指标的表格。不要改用 SQL/Python 或直接扫描原始Excel来替代语义查询。真实试运行后提交可采用草稿，并根据运行结果解释总次数和累计分钟，以及为什么累计报警时长不等于净停机时间。不要修改正式看板。';
      await page.getByRole('textbox', { name: 'AI 指令', exact: true }).fill(instruction);
      await writeFile(join(directory, `paid-request-intent-${attempt}.json`), JSON.stringify({ time: new Date().toISOString(), handle, instruction }), { flag: 'wx' });
      aiAllowed = true; await page.getByRole('button', { name: '发送 AI 指令', exact: true }).click();
      await page.waitForFunction(() => ['complete', 'failed'].includes(window.__semanticCase?.state), undefined, { timeout: 300000 }); aiAllowed = false;
      const observed = await page.evaluate(() => window.__semanticCase); assert.equal(observed.state, 'complete');
      await writeFile(join(directory, `response-${attempt}.json`), JSON.stringify(observed, null, 2));
      await page.getByRole('button', { name: '取消 AI 请求', exact: true }).waitFor({ state: 'hidden' }); await saved();
      assert.equal(observed.httpStatus, 200, observed.body);
      const frames = observed.body.split(/\r?\n\r?\n/u).flatMap(block => { const line = block.split(/\r?\n/u).find(v => v.startsWith('data: ')); return line ? [JSON.parse(line.slice(6))] : []; });
      const task = frames.findLast(f => f.task)?.task; report.task = task; assert.ok(task);
      await writeFile(join(directory, phase === '--explain' ? 'real-explanation-task.json' : 'real-public-task.json'), JSON.stringify({ frames }, null, 2));
      await page.getByRole('button', { name: '取消 AI 请求', exact: true }).waitFor({ state: 'hidden' }); await saved();
      await shot('04-real-ai-answer', page.locator('.conversation-turn').last());
      const trace = page.locator('.conversation-turn').last().locator('.harness-trace');
      if (await trace.count()) { if (await trace.getAttribute('open') === null) await trace.locator('summary').first().click(); await shot('05-real-ai-trace', trace); }
      if (phase === '--explain') {
        assert.equal(task.state, 'completed'); assert.equal(task.verification?.status, 'passed');
        assert.ok(!task.notebookArtifact);
        const tools = task.trace.filter(e => e.type === 'tool_completed').map(e => e.toolCall?.name);
        assert.ok(tools.includes('runNotebookCells')); assert.ok(tools.every(name => ['cellSearch', 'runNotebookCells'].includes(name)));
        const after = await saved(); assert.deepEqual(after.state.dataProduct.notebooks[pageId].cells, beforeAi.cells);
        assert.deepEqual(after.state.dataProduct.semanticLayer.models.find(m => m.id === owner.modelId), owner.persistedModel);
        owner.explanationTaskId = task.id; owner.explanationAnswer = task.resultMessage;
        report.checks.push({ readOnlyExplanation: task.resultMessage, tools });
      } else await adoptVerifiedTask(task, beforeAi);
    } else if (phase === 'verify') {
      stage = 'saved reopen'; const before = await saved(), ran = await run();
      assert.equal(before.state.dataProduct.semanticLayer.models[0].id, owner.modelId);
      assert.deepEqual(before.state.dataProduct.semanticLayer.models.find(m => m.id === owner.modelId), owner.persistedModel);
      assert.deepEqual(before.state.dataProduct.notebooks[pageId].cells, owner.adoptedCells);
      assert.equal(before.state.dataProduct.notebooks[pageId].lastDraftId, owner.adoptedDraftId);
      checkTotals(ran);
      report.checks.push({ reopened: true, cells: before.state.dataProduct.notebooks[pageId].cells.length, conversations: before.state.assistantSessions.items.length });
      await shot('07-reopened-case', page.getByRole('article', { name: '表格单元 异常总次数与累计时长', exact: true }));
      if (owner.explanationTaskId) {
        const turn = before.state.assistantSessions.items.flatMap(s => s.turns).find(t => t.taskId === owner.explanationTaskId);
        assert.ok(turn); assert.equal(turn.state, 'success'); assert.equal(turn.response, owner.explanationAnswer);
        await page.getByRole('tab', { name: 'AI 工作台', exact: true }).click();
        assert.ok((await page.locator('.conversation-turn').last().innerText()).includes('293'));
        await shot('08-reopened-ai-conclusion', page.locator('.conversation-turn').last());
        await shot('10-reopened-ai-totals', page.locator('.conversation-turn').last().getByText('总体情况', { exact: true }));
        report.checks.push('Exact successful answer persisted under the same task ID and conversation after fresh-context reopen.');
      }
    }
  }
  await saved(); assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.failure = { stage, name: error.name, message: error.message }; await shot('failure').catch(() => {}); process.exitCode = 1; }
finally {
  owner.projectPath = projectPath; owner.handle = handle; await writeFile(ownerPath, JSON.stringify(owner, null, 2));
  await writeFile(join(directory, `report-${phase.replace('--','')}-${attempt}.json`), JSON.stringify(report, null, 2));
  await browser.close(); console.log(JSON.stringify({ passed: report.passed, phase, failure: report.failure, checks: report.checks, screenshots: report.screenshots, directory: relative(process.cwd(), directory) }, null, 2));
}
