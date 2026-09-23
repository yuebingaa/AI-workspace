import { answerBlocks, answerInline, type AnswerInline } from "./assistant-answer-format";

function inline(nodes: AnswerInline[]) {
  return nodes.map((node, index) => node.kind === "code" ? <code key={index}>{node.text}</code>
    : node.kind === "strong" ? <strong key={index}>{inline(node.children)}</strong> : node.text);
}

/** Model text is untrusted content. Fixed React tags only: no HTML, URL/image
 * expansion, scripts, callbacks, or dependency on execution/persistence. */
export function AssistantAnswer({ text }: { text: string }) {
  return <div className="assistant-answer">{answerBlocks(text).map((block, index) => {
    if (block.kind === "literal") return <p key={index}>{block.text}</p>;
    if (block.kind === "code") return <pre key={index} tabIndex={0} aria-label="回答中的代码（仅供阅读）"><code>{block.text}</code></pre>;
    if (block.kind === "list") {
      const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{inline(answerInline(item))}</li>);
      return block.start === undefined ? <ul key={index}>{items}</ul> : <ol key={index} start={block.start}>{items}</ol>;
    }
    const content = inline(answerInline(block.text));
    if (block.kind === "heading") return block.level <= 2 ? <h3 key={index}>{content}</h3> : <h4 key={index}>{content}</h4>;
    return <p key={index}>{content}</p>;
  })}</div>;
}
