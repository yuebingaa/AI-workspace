import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: false,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["core/evaluation/live/**/*.live.ts"],
    passWithNoTests: false,
    testTimeout: 240_000,
  },
});
