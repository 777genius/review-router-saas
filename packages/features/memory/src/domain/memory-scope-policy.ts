import { memoryError } from "./memory-errors";

export type MemoryScope = "repository" | "workspace" | "user_prefs";

export type MemoryScopeContext = {
  readonly workspaceId: string;
  readonly repositoryId: string | null;
  readonly userId: string | null;
  readonly scope: MemoryScope;
};

const repoSpecificPattern =
  /\b(?:repo|repository|project|service|migration|prisma|deploy|database|schema|package|src\/|apps\/|packages\/|\.ts|\.tsx|\.env)\b/i;

export function assertValidMemoryScope(context: MemoryScopeContext): void {
  if (!context.workspaceId.trim()) {
    throw memoryError("memory_input_invalid");
  }
  if (context.scope === "repository" && !context.repositoryId) {
    throw memoryError("memory_scope_forbidden");
  }
  if (context.scope === "workspace" && context.repositoryId !== null) {
    throw memoryError("memory_scope_forbidden");
  }
  if (context.scope === "user_prefs") {
    if (!context.userId || context.repositoryId !== null) {
      throw memoryError("memory_scope_forbidden");
    }
  }
}

export function isSafeUserPreferenceBody(body: string): boolean {
  return repoSpecificPattern.test(body) === false;
}

export function defaultMemoryVisibility(
  scope: MemoryScope,
): "repository_runtime" | "workspace_runtime" | "user_preference_runtime" {
  if (scope === "repository") return "repository_runtime";
  if (scope === "workspace") return "workspace_runtime";
  return "user_preference_runtime";
}
