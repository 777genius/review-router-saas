export type ActionConflictReviewRuntimeGatePhase =
  | "session_exchange"
  | "runtime_config"
  | "posting_session";

export interface ActionConflictReviewRuntimeGatePort {
  assertConflictReviewRuntimeEnabled(input: {
    readonly phase: ActionConflictReviewRuntimeGatePhase;
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly repositoryFullName: string;
  }): Promise<void>;
}
