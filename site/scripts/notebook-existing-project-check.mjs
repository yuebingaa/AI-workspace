// Read-only validation of an existing project table. Never changes AI consent.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base='http://127.0.0.1:3001';
if(!process.env.EXISTING_PROJECT_AGENT_RECORD&&process.env.EXISTING_DATA_LIVE!=='1') throw new Error('Set EXISTING_DATA_LIVE=1 for real model calls, or EXISTING_PROJECT_AGENT_RECORD to reuse an observed result.');
const directory=resolve('.runtime',`existing-project-check-${new Date().toISOString().replaceAll(/[:.]/gu,'-')}`);
await mkdir(directory,{recursive:true});
const report={startedAt:new Date().toISOString(),checks:[]};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function get(path,headers={}) { const r=await fetch(base+path,{headers}); assert.equal(r.status,200); return r.json(); }
try {
  const recent=await get('/api/projects');
  let selection;
  for(const project of recent.projects.filter(p=>!p.path.includes('synthetic-project'))){
    const headers={'x-agentcanvas-project':project.handle};
    const {datasets}=await get('/api/datasets',headers);
    const dataset=datasets.find(d=>d.source?.rowCount>0);
    if(dataset){selection={project,dataset,headers};break;}
  }
  assert.ok(selection,'No existing populated project was found');
  const {dataset,headers}=selection;
  const before=await get('/api/projects',headers);
  const stored=await get('/api/datasets/'+dataset.datasetId,headers);
  const profile=dataset.source.fields.map(f=>({field:f.name,type:f.type,missing:stored.rows.filter(row=>row[f.name]===null||row[f.name]===undefined).length}));
  report.dataset={rows:stored.rows.length,columns:profile.length,aiAccessPolicy:dataset.aiAccessPolicy,unnamedColumns:dataset.source.fields.filter(f=>f.label.startsWith('未命名字段')).length,allNullColumns:profile.filter(f=>f.missing===stored.rows.length).map(f=>f.field)};
  const cells=[
    {id:'source_form',kind:'data',title:'已有导入表',sourceDataSourceId:dataset.datasetId,outputName:'imported_form'},
    {id:'quality_sql',kind:'sql',title:'字段完整性核对',inputCellIds:['source_form'],outputName:'quality_summary',sql:'SELECT COUNT(*) AS row_count, '+profile.map((f,i)=>`SUM(CASE WHEN "${f.field}" IS NULL THEN 1 ELSE 0 END) AS missing_${i}`).join(', ')+' FROM imported_form'},
  ];
  const response=await fetch(base+'/api/notebook/run',{method:'POST',headers:{...headers,origin:base,'content-type':'application/json'},body:JSON.stringify({pageId:'page_workspace_start',document:{name:'已有数据质量验收',revision:0,cells},action:'run'})});
  const result=await response.json(); assert.equal(response.status,200);assert.equal(result.run.status,'success');
  const row=result.run.cells.at(-1).table.rows[0];assert.equal(row.row_count,stored.rows.length);
  profile.forEach((f,i)=>assert.equal(row['missing_'+i],f.missing));
  report.checks.push('All existing rows and per-column NULL counts match independent calculations');
  console.log('PROJECT_LOCAL_PASS',JSON.stringify(report.dataset));
  if(process.env.EXISTING_PROJECT_AGENT_RECORD){
    const recorded=JSON.parse(await readFile(resolve(process.env.EXISTING_PROJECT_AGENT_RECORD),'utf8'));
    report.agent={...recorded.agent,recordReused:true,passed:false};
  }
  else if(dataset.aiAccessPolicy==='pending') report.agent={skipped:'Existing data awaits user consent; policy was preserved'};
  else {
    const appSpec=structuredClone(before.manifest.state.appSpec);
    appSpec.dataSources=[dataset.source];
    const pageId='page_existing_data_quality_'+randomUUID().replaceAll('-','');
    appSpec.pages=[{id:pageId,title:'已有数据质量验证',route:'/existing-data-quality',root:{id:'root_existing_quality',type:'PageRoot',props:{},children:[]}}];
    appSpec.navigation=[{id:'nav_existing_quality',title:'已有数据质量验证',pageId}];
    const instruction='检查选定表的数据质量，仅报告行数、列数、未命名字段和全空字段，判断是否具备按地区分析销售收入所需的字段。如果缺少地区或收入字段，请明确说明不能完成该销售分析，不要猜测字段含义，不作人员评价，不修改数据或看板。保留当前敏感字段处理策略。';
    const response=await fetch(base+'/api/ai/harness',{method:'POST',headers:{...headers,origin:base,'content-type':'application/json'},body:JSON.stringify({idempotencyKey:'existing_quality_'+randomUUID(),conversation_id:'existing_quality_'+randomUUID(),instruction,pageId,dataSourceId:dataset.datasetId,appSpec,recipes:[dataset.recipe]}),signal:AbortSignal.timeout(110000)});
    const data=await response.json(); assert.equal(response.status,200,JSON.stringify(data.error));
    const task=data.task;
    report.agent={state:task.state,model:task.model,terminationCode:task.terminationCode,counters:task.counters,usage:task.usage,durationMs:task.totalDurationMs,tools:task.events.filter(e=>e.toolCall).map(e=>e.toolCall),noNotebook:!task.notebookArtifact,noChangeSet:!task.pendingChangeSet};
    console.log('PROJECT_AGENT_RESULT',JSON.stringify(report.agent));
    // Inspect the response locally; do not store personal data or original rows.
    report.agent.explicitMissingFields=/缺|不足|无法|不能|不具备|不适合/.test(task.resultMessage??'');
    report.agent.mentionsCorrectRowCount=new RegExp(`\\b${stored.rows.length}\\b`).test(task.resultMessage??'');
    report.agent.passed=['completed','blocked'].includes(task.state)
      && report.agent.tools.some(t=>t.status==='success'&&['inspectDataset','inspectFields'].includes(t.name))
      && report.agent.noChangeSet&&report.agent.noNotebook&&report.agent.explicitMissingFields;
    if(report.agent.passed) report.checks.push('Real Agent inspected existing data and identified missing sales fields without generating a misleading chart');
  }
  const after=await get('/api/projects',headers);
  const storedAfter=await get('/api/datasets/'+dataset.datasetId,headers);
  assert.equal(digest(before.manifest),digest(after.manifest));assert.equal(digest(stored),digest(storedAfter));
  report.checks.push('Source data, consent and project manifest are unchanged');
  report.localPassed=true;
  report.passed=report.agent?.passed!==false;
}catch(error){report.failure=error.message;process.exitCode=1;}
await writeFile(resolve(directory,'report.json'),JSON.stringify(report,null,2));
if(report.passed===false) process.exitCode=1;
console.log('PROJECT_REPORT',directory,JSON.stringify(report));
