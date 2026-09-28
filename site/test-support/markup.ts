export function markupRoot(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}
export function buttonMarkup(html: string, text: string) {
  const button = [...markupRoot(html).querySelectorAll("button")].find(element => element.textContent?.trim() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}
