"use client";

import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { z } from "zod";
import { AiApiSettings } from "@/components/studio/AiApiSettings";
import { AppSpecRenderer } from "@/components/studio/AppSpecRenderer";
import { HarnessTrace, traceRows } from "@/components/studio/HarnessTrace";
import { requestHarnessTask } from "@/core/harness/client";
import { harnessTaskSummarySchema, MAX_HARNESS_INSTRUCTION_LENGTH, type HarnessTraceEvent } from "@/core/harness/contracts";
import { caseForInstruction, createLabRequest, LAB_PAGE_ID, visualizationCases } from "@/core/visualization-lab/cases";
import { evaluateLabTask } from "@/core/visualization-lab/evaluate";
import { demoLocalDataRuntime, retailOrderRows, retailOrdersDataSource } from "@/fixtures/retail-orders";
import styles from "./VisualizationLab.module.css";

const HISTORY_KEY = "agentcanvas:visualization-lab:v1";
const runSchema = z.object({ id: z.string(), caseId: z.string(), prompt: z.string().max(1000), startedAt: z.string(),
  durationMs: z.number().nonnegative(), task: harnessTaskSummarySchema.optional(), error: z.string().optional(),
  cancelled: z.boolean().optional(), review: z.enum(["pending", "passed", "failed"]).default("pending"), note: z.string().max(1000).default("") });
type LabRun = z.infer<typeof runSchema>;

class PreviewBoundary extends Component<{ children: ReactNode; onFailure: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFailure(); }
  render() { return this.state.failed ? <p role="alert">图表渲染失败，请查看生成配置。</p> : this.props.children; }
}

