#!/usr/bin/env node

const checks = [
  ["@777genius/subscription-runtime/core", "createSubscriptionRuntime"],
  ["@777genius/subscription-runtime/provider-codex", "CodexCliSessionDriver"],
  [
    "@777genius/subscription-runtime/runner-github-action",
    "GitHubActionRunner",
  ],
  [
    "@777genius/subscription-runtime/store-local-file",
    "createLocalFileBackendRuntimeAdapters",
  ],
  [
    "@777genius/subscription-runtime/worker-core",
    "BoundedSubscriptionWorkerPool",
  ],
  ["@777genius/subscription-runtime/worker-codex", "FileBackendCodexWorker"],
  [
    "@777genius/subscription-runtime/queue-core",
    "InMemorySubscriptionTaskQueue",
  ],
  ["@777genius/subscription-runtime/queue-bullmq", "BullSubscriptionTaskQueue"],
  ["@777genius/subscription-runtime/testing", "InMemorySessionStore"],
];

for (const [specifier, exportName] of checks) {
  const mod = await import(specifier);
  if (typeof mod[exportName] !== "function") {
    throw new Error(`${specifier} is missing ${exportName}`);
  }
}

console.log("External subscription runtime imports OK.");
