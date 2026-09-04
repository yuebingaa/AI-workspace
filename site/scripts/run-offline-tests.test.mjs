import assert from "node:assert/strict";
import test from "node:test";
import { runOfflineTests } from "./run-offline-tests.mjs";

test("Vitest 参数只传给第一阶段，成功后运行全部 Node 工具单测", async () => {
  const calls = [];
  const exitCode = await runOfflineTests(["--", "--reporter=dot"], async (executable, args) => {
    calls.push({ executable, args });
    return 0;
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].executable, process.execPath);
  assert.match(calls[0].args[0], /vitest[\\/]vitest\.mjs$/u);
  assert.deepEqual(calls[0].args.slice(1), ["run", "--reporter=dot"]);
  assert.equal(calls[1].executable, process.execPath);
  assert.equal(calls[1].args[0], "--test");
  assert.equal(calls[1].args.some((value) => value === "--reporter=dot"), false);
  assert.equal(calls[1].args.some((value) => value.endsWith("eds-browser-acceptance.test.mjs")), true);
  assert.equal(calls[1].args.some((value) => value.endsWith("run-offline-tests.test.mjs")), true);
});

test("Vitest 非零退出时保留失败码且不启动 Node 工具单测", async () => {
  const calls = [];
  const exitCode = await runOfflineTests([], async (executable, args) => {
    calls.push({ executable, args });
    return 7;
  });

  assert.equal(exitCode, 7);
  assert.equal(calls.length, 1);
});
