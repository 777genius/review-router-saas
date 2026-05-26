import type { RunnerCapabilities } from "@reviewrouter/subscription-runtime-core";

export const githubActionRunnerCapabilities: RunnerCapabilities = {
  runnerId: "github-action",
  supportsEnvAllowlist: true,
  supportsWorkingDirectory: true,
  supportsTimeout: true,
  supportsAbortSignal: true,
  supportsOutputRedaction: true,
  supportsReadOnlySandbox: true,
  readOnlyFilesystem: false,
  platform: "github-actions",
};
