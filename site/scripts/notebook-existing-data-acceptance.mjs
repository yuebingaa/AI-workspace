// Uses the existing managed dev service, existing data, and an isolated browser.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { retailOrderRows } from '../fixtures/retail-orders.ts';

const base = 'http://127.0.0.1:3001';
if(!process.env.EXISTING_DATA_AGENT_RECORD&&process.env.EXISTING_DATA_LIVE!=='1') throw new Error('Set EXISTING_DATA_LIVE=1 for real model calls, or EXISTING_DATA_AGENT_RECORD to reuse an observed result.');
const directory = resolve('.runtime', process.env.EXISTING_DATA_RUN_DIR || `notebook-existing-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}`);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const context = await browser.newContext({ viewport: { width: 1536, height: 1000 } });
const page = await context.newPage();
const report = { directory, checks: [], errors: [], startedAt: new Date().toISOString() };
const createdIds = new Set();
const check = (name, detail) => { report.checks.push({name, detail}); console.log('PASS', name, JSON.stringify(detail ?? '')); };
async function notebookRun(button) {
  const pending = page.waitForResponse(r=>r.url()===base+'/api/notebook/run', {timeout:45000});
  await button.click(); const response=await pending; const body=await response.json();
  assert.equal(response.status(),200,JSON.stringify(body)); assert.equal(body.run.status,'success',JSON.stringify(body));
  if(body.snapshot) createdIds.add(body.snapshot.dataset.datasetId);
  await page.getByRole('button',{name:'停止运行',exact:true}).waitFor({state:'hidden'});
  return body;
}
page.on('pageerror', error => report.errors.push(error.message));
page.setDefaultTimeout(15000);
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
  // Legacy demo pages are hidden in the current UI. Attach the existing fixture
  // to this isolated browser's blank page; no user's project is changed.
  await page.getByRole('button',{name:'＋ 说明',exact:true}).click();
  await page.locator('.notebook-editor').getByRole('button',{name:'保存单元',exact:true}).click();
  await page.waitForFunction(()=>Boolean(localStorage.getItem('datacanvas-ai:studio:v1')));
  await page.evaluate(()=>{
    const key='datacanvas-ai:studio:v1', s=JSON.parse(localStorage.getItem(key));
    s.dataProduct.datasets.find(d=>d.id==='dataset_retail_orders').workspaceId='page_workspace_start';
    s.dataProduct.notebooks={}; localStorage.setItem(key,JSON.stringify(s));
  });
  await page.reload({waitUntil:'networkidle'});
  await page.getByRole('button', { name: '＋ Data', exact: true }).click();
  await page.locator('.notebook-editor').getByLabel('输出表名（SQL 中使用）', { exact: true }).fill('retail_orders');
  await page.locator('.notebook-editor').getByLabel('数据源', { exact: true }).selectOption('dataset_retail_orders');
  await page.locator('.notebook-editor').getByRole('button', { name: '保存单元', exact: true }).click();
  await page.waitForFunction(() => Boolean(localStorage.getItem('datacanvas-ai:studio:v1')));
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('datacanvas-ai:studio:v1')));
  await writeFile(resolve(directory, 'initial-state.json'), JSON.stringify(state, null, 2));
  await page.screenshot({ path: resolve(directory, 'initial.png') });
  const raw=await notebookRun(page.getByRole('button',{name:'▶ 全部运行',exact:true}));
  assert.equal(raw.run.cells[0].table.rows.length,retailOrderRows.length);
  const expected=Object.entries(retailOrderRows.reduce((acc,row)=>{acc[row.region]=(acc[row.region]??0)+row.revenue;return acc;},{})).sort((a,b)=>b[1]-a[1]);
  check('Existing retail fixture loaded through Notebook', {rows:retailOrderRows.length,expected});
  const instruction='使用当前已有的 retail_orders 数据，在 Notebook 中创建可重复运行的地区收入分析：保留 Data 单元，先用 SQL 选取全部记录的 region 和 revenue，再用一个 DataRecipe 单元按 region 汇总 revenue 为 total_revenue 并按收入降序排序，最后创建地区收入柱状图和简短说明。必须真实执行，说明数据覆盖范围，不生成销售预测，不修改正式看板。';
  let task;
  if(process.env.EXISTING_DATA_AGENT_RECORD){
    task=JSON.parse(await readFile(resolve(process.env.EXISTING_DATA_AGENT_RECORD),'utf8'));
    report.agentRecordReused=true;
  }else{
    const pending=page.waitForResponse(r=>r.url().includes('/api/ai/harness')&&r.request().method()==='POST',{timeout:110000});
    await page.locator('textarea').filter({visible:true}).fill(instruction);
    await page.getByRole('button',{name:'发送 AI 指令',exact:true}).click();
    console.log('LIVE_AGENT_STARTED',new Date().toISOString());
    const response=await pending;
    assert.equal(response.status(),200);
    await page.waitForFunction(instruction=>{
      const state=JSON.parse(localStorage.getItem('datacanvas-ai:studio:v1')??'null');
      return state?.harnessTasks.some(t=>t.instruction===instruction&&['completed','awaitingConfirmation','failed','blocked','cancelled'].includes(t.state));
    },instruction,{timeout:110000});
    task=await page.evaluate(instruction=>JSON.parse(localStorage.getItem('datacanvas-ai:studio:v1')).harnessTasks.find(t=>t.instruction===instruction),instruction);
  }
  await writeFile(resolve(directory,'agent-task.json'),JSON.stringify(task,null,2));
  report.agent={state:task?.state,error:task?.error,terminationCode:task?.terminationCode,model:task?.model,counters:task?.counters,usage:task?.usage,durationMs:task?.totalDurationMs,tools:task?.events.filter(e=>e.toolCall).map(e=>e.toolCall)};
  console.log('LIVE_AGENT_RESULT',JSON.stringify(report.agent));
  let cells;
  if(task?.notebookArtifact?.executionEvidence?.status==='success'&&!report.agentRecordReused){
    cells=task.notebookArtifact.cells;
    assert.ok(['data','sql','transform','chart'].every(kind=>cells.some(c=>c.kind===kind)));
    check('Real Agent generated and trial-ran SQL, DataRecipe and chart',report.agent);
    await page.getByRole('button',{name:'采用草稿',exact:true}).click();
  }else{
    report.agent.passed=false;
    const source=raw.run.cells[0].cellId;
    cells=[state.dataProduct.notebooks.page_workspace_start.cells.find(c=>c.id===source),
      {id:'sql_existing_retail',kind:'sql',title:'选取地区与收入',inputCellIds:[source],outputName:'retail_selected',sql:'SELECT region, revenue FROM retail_orders'},
      {id:'recipe_existing_retail',kind:'transform',title:'地区收入汇总',inputCellId:'sql_existing_retail',outputName:'retail_totals',steps:[
        {id:'group_region',type:'groupAggregate',groupBy:['region'],aggregations:[{field:'revenue',aggregation:'sum',as:'total_revenue',label:'地区收入'}]},
        {id:'sort_revenue',type:'sort',by:[{field:'total_revenue',direction:'desc'}]},
      ]},
      {id:'chart_existing_retail',kind:'chart',title:'已有零售数据地区收入',inputCellId:'recipe_existing_retail',chartType:'bar',categoryField:'region',valueFields:['total_revenue']},
    ];
    await page.evaluate(cells=>{const key='datacanvas-ai:studio:v1',s=JSON.parse(localStorage.getItem(key));s.dataProduct.notebooks.page_workspace_start={name:'已有数据手动验收',revision:2,cells};localStorage.setItem(key,JSON.stringify(s));},cells);
    await page.reload({waitUntil:'networkidle'});
    report.manualSetup='Test-authored Notebook; this is not an Agent-generated draft';
  }
  const result=await notebookRun(page.getByRole('button',{name:'▶ 全部运行',exact:true}));
  await writeFile(resolve(directory,'manual-run.json'),JSON.stringify(result,null,2));
  const chartCell=cells.find(c=>c.kind==='chart');
  const output=result.run.cells.find(c=>c.cellId===chartCell.id);
  assert.equal(output.table.rows.length,expected.length);
  for(const [region,amount] of expected){const row=output.table.rows.find(r=>r[chartCell.categoryField]===region);assert.ok(row);assert.ok(Math.abs(row[chartCell.valueFields[0]]-amount)<0.00001);}
  assert.equal(await page.locator('.recharts-bar-rectangle').count(),4);
  check('Manual run and rendered chart match an independent calculation',{total:expected.reduce((s,r)=>s+r[1],0),regions:expected.length});
  const chart=page.getByRole('article',{name:`图表单元 ${chartCell.title}`,exact:true});
  await chart.scrollIntoViewIfNeeded(); await page.screenshot({path:resolve(directory,'chart.png')});
  const recipeCell=cells.find(c=>c.kind==='transform');
  const recipe=page.getByRole('article',{name:`DataRecipe单元 ${recipeCell.title}`,exact:true});
  const saved=await notebookRun(recipe.getByRole('button',{name:'保存为 Dataset',exact:true}));
  assert.equal(saved.snapshot.rows.length,4); assert.equal(saved.snapshot.dataset.provenance.cellId,recipeCell.id);
  const fetched=await context.request.get(base+'/api/datasets/'+saved.snapshot.dataset.datasetId);
  assert.equal(fetched.status(),200);
  check('Saved Dataset can be read and records its source result',{rows:4});
  assert.match(await chart.innerText(),/已失效/);
  check('Rerunning the recipe invalidates the prior chart');
  await page.reload({waitUntil:'networkidle'});
  assert.ok(await page.getByRole('article',{name:`DataRecipe单元 ${recipeCell.title}`,exact:true}).count());
  const rerun=await notebookRun(page.getByRole('button',{name:'▶ 全部运行',exact:true}));
  assert.deepEqual(rerun.run.cells.find(c=>c.cellId===chartCell.id).table.rows,output.table.rows);
  check('Notebook definitions survive refresh and rerun produces the same result');
  const savedState=await page.evaluate(()=>JSON.parse(localStorage.getItem('datacanvas-ai:studio:v1')));
  assert.deepEqual(savedState.appSpec.pages,state.appSpec.pages);
  check('Notebook work and Dataset saving leave the dashboard pages unchanged');
  await chart.scrollIntoViewIfNeeded();
  const snapshot=await notebookRun(chart.getByRole('button',{name:'生成看板预览 ↗',exact:true}));
  assert.equal(snapshot.snapshot.rows.length,4);
  await page.getByRole('button',{name:'应用编辑',exact:true}).waitFor();
  await page.evaluate(()=>new Promise((resolve,reject)=>{
    let previous='',stable=0;const end=Date.now()+5000;
    const frame=()=>{const size=[...document.querySelectorAll('.recharts-wrapper')].map(n=>`${n.getBoundingClientRect().width}:${n.getBoundingClientRect().height}`).join(',');stable=size===previous?stable+1:0;previous=size;if(stable>=10)return resolve();if(Date.now()>end)return reject(new Error('Chart size did not settle'));requestAnimationFrame(frame);};frame();
  }));
  assert.equal(await page.locator('.recharts-bar-rectangle').count(),4);
  await page.mouse.move(10,10);
  await page.screenshot({path:resolve(directory,'dashboard-preview.png'),animations:'disabled'});
  check('Chart result creates a separate Dashboard preview');
  await page.getByRole('button',{name:'应用编辑',exact:true}).click();
  await page.getByRole('button',{name:'应用编辑',exact:true}).waitFor({state:'hidden'});
  const applied=await page.evaluate(()=>JSON.parse(localStorage.getItem('datacanvas-ai:studio:v1')));
  const testPage=applied.appSpec.pages.find(p=>p.id==='page_workspace_start');
  assert.equal(testPage.root.children.length,1);
  report.dashboardVisual=await page.locator('.recharts-bar-plot').evaluate(plot=>{
    const center=node=>{const r=node.getBoundingClientRect();return r.x+r.width/2;};
    const bars=[...plot.querySelectorAll('.recharts-bar-rectangle')].map(center);
    const labels=[...plot.querySelectorAll('.recharts-category-labels small')].map(center);
    const offsets=bars.map((x,i)=>Math.round((x-labels[i])*100)/100);
    return {barCount:bars.length,labelCount:labels.length,centerOffsetsPx:offsets,passed:bars.length===labels.length&&offsets.every(d=>Math.abs(d)<=4)};
  });
  console.log('DASHBOARD_VISUAL',JSON.stringify(report.dashboardVisual));
  await page.screenshot({path:resolve(directory,'dashboard-applied.png'),animations:'disabled'});
  check('Confirmed the preview in the isolated browser, adding one chart to its test dashboard');
  assert.deepEqual(report.errors,[]);
  report.manualPassed=true;
  report.passed=report.agent.passed!==false&&report.dashboardVisual.passed;
} catch (error) {
  report.failure = error.message;
  await writeFile(resolve(directory,'failure-state.json'),await page.evaluate(()=>localStorage.getItem('datacanvas-ai:studio:v1')??'null')).catch(()=>{});
  await page.screenshot({ path: resolve(directory, 'failure.png') }).catch(()=>{});
  process.exitCode = 1;
} finally {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  for(const id of createdIds) await context.request.delete(base+'/api/datasets/'+id);
  await browser.close();
  if(report.passed===false) process.exitCode=1;
  console.log('REPORT', JSON.stringify(report));
}
