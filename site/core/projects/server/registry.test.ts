import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalProjectStore, openProject, PROJECT_REGISTRY_LIMITS, recentProjects } from "./store";

let root: string;
const indexPath = () => join(root, "private-state", "local-projects.json");
function seedRegistry(count: number, longPaths = false) {
  const entries = Array.from({ length: count }, (_, index) => ({
    handle: randomUUID(), path: join(root, `${longPaths ? "合成路径".repeat(40) : "project"}-${index}`), name: `Synthetic ${index}`,
  }));
  mkdirSync(dirname(indexPath()), { recursive: true });
  writeFileSync(indexPath(), JSON.stringify({ version: 1, entries }));
  return entries;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentcanvas-registry-test-"));
  vi.stubEnv("STUDIO_LOCAL_STATE_DIR", join(root, "private-state"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "agentcanvas-registry-test-"))) throw new Error("Unsafe fixture cleanup");
  rmSync(root, { recursive: true, force: true });
});

describe("local project registry capacity", () => {
  it("creates a 101st project without replacing any existing version-1 registry entry", () => {
    const previous = seedRegistry(100);
    const session = openProject(join(root, "project-101"), "New synthetic project");
    expect(session.manifest).toMatchObject({ name: "New synthetic project", state: null, tables: [], files: [] });
    expect(recentProjects()).toEqual([{ handle: session.handle, path: session.path, name: session.manifest.name }, ...previous]);
    expect(JSON.parse(readFileSync(indexPath(), "utf8"))).toEqual({ version: 1, entries: recentProjects() });
  });

  it("refuses a new project at 1000 entries before creating a directory and preserves the registry bytes", () => {
    expect(PROJECT_REGISTRY_LIMITS.entries).toBe(1_000);
    const previous = seedRegistry(PROJECT_REGISTRY_LIMITS.entries, true);
    const bytes = readFileSync(indexPath());
    // The bounded metadata allocation grows with the entry limit, not project data.
    expect(bytes.length).toBeGreaterThan(512 * 1024);
    expect(bytes.length).toBeLessThan(PROJECT_REGISTRY_LIMITS.bytes);
    expect(recentProjects()).toEqual(previous);
    const target = join(root, "project-overflow");
    expect(() => openProject(target, "Overflow")).toThrow("最近项目数量达到 1000 个上限");
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(indexPath())).toEqual(bytes);
  });

  it("reopens a registered project at capacity with the same handle and no eviction", () => {
    const previous = seedRegistry(PROJECT_REGISTRY_LIMITS.entries);
    const last = previous.at(-1)!;
    const project = LocalProjectStore.create(last.path, last.name);
    const manifestPath = join(project.root, "agentcanvas.project.json"), manifestBytes = readFileSync(manifestPath);
    const session = openProject(last.path);
    expect(session.handle).toBe(last.handle);
    expect(recentProjects()).toEqual([last, ...previous.slice(0, -1)]);
    expect(readFileSync(manifestPath)).toEqual(manifestBytes);
    expect(Object.keys(JSON.parse(readFileSync(indexPath(), "utf8")))).toEqual(["version", "entries"]);
  });
});
