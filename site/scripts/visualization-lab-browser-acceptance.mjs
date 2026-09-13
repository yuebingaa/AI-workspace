import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = 'http://127.0.0.1:3001';
const live = process.argv.includes('--live');
const directory = resolve('evidence', `visualization-lab-${live ? 'live-' : ''}${new Date().toISOString().replaceAll(/[:.]/gu, '-')}`);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, acceptDownloads: true });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const errors = [], checks = [], payloads = [];
page.on('pageerror', (error) => errors.push(error.message));
let mode = 'success', heldRoute;
function fixture(request) {
  const taskId = `harness_${request.idempotencyKey}`;
  const now = new Date().toISOString();
  const task = { id: taskId, idempotencyKey: request.idempotencyKey, instruction: request.instruction, pageId: request.pageId,
    role: 'editor', state: 'awaitingConfirmation', createdAt: now, updatedAt: now, events: [], counters: { loopCount: 2, modelCallCount: 2, toolCallCount: 1 },
    model: 'browser-replay-not-live', usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
    resultMessage: '浏览器回放：已生成折线图预览。', pendingChangeSet: { id: 'lab_preview', title: '月度收入趋势', status: 'ready',
      operations: [{ id: 'op_lab', label: '新增图表', description: '合成数据回放', pageId: request.pageId, type: 'addNode', parentId: 'visualization_lab_charts',
        node: { id: 'lab_chart', type: 'BarChart', props: { title: '月度收入趋势', subtitle: '2025 年 · 全部区域 · 人民币元', chartType: 'line', color: 'green',
          binding: { dataSourceId: 'dataset_retail_orders', field: 'revenue', aggregation: 'sum', groupBy: 'month', filters: [], sort: [{ field: 'month', direction: 'asc' }], limit: 12,
            format: { style: 'currency', currency: 'CNY', decimals: 0, notation: 'compact' } } } } }] } };
  const event = { id: `${taskId}:1`, sequence: 1, taskId, timestamp: now, type: 'completed', taskState: task.state, message: '回放完成' };
  return { task, body: `id: ${event.id}\nevent: completed\ndata: ${JSON.stringify({ event, task })}\n\n` };
}
if (!live) await page.route('**/api/ai/**', async (route) => {
  if (!route.request().url().endsWith('/visualization-lab/stream')) return route.abort();
  const request = route.request().postDataJSON(); payloads.push(request);
  assert.equal(route.request().headers()['x-agentcanvas-project'], undefined);
  assert.equal(request.conversation_id, undefined);
  assert.deepEqual(request.appSpec.pages[0].root.children[0].children, []);
  if (mode === 'hold') { heldRoute = route; return; }
  if (mode === 'error') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '测试回放：AI 服务暂时不可用。' } }) });
  await route.fulfill({ status: 200, contentType: 'text/event-stream', body: fixture(request).body });
});

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  assert.equal(await page.getByRole('link', { name: '可视化测试 ↗', exact: true }).getAttribute('href'), '/visualization-lab');
  const originalStorage = await page.evaluate(() => JSON.stringify(localStorage));
  await page.goto(`${base}/visualization-lab`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '开始 Agent 测试', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), '让数据成图，让能力可见。');
  await page.screenshot({ path: resolve(directory, '01-empty.png'), fullPage: true });
  checks.push('Navigation and empty state');

  if (live) {
    const status = await page.request.get(`${base}/api/settings/ai`);
    const config = await status.json();
    if (!config.configured) {
      checks.push('Live model unavailable: API not configured');
    } else {
      await page.getByRole('button', { name: '开始 Agent 测试', exact: true }).click();
      await page.getByRole('button', { name: '停止本轮测试', exact: true }).waitFor({ state: 'hidden', timeout: 110000 });
      const history = await page.evaluate(() => JSON.parse(sessionStorage.getItem('agentcanvas:visualization-lab:v1') || '[]'));
      await writeFile(resolve(directory, 'live-result.json'), JSON.stringify(history[0], null, 2));
      if (history[0]?.task?.state === 'awaitingConfirmation') {
        await page.getByText('已检测到图表渲染。请继续人工检查表达与可读性。', { exact: true }).waitFor();
      }
      const ruleChecks = await page.locator('[data-status]').evaluateAll((items) => items.map((item) => ({ status: item.getAttribute('data-status'), detail: item.textContent })));
      await writeFile(resolve(directory, 'live-checks.json'), JSON.stringify(ruleChecks, null, 2));
      await page.screenshot({ path: resolve(directory, '02-live-result.png'), fullPage: true });
      checks.push(`Live model receipt: ${history[0]?.task?.state ?? history[0]?.error}`);
    }
  } else {
    await page.getByRole('button', { name: '开始 Agent 测试', exact: true }).click();
    await page.getByText('已检测到图表渲染。请继续人工检查表达与可读性。', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-status=failed]').count(), 0);
    assert.equal(await page.locator('.recharts-line').count(), 1);
    assert.equal(await page.locator('.recharts-line-dot').count(), 12);
    await page.screenshot({ path: resolve(directory, '02-chart.png'), fullPage: true });
    checks.push('Replayed SSE response renders 12 real data points and passes independent checks');

    await page.getByLabel('人工评定', { exact: true }).selectOption('failed');
    await page.getByLabel('评定备注', { exact: true }).fill('检查标题和坐标单位。');
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByLabel('评定备注', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('评定备注', { exact: true }).inputValue(), '检查标题和坐标单位。');
    assert.equal(await page.getByLabel('人工评定', { exact: true }).inputValue(), 'failed');
    checks.push('Per-tab run history and independent human review survive refresh');

    const downloadReady = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载报告 ↓' }).click();
    const download = await downloadReady; const reportPath = resolve(directory, 'report.json'); await download.saveAs(reportPath);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.run.review, 'failed'); assert.equal(report.run.task.model, 'browser-replay-not-live');
    assert.ok(report.checks.some((check) => check.status === 'manual'));
    checks.push('JSON report preserves instructions, receipts, checks and human review');

    await page.getByRole('tab', { name: '示例数据', exact: true }).click();
    assert.equal(await page.locator('tbody tr').count(), 48);
    await page.getByRole('tab', { name: '生成配置', exact: true }).click();
    assert.match(await page.locator('pre').innerText(), /addNode/);
    await page.getByLabel('测试指令', { exact: true }).fill('请按区域绘制收入比较图。');
    assert.ok(await page.getByText('自定义指令 · 人工核对需求', { exact: true }).isVisible());
    checks.push('Data/config inspection and edited-prompt assessment boundary');

    mode = 'error'; await page.getByRole('button', { name: '开始 Agent 测试', exact: true }).click();
    await page.getByRole('button', { name: '停止本轮测试', exact: true }).waitFor({ state: 'hidden' });
    assert.match(await page.getByRole('alert').innerText(), /AI 服务暂时不可用/);
    mode = 'hold'; await page.getByRole('button', { name: '开始 Agent 测试', exact: true }).click();
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: '停止本轮测试', exact: true }).click();
    await page.getByRole('heading', { name: '测试已取消', exact: true }).waitFor();
    await heldRoute?.abort().catch(() => undefined);
    checks.push('Service failure and cancellation have separate honest outcomes');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: /月度收入趋势/ }).first().click();
    mode = 'success'; await page.getByRole('button', { name: '开始 Agent 测试', exact: true }).click();
    await page.getByText('已检测到图表渲染。请继续人工检查表达与可读性。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '窄屏', exact: true }).click();
    await page.screenshot({ path: resolve(directory, '03-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    checks.push('390px mobile layout and chart have no horizontal page overflow');
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), originalStorage);
    assert.equal(new Set(payloads.map((request) => request.idempotencyKey)).size, payloads.length);
    checks.push('Unique requests, isolated synthetic app and unchanged workbench storage');
  }
  assert.deepEqual(errors, []);
  await writeFile(resolve(directory, 'verification.json'), JSON.stringify({ live, checks, errors }, null, 2));
  console.log(JSON.stringify({ directory, live, checks, errors }, null, 2));
} finally { await browser.close(); }
