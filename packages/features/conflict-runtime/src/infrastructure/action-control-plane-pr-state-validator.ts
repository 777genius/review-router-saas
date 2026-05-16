import type { ActionConflictReviewRuntimeConfig } from "@reviewrouter/features-action-control-plane";
import type {
  ConflictRuntimePrStateValidatorPort,
  ConflictRuntimeValidationPhase,
} from "../application/conflict-runtime-runner.js";
import type { ActionControlPlaneRuntimeConfigClient } from "./action-control-plane-runtime-config-client.js";

export type ActionControlPlanePrStateValidatorOptions = {
  readonly configClient: Pick<
    ActionControlPlaneRuntimeConfigClient,
    "fetchConflictRuntimeConfig"
  >;
  readonly sessionToken: string;
};

export class ActionControlPlanePrStateValidator implements ConflictRuntimePrStateValidatorPort {
  private readonly configClient: Pick<
    ActionControlPlaneRuntimeConfigClient,
    "fetchConflictRuntimeConfig"
  >;
  private readonly sessionToken: string;

  constructor(options: ActionControlPlanePrStateValidatorOptions) {
    this.configClient = options.configClient;
    this.sessionToken = options.sessionToken;
  }

  async assertCurrentPrState(input: {
    readonly phase: ConflictRuntimeValidationPhase;
    readonly config: ActionConflictReviewRuntimeConfig;
    readonly manifestHash?: string | undefined;
  }): Promise<void> {
    const latest = await this.configClient.fetchConflictRuntimeConfig({
      sessionToken: this.sessionToken,
    });
    assertSameConflictRuntimeConfig(input.config, latest.conflictReview);
  }
}

function assertSameConflictRuntimeConfig(
  expected: ActionConflictReviewRuntimeConfig,
  actual: ActionConflictReviewRuntimeConfig,
): void {
  const fields = [
    "dispatchId",
    "pullRequestNumber",
    "headSha",
    "baseRef",
    "baseSha",
  ] as const;
  for (const field of fields) {
    if (String(expected[field]) !== String(actual[field])) {
      throw new Error(`conflict_runtime_pr_state_stale:${field}`);
    }
  }
  if (
    expected.checkout.headSha !== actual.checkout.headSha ||
    expected.checkout.baseSha !== actual.checkout.baseSha ||
    expected.diff.headSha !== actual.diff.headSha ||
    expected.diff.baseSha !== actual.diff.baseSha
  ) {
    throw new Error("conflict_runtime_pr_state_stale:checkout_diff");
  }
  if (expected.posting.mode !== actual.posting.mode) {
    throw new Error("conflict_runtime_pr_state_stale:posting_mode");
  }
}
