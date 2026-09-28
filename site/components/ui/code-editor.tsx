"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";

const externalUpdate = Annotation.define<boolean>();
export type CodeLanguage = "sql" | "python" | "json";
const emptySchema: Record<string, string[]> = {};

/** CodeMirror owns transient selection/history; the caller owns saved source text. */
export function CodeEditor({ value, onChange, label, language = "sql", maxLength = 10000, disabled = false, schema = emptySchema }: {
  value: string; onChange(value: string): void; label: string; language?: CodeLanguage;
  maxLength?: number; disabled?: boolean; schema?: Record<string, string[]>;
}) {
  const host = useRef<HTMLDivElement>(null), editor = useRef<EditorView | null>(null);
  const [initialValue] = useState(value), [configuration] = useState(() => new Compartment());
  const [feedback, setFeedback] = useState("");
  const notify = useEffectEvent((text: string) => onChange(text));
  const schemaKey = JSON.stringify(schema);
  const extensions = useMemo(() => [
    language === "python" ? python() : language === "json" ? json() : sql({ dialect: PostgreSQL, schema: JSON.parse(schemaKey) as Record<string, string[]>, upperCaseKeywords: true }),
    EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled),
    EditorState.phrases.of({ "Find": "查找", "Replace": "替换", "next": "下一处", "previous": "上一处", "all": "全部",
      "match case": "区分大小写", "regexp": "正则表达式", "by word": "全词匹配", "replace": "替换", "replace all": "全部替换", "close": "关闭",
      "Fold line": "折叠此行", "Unfold line": "展开此行", "Folded code": "已折叠代码", "Go to line": "跳转到行", "go": "跳转" }),
    EditorView.contentAttributes.of({ "aria-label": label, "aria-required": "true", "aria-disabled": String(disabled), spellcheck: "false" }),
    EditorState.transactionFilter.of(transaction => {
      if (transaction.docChanged && !transaction.annotation(externalUpdate)
        && transaction.newDoc.length > maxLength && transaction.newDoc.length >= transaction.startState.doc.length) return [];
      return transaction;
    }),
    EditorView.domEventHandlers({ paste(event, view) {
      const text = event.clipboardData?.getData("text/plain");
      if (text != null && view.state.doc.length - view.state.selection.main.to + view.state.selection.main.from + text.length > maxLength) {
        setFeedback(`代码最多 ${maxLength.toLocaleString()} 个字符，本次粘贴未写入。`);
      }
      return false;
    } }),
  ], [language, schemaKey, disabled, label, maxLength]);

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: initialValue, extensions: [
      basicSetup, configuration.of([]),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalUpdate))) {
          setFeedback(""); notify(update.state.doc.toString());
        }
      }),
    ] }) });
    editor.current = view;
    return () => { editor.current = null; view.destroy(); };
  }, [initialValue, configuration]);

  useEffect(() => { editor.current?.dispatch({ effects: configuration.reconfigure(extensions) }); }, [configuration, extensions]);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value) view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: externalUpdate.of(true),
    });
  }, [value]);

  return <div className="notebook-code-editor" data-language={language}>
    <div className="notebook-code-editor-bar"><span>{language === "sql" ? "SQL" : language === "python" ? "Python" : "JSON"}</span><span>Ctrl F 搜索 · Ctrl Space 补全</span></div>
    <div ref={host} className="notebook-codemirror" />
    <div className="notebook-code-editor-status"><span>{value.split("\n").length} 行</span><span>{value.length.toLocaleString()} / {maxLength.toLocaleString()} 字符</span></div>
    {feedback && <p role="status">{feedback}</p>}
  </div>;
}
