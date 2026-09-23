/** A deliberately small display grammar, not a Markdown/HTML interpreter.
 * Unknown and incomplete syntax stays visible. Never rewrites stored answers. */
export type AnswerInline = { kind: "text" | "code"; text: string }
  | { kind: "strong"; children: AnswerInline[] };
export type AnswerBlock = { kind: "paragraph" | "literal" | "code"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; start?: number; items: string[] };

function strongEnd(text: string, start: number): number {
  for (let index = start; index < text.length && text[index] !== "\n"; index++) {
    if (text[index] === "\\") { index++; continue; }
    // A marker inside a complete inline code span is source, not a closer.
    if (text[index] === "`" && text[index - 1] !== "`" && text[index + 1] !== "`") {
      const end = text.indexOf("`", index + 1);
      const value = end < 0 ? "" : text.slice(index + 1, end);
      if (value && !value.includes("\n") && !value.endsWith("\\") && text[end + 1] !== "`") {
        index = end; continue;
      }
    }
    if (text.startsWith("**", index) && text[index - 1] !== "*" && text[index + 2] !== "*") return index;
  }
  return -1;
}

export function answerInline(text: string, allowStrong = true): AnswerInline[] {
  const nodes: AnswerInline[] = [];
  let plain = "";
  const flush = () => { if (plain) nodes.push({ kind: "text", text: plain }); plain = ""; };
  for (let index = 0; index < text.length;) {
    if (text[index] === "\\" && index + 1 < text.length) {
      plain += text.slice(index, index + 2); index += 2; continue;
    }
    const marker = text[index] === "`" && text[index - 1] !== "`" && text[index + 1] !== "`" ? "`"
      : allowStrong && text.startsWith("**", index) && text[index - 1] !== "*" && text[index + 2] !== "*" ? "**" : undefined;
    if (marker) {
      const end = marker === "**" ? strongEnd(text, index + marker.length) : text.indexOf(marker, index + marker.length);
      const value = end < 0 ? "" : text.slice(index + marker.length, end);
      if (value && !value.includes("\n") && !value.endsWith("\\") && text[end + marker.length] !== marker[0]) {
        flush();
        nodes.push(marker === "`" ? { kind: "code", text: value } : { kind: "strong", children: answerInline(value, false) });
        index = end + marker.length; continue;
      }
    }
    plain += text[index++];
  }
  flush(); return nodes;
}

const fence = /^```[A-Za-z0-9_+-]{0,24}[ \t]*$/u;
const heading = /^(#{1,6})[ \t]+(.+)$/u;
function listItem(line: string) {
  const unordered = /^[-+*][ \t]+(\S.*)$/u.exec(line);
  if (unordered) return { text: unordered[1], number: undefined };
  const ordered = /^([1-9]\d{0,5})[.)][ \t]+(\S.*)$/u.exec(line);
  return ordered ? { text: ordered[2], number: Number(ordered[1]) } : undefined;
}

export function answerBlocks(text: string): AnswerBlock[] {
  // Normally at most 2,000 characters. Preserve unexpected larger legacy text
  // without parsing or truncation instead of creating thousands of DOM nodes.
  if (text.length > 10_000) return [{ kind: "literal", text }];
  const lines = text.replace(/\r\n?/gu, "\n").split("\n"), blocks: AnswerBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { flush(); index++; continue; }
    if (fence.test(line)) {
      flush();
      const offset = lines.slice(index + 1).findIndex(candidate => /^```[ \t]*$/u.test(candidate));
      if (offset < 0) { blocks.push({ kind: "literal", text: lines.slice(index).join("\n") }); break; }
      const end = index + offset + 1;
      blocks.push({ kind: "code", text: lines.slice(index + 1, end).join("\n") }); index = end + 1; continue;
    }
    // Unknown fence variants are not partially parsed as prose: keep the rest
    // literal, including heading/bold markers that may be part of source code.
    if (/^[ \t]*(?:`{3,}|~{3,})/u.test(line)) {
      flush(); blocks.push({ kind: "literal", text: lines.slice(index).join("\n") }); break;
    }
    const title = heading.exec(line);
    if (title) { flush(); blocks.push({ kind: "heading", level: title[1].length, text: title[2] }); index++; continue; }
    const first = listItem(line);
    if (first) {
      const items = [first.text];
      for (let next = index + 1; next < lines.length; next++) {
        const candidate = listItem(lines[next]);
        if (!candidate || (first.number === undefined ? candidate.number !== undefined : candidate.number !== first.number + items.length)) break;
        items.push(candidate.text);
      }
      // One numerical line could be prose or data, not an intended list.
      if (items.length > 1) { flush(); blocks.push({ kind: "list", start: first.number, items }); index += items.length; continue; }
    }
    paragraph.push(line); index++;
  }
  flush(); return blocks;
}
