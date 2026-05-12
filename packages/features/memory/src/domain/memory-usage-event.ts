import { createHash } from "node:crypto";

export type MemoryUsageRuntimeContext = {
  readonly githubRunId: string;
  readonly githubRunAttempt: string;
  readonly eventName: string;
};

export function createMemoryUsageDedupeKey(input: {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly memoryItemId: string;
  readonly eventType: "action_bundle_exposed";
  readonly bundleVersion: number;
  readonly runtimeContext: MemoryUsageRuntimeContext;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        input.workspaceId,
        input.repositoryId,
        input.memoryItemId,
        input.eventType,
        input.bundleVersion,
        input.runtimeContext.githubRunId,
        input.runtimeContext.githubRunAttempt,
        input.runtimeContext.eventName,
      ]),
      "utf8",
    )
    .digest("hex");
  return `mem_usage:${digest}`;
}
