import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { portableEnvironment } from "../portable/windows/launcher-config.mjs";

test("portable deployment uses its own browser, data and DSH default without mutating host environment", () => {
  const source = { PATH: "system-only", NOTEBOOK_PYTHON_BROWSER: "host-browser", STUDIO_LOCAL_STATE_DIR: "host-data",
    NODE_OPTIONS: "--require host-loader", node_path: "host-modules" };
  const root = join("fixture", "中文 空格", "AgentCanvas");
  const result = portableEnvironment(root, 3214, source);
  assert.equal(result.PATH, "system-only");
  assert.equal(result.NOTEBOOK_PYTHON_BROWSER, join(root, "runtime", "browser", "chrome-headless-shell.exe"));
  assert.equal(result.STUDIO_LOCAL_STATE_DIR, join(root, "data", "state"));
  assert.equal(result.AGENTCANVAS_DEFAULT_ENGINE, "dsh");
  assert.equal(result.NOTEBOOK_PYTHON_ENABLED, "true");
  assert.equal(result.HOST, "127.0.0.1");
  assert.equal(result.PORT, "3214");
  assert.equal(result.NODE_OPTIONS, undefined);
  assert.equal(result.node_path, undefined);
  assert.equal(source.NODE_OPTIONS, "--require host-loader");
  assert.equal(source.NOTEBOOK_PYTHON_BROWSER, "host-browser");
  assert.equal(source.STUDIO_LOCAL_STATE_DIR, "host-data");
});
