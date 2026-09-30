import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { NotebookTextPart } from "@/core/notebook/text-references";
import "./notebook-rich-text.css";

type HtmlNode = { type: string; value?: string; properties?: Record<string, unknown>; children?: HtmlNode[] };

/** Substitute data only after parsing Markdown. Data cannot create markup, URLs or table cells. */
function literalDocument(parts: readonly NotebookTextPart[]) {
  let prefix = "ACNOTEBOOKVALUE";
  while (parts.some(part => part.value.includes(prefix))) prefix += "X";
  const values = new Map<string, string>();
  const markdown = parts.map((part, index) => {
    if (part.kind === "markdown") return part.value;
    const key = `${prefix}${index}END`;
    values.set(key, part.value); return key;
  }).join("");
  const pattern = new RegExp(`${prefix}\\d+END`, "g");
  const plugin = () => (root: HtmlNode) => {
    function visit(node: HtmlNode) {
      if (node.type === "text" && node.value) node.value = node.value.replace(pattern, token => values.get(token) ?? token);
      // Substitutions are never allowed in URLs, titles or other attributes.
      if (node.properties) for (const key of Object.keys(node.properties)) {
        if (String(node.properties[key]).includes(prefix)) delete node.properties[key];
      }
      node.children?.forEach(visit);
    }
    visit(root);
  };
  return { markdown, plugin };
}

export function NotebookRichText({ markdown, parts, label }: { markdown: string; parts?: readonly NotebookTextPart[]; label?: string }) {
  const literal = parts ? literalDocument(parts) : undefined;
  return <div className="notebook-rich-text" aria-label={label}>
    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={literal ? [literal.plugin] : []}
      allowedElements={["h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "strong", "em", "del", "ul", "ol", "li", "blockquote", "pre", "code", "table", "thead", "tbody", "tr", "th", "td", "a"]}
      unwrapDisallowed urlTransform={url => /^(https?:\/\/|mailto:)/iu.test(url) ? url : undefined}
      components={{ a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a> : <span>{children}</span> }}>
      {literal?.markdown ?? markdown}
    </Markdown>
  </div>;
}
