import { initializeReviewMutationAuthority } from "../../domain/review-mutation-authority";
import { ReviewMutationLaneKind } from "../../domain/review-run-control-types";
import type { ClockPort } from "../ports/platform-ports";
import type {
  ReviewMutationAuthorityCommandPort,
  ReviewMutationAuthorityQueryPort,
} from "../ports/review-mutation-authority-ports";

/**
 * Establishes the durable V1 fence before any legacy mutation capability can
 * be issued. The command repository serializes this create with Direct V2
 * initialization, so a concurrent lane decision cannot be overwritten.
 */
export class AdmitLegacyReviewMutation {
  constructor(
    private readonly dependencies: {
      readonly clock: ClockPort;
      readonly queries: ReviewMutationAuthorityQueryPort;
      readonly commands: ReviewMutationAuthorityCommandPort;
    },
  ) {}

  async admit(input: { readonly scmRepositoryIdentityId: string }) {
    const query = {
      scmRepositoryIdentityId: input.scmRepositoryIdentityId,
      laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
    } as const;
    const current =
      await this.dependencies.queries.findReviewMutationAuthority(query);
    if (current) return current;

    const initialized = initializeReviewMutationAuthority({
      scmRepositoryIdentityId: input.scmRepositoryIdentityId,
      initializedAt: this.dependencies.clock.now(),
    });
    const result =
      await this.dependencies.commands.initializeReviewMutationAuthority(
        initialized.authority,
      );
    return result.authority;
  }
}
