import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertPortableEvidence,
  CdpClient,
  loopbackUrl,
  loopbackWebSocketUrl,
  parseCdpMessageFrame,
  publishEvidenceAtomically,
  readBoundedResponseBytes,
  renameEvidenceWithRetry,
  sameOriginUrl,
  selectCdpPageTarget,
} from "./eds-browser-acceptance.mjs";

class FakeWebSocket extends EventTarget {
  constructor() {
    super();
    this.readyState = 0;
  }

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  send(value) {
    this.lastMessage = value;
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

test("HTTP 与 WebSocket 目标只允许回环地址", () => {
  assert.equal(loopbackUrl("base", "http://127.0.0.1:3102").hostname, "127.0.0.1");
  assert.equal(loopbackWebSocketUrl("cdp", "ws://localhost:9223/devtools/page/1").hostname, "localhost");
  assert.throws(() => loopbackUrl("base", "https://127.0.0.1:3102"), /只允许 HTTP 回环地址/u);
  assert.throws(() => loopbackUrl("base", "http://example.com"), /只允许 HTTP 回环地址/u);
  assert.throws(() => loopbackWebSocketUrl("cdp", "wss://127.0.0.1:9223/devtools/page/1"), /只允许 WS 回环地址/u);
  assert.throws(() => loopbackWebSocketUrl("cdp", "ws://example.com/devtools/page/1"), /只允许 WS 回环地址/u);
});

test("CDP WebSocket 连接停滞时按硬超时失败", async () => {
  const client = new CdpClient("ws://127.0.0.1:9223", {
    connectTimeoutMs: 5,
    commandTimeoutMs: 10,
    WebSocketConstructor: FakeWebSocket,
  });
  await assert.rejects(client.connect(), /连接超过 5ms/u);
});

test("已连接但无响应的 CDP 命令按硬超时失败", async () => {
  class OpenableFakeWebSocket extends FakeWebSocket {
    constructor() {
      super();
      queueMicrotask(() => this.open());
    }
  }
  const client = new CdpClient("ws://127.0.0.1:9223", {
    connectTimeoutMs: 50,
    commandTimeoutMs: 5,
    WebSocketConstructor: OpenableFakeWebSocket,
  });
  await client.connect();
  await assert.rejects(client.send("Runtime.evaluate"), /Runtime\.evaluate 超过 5ms/u);
  client.close();
});

test("证据写入失败时不留下最终目录或临时目录", async () => {
  const parent = await mkdtemp(join(tmpdir(), "eds-browser-evidence-test-"));
  const evidenceDir = join(parent, "final-evidence");
  const circularEvidence = {};
  circularEvidence.self = circularEvidence;

  try {
    await assert.rejects(
      publishEvidenceAtomically({
        evidenceDir,
        downloadedBytes: Buffer.from("download"),
        screenshotBytes: Buffer.from("screenshot"),
        evidence: circularEvidence,
      }),
      /circular/u,
    );
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("机器证据拒绝 Windows、UNC 与 POSIX 绝对路径", () => {
  assert.doesNotThrow(() => assertPortableEvidence({
    baseUrl: "http://127.0.0.1:3102/",
    inputs: [{ name: "input.xlsx" }],
    artifact: "EDS-browser-result.xlsx",
  }));
  assert.throws(() => assertPortableEvidence({ path: "C:\\private\\input.xlsx" }), /绝对文件系统路径/u);
  assert.throws(() => assertPortableEvidence({ path: "\\\\server\\share\\input.xlsx" }), /绝对文件系统路径/u);
  assert.throws(() => assertPortableEvidence({ path: "/private/input.xlsx" }), /绝对文件系统路径/u);
});

test("最终页面与下载地址必须保持同源且不含凭据", () => {
  assert.equal(sameOriginUrl("page", "/studio", "http://127.0.0.1:3102").href, "http://127.0.0.1:3102/studio");
  assert.throws(() => sameOriginUrl("page", "http://127.0.0.1:3103/studio", "http://127.0.0.1:3102"), /必须.*同源/u);
  assert.throws(() => sameOriginUrl("page", "http://user:secret@127.0.0.1:3102/studio", "http://127.0.0.1:3102"), /不含凭据/u);
});

test("下载读取同时限制声明大小、实际大小并核对长度", async () => {
  const bytes = await readBoundedResponseBytes(new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-length": "3" },
  }), 4);
  assert.deepEqual(bytes, Buffer.from([1, 2, 3]));
  await assert.rejects(
    readBoundedResponseBytes(new Response("x", { headers: { "content-length": "5" } }), 4),
    /声明大小超过 4/u,
  );
  await assert.rejects(
    readBoundedResponseBytes(new Response(new Uint8Array([1, 2, 3, 4, 5])), 4),
    /实际大小超过 4/u,
  );
  await assert.rejects(
    readBoundedResponseBytes(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "2" } }), 4),
    /与正文 3 不一致/u,
  );
});

