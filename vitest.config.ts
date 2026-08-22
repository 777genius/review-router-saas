import { configDefaults, defineConfig } from "vitest/config";

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
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.REVIEW_ROUTER_RUN_HOSTED_POOL_POSTGRES_E2E === "1"
        ? []
        : ["scripts/hosted-pool-e2e/hosted-pool-postgres.e2e.test.ts"]),
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
