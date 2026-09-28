import { Button } from "@/components/ui/button";
import { SelectField, SelectItem, TextInput } from "@/components/ui/fields";
import type { DataRecipeStep, RecipeOperand } from "@/core/models";
import { useState } from "react";
import { RecipeNumberInput } from "./RecipeNumberInput";

const labels: Record<DataRecipeStep["type"], string> = {
  selectFields: "选择字段", filter: "筛选", renameField: "重命名", castField: "转换类型",
  deriveField: "计算字段", groupAggregate: "分组汇总", sort: "排序", limit: "限制行数",
};
const split = (value: string) => value.split(/[,，]/u).map((item) => item.trim()).filter(Boolean);
function FieldsInput({ label, fields, onChange }: { label: string; fields: string[]; onChange: (fields: string[]) => void }) {
  const [text, setText] = useState(fields.join(", "));
  return <label>{label}<TextInput required value={text} onChange={(event) => { setText(event.target.value); onChange(split(event.target.value)); }} /></label>;
}
function initial(type: DataRecipeStep["type"], id: string): DataRecipeStep {
  switch (type) {
    case "selectFields": return { id, type, fields: ["field"] };
    case "filter": return { id, type, field: "field", operator: "equals", value: "" };
    case "renameField": return { id, type, field: "field", newName: "renamed" };
    case "castField": return { id, type, field: "field", to: "number" };
    case "deriveField": return { id, type, field: "calculated", label: "计算结果", operator: "multiply", left: { kind: "field", field: "field" }, right: { kind: "literal", value: 1 } };
    case "groupAggregate": return { id, type, groupBy: ["category"], aggregations: [{ field: "amount", aggregation: "sum", as: "total", label: "合计" }] };
    case "sort": return { id, type, by: [{ field: "field", direction: "asc" }] };
    case "limit": return { id, type, count: 100 };
  }
}
function Operand({ label, value, onChange }: { label: string; value: RecipeOperand; onChange: (value: RecipeOperand) => void }) {
  return <label>{label}<SelectField value={value.kind} onValueChange={(selectedValue) => onChange(selectedValue === "field" ? { kind: "field", field: "field" } : { kind: "literal", value: 1 })}><SelectItem value="field">字段</SelectItem><SelectItem value="literal">常数</SelectItem></SelectField>
    {value.kind === "literal" ? <RecipeNumberInput label={label} value={value.value} onChange={(number) => onChange({ ...value, value: number })} />
      : <TextInput aria-label={label} required value={value.field} onChange={(event) => onChange({ ...value, field: event.target.value })} />}</label>;
}
export function RecipeStepsEditor({ steps, onChange }: { steps: DataRecipeStep[]; onChange: (steps: DataRecipeStep[]) => void }) {
  function replace(index: number, step: DataRecipeStep) { onChange(steps.map((item, i) => i === index ? step : item)); }
  return <div className="notebook-wide notebook-recipe-steps">
    <p>按顺序处理上游完整结果。字段使用结果表头中的名称；空值和无效类型沿用 DataRecipe 的严格校验。</p>
    {steps.map((step, index) => <div className="notebook-recipe-step" key={step.id}>
      <label>步骤 {index + 1}<SelectField aria-label={`步骤 ${index + 1} 类型`} value={step.type} onValueChange={(selectedValue) => replace(index, initial(selectedValue as DataRecipeStep["type"], step.id))}>{Object.entries(labels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectField></label>
      {"field" in step && <label>字段<TextInput required value={step.field} onChange={(event) => replace(index, { ...step, field: event.target.value })} /></label>}
      {step.type === "selectFields" && <FieldsInput key={`${step.id}:fields`} label="保留字段（逗号分隔）" fields={step.fields} onChange={(fields) => replace(index, { ...step, fields })} />}
      {step.type === "renameField" && <label>新字段名<TextInput required value={step.newName} onChange={(event) => replace(index, { ...step, newName: event.target.value })} /></label>}
      {step.type === "castField" && <label>目标类型<SelectField value={step.to} onValueChange={(selectedValue) => replace(index, { ...step, to: selectedValue as typeof step.to })}>{["number", "string", "date", "boolean"].map((value) => <SelectItem key={value}>{value}</SelectItem>)}</SelectField></label>}
      {step.type === "filter" && <>
        <label>条件<SelectField value={step.operator} onValueChange={(selectedValue) => replace(index, { ...step, operator: selectedValue as typeof step.operator })}>{[["equals", "等于"], ["notEquals", "不等于"], ["contains", "包含"], ["greaterThan", "大于"], ["greaterThanOrEqual", "大于等于"], ["lessThan", "小于"], ["lessThanOrEqual", "小于等于"]].map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectField></label>
        <label>值类型<SelectField value={typeof step.value} onValueChange={(selectedValue) => replace(index, { ...step, value: selectedValue === "number" ? 0 : selectedValue === "boolean" ? true : "" })}><SelectItem value="string">文本</SelectItem><SelectItem value="number">数字</SelectItem><SelectItem value="boolean">布尔</SelectItem></SelectField></label>
        <label>值{typeof step.value === "boolean" ? <SelectField value={String(step.value)} onValueChange={(selectedValue) => replace(index, { ...step, value: selectedValue === "true" })}><SelectItem>true</SelectItem><SelectItem>false</SelectItem></SelectField>
          : typeof step.value === "number" ? <RecipeNumberInput value={step.value} onChange={(value) => replace(index, { ...step, value })} />
            : <TextInput type="text" value={step.value} onChange={(event) => replace(index, { ...step, value: event.target.value })} />}</label>
      </>}
      {step.type === "deriveField" && <>
        <label>显示名称<TextInput required value={step.label} onChange={(event) => replace(index, { ...step, label: event.target.value })} /></label>
        <Operand label="左侧" value={step.left} onChange={(left) => replace(index, { ...step, left })} />
        <label>运算<SelectField value={step.operator} onValueChange={(selectedValue) => replace(index, { ...step, operator: selectedValue as typeof step.operator })}>{[["add", "+"], ["subtract", "−"], ["multiply", "×"], ["divide", "÷"]].map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectField></label>
        <Operand label="右侧" value={step.right} onChange={(right) => replace(index, { ...step, right })} />
      </>}
      {step.type === "groupAggregate" && <>
        <FieldsInput key={`${step.id}:groupBy`} label="分组字段（逗号分隔）" fields={step.groupBy} onChange={(groupBy) => replace(index, { ...step, groupBy })} />
        {step.aggregations.map((aggregation, a) => <div key={a} className="notebook-recipe-aggregate">
          <label>汇总字段<TextInput required value={aggregation.field} onChange={(event) => replace(index, { ...step, aggregations: step.aggregations.map((item, i) => i === a ? { ...item, field: event.target.value } : item) })} /></label>
          <label>汇总方式<SelectField value={aggregation.aggregation} onValueChange={(selectedValue) => replace(index, { ...step, aggregations: step.aggregations.map((item, i) => i === a ? { ...item, aggregation: selectedValue as typeof item.aggregation } : item) })}>{["sum", "average", "count", "countDistinct", "min", "max"].map((value) => <SelectItem key={value}>{value}</SelectItem>)}</SelectField></label>
          <label>输出字段<TextInput required value={aggregation.as} onChange={(event) => replace(index, { ...step, aggregations: step.aggregations.map((item, i) => i === a ? { ...item, as: event.target.value, label: event.target.value } : item) })} /></label>
          <Button variant="secondary" type="button" disabled={step.aggregations.length <= 1} onClick={() => replace(index, { ...step, aggregations: step.aggregations.filter((_, i) => i !== a) })}>移除指标</Button>
        </div>)}
        <Button variant="secondary" type="button" disabled={step.aggregations.length >= 20} onClick={() => replace(index, { ...step, aggregations: [...step.aggregations, { field: "amount", aggregation: "sum", as: `total_${step.aggregations.length + 1}`, label: "合计" }] })}>添加指标</Button>
      </>}
      {step.type === "sort" && step.by.map((sort, s) => <div key={s}><label>排序字段<TextInput required value={sort.field} onChange={(event) => replace(index, { ...step, by: step.by.map((item, i) => i === s ? { ...item, field: event.target.value } : item) })} /></label><label>顺序<SelectField value={sort.direction} onValueChange={(selectedValue) => replace(index, { ...step, by: step.by.map((item, i) => i === s ? { ...item, direction: selectedValue as "asc" | "desc" } : item) })}><SelectItem value="asc">升序</SelectItem><SelectItem value="desc">降序</SelectItem></SelectField></label></div>)}
      {step.type === "limit" && <label>行数<RecipeNumberInput min={1} max={10_000} integer value={step.count} onChange={(count) => replace(index, { ...step, count })} /></label>}
      {step.type === "sort" && <div><Button variant="secondary" type="button" disabled={step.by.length >= 10} onClick={() => replace(index, { ...step, by: [...step.by, { field: "field", direction: "asc" }] })}>添加排序字段</Button><Button variant="secondary" type="button" disabled={step.by.length <= 1} onClick={() => replace(index, { ...step, by: step.by.slice(0, -1) })}>移除末尾排序</Button></div>}
      <div><Button variant="secondary" type="button" disabled={index === 0} onClick={() => { const next = [...steps]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; onChange(next); }}>上移步骤</Button><Button variant="secondary" type="button" disabled={steps.length <= 1} onClick={() => onChange(steps.filter((_, i) => i !== index))}>删除步骤</Button></div>
    </div>)}
    <Button variant="secondary" type="button" disabled={steps.length >= 50} onClick={() => onChange([...steps, initial("filter", `step_${crypto.randomUUID().replaceAll("-", "")}`)])}>＋ 添加处理步骤</Button>
  </div>;
}
