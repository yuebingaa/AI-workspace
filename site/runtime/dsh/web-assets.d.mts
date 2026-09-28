export interface DshWebAssets {
  html(options: { nonce: string; surface?: "chat" | "settings" }): Promise<string>;
  fetch(path: string): Promise<Response>;
}
export function createDshWebAssets(options?: { runtimeRoot?: string; basePath?: string }): Promise<DshWebAssets>;
