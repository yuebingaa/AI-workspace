// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { triggerBrowserDownload } from "./browser-download";
import { triggerBrowserDownload as legacyDownload } from "@/components/studio/ExcelDownloadButton";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("shared browser download effect", () => {
  it("keeps the old Excel entry as the same function, not a second implementation", () => {
    expect(legacyDownload).toBe(triggerBrowserDownload);
  });

  it("passes the exact Blob and filename and defers URL cleanup until after clicking", () => {
    vi.useFakeTimers();
    const remove = vi.fn(), click = vi.fn(), appendChild = vi.fn(), revokeObjectURL = vi.fn();
    const anchor = { href: "", download: "", click, remove };
    const createObjectURL = vi.fn(() => "blob:synthetic-preview");
    vi.stubGlobal("document", { createElement: () => anchor, body: { appendChild } });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const blob = new Blob(["\uFEFF\"合成列\"\r\n"], { type: "text/csv;charset=utf-8" });
    triggerBrowserDownload(blob, "notebook-合成预览-preview.csv");
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(anchor).toMatchObject({ href: "blob:synthetic-preview", download: "notebook-合成预览-preview.csv" });
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:synthetic-preview");
  });

  it.each(["createElement", "appendChild", "click"])("cleans up the allocated URL when %s fails, without claiming success", (phase) => {
    vi.useFakeTimers();
    const error = new Error(`synthetic ${phase} failure`);
    const remove = vi.fn(), revokeObjectURL = vi.fn();
    const anchor = { href: "", download: "", click: () => { if (phase === "click") throw error; }, remove };
    vi.stubGlobal("document", {
      createElement: () => { if (phase === "createElement") throw error; return anchor; },
      body: { appendChild: () => { if (phase === "appendChild") throw error; } },
    });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:synthetic-failure", revokeObjectURL });
    expect(() => triggerBrowserDownload(new Blob(["synthetic"]), "preview.csv")).toThrow(error);
    expect(remove).toHaveBeenCalledTimes(phase === "createElement" ? 0 : 1);
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:synthetic-failure");
  });

  it("fails before touching DOM if Blob URL allocation is unavailable", () => {
    const createElement = vi.fn(), revokeObjectURL = vi.fn();
    vi.stubGlobal("document", { createElement });
    vi.stubGlobal("URL", { createObjectURL: () => { throw Error("synthetic allocation failure"); }, revokeObjectURL });
    expect(() => triggerBrowserDownload(new Blob(["synthetic"]), "preview.csv")).toThrow("allocation failure");
    expect(createElement).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});
