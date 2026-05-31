import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@reviewrouter\/subscription-runtime-core\/testing$/,
        replacement: `${root}packages/subscription-runtime/core/src/testing/index.ts`,
      },
      {
        find: /^@reviewrouter\/subscription-runtime-core$/,
        replacement: `${root}packages/subscription-runtime/core/src/index.ts`,
      },
      {
        find: /^@reviewrouter\/subscription-runtime-provider-codex$/,
        replacement: `${root}packages/subscription-runtime/provider-codex/src/index.ts`,
      },
      {
        find: /^@reviewrouter\/subscription-runtime-store-local-file$/,
        replacement: `${root}packages/subscription-runtime/store-local-file/src/index.ts`,
      },
      {
        find: /^@reviewrouter\/subscription-runtime-worker-core$/,
        replacement: `${root}packages/subscription-runtime/worker-core/src/index.ts`,
      },
      {
        find: /^@reviewrouter\/subscription-runtime-worker-codex$/,
        replacement: `${root}packages/subscription-runtime/worker-codex/src/index.ts`,
      },
      {
        find: /^@reviewrouter\/subscription-runtime-queue-core$/,
        replacement: `${root}packages/subscription-runtime/queue-core/src/index.ts`,
      },
      {
        find: /^@reviewrouter\/subscription-runtime-queue-bull$/,
        replacement: `${root}packages/subscription-runtime/queue-bull/src/index.ts`,
      },
    ],
  },
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
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
    },
  },
});
