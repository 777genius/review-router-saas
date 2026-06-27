import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "packages/**/*.test.ts",
      "packages/**/*.test.tsx",
      "scripts/**/*.test.ts",
      "spikes/**/*.test.ts",
    ],
    environment: "node",
    globals: false,
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
    },
  },
});
