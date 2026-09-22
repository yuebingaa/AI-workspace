import { describe, expect, it } from "vitest";
import { DEFAULT_NOTEBOOK_CAPABILITIES } from "../capabilities";
import {
  NotebookCapabilityConfigurationError,
  notebookCapabilitiesFromEnvironment,
} from "./capabilities";

describe("Notebook server capability configuration", () => {
  it("enables Python by default and accepts explicit enabled values", () => {
    expect(notebookCapabilitiesFromEnvironment({})).toBe(DEFAULT_NOTEBOOK_CAPABILITIES);
    for (const value of ["true", "TRUE", "1", "on", " ON "]) {
      expect(notebookCapabilitiesFromEnvironment({ NOTEBOOK_PYTHON_ENABLED: value }))
        .toBe(DEFAULT_NOTEBOOK_CAPABILITIES);
    }
  });

  it("disables Python with a stable user-facing reason", () => {
    for (const value of ["false", "FALSE", "0", "off", " OFF "]) {
      expect(notebookCapabilitiesFromEnvironment({ NOTEBOOK_PYTHON_ENABLED: value })).toEqual({
        python: {
          enabled: false,
          reason: "Python Notebook 能力已通过服务器配置关闭",
        },
      });
    }
  });

  it.each(["", "yes", "disabled", "2"])("rejects invalid value %j instead of silently enabling", (value) => {
    expect(() => notebookCapabilitiesFromEnvironment({ NOTEBOOK_PYTHON_ENABLED: value }))
      .toThrow(NotebookCapabilityConfigurationError);
    expect(() => notebookCapabilitiesFromEnvironment({ NOTEBOOK_PYTHON_ENABLED: value }))
      .toThrow("NOTEBOOK_PYTHON_ENABLED 配置无效");
  });
});
