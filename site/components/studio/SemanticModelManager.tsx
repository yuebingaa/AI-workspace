"use client";

import { SelectItem } from "@/components/ui/fields";
import { useId, useRef, useState } from "react";
import type { DataProduct, DataRow, DataSourceDefinition } from "@/core/models";
import type { StudioRole } from "@/core/permissions";
import { executeDataRecipe } from "@/core/data";
import { SEMANTIC_AGGREGATIONS, semanticAggregationLabels, semanticModelSchema, type SemanticModel } from "@/core/semantic/contracts";
import { compileSemanticQuery } from "@/core/semantic/model";
import { readableValidationError } from "@/core/schemas/errors";
import { semanticModelReferences } from "@/core/semantic/model-references";
import { SemanticModelDeletionImpact } from "./SemanticModelDeletionImpact";
import { semanticDraftErrors } from "./semantic-form";
import { Button } from "../ui/button";
import { Field, Input, Select, Textarea } from "../ui/field";
import { Dialog, DialogContent, DialogTitle, DialogDescription, ConfirmDialog } from "../ui/dialog";
import { SearchSelect } from "../ui/search-select";

function blankModel(sourceId: string): SemanticModel {
  return { id: "new_model", version: 1, name: "", description: "", sourceDatasetId: sourceId, dimensions: [], measures: [] };
}
interface ManagerProps {
  models: SemanticModel[]; notebooks: DataProduct["notebooks"]; sources: DataSourceDefinition[];
  rowsByDataSourceId: Record<string, DataRow[]>; initialModelId?: string; activeDataSourceId: string;
  role: StudioRole; busy: boolean; onSave(model: SemanticModel): void; onDelete(id: string): boolean; onClose(): void;
}