test("CDP 目标必须是唯一空白页且 WebSocket 使用配置端口", () => {
  const validTarget = {
    type: "page",
    url: "about:blank",
    webSocketDebuggerUrl: "ws://localhost:9223/devtools/page/one",
  };
  assert.equal(selectCdpPageTarget([validTarget], "http://127.0.0.1:9223").socketUrl.port, "9223");
  assert.throws(() => selectCdpPageTarget({}, "http://127.0.0.1:9223"), /必须为数组/u);
  assert.throws(() => selectCdpPageTarget([validTarget, validTarget], "http://127.0.0.1:9223"), /只能包含一个/u);
  assert.throws(() => selectCdpPageTarget([{ ...validTarget, url: "https://example.com" }], "http://127.0.0.1:9223"), /必须为空白页/u);
  assert.throws(
    () => selectCdpPageTarget([{ ...validTarget, webSocketDebuggerUrl: "ws://127.0.0.1:9224/devtools/page/one" }], "http://127.0.0.1:9223"),
    /端口.*不一致/u,
  );
});

test("畸形 CDP WebSocket 帧立即拒绝待处理命令", async () => {
  class OpenableFakeWebSocket extends FakeWebSocket {
    constructor() {
      super();
      queueMicrotask(() => this.open());
    }
  }
  const client = new CdpClient("ws://127.0.0.1:9223", {
    connectTimeoutMs: 50,
    commandTimeoutMs: 1_000,
    WebSocketConstructor: OpenableFakeWebSocket,
  });
  await client.connect();
  const pendingCommand = client.send("Runtime.evaluate");
  client.socket.dispatchEvent(new MessageEvent("message", { data: "null" }));
  await assert.rejects(pendingCommand, /JSON 帧必须是对象/u);
});

test("CDP 帧结构只接受有效事件、成功响应或错误响应", () => {
  assert.deepEqual(parseCdpMessageFrame('{"method":"Page.loadEventFired","params":{}}'), {
    method: "Page.loadEventFired",
    params: {},
  });
  assert.deepEqual(parseCdpMessageFrame('{"id":1,"result":{}}'), { id: 1, result: {} });
  assert.deepEqual(parseCdpMessageFrame('{"id":2,"error":{"code":-1,"message":"failed"}}'), {
    id: 2,
    error: { code: -1, message: "failed" },
  });
  assert.throws(() => parseCdpMessageFrame("not-json"), /无法解析/u);
  assert.throws(() => parseCdpMessageFrame("null"), /必须是对象/u);
  assert.throws(() => parseCdpMessageFrame("[]"), /必须是对象/u);
  assert.throws(() => parseCdpMessageFrame('{"id":"1","result":{}}'), /无效 id/u);
  assert.throws(() => parseCdpMessageFrame('{"id":1}'), /result 或 error/u);
  assert.throws(() => parseCdpMessageFrame('{"id":1,"result":{},"error":{"code":-1,"message":"failed"}}'), /result 或 error/u);
  assert.throws(() => parseCdpMessageFrame('{"event":"Page.loadEventFired"}'), /有效 method/u);
});

test("Windows 证据目录瞬时重命名错误按小预算恢复", async () => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    const delays = [];
    let attempts = 0;
    await renameEvidenceWithRetry("temporary", "final", {
      platform: "win32",
      async rename() {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("transient"), { code });
      },
      async wait(delayMs) {
        delays.push(delayMs);
      },
    });
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [10, 25]);
  }
});

test("证据目录瞬时重命名耗尽后停止，冲突错误立即失败", async () => {
  let transientAttempts = 0;
  await assert.rejects(renameEvidenceWithRetry("temporary", "final", {
    platform: "win32",
    async rename() {
      transientAttempts += 1;
      throw Object.assign(new Error("still busy"), { code: "EPERM" });
    },
    async wait() {},
  }), /still busy/u);
  assert.equal(transientAttempts, 4);

  let conflictAttempts = 0;
  await assert.rejects(renameEvidenceWithRetry("temporary", "final", {
    platform: "win32",
    async rename() {
      conflictAttempts += 1;
      throw Object.assign(new Error("already exists"), { code: "EEXIST" });
    },
    async wait() {
      throw new Error("不应等待");
    },
  }), /already exists/u);
  assert.equal(conflictAttempts, 1);
});
