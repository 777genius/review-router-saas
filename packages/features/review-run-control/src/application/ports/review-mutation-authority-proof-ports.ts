import type {
  ReviewMutationAbortProofFacts,
  ReviewMutationActivationProofFacts,
  ReviewMutationDirectV2InitializationProofFacts,
  ReviewMutationResumeProofFacts,
} from "../../domain/review-mutation-authority-proof";
import type {
  ReviewMutationAuthorityInitializationMode,
  ReviewMutationLaneKind,
} from "../../domain/review-run-control-types";

export type ReviewMutationAuthorityProofQuery = {
  readonly scmRepositoryIdentityId: string;
  readonly laneKind: ReviewMutationLaneKind;
};

export type ReviewMutationAuthorityProofFactsSnapshot<TFacts> = {
  readonly factsVersion: string;
  readonly facts: TFacts;
};

export interface ReviewMutationAbortProofFactsQueryPort {
  inspectAbortDrainFacts(
    input: ReviewMutationAuthorityProofQuery,
  ): Promise<
    ReviewMutationAuthorityProofFactsSnapshot<ReviewMutationAbortProofFacts>
  >;
}

export interface ReviewMutationDirectV2InitializationProofFactsQueryPort {
  inspectDirectV2InitializationFacts(
    input: ReviewMutationAuthorityProofQuery,
  ): Promise<
    ReviewMutationAuthorityProofFactsSnapshot<ReviewMutationDirectV2InitializationProofFacts>
  >;
}

export interface ReviewMutationActivationProofFactsQueryPort {
  inspectActivationFacts(
    input: ReviewMutationAuthorityProofQuery,
  ): Promise<
    ReviewMutationAuthorityProofFactsSnapshot<ReviewMutationActivationProofFacts>
  >;
}

export interface ReviewMutationResumeProofFactsQueryPort {
  inspectResumeFacts(
    input: ReviewMutationAuthorityProofQuery,
  ): Promise<
    ReviewMutationAuthorityProofFactsSnapshot<ReviewMutationResumeProofFacts>
  >;
}

export type ReviewMutationAuthorityProofFactsQueryPorts =
  ReviewMutationDirectV2InitializationProofFactsQueryPort &
    ReviewMutationAbortProofFactsQueryPort &
    ReviewMutationActivationProofFactsQueryPort &
    ReviewMutationResumeProofFactsQueryPort;

export interface ReviewMutationAuthorityInitializationPolicyPort {
  selectInitializationMode(input: {
    readonly scmRepositoryIdentityId: string;
    readonly laneKind: ReviewMutationLaneKind;
  }): Promise<ReviewMutationAuthorityInitializationMode>;
}
