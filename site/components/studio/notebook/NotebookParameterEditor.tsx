import { Button } from "@/components/ui/button";
import { SelectField, SelectItem, TextArea, TextInput } from "@/components/ui/fields";
import { useState, type FormEvent } from "react";
import { notebookCellSchema, type NotebookCell } from "@/core/notebook/definition";
import { notebookParameterSchema, type NotebookParameter } from "@/core/notebook/parameter";

type ParameterCell = Extract<NotebookCell, { kind: "parameter" }>;
const typeLabels: Record<NotebookParameter["type"], string> = { text: "文本", number: "数值", date: "日期", select: "单选" };

// Keep incomplete form strings local. Only a successful parse can update the
// document; an empty number must never silently become zero.
export function parseNotebookParameterInput(type: NotebookParameter["type"], value: string, options: readonly string[]): NotebookParameter {
  if (type === "number" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value.trim())) {
    throw new Error("请输入有效数值；空值、NaN 和 Infinity 不能保存。");
  }
  const candidate = type === "number" ? { type, value: Number(value) }
    : type === "select" ? { type, value, options: [...options] }
      : { type, value };
  const result = notebookParameterSchema.safeParse(candidate);
  if (result.success) return result.data;
  const message = type === "text" ? "文本最多 2,000 个字符；空格、换行和空文本原样保留。"
    : type === "number" ? "数值须有限且介于 ±9,007,199,254,740,991；精确大整数或小数请用文本参数。"
      : type === "date" ? "请输入有效日期，格式为 YYYY-MM-DD。"
        : "请填写 1–50 个不重复、非空的选项，每项最多 200 个字符；参数值必须属于选项。";
  throw new Error(message);
}

export function NotebookParameterSummary({ parameter, automatic = false }: { parameter: NotebookParameter; automatic?: boolean }) {
  const value = JSON.stringify(parameter.value);
  return <p className="notebook-cell-description">{typeLabels[parameter.type]} · 当前值 <code>{value.length > 120 ? `${value.slice(0, 120)}…` : value}</code> · {automatic ? "仅保存值变更后自动重算相关步骤" : "保存后需手动运行"}</p>;
}

export function NotebookParameterEditor({ cell, disabled, onSave, onCancel }: {
  cell: ParameterCell; disabled: boolean; onSave: (cell: NotebookCell) => void; onCancel: () => void;
}) {
  const [title, setTitle] = useState(cell.title);
  const [outputName, setOutputName] = useState(cell.outputName);
  const [type, setType] = useState(cell.parameter.type);
  const [value, setValue] = useState(String(cell.parameter.value));
  const [options, setOptions] = useState<string[]>(cell.parameter.type === "select" ? [...cell.parameter.options] : ["选项 1", "选项 2"]);
  const [error, setError] = useState("");

  function changeType(next: string) {
    if (next !== "text" && next !== "number" && next !== "date" && next !== "select") return;
    setType(next);
    setValue(next === "number" ? "0" : next === "date" ? "1970-01-01" : next === "select" ? options[0] ?? "" : "");
    setError("");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    try {
      const parameter = parseNotebookParameterInput(type, value, options);
      const parsed = notebookCellSchema.safeParse({ ...cell, title, outputName, parameter });
      if (!parsed.success) throw new Error("单元名称或输出表名无效；输出表名须以英文字母开头，仅包含字母、数字和下划线，最多 120 个字符。");
      onSave(parsed.data);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "参数格式无效"); }
  }

  return <form className="notebook-editor" onSubmit={submit} noValidate>
    <fieldset disabled={disabled}>
      <label>单元名称<TextInput value={title} maxLength={120} required onChange={(event) => setTitle(event.target.value)} /></label>
      <label>输出表名（SQL 中使用）<TextInput value={outputName} required maxLength={120} onChange={(event) => setOutputName(event.target.value)} /></label>
      <label>参数类型<SelectField aria-label="参数类型" value={type} onValueChange={(selectedValue) => changeType(selectedValue)}>
        <SelectItem value="text">文本</SelectItem><SelectItem value="number">数值</SelectItem><SelectItem value="date">日期</SelectItem><SelectItem value="select">单选</SelectItem>
      </SelectField></label>
      {type === "text" && <label className="notebook-wide">参数值<TextArea aria-label="参数值" rows={3} value={value} maxLength={2000} onChange={(event) => setValue(event.target.value)} /></label>}
      {type === "number" && <label>参数值<TextInput aria-label="参数值" inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} /></label>}
      {type === "date" && <label>参数值<TextInput aria-label="参数值" type="date" value={value} onChange={(event) => setValue(event.target.value)} /></label>}
      {type === "select" && <>
        <div className="notebook-wide notebook-parameter-options" role="group" aria-label="单选选项">
          {options.map((option, index) => <div key={index}>
            <label>单选选项 {index + 1}<TextArea aria-label={`单选选项 ${index + 1}`} rows={2} maxLength={200} value={option} onChange={(event) => setOptions(options.map((item, i) => i === index ? event.target.value : item))} /></label>
            <Button variant="secondary" type="button" aria-label={`移除选项 ${index + 1}`} disabled={options.length <= 1} onClick={() => setOptions(options.filter((_, i) => i !== index))}>移除</Button>
          </div>)}
          <Button variant="secondary" type="button" disabled={options.length >= 50} onClick={() => setOptions([...options, ""])}>添加选项</Button>
        </div>
        <label>参数值<SelectField aria-label="参数值" value={value} onValueChange={(selectedValue) => setValue(selectedValue)}>
          {!options.includes(value) && <SelectItem value={value}>当前值已不在选项中，请重新选择</SelectItem>}
          {options.map((option, index) => <SelectItem key={index} value={option}>{option || "（空选项，保存时需修正）"}</SelectItem>)}
        </SelectField></label>
      </>}
      <small className="notebook-wide">运行后输出一行 <code>value</code> 列。请在下游 SQL / Python 显式勾选此输入表；默认手动运行，仅显式开启参数自动重算后，保存值变更才触发相关步骤；不向数据库 SQL 插入值。</small>
      <small className="notebook-wide">SQL：<code>(SELECT value FROM {outputName || "参数表名"})</code>；Python：<code>{outputName || "参数表名"}[&quot;value&quot;].iloc[0]</code>。日期在 SQL 中比较时请显式 CAST；Python 已转换为日期列，与带时区数据比较时请显式统一时区。</small>
      {type === "number" && <small className="notebook-wide">数值使用 JavaScript 浮点数；精确大整数和小数请改用文本，不保证任意十进制精度。</small>}
      <small className="notebook-wide">参数值会随 Notebook 保存，并可能进入 AI 上下文。请勿填写密码、API Key 或其他秘密。</small>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <footer><Button variant="secondary" type="button" onClick={onCancel}>取消编辑</Button><Button variant="primary" type="submit" className="notebook-primary" disabled={disabled}>保存单元</Button></footer>
  </form>;
}
