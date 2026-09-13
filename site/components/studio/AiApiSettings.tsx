import { useEffect, useState, type FormEvent } from "react";

interface AiApiStatus {
  configured: boolean;
  source: "runtime" | "environment" | "none";
  model: string;
  modelSource: "runtime" | "environment" | "default";
  availableModels: Array<{ id: string; ownedBy: string }>;
  modelsDiscovered: boolean;
  persistence: "process-memory";
}

async function readResponse(response: Response): Promise<AiApiStatus> {
  const payload = await response.json() as AiApiStatus & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || "AI API 配置请求失败。");
  return payload;
}

export function AiApiSettings() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<AiApiStatus | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetch("/api/settings/ai", { cache: "no-store", signal: controller.signal })
      .then(readResponse)
      .then((next) => { setStatus(next); setSelectedModel(next.model); setEditing(!next.configured); })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "无法读取 AI API 配置。");
      });
    return () => controller.abort();
  }, [open]);

  function openSettings() {
    setError("");
    setOpen(true);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiKey.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await readResponse(await fetch("/api/settings/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey }),
      }));
      setStatus(next);
      setSelectedModel(next.model);
      setApiKey("");
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法保存 AI API 配置。");
    } finally {
      setBusy(false);
    }
  }

  async function discoverModels() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await readResponse(await fetch("/api/settings/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }));
      setStatus(next);
      setSelectedModel(next.model);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法识别可用模型。");
    } finally {
      setBusy(false);
    }
  }

  async function applyModel() {
    if (!selectedModel || busy || selectedModel === status?.model) return;
    setBusy(true);
    setError("");
    try {
      const next = await readResponse(await fetch("/api/settings/ai", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: selectedModel }),
      }));
      setStatus(next);
      setSelectedModel(next.model);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法应用所选模型。");
    } finally {
      setBusy(false);
    }
  }

  async function clearRuntimeKey() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await readResponse(await fetch("/api/settings/ai", { method: "DELETE" }));
      setStatus(next);
      setSelectedModel(next.model);
      setApiKey("");
      setEditing(!next.configured);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法清除 AI API 配置。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="ai-api-settings-trigger"
        aria-label="配置 AI API"
        title="配置 AI API"
        onClick={openSettings}
      >
        <span aria-hidden="true">⚙</span> API
      </button>
      {open && (
        <div className="ai-api-settings-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) setOpen(false);
        }}>
          <section className="ai-api-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-api-settings-title">
            <header>
              <div>
                <small>LOCAL AI CREDENTIAL</small>
                <h2 id="ai-api-settings-title">AI 接口配置</h2>
                <p>配置 DeepSeek API Key，供本机 Harness 和 AI 规划器使用。</p>
              </div>
              <button type="button" aria-label="关闭 AI API 配置" disabled={busy} onClick={() => setOpen(false)}>×</button>
            </header>

            {status?.configured && !editing ? (
              <div className="ai-api-configured-card" role="status">
                <span aria-hidden="true">✓</span>
                <div>
                  <b>DeepSeek API 已配置</b>
                  <p>密钥已隐藏，不会返回浏览器，也不会写入工作区备份。当前模型：{status.model}</p>
                  <small>{status.source === "runtime" ? "当前会话的本机服务内存" : "服务器环境变量"}</small>
                </div>
              </div>
            ) : (
              <form onSubmit={save}>
                <label htmlFor="deepseek-api-key">DeepSeek API Key</label>
                <input
                  id="deepseek-api-key"
                  type="password"
                  value={apiKey}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="输入后将被隐藏"
                  minLength={8}
                  maxLength={512}
                  required
                  autoFocus
                  disabled={busy}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <p>仅发送到当前网站的本机服务端；页面不会保存或重新显示密钥。</p>
                <button className="primary" type="submit" disabled={busy || apiKey.trim().length < 8}>{busy ? "正在识别…" : "验证密钥并识别模型"}</button>
              </form>
            )}

            {status?.configured && !editing && (
              <section className="ai-api-model-panel" aria-label="DeepSeek 模型选择">
                <div>
                  <b>API 可用模型</b>
                  <small>{status.modelsDiscovered ? `已识别 ${status.availableModels.length} 个模型` : "尚未读取当前账号的模型列表"}</small>
                </div>
                {status.availableModels.length > 0 && (
                  <label>
                    <span>选择模型</span>
                    <select value={selectedModel} disabled={busy} onChange={(event) => setSelectedModel(event.target.value)}>
                      {status.availableModels.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
                    </select>
                  </label>
                )}
                <div className="ai-api-model-actions">
                  <button type="button" disabled={busy} onClick={() => { void discoverModels(); }}>{busy ? "处理中…" : status.modelsDiscovered ? "重新识别" : "识别可用模型"}</button>
                  {status.availableModels.length > 0 && <button className="primary" type="button" disabled={busy || !selectedModel || selectedModel === status.model} onClick={() => { void applyModel(); }}>应用模型</button>}
                </div>
                <p>模型列表来自 DeepSeek 官方接口；选择结果仅保存在当前服务进程中。</p>
              </section>
            )}

            {error && <p className="ai-api-settings-error" role="alert">{error}</p>}
            <footer>
              {status?.configured && !editing && <button type="button" disabled={busy} onClick={() => setEditing(true)}>更换密钥</button>}
              {status?.source === "runtime" && !editing && <button type="button" disabled={busy} onClick={() => { void clearRuntimeKey(); }}>清除临时密钥</button>}
              {editing && status?.configured && <button type="button" disabled={busy} onClick={() => { setApiKey(""); setEditing(false); }}>取消更换</button>}
              <button type="button" disabled={busy} onClick={() => setOpen(false)}>完成</button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
