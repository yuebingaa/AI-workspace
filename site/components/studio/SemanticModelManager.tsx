"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DataRow, DataSourceDefinition } from "@/core/models";
import type { StudioRole } from "@/core/permissions";
import { executeDataRecipe } from "@/core/data";
import { SEMANTIC_AGGREGATIONS, semanticAggregationLabels, semanticModelSchema, type SemanticModel } from "@/core/semantic/contracts";
import { compileSemanticQuery } from "@/core/semantic/model";
import { readableValidationError } from "@/core/schemas/errors";

export function SemanticModelSection({ models, selectedId, canCreate, busy, onManage, onSelect }: {
  models: SemanticModel[]; selectedId?: string; canCreate: boolean; busy: boolean;
  onManage(id?: string): void; onSelect(id: string | null): void;
}) {
  return <section className="semantic-section" aria-label="语义模型">
    <div className="section-label data-source-section-head"><span>语义模型</span><button type="button" disabled={!canCreate || busy} onClick={() => onManage()}>＋ 创建</button></div>
    <p className="semantic-hint">统一维度含义和指标计算口径</p>
    {models.length ? <div className="semantic-model-list">
      {models.map((model) => <div className={`semantic-model-row${selectedId === model.id ? " selected" : ""}`} key={model.id}>
        <button type="button" disabled={busy} aria-pressed={selectedId === model.id} onClick={() => onSelect(selectedId === model.id ? null : model.id)}>
          <span aria-hidden="true">◇</span><span><b>{model.name}</b><small>{model.dimensions.length} 个维度 · {model.measures.length} 个指标 · v{model.version}</small></span>
        </button>
        <button type="button" aria-label={`管理语义模型 ${model.name}`} title="查看、编辑或删除" disabled={busy} onClick={() => onManage(model.id)}>···</button>
      </div>)}
    </div> : <p className="semantic-empty">暂无模型。导入表格后，可创建自己的分析口径。</p>}
  </section>;
}

function blankModel(sourceId: string): SemanticModel {
  // The final ID is assigned on explicit Save, never while rendering.
  return { id: "new_model", version: 1, name: "", description: "", sourceDatasetId: sourceId, dimensions: [], measures: [] };
}

interface ManagerProps {
  models: SemanticModel[];
  sources: DataSourceDefinition[];
  rowsByDataSourceId: Record<string, DataRow[]>;
  initialModelId?: string;
  activeDataSourceId: string;
  role: StudioRole;
  busy: boolean;
  onSave(model: SemanticModel): void;
  onDelete(id: string): boolean;
  onClose(): void;
}

