import assert from "node:assert/strict";
import test from "node:test";
import { assertNoEnvironmentConflict, assertPrivateWindowsDirectory, CONNECTION_ID } from "./bind-dev-adventureworks.mjs";

test("binding refuses existing environment IDs and overriding credentials without exposing values", () => {
  assert.throws(() => assertNoEnvironmentConflict([{ id: CONNECTION_ID }], {}, "synthetic"), /already exists/);
  assert.throws(() => assertNoEnvironmentConflict([], { AGENTCANVAS_ADVENTUREWORKS_READER_PASSWORD: "private-marker" }, "synthetic"),
    (error) => /override/.test(error.message) && !error.message.includes("private-marker"));
  assert.throws(() => assertNoEnvironmentConflict([], { AGENTCANVAS_ADVENTUREWORKS_READER_PASSWORD: "" }, "synthetic"), /override/);
  assert.doesNotThrow(() => assertNoEnvironmentConflict([{ id: "unrelated" }], {}, "synthetic"));
  assert.doesNotThrow(() => assertNoEnvironmentConflict([], { AGENTCANVAS_ADVENTUREWORKS_READER_PASSWORD: "synthetic" }, "synthetic"));
});

test("shared directory permissions are rejected before writing a credential file", () => {
  const owner = "S-1-5-21-1-2-3-1001";
  const privateRules = [owner, "S-1-5-18", "S-1-5-32-544", "S-1-3-0"].map((sid) => ({ sid, type: "Allow" }));
  assert.doesNotThrow(() => assertPrivateWindowsDirectory(privateRules, owner));
  assert.throws(() => assertPrivateWindowsDirectory([...privateRules, { sid: "S-1-1-0", type: "Allow" }], owner), /shared/);
  assert.throws(() => assertPrivateWindowsDirectory([{ sid: "unknown", type: "Unknown" }], owner), /shared/);
  assert.throws(() => assertPrivateWindowsDirectory([], owner), /shared/);
});
