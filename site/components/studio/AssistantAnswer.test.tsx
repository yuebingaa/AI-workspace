import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AssistantAnswer } from "./AssistantAnswer";

function render(text: string) {
  return renderToStaticMarkup(<AssistantAnswer text={text} />);
}

function escaped(text: string) {
  return renderToStaticMarkup(<>{text}</>);
}

function expectOnlyAnswerElements(html: string) {
  const tags = Array.from(html.matchAll(/<\/?([a-z][a-z\d]*)\b/giu), (match) => match[1]);
  expect(tags.every((tag) => ["div", "p", "strong", "code", "h3", "h4", "ul", "ol", "li", "pre"].includes(tag))).toBe(true);
  expect(html).not.toMatch(/<[^>]+\s(?:href|src|srcdoc|on\w+)\s*=/iu);
}

describe("AssistantAnswer safe formatting", () => {
  it("renders Chinese paragraphs, line breaks, bold text, and inline code", () => {
    const html = render("当前参数：**华东**，字段是 `region`。\n第二行保留。\n\n下一段说明。");
    expect(html).toContain('class="assistant-answer"');
    expect(html).toContain("<strong>华东</strong>");
    expect(html).toContain("<code>region</code>");
    expect(html).toContain("。\n第二行保留。");
    expect(html.match(/<p(?:\s|>)/gu)).toHaveLength(2);
    expect(html).toContain("下一段说明。");
    expectOnlyAnswerElements(html);
  });

  it("uses local heading levels for ATX headings without creating page headings", () => {
    const html = render("# 概览\n## 结论\n### 数据\n#### 字段\n##### 范围\n###### 限制");
    expect(html.match(/<h[34](?:\s|>)/gu)).toHaveLength(6);
    expect(html.match(/<h3(?:\s|>)/gu)).toHaveLength(2);
    expect(html.match(/<h4(?:\s|>)/gu)).toHaveLength(4);
    for (const text of ["概览", "结论", "数据", "字段", "范围", "限制"]) expect(html).toContain(text);
    expectOnlyAnswerElements(html);
  });

  it.each(["-", "*", "+"])("supports flat unordered lists marked with %s", (marker) => {
    const html = render(`${marker} **第一项**\n${marker} 第二项含 \`field\``);
    expect(html).toMatch(/<ul(?:\s|>)/u);
    expect(html.match(/<li(?:\s|>)/gu)).toHaveLength(2);
    expect(html).toContain("<strong>第一项</strong>");
    expect(html).toContain("<code>field</code>");
    expectOnlyAnswerElements(html);
  });

  it("supports consecutive ordered list items without swallowing adjacent prose", () => {
    const html = render("先看步骤。\n\n1. 读取字段\n2. 核对数据\n3. 给出结论\n\n最后说明。");
    expect(html).toMatch(/<ol(?:\s|>)/u);
    expect(html.match(/<li(?:\s|>)/gu)).toHaveLength(3);
    expect(html).toContain("先看步骤。");
    expect(html).toContain("最后说明。");
    expectOnlyAnswerElements(html);
  });

  it("preserves the original start of a consecutive numbered list", () => {
    const html = render("3. 接续读取\n4. 继续核对");
    expect(html).toMatch(/<ol\b[^>]*\bstart="3"/u);
    expect(html.match(/<li(?:\s|>)/gu)).toHaveLength(2);
    expect(html).toContain("接续读取");
    expect(html).toContain("继续核对");
  });

  it("preserves a complete fenced code block as escaped source", () => {
    const code = "const label = '<img src=\"https://invalid.example/pixel\">';\n  **原样保留** `field`\n# 不是标题\n1. 不是列表";
    const html = render(`前文。\n\n\`\`\`javascript\n${code}\n\`\`\`\n\n后文。`);
    expect(html).toMatch(/<pre(?:\s|>)/u);
    expect(html).toMatch(/<code(?:\s|>)/u);
    expect(html).toContain(escaped(code));
    expect(html).not.toMatch(/<(?:strong|h[34]|ol|ul|li)(?:\s|>)/u);
    expect(html).toContain("前文。");
    expect(html).toContain("后文。");
    expectOnlyAnswerElements(html);
  });

  it("does not interpret formatting inside an inline code span", () => {
    const html = render("`**literal** <script>alert(1)</script>`");
    expect(html).toContain(`<code>${escaped("**literal** <script>alert(1)</script>")}</code>`);
    expect(html).not.toContain("<strong>");
    expectOnlyAnswerElements(html);
  });

  it("supports inline code inside strong text", () => {
    const html = render("**参数 `region` 的定义**");
    expect(html).toContain("<strong>参数 <code>region</code> 的定义</strong>");
    expectOnlyAnswerElements(html);
  });

  it.each(["x**y", "**"])("keeps bold delimiters inside inline code literal: %s", (source) => {
    const html = render(`**Code \`${source}\` end**`);
    expect(html).toContain(`<strong>Code <code>${source}</code> end</strong>`);
    expectOnlyAnswerElements(html);
  });

  it.each([
    "<script>globalThis.__answerExecuted = true</script>",
    '<img src="https://invalid.example/pixel" onerror="alert(1)">',
    '<iframe srcdoc="<script>alert(1)</script>" src="https://invalid.example/frame"></iframe>',
    '<svg onload="alert(1)"><image href="https://invalid.example/pixel" /></svg>',
    '<html><body><a href="javascript:alert(1)">执行</a></body></html>',
    '<a href="data:text/html,<script>alert(1)</script>">数据</a>',
    '<style>body { background-image: url(https://invalid.example/image); }</style>',
    "[执行](javascript:alert(1))",
    "![图片](data:image/svg+xml,<svg onload=alert(1)>)",
    "https://invalid.example/pixel",
  ])("keeps untrusted markup and URLs visible without active elements: %s", (source) => {
    const html = render(source);
    expect(html).toContain(escaped(source));
    expectOnlyAnswerElements(html);
  });

  it("does not fetch remote resources while rendering answers", () => {
    const fetchSpy = vi.fn(() => { throw new Error("Answer rendering must not fetch"); });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const html = render('<img src="https://invalid.example/image">\n![图](https://invalid.example/image)\n[链接](https://invalid.example/page)');
      expect(fetchSpy).not.toHaveBeenCalled();
      expectOnlyAnswerElements(html);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cannot turn a code fence language marker into HTML attributes", () => {
    const html = render('```html\" onmouseover=\"alert(1)\"><img src=\"https://invalid.example/image\">\n<script>alert(1)</script>\n```');
    expect(html).toContain(escaped("<script>alert(1)</script>"));
    expectOnlyAnswerElements(html);
  });

  it.each([
    "未闭合 **粗体",
    "未闭合 `字段",
    "**",
    "`",
    "``双反引号``",
    "*斜体* 与 _另一种斜体_",
    "[普通链接](https://invalid.example/page)",
    "![图片](https://invalid.example/image)",
    "| 字段 | 数值 |\n| --- | --- |\n| region | East |",
    "#没有空格的普通文字",
    "####### 超过六级的普通文字",
  ])("preserves unsupported or incomplete syntax literally: %s", (source) => {
    const html = render(source);
    expect(html).toContain(escaped(source));
    expect(html).not.toMatch(/<(?:strong|code|pre|h[34]|ul|ol|li)(?:\s|>)/u);
    expectOnlyAnswerElements(html);
  });

  it("keeps an unclosed code fence and its contents literal", () => {
    const source = "```sql\nSELECT ** FROM source;\n# not a heading\n- not a list";
    const html = render(source);
    expect(html).toContain(escaped(source));
    expect(html).not.toMatch(/<(?:strong|code|pre|h[34]|ul|ol|li)(?:\s|>)/u);
    expectOnlyAnswerElements(html);
  });

  it.each([
    "```c#\n# Keep this code line\n**literal**\n```",
    "````\n# Keep this code line\n**literal**\n````",
    "~~~\n# Keep this code line\n**literal**\n~~~",
  ])("keeps an unsupported fenced block entirely literal: %s", (source) => {
    const html = render(source);
    expect(html).toContain(escaped(source));
    expect(html).not.toMatch(/<(?:strong|code|pre|h[34]|ul|ol|li)(?:\s|>)/u);
    expectOnlyAnswerElements(html);
  });

  it.each(["普通中文回答。", "", "0", "-1", "-12.50\n+12.50\n3.14159", "2026. 年度记录", "1. 单独编号", "1. 甲\n3. 乙", "- 单独一行", "+ 150", "* 孤立项目"])("does not invent a list for ordinary or ambiguous content: %s", (source) => {
    const html = render(source);
    expect(html).toContain(escaped(source));
    expect(html).not.toMatch(/<(?:ol|ul|li)(?:\s|>)/u);
    expectOnlyAnswerElements(html);
  });

  it("preserves over-limit answers in full as plain text", () => {
    const source = `**开头**\n${"长文本".repeat(3_334)}\n\`尾部字段\``;
    const html = render(source);
    expect(html).toContain(escaped(source));
    expect(html).not.toMatch(/<(?:strong|code|pre|h[34]|ul|ol|li)(?:\s|>)/u);
    expectOnlyAnswerElements(html);
  });
});