function ChartIcon({ variant = "line" }: { variant?: string }) {
  return <svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M5 5v22h23" stroke="currentColor" strokeWidth="1.5" />
    {variant.includes("bar") || variant.includes("auto") ? <path d="M10 22V13m7 9V8m7 14v-6" stroke="currentColor" strokeWidth="4" />
      : variant.includes("donut") || variant.includes("pie") ? <circle cx="18" cy="14" r="8" stroke="currentColor" strokeWidth="4" strokeDasharray="35 7" />
        : <path d="m8 21 6-7 5 3 7-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}</svg>;
}

function runLabel(run: LabRun) {
  if (run.cancelled) return "已取消";
  if (run.error) return "运行失败";
  if (!run.task) return "无回执";
  const result = evaluateLabTask(run.task, caseForInstruction(run.caseId, run.prompt));
  if (result.checks.some((check) => check.status === "failed")) return "检查未通过";
  return run.review === "passed" ? "人工通过" : run.review === "failed" ? "需改进" : "待看图评定";
}

export function VisualizationLab() {
  const [caseId, setCaseId] = useState(visualizationCases[0].id);
  const [instruction, setInstruction] = useState(visualizationCases[0].prompt);
  const [runs, setRuns] = useState<LabRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [storageNotice, setStorageNotice] = useState("");
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<HarnessTraceEvent[]>([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [tab, setTab] = useState<"chart" | "data" | "config">("chart");
  const [renderObservation, setRenderObservation] = useState<{ key: string; status: "rendered" | "failed" } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const activeRun = runs.find((run) => run.id === selectedId);
  const renderKey = `${activeRun?.id ?? "empty"}:${device}`;
  const renderState = renderObservation?.key === renderKey ? renderObservation.status : "pending";
  const currentTask = activeRun?.task;
  const currentCaseId = activeRun?.caseId;
  const currentPrompt = activeRun?.prompt;
  const evaluation = useMemo(() => currentTask ? evaluateLabTask(currentTask, caseForInstruction(currentCaseId!, currentPrompt!)) : null, [currentTask, currentCaseId, currentPrompt]);
  const selectedCase = visualizationCases.find((item) => item.id === caseId)!;
  const preset = caseForInstruction(caseId, instruction)?.expected;

  useEffect(() => {
    const hydration = window.setTimeout(() => {
      try {
        const saved = sessionStorage.getItem(HISTORY_KEY);
        if (saved && saved.length <= 2_000_000) {
          const parsed = z.array(runSchema).max(8).parse(JSON.parse(saved));
          setRuns(parsed); setSelectedId(parsed[0]?.id ?? null);
        }
      } catch { setStorageNotice("上次的测试记录无法读取，本轮仍可继续测试。"); }
      setLoaded(true);
    }, 0);
    return () => { window.clearTimeout(hydration); abortRef.current?.abort(); abortRef.current = null; };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const save = window.setTimeout(() => {
      try {
        const value = JSON.stringify(runs);
        if (value.length > 2_000_000) throw new Error("history limit");
        sessionStorage.setItem(HISTORY_KEY, value);
      } catch { setStorageNotice("本轮记录暂未保存到浏览器，请下载测试报告保留结果。"); }
    }, 0);
    return () => window.clearTimeout(save);
  }, [runs, loaded]);

  useEffect(() => {
    if (!evaluation?.chartIds.length || tab !== "chart") return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      const root = canvasRef.current;
      if (root?.querySelector('.data-binding-error')) { setRenderObservation({ key: renderKey, status: "failed" }); window.clearInterval(timer); return; }
      const charts = root?.querySelectorAll('[data-chart-type]');
      if (charts?.length === evaluation.chartIds.length && [...charts].every((chart) => chart.querySelector("svg.recharts-surface path"))) {
        setRenderObservation({ key: renderKey, status: "rendered" }); window.clearInterval(timer);
      } else if (++attempts >= 40) { setRenderObservation({ key: renderKey, status: "failed" }); window.clearInterval(timer); }
    }, 150);
    return () => window.clearInterval(timer);
  }, [evaluation, renderKey, tab]);

  function chooseCase(id: string) {
    const next = visualizationCases.find((item) => item.id === id)!;
    setCaseId(id); setInstruction(next.prompt);
  }
  function updateReview(values: Partial<Pick<LabRun, "review" | "note">>) {
    setRuns((previous) => previous.map((run) => run.id === selectedId ? { ...run, ...values } : run));
  }

  async function startRun() {
    if (abortRef.current || !instruction.trim()) return;
    const controller = new AbortController(); abortRef.current = controller;
    const initial: LabRun = { id: `viz_${crypto.randomUUID().replaceAll("-", "")}`, caseId, prompt: instruction.trim(),
      startedAt: new Date().toISOString(), durationMs: 0, review: "pending", note: "" };
    const started = performance.now();
    setRunning(true); setEvents([]); setStatusMessage("正在连接 Agent…"); setSelectedId(null); setTab("chart");
    let finished: LabRun;
    try {
      const result = await requestHarnessTask(createLabRequest(initial.prompt, initial.id), {
        stream: true, signal: controller.signal,
        // A dedicated server route fixes the dataset and isolates project, conversation and external tools.
        fetchImpl: (url, init) => {
          const headers = new Headers(init?.headers); headers.delete("x-agentcanvas-project");
          return fetch(url === "/api/ai/harness/stream" ? "/api/ai/visualization-lab/stream" : url, { ...init, headers });
        },
        onEvent: (event) => { if (!controller.signal.aborted) { setEvents((previous) => [...previous, event].slice(-256)); setStatusMessage(event.message); } },
      });
      if (controller.signal.aborted) throw new Error("cancelled");
      finished = { ...initial, task: result.task, durationMs: Math.round(performance.now() - started) };
    } catch (error) {
      finished = { ...initial, durationMs: Math.round(performance.now() - started), cancelled: controller.signal.aborted,
        error: controller.signal.aborted ? "本轮测试已取消。" : error instanceof Error ? error.message : "无法运行测试。" };
    }
    // Unmount cancellation must not write back into a departed view.
    if (abortRef.current !== controller) return;
    abortRef.current = null;
    setRuns((previous) => [finished, ...previous].slice(0, 8)); setSelectedId(finished.id); setRunning(false);
  }

  function downloadReport() {
    if (!activeRun) return;
    const report = { schemaVersion: "visualization-lab-v1", exportedAt: new Date().toISOString(),
      data: { source: "retail_orders synthetic fixture", rowCount: retailOrderRows.length }, run: activeRun,
      checks: evaluation?.checks ?? [], renderState: tab === "chart" ? renderState : "not-observed",
      note: "自动检查不评定视觉质量；用户评分单独记录。此报告不代表正式看板已应用。" };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `${activeRun.id}.json`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const failures = evaluation?.checks.filter((check) => check.status === "failed").length ?? 0;
  const ruleCount = evaluation?.checks.filter((check) => check.status !== "manual").length ?? 0;
  return <main className={styles.lab}>
    <header className={styles.header}>
      <Link href="/" className={styles.brand}><span><ChartIcon /></span>DataCanvas <b>Lab</b></Link>
      <nav aria-label="测试页导航"><a href="/" target="_blank" rel="noopener noreferrer">打开工作台 ↗</a><AiApiSettings /></nav>
    </header>
    <section className={styles.hero}>
      <div><span className={styles.eyebrow}>AGENT VISUALIZATION LAB</span><h1>让数据成图，让能力可见。</h1><p>给 Agent 一道题，查看它生成的图表、数据计算和执行记录。</p></div>
      <div className={styles.environment}><i />原生图表测试<span>合成数据 · 独立画布</span></div>
    </section>
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <section className={styles.panel}>
          <div className={styles.sectionHeading}><h2>选择测试题</h2><small>01 — 场景</small></div>
          <div className={styles.cases}>{visualizationCases.map((item) => <button key={item.id} type="button" disabled={running} aria-pressed={caseId === item.id}
            className={caseId === item.id ? styles.selectedCase : ""} onClick={() => chooseCase(item.id)}>
            <span className={styles.caseIcon}><ChartIcon variant={item.id} /></span><span><b>{item.name}</b><small>{item.description}</small></span><span aria-hidden="true">{caseId === item.id ? "●" : "›"}</span>
          </button>)}</div>
        </section>
        <section className={styles.panel}>
          <div className={styles.sectionHeading}><h2>测试指令</h2><small>02 — 目标</small></div>
          <label className={styles.srOnly} htmlFor="viz-instruction">测试指令</label>
          <textarea id="viz-instruction" value={instruction} maxLength={MAX_HARNESS_INSTRUCTION_LENGTH} disabled={running} onChange={(event) => setInstruction(event.target.value)} rows={6} />
          <div className={styles.promptMeta}><span>{preset ? "预置题 · 有标准答案" : "自定义指令 · 人工核对需求"}</span><span>{instruction.length}/1000</span></div>
          <button className={styles.runButton} type="button" disabled={!loaded || (!running && !instruction.trim())} onClick={running ? () => { abortRef.current?.abort(); setStatusMessage("正在取消…"); } : () => void startRun()}>{running ? "停止本轮测试" : "开始 Agent 测试"}<span aria-hidden="true">{running ? "■" : "↗"}</span></button>
          <p className={styles.hint}>点击后调用当前 API 模型。结果只在测试画布预览。</p>
        </section>
        <section className={styles.capabilities} aria-label="当前能力范围"><b>当前测试范围</b><p>柱状图 · 折线图 · 面积图 · 饼图 · 环形图</p><small>热力图、动态交互与 Vega-Lite：待接入。当前使用主 Agent 原生图表链路。</small></section>
      </aside>
      <div className={styles.mainColumn}>
        <section className={styles.previewPanel} aria-label="可视化测试结果">
          <div className={styles.previewHeading}><div><small>03 — 生成与观察</small><h2>{running ? "Agent 正在处理" : activeRun ? visualizationCases.find((item) => item.id === activeRun.caseId)?.name ?? "测试结果" : "图表预览"}</h2></div>
            <div className={styles.deviceButtons} aria-label="预览尺寸"><button type="button" aria-pressed={device === "desktop"} onClick={() => setDevice("desktop")}>桌面</button><button type="button" aria-pressed={device === "mobile"} onClick={() => setDevice("mobile")}>窄屏</button></div>
          </div>
          <div className={styles.tabs} role="tablist" aria-label="查看测试内容">{([['chart', '图表'], ['data', '示例数据'], ['config', '生成配置']] as const).map(([value, label]) => <button key={value} type="button" id={`viz-tab-${value}`} role="tab" aria-selected={tab === value} aria-controls="viz-panel" onClick={() => setTab(value)}>{label}</button>)}
            {activeRun && <button type="button" className={styles.export} onClick={downloadReport}>下载报告 ↓</button>}</div>
          <div id="viz-panel" role="tabpanel" aria-labelledby={`viz-tab-${tab}`} className={styles.resultContent}>
            {tab === "chart" && <>
              {running ? <div className={styles.empty} role="status"><span className={styles.pulse}><ChartIcon /></span><h3>正在把问题转成图表</h3><p>{statusMessage}</p></div>
                : evaluation?.preview ? <div ref={canvasRef} className={`${styles.canvas} ${device === "mobile" ? styles.mobileCanvas : ""}`}>
                  <PreviewBoundary key={activeRun!.id} onFailure={() => setRenderObservation({ key: renderKey, status: "failed" })}><AppSpecRenderer node={evaluation.preview.pages[0].root} context={{ dataSources: evaluation.preview.dataSources, dataRuntime: demoLocalDataRuntime, pageId: LAB_PAGE_ID, queryRevision: activeRun!.id }} /></PreviewBoundary>
                </div>
                  : <div className={styles.empty}><span className={styles.emptyIcon}><ChartIcon /></span><h3>{activeRun ? activeRun.cancelled ? "测试已取消" : "本轮没有生成图表" : "第一张图，从一个问题开始"}</h3><p>{activeRun?.error ?? activeRun?.task?.resultMessage ?? "左侧选择测试题，点击开始。这里将展示 Agent 实际生成的结果。"}</p>{!activeRun && <small>示例：{selectedCase.name} · {retailOrderRows.length} 行零售数据</small>}</div>}
              {evaluation?.preview && <p className={styles.renderNote} role="status">{renderState === "rendered" ? "已检测到图表渲染。请继续人工检查表达与可读性。" : renderState === "failed" ? "未能确认图表渲染，请检查预览和生成配置。" : "正在检查图表渲染…"}</p>}
            </>}
            {tab === "data" && <div><p className={styles.dataIntro}>固定的 {retailOrderRows.length} 行合成数据，覆盖 12 个月、4 个区域。所有测试使用同一份数据。</p><div className={styles.tableScroll}><table><thead><tr>{["month", "region", "category", "revenue"].map((field) => <th key={field}>{retailOrdersDataSource.fields.find((item) => item.name === field)?.label}<small>{field}</small></th>)}</tr></thead><tbody>{retailOrderRows.map((row) => <tr key={String(row.order_id)}><td>{String(row.month)}</td><td>{String(row.region)}</td><td>{String(row.category)}</td><td>{Number(row.revenue).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}</td></tr>)}</tbody></table></div><p className={styles.hint}>表格金额显示两位小数；运行与数值检查使用原始精度。</p></div>}
            {tab === "config" && <pre className={styles.config}>{activeRun?.task?.pendingChangeSet ? JSON.stringify(activeRun.task.pendingChangeSet, null, 2) : "运行测试后，这里显示 Agent 返回的图表配置。"}</pre>}
          </div>
        </section>
        {(running || activeRun) && <section className={styles.panel} aria-label="运行与检查">
          <div className={styles.sectionHeading}><h2>运行与检查</h2><small>{activeRun ? new Date(activeRun.startedAt).toLocaleString("zh-CN") : "执行中"}</small></div>
          {activeRun && <><div className={styles.metrics}><div><small>耗时</small><b>{(activeRun.durationMs / 1000).toFixed(1)} <em>s</em></b></div><div><small>模型调用</small><b>{activeRun.task?.counters.modelCallCount ?? "—"}</b></div><div><small>Token</small><b>{activeRun.task?.usage?.totalTokens.toLocaleString() ?? "—"}</b></div><div><small>规则检查</small><b>{ruleCount ? `${ruleCount - failures}/${ruleCount}` : "—"}</b></div></div>
            <p className={styles.modelLabel}>模型：{activeRun.task?.model ?? "未收到模型回执"} · {activeRun.review === "passed" ? "人工评定：通过" : activeRun.review === "failed" ? "人工评定：需改进" : runLabel(activeRun)}</p>
            <details className={styles.promptDetail}><summary>本轮完整指令</summary><p>{activeRun.prompt}</p></details>
            {evaluation && <ul className={styles.checks}>{evaluation.checks.map((check) => <li key={check.id} data-status={check.status}><span>{check.status === "passed" ? "✓" : check.status === "failed" ? "!" : "○"}</span><div><b>{check.label}</b><p>{check.detail}</p></div><small>{check.status === "passed" ? "通过" : check.status === "failed" ? "未通过" : "待人工"}</small></li>)}</ul>}
            {activeRun.error && <p role="alert" className={styles.error}>{activeRun.error}</p>}
            {activeRun.task && <HarnessTrace task={activeRun.task} />}
            {evaluation?.preview && <div className={styles.review}><label htmlFor="viz-review">人工评定</label><select id="viz-review" value={activeRun.review} onChange={(event) => updateReview({ review: event.target.value as LabRun["review"] })}><option value="pending">待评定</option><option value="passed">通过</option><option value="failed">需改进</option></select><label className={styles.srOnly} htmlFor="viz-note">评定备注</label><input id="viz-note" maxLength={1000} value={activeRun.note} placeholder="记录图表的问题或改进建议…" onChange={(event) => updateReview({ note: event.target.value })} /></div>}
          </>}
          {running && <ol className={styles.liveTrace}>{traceRows(events).map((event) => <li key={event.id}>{event.message}</li>)}</ol>}
        </section>}
        <section className={styles.panel} aria-label="最近测试记录"><div className={styles.sectionHeading}><h2>最近测试</h2><small>当前标签页保留最近 8 次</small></div>
          {storageNotice && <p role="status" className={styles.error}>{storageNotice}</p>}
          {!runs.length ? <p className={styles.historyEmpty}>运行一次测试后，可在这里回看和比较结果。</p> : <div className={styles.history}>{runs.map((run) => <button type="button" key={run.id} disabled={running} aria-pressed={selectedId === run.id} onClick={() => { setSelectedId(run.id); setTab("chart"); }}><span><b>{visualizationCases.find((item) => item.id === run.caseId)?.name ?? "自定义测试"}</b><small>{new Date(run.startedAt).toLocaleTimeString("zh-CN")} · {run.task?.model ?? "无模型回执"}</small></span><small>{runLabel(run)}</small><span>{(run.durationMs / 1000).toFixed(1)} s</span></button>)}</div>}
        </section>
      </div>
    </div>
    <footer className={styles.footer}>DataCanvas Lab · 同一数据，同一任务，观察每次生成的差异。</footer>
  </main>;
}