export function SemanticModelManager({ models, notebooks, sources, rowsByDataSourceId, initialModelId, activeDataSourceId, role, busy, onSave, onDelete, onClose }: ManagerProps) {
  const [editingId, setEditingId] = useState<string | null>(initialModelId ?? null);
  const [draft, setDraft] = useState<SemanticModel>(() => structuredClone(models.find(model => model.id === initialModelId)
    ?? blankModel(sources.find(source => source.id === activeDataSourceId)?.id ?? sources[0]?.id ?? "")));
  const [error, setError] = useState<string | null>(null), [attempted, setAttempted] = useState(false);
  const [pendingSource, setPendingSource] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ fields: Array<{ name: string; label: string }>; rows: DataRow[] } | null>(null);
  const formRef = useRef<HTMLFormElement>(null), previewRef = useRef<HTMLElement>(null);
  const prefix = useId(), deletionDescriptionId = useId();
  const references = editingId ? semanticModelReferences({ notebooks }, editingId) : [];
  const source = sources.find(source => source.id === draft.sourceDatasetId);
  const readOnly = role === "viewer" || busy;
  const errors = attempted ? semanticDraftErrors(draft, source, models) : {};
  const control = (path: string) => ({ id: prefix + "-" + path, "aria-invalid": errors[path] ? true : undefined,
    "aria-describedby": errors[path] ? prefix + "-" + path + "-error" : undefined });
  const fieldProps = (path: string, label: string) => ({ id: prefix + "-" + path, label, error: errors[path] });

  function update(next: SemanticModel) { setDraft(next); setError(null); setPreview(null); }
  function selectEditor(id: string | null) {
    const model = models.find(item => item.id === id);
    setEditingId(model?.id ?? null); setAttempted(false);
    update(structuredClone(model ?? blankModel(source?.id ?? sources[0]?.id ?? "")));
  }
  function changeSource(id: string) {
    if (readOnly || id === draft.sourceDatasetId) return;
    if (draft.dimensions.length || draft.measures.length) setPendingSource(id);
    else update({ ...draft, sourceDatasetId: id });
  }
  function addMember(kind: "dimensions" | "measures") {
    if (!source || readOnly) return;
    const field = kind === "dimensions"
      ? source.fields.find(field => !draft.dimensions.some(item => item.field === field.name))
      : source.fields.find(field => field.type === "number" && field.supportedAggregations.includes("sum"))
        ?? source.fields.find(field => field.supportedAggregations.some(value => value !== "none"));
    if (!field) { setError("没有可添加的字段。"); return; }
    const occupied = new Set([...draft.dimensions, ...draft.measures].map(item => item.key));
    let index = 1; const memberPrefix = kind === "dimensions" ? "dimension" : "measure";
    while (occupied.has(memberPrefix + "_" + index)) index++;
    const common = { key: memberPrefix + "_" + index, label: field.label, field: field.name, description: "" };
    if (kind === "dimensions") update({ ...draft, dimensions: [...draft.dimensions, common] });
    else {
      const aggregation = SEMANTIC_AGGREGATIONS.find(value => field.supportedAggregations.includes(value)
        && (!["sum", "average"].includes(value) || field.type === "number"));
      if (!aggregation) { setError("这个字段没有可用的计算方式。"); return; }
      update({ ...draft, measures: [...draft.measures, { ...common, label: field.label + semanticAggregationLabels[aggregation], aggregation }] });
    }
  }
  function validate() {
    setAttempted(true); setError(null);
    if (!Object.keys(semanticDraftErrors(draft, source, models)).length) return true;
    setPreview(null);
    requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
    return false;
  }
  function runPreview() {
    if (busy || !validate()) return;
    try {
      if (!source) throw new Error("请先选择数据表。");
      const rows = rowsByDataSourceId[source.id];
      if (!rows) throw new Error("当前会话没有可用数据，请重新导入后绑定模型。");
      const model = semanticModelSchema.parse(draft);
      const recipe = compileSemanticQuery(model, source, { dimensions: model.dimensions.slice(0, 5).map(item => item.key), measures: model.measures.map(item => item.key), limit: 10 });
      const result = executeDataRecipe(recipe, source, rows);
      if (!result.success) throw new Error(result.error);
      setPreview({ fields: result.fields, rows: result.rows }); setError(null);
      requestAnimationFrame(() => previewRef.current?.scrollIntoView({ block: "nearest" }));
    } catch (error) { setPreview(null); setError(readableValidationError(error)); }
  }
  function save() {
    if (readOnly || !validate()) return;
    try {
      const model = semanticModelSchema.parse({ ...draft, id: editingId ?? "semantic_" + crypto.randomUUID().replaceAll("-", "") });
      onSave(model); onClose();
    } catch (error) { setError(readableValidationError(error)); }
  }

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="semantic-dialog">
      <header className="semantic-header"><div><small>SEMANTIC MODELS</small><DialogTitle>语义模型管理</DialogTitle>
        <DialogDescription>定义一次业务口径，在后续 AI 分析中重复使用。</DialogDescription></div>
        <Button variant="ghost" size="icon" aria-label="关闭语义模型管理" onClick={onClose}>×</Button></header>
      <div className="semantic-manager-body">
        <aside aria-label="当前工作界面的语义模型">
          <div className="semantic-library-label">模型库 <span>{models.length}</span></div>
          <Button className="semantic-new" disabled={readOnly || !sources.length} onClick={() => selectEditor(null)}>＋ 新建模型</Button>
          {models.map(model => <Button variant="ghost" className={"semantic-library-item " + (editingId === model.id ? "active" : "")} aria-current={editingId === model.id ? "true" : undefined} key={model.id} onClick={() => selectEditor(model.id)}><b>{model.name}</b><small>{model.measures.length} 个指标 · v{model.version}</small></Button>)}
          {!models.length && <p>保存模型后，可以在侧边栏或 AI 上下文菜单中选择。</p>}
        </aside>
        <form ref={formRef} id="semantic-model-form" noValidate onSubmit={event => { event.preventDefault(); save(); }}>
          {editingId && <SemanticModelDeletionImpact references={references} id={deletionDescriptionId} />}
          {!sources.length && <p className="semantic-empty">还没有可用数据表，请先导入一份表格。</p>}
          <fieldset disabled={readOnly}>
            <section className="semantic-form-section">
              <div className="semantic-section-title"><span>01</span><div><h3>选择数据</h3><p>为模型命名，并指定它使用的数据表。</p></div></div>
              <div className="semantic-basics">
                <Field {...fieldProps("name", "模型名称")}><Input {...control("name")} required maxLength={100} value={draft.name} placeholder="例如：EDS 异常分析" onChange={event => update({ ...draft, name: event.target.value })} /></Field>
                <Field {...fieldProps("sourceDatasetId", "来源数据表")}><SearchSelect id={control("sourceDatasetId").id} label="来源数据表" value={draft.sourceDatasetId} options={sources.map(source => ({ value: source.id, label: source.name, detail: source.fields.length + " 个字段" }))} placeholder="选择数据表" disabled={readOnly || !sources.length} invalid={!!errors.sourceDatasetId} describedBy={control("sourceDatasetId")["aria-describedby"]} onValueChange={changeSource} /></Field>
              </div>
              <Field {...fieldProps("description", "业务说明（可选）")}><Textarea {...control("description")} aria-label="业务说明" rows={2} maxLength={500} value={draft.description} placeholder="说明这份数据的业务含义和适用范围" onChange={event => update({ ...draft, description: event.target.value })} /></Field>
            </section>
            <section className="semantic-form-section">
              <div className="semantic-section-title"><span>02</span><div><h3>定义业务口径</h3><p>维度决定按什么分类，指标决定计算什么。</p></div></div>
              {(["dimensions", "measures"] as const).map(kind => {
                const noun = kind === "dimensions" ? "维度" : "指标";
                return <section key={kind} className="semantic-members" aria-label={noun + "定义"}>
                  <div className="semantic-subheading"><div><h4>{noun} <span>{draft[kind].length}</span></h4><p>{kind === "dimensions" ? "可选 · 例如工站、产品、日期" : "至少一个 · 例如报警次数、累计停机秒数"}</p></div>
                    <Button {...control(kind)} size="small" disabled={!source || readOnly || draft[kind].length >= 20} onClick={() => addMember(kind)}>＋ 添加{noun}</Button></div>
                  {!draft[kind].length && <div className="semantic-empty">{kind === "dimensions" ? "添加维度，按类别查看数据；留空时计算整张表。" : "添加指标，为 AI 提供可以重复使用的计算口径。"}</div>}
                  {errors[kind] && <p className="ui-field-error" id={prefix + "-" + kind + "-error"} role="alert">{errors[kind]}</p>}
                  {draft[kind].map((item, index) => {
                    const path = kind + "." + index, label = noun + (index + 1);
                    const patch = (change: Partial<typeof item>) => update({ ...draft, [kind]: draft[kind].map((member, i) => i === index ? { ...member, ...change } : member) });
                    return <div className="semantic-member" key={kind + "_" + index}>
                      <div className="semantic-member-header"><span>{noun} {index + 1}</span><Button variant="ghost" size="icon" aria-label={"移除" + noun + " " + item.label} onClick={() => update({ ...draft, [kind]: draft[kind].filter((_, i) => i !== index) })}>×</Button></div>
                      <div className={"semantic-member-fields " + ("aggregation" in item ? "has-aggregation" : "")}>
                        <Field {...fieldProps(path + ".label", "业务名称")}><Input {...control(path + ".label")} aria-label={label + "名称"} required maxLength={100} value={item.label} onChange={event => patch({ label: event.target.value })} /></Field>
                        <Field {...fieldProps(path + ".field", "数据字段")}><SearchSelect id={control(path + ".field").id} label={label + "字段"} value={item.field} options={source?.fields.map(field => ({ value: field.name, label: field.label, detail: field.name + " · " + (field.type === "number" ? "数值" : field.type === "string" ? "文本" : field.type) })) ?? []} disabled={readOnly} invalid={!!errors[path + ".field"]} describedBy={control(path + ".field")["aria-describedby"]} onValueChange={field => patch({ field })} /></Field>
                        {"aggregation" in item && <Field {...fieldProps(path + ".aggregation", "计算方式")}><Select {...control(path + ".aggregation")} aria-label={label + "计算方式"} value={item.aggregation} onValueChange={value => patch({ aggregation: value as typeof item.aggregation })}>{SEMANTIC_AGGREGATIONS.map(value => <SelectItem key={value} value={value} disabled={!source?.fields.find(field => field.name === item.field)?.supportedAggregations.includes(value)}>{semanticAggregationLabels[value]}</SelectItem>)}</Select></Field>}
                      </div>
                      <div className="semantic-member-details">
                        <Field {...fieldProps(path + ".key", "引用标识")}><Input {...control(path + ".key")} aria-label={label + "标识"} required maxLength={120} value={item.key} onChange={event => patch({ key: event.target.value })} /></Field>
                        <Field {...fieldProps(path + ".description", "口径说明（可选）")}><Input {...control(path + ".description")} aria-label={label + "口径说明"} maxLength={300} value={item.description} placeholder={kind === "dimensions" ? "例如：按设备所属工站分类" : "例如：原始时长求和，单位为秒"} onChange={event => patch({ description: event.target.value })} /></Field>
                      </div>
                    </div>;
                  })}
                </section>;
              })}
            </section>
          </fieldset>
          <section ref={previewRef} className="semantic-form-section semantic-preview" aria-label="语义查询预览">
            <div className="semantic-section-title"><span>03</span><div><h3>检查计算结果</h3><p>保存前，先用当前数据确认口径。</p></div></div>
            {preview ? <><p className="semantic-preview-status" role="status">预览完成 · {preview.rows.length} 行 · {preview.fields.length} 列</p><div className="semantic-preview-table" tabIndex={0}><table><thead><tr>{preview.fields.map(field => <th key={field.name}>{field.label}</th>)}</tr></thead><tbody>{preview.rows.map((row, index) => <tr key={index}>{preview.fields.map(field => <td key={field.name}>{String(row[field.name] ?? "—")}</td>)}</tr>)}</tbody></table></div>{!preview.rows.length && <p>当前数据没有查询结果。</p>}</> : <div className="semantic-empty">定义好指标后，点击下方「预览计算」查看结果。</div>}
            <details className="semantic-note"><summary>预览范围与计算说明</summary><p>单表模型。预览使用前 5 个维度和全部指标，最多展示 10 行。空值不会自动填零，请先清洗数据。保存模型不会修改看板。</p></details>
          </section>
          {error && <p className="semantic-error" role="alert">{error}</p>}
        </form>
      </div>
      <footer className="semantic-footer"><div>{editingId && role !== "viewer" && <Button variant="danger" aria-describedby={deletionDescriptionId} disabled={busy || references.length > 0} onClick={() => { try { if (onDelete(editingId)) onClose(); } catch (error) { setError(readableValidationError(error)); } }}>删除模型</Button>}</div><div><Button variant="ghost" onClick={onClose}>取消</Button><Button disabled={!source || busy} onClick={runPreview}>预览计算</Button><Button variant="primary" type="submit" form="semantic-model-form" disabled={readOnly || !sources.length}>保存并选择</Button></div></footer>
      <ConfirmDialog open={pendingSource !== null} title="更换来源数据表？" description="当前草稿中的维度和指标需要重新定义。已保存的模型会保留，直到你再次保存。" confirmLabel="更换并重新定义" cancelLabel="保留当前数据表" onCancel={() => setPendingSource(null)} onConfirm={() => { if (pendingSource && !readOnly) { update({ ...draft, sourceDatasetId: pendingSource, dimensions: [], measures: [] }); setAttempted(false); } setPendingSource(null); }} />
    </DialogContent>
  </Dialog>;
}
