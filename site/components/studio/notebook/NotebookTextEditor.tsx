import { useRef, useState, type FormEvent } from "react";
import { notebookCellSchema, type NotebookCell } from "@/core/notebook/definition";
import { MAX_NOTEBOOK_TEXT_REFERENCES, MAX_NOTEBOOK_TEXT_OUTPUT_CHARS, type NotebookTextReference } from "@/core/notebook/text-references";

export function insertNotebookTextPlaceholder(markdown: string, key: string, start = markdown.length, end = start) {
  const position = Math.max(0, Math.min(markdown.length, start));
  const last = Math.max(position, Math.min(markdown.length, end));
  const placeholder = `{{${key}}}`;
  return { markdown: markdown.slice(0, position) + placeholder + markdown.slice(last), caret: position + placeholder.length };
}

export function removeNotebookTextReference(markdown: string, references: readonly NotebookTextReference[], index: number) {
  const removed = references[index];
  return {
    markdown: removed ? markdown.replaceAll(`{{${removed.key}}}`, "") : markdown,
    references: references.filter((_, position) => position !== index),
  };
}

export function NotebookTextEditor({ cell, availableInputs, disabled, onSave, onCancel }: {
  cell: Extract<NotebookCell, { kind: "text" }>; availableInputs: NotebookCell[]; disabled: boolean;
  onSave: (cell: NotebookCell) => void; onCancel: () => void;
}) {
  const [title, setTitle] = useState(cell.title);
  const [markdown, setMarkdown] = useState(cell.markdown);
  const [references, setReferences] = useState<NotebookTextReference[]>(() => (cell.references ?? []).map((reference) => ({ ...reference })));
  const [error, setError] = useState("");
  const body = useRef<HTMLTextAreaElement | null>(null);
  const inputs = availableInputs.filter((input) => "outputName" in input);
  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const value = notebookCellSchema.parse({ id: cell.id, kind: "text", title, markdown, ...(references.length ? { references } : {}) });
      onSave(value); setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "说明配置无效，请检查引用与正文。"); }
  }
  function updateReference(index: number, value: Partial<NotebookTextReference>) {
    setReferences((current) => current.map((reference, position) => position === index ? { ...reference, ...value } : reference));
  }
  function addReference() {
    const input = inputs[0];
    if (!input || references.length >= MAX_NOTEBOOK_TEXT_REFERENCES) return;
    let index = 1;
    while (references.some((reference) => reference.key === `value_${index}`)) index += 1;
    setReferences([...references, { key: `value_${index}`, cellId: input.id, field: input.kind === "parameter" ? "value" : "" }]);
  }
  function insertPlaceholder(reference: NotebookTextReference) {
    const next = insertNotebookTextPlaceholder(markdown, reference.key, body.current?.selectionStart, body.current?.selectionEnd);
    setMarkdown(next.markdown);
    window.requestAnimationFrame(() => { body.current?.focus(); body.current?.setSelectionRange(next.caret, next.caret); });
  }
  return <form className="notebook-editor notebook-text-editor" aria-label="说明单元编辑器" onSubmit={submit}>
    <fieldset disabled={disabled}>
      <label>单元名称<input value={title} maxLength={120} required onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="notebook-wide">分析说明<textarea ref={body} aria-label="分析说明" value={markdown} maxLength={4000} required rows={6} onChange={(event) => setMarkdown(event.target.value)} /></label>
      <div className="notebook-wide notebook-text-references">
        {references.map((reference, index) => <div key={index} className="notebook-text-reference" role="group" aria-label={`数据引用 ${index + 1}`}>
          <label>引用键<input aria-label={`引用键 ${index + 1}`} value={reference.key} pattern="[A-Za-z][A-Za-z0-9_]*" maxLength={60} required onChange={(event) => updateReference(index, { key: event.target.value })} /></label>
          <label>引用单元<select aria-label={`引用单元 ${index + 1}`} value={reference.cellId} required onChange={(event) => {
            const input = inputs.find((item) => item.id === event.target.value);
            updateReference(index, { cellId: event.target.value, field: input?.kind === "parameter" ? "value" : "" });
          }}>
            {!inputs.some((input) => input.id === reference.cellId) && <option value={reference.cellId}>原引用不可用，请重新选择</option>}
            {inputs.map((input) => <option key={input.id} value={input.id}>{input.title} · {input.outputName}</option>)}
          </select></label>
          <label>字段名<input aria-label={`引用字段 ${index + 1}`} value={reference.field} maxLength={120} required onChange={(event) => updateReference(index, { field: event.target.value })} /></label>
          <div><button type="button" aria-label={`插入占位符 ${index + 1}`} disabled={!/^[A-Za-z][A-Za-z0-9_]{0,59}$/u.test(reference.key)} onClick={() => insertPlaceholder(reference)}>插入 {`{{${reference.key}}}`}</button>
            <button type="button" aria-label={`移除引用 ${index + 1}`} onClick={() => {
              const next = removeNotebookTextReference(markdown, references, index); setMarkdown(next.markdown); setReferences(next.references);
            }}>移除引用</button></div>
        </div>)}
        <button type="button" disabled={!inputs.length || references.length >= MAX_NOTEBOOK_TEXT_REFERENCES} onClick={addReference}>添加数据引用</button>
      </div>
      <small className="notebook-wide">没有数据引用时，说明按原样显示；添加引用后，使用精确占位符 <code>{"{{引用键}}"}</code> 插入纯文本，不执行代码、表达式或 HTML。</small>
      <small className="notebook-wide">引用单元必须成功运行、结果完整且恰好一行。参数字段默认为 <code>value</code>；其他单元请填写实际字段名，而非显示标签，可先运行上游查看字段。</small>
      <small className="notebook-wide">保存只修改定义，不会自动运行。更改引用键后请同步修改正文；移除引用会删除对应占位符。NULL 显示为 NULL，说明结果最多 {MAX_NOTEBOOK_TEXT_OUTPUT_CHARS.toLocaleString("en-US")} 字符。</small>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <footer><button type="button" onClick={onCancel}>取消编辑</button><button type="submit" className="notebook-primary" disabled={disabled}>保存单元</button></footer>
  </form>;
}
