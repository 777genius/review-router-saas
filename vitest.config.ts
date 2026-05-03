import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "packages/**/*.test.ts",
      "packages/**/*.test.tsx",
      "spikes/**/*.test.ts",
    ],
    environment: "node",
    globals: false,
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
    },
  },
});