export function SemanticModelManager({ models, sources, rowsByDataSourceId, initialModelId, activeDataSourceId, role, busy, onSave, onDelete, onClose }: ManagerProps) {
  const [editingId, setEditingId] = useState<string | null>(initialModelId ?? null);
  const [draft, setDraft] = useState<SemanticModel>(() => structuredClone(models.find((model) => model.id === initialModelId)
    ?? blankModel(sources.find((source) => source.id === activeDataSourceId)?.id ?? sources[0]?.id ?? "")));
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ fields: Array<{ name: string; label: string }>; rows: DataRow[] } | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const source = sources.find((source) => source.id === draft.sourceDatasetId);
  const readOnly = role === "viewer" || busy;
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { dialog?.close(); };
  }, []);

  function update(next: SemanticModel) { setDraft(next); setError(null); setPreview(null); }
  function selectEditor(id: string | null) {
    const model = models.find((item) => item.id === id);
    setEditingId(model?.id ?? null);
    update(structuredClone(model ?? blankModel(source?.id ?? sources[0]?.id ?? "")));
  }
  function addMember(kind: "dimensions" | "measures") {
    if (!source || readOnly) return;
    const field = kind === "dimensions"
      ? source.fields.find((field) => !draft.dimensions.some((item) => item.field === field.name))
      : source.fields.find((field) => field.supportedAggregations.some((value) => value !== "none"));
    if (!field) { setError("没有可添加的字段。"); return; }
    const occupied = new Set([...draft.dimensions, ...draft.measures].map((item) => item.key));
    let index = 1; const prefix = kind === "dimensions" ? "dimension" : "measure";
    while (occupied.has(`${prefix}_${index}`)) index++;
    const common = { key: `${prefix}_${index}`, label: field.label, field: field.name, description: "" };
    if (kind === "dimensions") update({ ...draft, dimensions: [...draft.dimensions, common] });
    else {
      const aggregation = SEMANTIC_AGGREGATIONS.find((value) => field.supportedAggregations.includes(value))!;
      update({ ...draft, measures: [...draft.measures, { ...common, label: `${field.label}${semanticAggregationLabels[aggregation]}`, aggregation }] });
    }
  }
  function runPreview() {
    try {
      if (!source) throw new Error("请先选择数据表。");
      const rows = rowsByDataSourceId[source.id];
      if (!rows) throw new Error("当前会话没有可用数据，数据可能已过期，请重新导入后绑定模型。");
      const model = semanticModelSchema.parse(draft);
      const recipe = compileSemanticQuery(model, source, { dimensions: model.dimensions.slice(0, 5).map((item) => item.key), measures: model.measures.map((item) => item.key), limit: 10 });
      const result = executeDataRecipe(recipe, source, rows);
      if (!result.success) throw new Error(result.error);
      setPreview({ fields: result.fields, rows: result.rows }); setError(null);
    } catch (error) { setPreview(null); setError(readableValidationError(error)); }
  }
  function save() {
    try {
      if (readOnly) throw new Error("当前不能修改语义模型。");
      const model = semanticModelSchema.parse({ ...draft, id: editingId ?? `semantic_${crypto.randomUUID().replaceAll("-", "")}` });
      onSave(model); onClose();
    } catch (error) { setError(readableValidationError(error)); }
  }

  return createPortal(<dialog ref={dialogRef} className="semantic-dialog" aria-labelledby="semantic-dialog-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header><div><small>SEMANTIC MODELS</small><h2 id="semantic-dialog-title">语义模型管理</h2><p>为数据定义业务名称、维度和可复用指标</p></div><button type="button" aria-label="关闭语义模型管理" onClick={onClose}>×</button></header>
    <div className="semantic-manager-body">
      <aside aria-label="当前工作界面的语义模型">
        <button type="button" className={!editingId ? "active" : ""} disabled={readOnly || !sources.length} onClick={() => selectEditor(null)}>＋ 新建模型</button>
        {models.map((model) => <button type="button" className={editingId === model.id ? "active" : ""} key={model.id} onClick={() => selectEditor(model.id)}><b>{model.name}</b><small>v{model.version} · {model.measures.length} 个指标</small></button>)}
        {!models.length && <p>创建后可在侧边栏或 AI 上下文菜单中选择。</p>}
      </aside>
      <form id="semantic-model-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <fieldset disabled={readOnly}>
          <div className="semantic-basics">
            <label>模型名称<input required maxLength={100} value={draft.name} placeholder="例如：销售分析口径" onChange={(event) => update({ ...draft, name: event.target.value })} /></label>
            <label>来源数据表<select required value={draft.sourceDatasetId} onChange={(event) => {
              if ((draft.dimensions.length || draft.measures.length) && !window.confirm("更换数据表会清空当前草稿的维度和指标，需要重新定义。继续吗？已保存模型在再次保存前不会改变。")) return;
              update({ ...draft, sourceDatasetId: event.target.value, dimensions: [], measures: [] });
            }}>
              <option value="" disabled>请选择数据表</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
            </select></label>
          </div>
          <label>业务说明<textarea rows={2} maxLength={500} value={draft.description} placeholder="描述这份数据和指标的适用范围；请勿填写密钥或敏感原始数据" onChange={(event) => update({ ...draft, description: event.target.value })} /></label>
          {(["dimensions", "measures"] as const).map((kind) => <section key={kind} className="semantic-members" aria-label={kind === "dimensions" ? "维度定义" : "指标定义"}>
            <div className="semantic-subheading"><h3>{kind === "dimensions" ? "维度" : "指标"}<small>{kind === "dimensions" ? "按什么分类观察" : "使用固定计算方式，至少定义一个"}</small></h3><button type="button" disabled={!source || draft[kind].length >= 20} onClick={() => addMember(kind)}>＋ 添加{kind === "dimensions" ? "维度" : "指标"}</button></div>
            {draft[kind].map((item, index) => <div className="semantic-member" key={`${kind}_${index}`}>
              <label>业务名称<input aria-label={`${kind === "dimensions" ? "维度" : "指标"}${index + 1}名称`} required maxLength={100} value={item.label} onChange={(event) => update({ ...draft, [kind]: draft[kind].map((member, i) => i === index ? { ...member, label: event.target.value } : member) })} /></label>
              <label>标识<input aria-label={`${kind === "dimensions" ? "维度" : "指标"}${index + 1}标识`} required pattern="[A-Za-z][A-Za-z0-9_]*" maxLength={120} value={item.key} onChange={(event) => update({ ...draft, [kind]: draft[kind].map((member, i) => i === index ? { ...member, key: event.target.value } : member) })} /></label>
              <label>数据字段<select aria-label={`${kind === "dimensions" ? "维度" : "指标"}${index + 1}字段`} value={item.field} onChange={(event) => update({ ...draft, [kind]: draft[kind].map((member, i) => i === index ? { ...member, field: event.target.value } : member) })}>
                {!source?.fields.some((field) => field.name === item.field) && <option value={item.field}>字段已失效：{item.field}</option>}
                {source?.fields.map((field) => <option key={field.name} value={field.name}>{field.label} · {field.name}</option>)}
              </select></label>
              {"aggregation" in item && <label>计算方式<select aria-label={`指标${index + 1}计算方式`} value={item.aggregation} onChange={(event) => update({ ...draft, measures: draft.measures.map((member, i) => i === index ? { ...member, aggregation: event.target.value as typeof item.aggregation } : member) })}>
                {SEMANTIC_AGGREGATIONS.map((value) => <option key={value} value={value} disabled={!source?.fields.find((field) => field.name === item.field)?.supportedAggregations.includes(value)}>{semanticAggregationLabels[value]}</option>)}
              </select></label>}
              <button type="button" className="semantic-remove" aria-label={`移除${kind === "dimensions" ? "维度" : "指标"} ${item.label}`} onClick={() => update({ ...draft, [kind]: draft[kind].filter((_, i) => i !== index) })}>×</button>
              <label className="semantic-member-description">口径说明<input maxLength={300} value={item.description} placeholder={kind === "dimensions" ? "例如：按订单所属地区分类" : "例如：原始金额求和；空值须先清洗"} onChange={(event) => update({ ...draft, [kind]: draft[kind].map((member, i) => i === index ? { ...member, description: event.target.value } : member) })} /></label>
            </div>)}
          </section>)}
        </fieldset>
        <p className="semantic-note">单表模型，不执行 SQL 或任意代码。预览最多使用前 5 个维度、返回 10 行；空值遵循现有 DataRecipe 严格校验，不自动填零。保存模型不会修改看板。</p>
        {error && <p className="semantic-error" role="alert">{error}</p>}
        {preview && <section className="semantic-preview" aria-label="语义查询预览"><b>计算预览 · {preview.rows.length} 行</b><div><table><thead><tr>{preview.fields.map((field) => <th key={field.name}>{field.label}</th>)}</tr></thead><tbody>{preview.rows.map((row, i) => <tr key={i}>{preview.fields.map((field) => <td key={field.name}>{String(row[field.name] ?? "—")}</td>)}</tr>)}</tbody></table></div>{!preview.rows.length && <p>当前数据没有查询结果。</p>}</section>}
      </form>
    </div>
    <footer><div>{editingId && role !== "viewer" && <button type="button" className="semantic-delete" disabled={busy} onClick={() => { try { if (onDelete(editingId)) onClose(); } catch (error) { setError(readableValidationError(error)); } }}>删除模型</button>}</div><div><button type="button" onClick={onClose}>取消</button><button type="button" disabled={!source || busy} onClick={runPreview}>预览计算</button><button type="submit" form="semantic-model-form" className="semantic-save" disabled={readOnly || !sources.length}>保存并选择</button></div></footer>
  </dialog>, document.body);
}
