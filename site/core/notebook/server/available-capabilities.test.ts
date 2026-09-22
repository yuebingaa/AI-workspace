import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_NOTEBOOK_CAPABILITIES } from "../capabilities";
import { NotebookCapabilityConfigurationError } from "./capabilities";
import { getNotebookCapabilities } from "./available-capabilities";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, closeSync: vi.fn(actual.closeSync), fstatSync: vi.fn(actual.fstatSync), lstatSync: vi.fn(actual.lstatSync), openSync: vi.fn(actual.openSync) };
});
let root: string;
const marker = () => join(root, "vendor", "python", "runtime-lock.json");
function installMarker(contents = "synthetic-presence-only") {
  mkdirSync(join(root, "vendor", "python"), { recursive: true });
  writeFileSync(marker(), contents);
}
const read = () => getNotebookCapabilities({ environment: {}, rootDirectory: root });
beforeEach(() => { vi.clearAllMocks(); root = mkdtempSync(join(tmpdir(), "agentcanvas-python-presence-")); });
afterEach(() => {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "agentcanvas-python-presence-"))) throw new Error("Unsafe fixture cleanup");
  rmSync(root, { recursive: true, force: true });
});
describe("server composition for optional Python resources", () => {
  it("skips all filesystem inspection when configured off", () => {
    expect(getNotebookCapabilities({ environment: { NOTEBOOK_PYTHON_ENABLED: "false" }, rootDirectory: root })).toEqual({ python: {
      enabled: false, reason: "Python Notebook 能力已通过服务器配置关闭",
    } });
    expect(lstatSync).not.toHaveBeenCalled(); expect(openSync).not.toHaveBeenCalled();
    expect(fstatSync).not.toHaveBeenCalled(); expect(closeSync).not.toHaveBeenCalled();
  });
  it("rejects invalid environment configuration before inspecting files", () => {
    expect(() => getNotebookCapabilities({ environment: { NOTEBOOK_PYTHON_ENABLED: "invalid" }, rootDirectory: root })).toThrow(NotebookCapabilityConfigurationError);
    expect(lstatSync).not.toHaveBeenCalled();
  });
  it("disables missing resources and recognizes later installation without a cache or restart", () => {
    expect(read()).toMatchObject({ python: { enabled: false, reason: expect.stringContaining("未包含 Python 资源") } });
    expect(JSON.stringify(read())).not.toContain(root);
    installMarker(); expect(read()).toBe(DEFAULT_NOTEBOOK_CAPABILITIES);
    expect(openSync).toHaveBeenCalledWith(marker(), "r"); expect(closeSync).toHaveBeenCalledTimes(1);
  });
  it("does not treat an existing marker as proof of complete or valid runtime assets", () => {
    installMarker("this is not valid runtime JSON");
    expect(read()).toBe(DEFAULT_NOTEBOOK_CAPABILITIES);
    expect(fstatSync).toHaveBeenCalledTimes(1);
  });
  it("disables a directory in place of the marker without opening it", () => {
    mkdirSync(marker(), { recursive: true });
    expect(read()).toMatchObject({ python: { enabled: false, reason: expect.stringContaining("不是普通文件") } });
    expect(openSync).not.toHaveBeenCalled();
  });
  it("refuses a symlink-like marker before following or opening it", () => {
    installMarker(); const stat = lstatSync(marker());
    vi.spyOn(stat, "isSymbolicLink").mockReturnValue(true);
    vi.mocked(lstatSync).mockReturnValueOnce(stat);
    expect(read()).toMatchObject({ python: { enabled: false, reason: expect.stringContaining("不是普通文件") } });
    expect(openSync).not.toHaveBeenCalled();
  });
  it.each(["EACCES", "EPERM", "EIO"])("keeps non-Python capability available while reporting unreadable marker %s", (code) => {
    installMarker();
    vi.mocked(openSync).mockImplementationOnce(() => { throw Object.assign(new Error(`private path ${root}`), { code }); });
    const capabilities = read();
    expect(capabilities).toMatchObject({ python: { enabled: false, reason: expect.stringContaining("无法读取") } });
    expect(JSON.stringify(capabilities)).not.toContain(root); expect(closeSync).not.toHaveBeenCalled();
  });
  it("rejects a file replacement during opening and still closes its descriptor", () => {
    installMarker(); const replacement = lstatSync(marker()); replacement.ino += 1;
    vi.mocked(fstatSync).mockReturnValueOnce(replacement);
    expect(read()).toMatchObject({ python: { enabled: false, reason: expect.stringContaining("发生变化") } });
    expect(closeSync).toHaveBeenCalledTimes(1);
  });
  it("releases the opened descriptor if inspection fails", () => {
    installMarker();
    vi.mocked(fstatSync).mockImplementationOnce(() => { throw Object.assign(new Error("private failed stat"), { code: "EIO" }); });
    expect(read()).toMatchObject({ python: { enabled: false, reason: expect.stringContaining("无法读取") } });
    expect(closeSync).toHaveBeenCalledTimes(1);
  });
});
