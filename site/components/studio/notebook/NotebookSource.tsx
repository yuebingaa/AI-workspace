import { Button } from "@/components/ui/button";
import { useState } from "react";
import { CodeEditor, type CodeLanguage } from "@/components/ui/code-editor";
import type { SourceLine } from "./cell-source";

// Highlighting is decorative; React escapes every token and code is never HTML.
function highlight(line: string) {
  return line.split(/(--.*$|"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|\b(?:SELECT|FROM|WHERE|GROUP|BY|ORDER|AS|SUM|COUNT|AVG|MIN|MAX|WITH|JOIN|ON|LEFT|RIGHT|INNER|OUTER|LIMIT|HAVING|DISTINCT|CASE|WHEN|THEN|ELSE|END|AND|OR|NOT|NULL|TRUE|FALSE)\b|\b\d+(?:\.\d+)?\b)/giu)
    .map((token, index) => <span key={index} className={/^--/u.test(token) ? "source-comment" : /^["']/u.test(token) ? "source-string" : /^\d/u.test(token) ? "source-number" : /^(?:SELECT|FROM|WHERE|GROUP|BY|ORDER|AS|SUM|COUNT|AVG|MIN|MAX|WITH|JOIN|ON|LEFT|RIGHT|INNER|OUTER|LIMIT|HAVING|DISTINCT|CASE|WHEN|THEN|ELSE|END|AND|OR|NOT|NULL|TRUE|FALSE)$/iu.test(token) ? "source-keyword" : undefined}>{token}</span>);
}

export function NotebookSource({ value, language, label, lines }: { value: string; language: string; label: string; lines?: SourceLine[] }) {
  const [copyState, setCopyState] = useState("");
  const rows = lines ?? value.split("\n").map((text, i): SourceLine => ({ text, kind: "same", newLine: i + 1 }));
  return <div className="notebook-source">
    <div className="notebook-source-toolbar"><span>{language}</span><span>{lines ? "− 原有内容　+ 建议内容" : `${rows.length} 行`}</span>
      {!lines && <Button size="small" variant="ghost" type="button" onClick={async () => { try { await navigator.clipboard.writeText(value); setCopyState("已复制"); } catch { setCopyState("复制失败，请选中代码复制"); } }}>复制代码</Button>}
      {copyState && <small role="status">{copyState}</small>}
    </div>
    <div className="notebook-source-scroll" tabIndex={0} role="region" aria-label={label}>
      <pre>{rows.map((line, i) => <span className={`notebook-source-line ${line.kind}`} key={i}>
        <span className="source-line-number" aria-hidden="true">{line.newLine ?? line.oldLine}</span>
        {lines && <span className="source-diff-marker" aria-label={line.kind === "added" ? "新增" : line.kind === "removed" ? "移除" : undefined}>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>}
        <code>{highlight(line.text || " ")}</code>
      </span>)}</pre>
    </div>
  </div>;
}

export function NotebookCodeEditor(props: { value: string; onChange: (value: string) => void; label: string; maxLength?: number;
  disabled?: boolean; language?: CodeLanguage; schema?: Record<string, string[]> }) {
  return <CodeEditor {...props} language={props.language ?? (props.label === "Python" ? "python" : props.label.includes("JSON") || props.label.includes("规则") ? "json" : "sql")} />;
}
