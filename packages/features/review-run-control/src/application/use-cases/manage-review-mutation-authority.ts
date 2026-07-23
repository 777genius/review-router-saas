import {
  abortReviewMutationDrain,
  activateReviewMutationEpoch,
  beginReviewMutationDrain,
  initializeDirectV2ReviewMutationAuthority,
  initializeReviewMutationAuthority,
  pauseReviewMutation,
  resumeReviewMutationEpoch,
  ReviewMutationTransitionKind,
  type ReviewMutationAuthority,
  type ReviewMutationTransition,
} from "../../domain/review-mutation-authority";
import {
  ReviewMutationAuthorityProofKind,
  reviewMutationAuthorityProofBlockers,
  reviewMutationAuthorityProofReference,
  type ReviewMutationAuthorityProof,
  type ReviewMutationAuthorityProofReference,
} from "../../domain/review-mutation-authority-proof";
import {
  ReviewMutationLaneKind,
  ReviewMutationAuthorityInitializationMode,
  ReviewMutationMode,
  ReviewRunControlDomainError,
  ReviewRunControlErrorCode,
} from "../../domain/review-run-control-types";
import type { ClockPort } from "../ports/platform-ports";
import {
  ReviewMutationAuthorityWriteStatus,
  type ReviewMutationAuthorityCommandPort,
  type ReviewMutationAuthorityQueryPort,
} from "../ports/review-mutation-authority-ports";
import type { ReviewMutationAuthorityInitializationPolicyPort } from "../ports/review-mutation-authority-proof-ports";
import type { ReviewMutationAuthorityProofCollector } from "../services/review-mutation-authority-proof-collector";

export enum ReviewMutationAuthorityCommandKind {
  InitializeV1 = "initialize_v1",
  DirectV2Initialize = "direct_v2_initialize",
  BeginDrain = "begin_drain",
  AbortDrain = "abort_drain",
  Activate = "activate",
  Pause = "pause",
  Resume = "resume",
}

export enum ReviewMutationAuthorityPreflightStatus {
  Ready = "ready",
  Blocked = "blocked",
  Missing = "missing",
}

export type ReviewMutationAuthorityPreflight =
  | {
      readonly status: ReviewMutationAuthorityPreflightStatus.Missing;
      readonly operation: ReviewMutationAuthorityCommandKind;
    }
  | {
      readonly status:
        | ReviewMutationAuthorityPreflightStatus.Ready
        | ReviewMutationAuthorityPreflightStatus.Blocked;
      readonly operation: ReviewMutationAuthorityCommandKind;
      readonly authority: ReviewMutationAuthority | null;
      readonly proof: ReviewMutationAuthorityProof | null;
      readonly blockers: readonly string[];
    };

export class ManageReviewMutationAuthority {
  constructor(
    private readonly dependencies: {
      readonly clock: ClockPort;
      readonly queries: ReviewMutationAuthorityQueryPort;
      readonly commands: ReviewMutationAuthorityCommandPort;
      readonly proofs: ReviewMutationAuthorityProofCollector;
      readonly initializationPolicy: ReviewMutationAuthorityInitializationPolicyPort;
    },
  ) {}

  async preflight(input: {
    readonly scmRepositoryIdentityId: string;
    readonly operation: ReviewMutationAuthorityCommandKind;
  }): Promise<ReviewMutationAuthorityPreflight> {
    const authority = await this.findAuthority(input.scmRepositoryIdentityId);
    if (
      input.operation === ReviewMutationAuthorityCommandKind.DirectV2Initialize
    ) {
      if (authority) {
        return {
          status: ReviewMutationAuthorityPreflightStatus.Blocked,
          operation: input.operation,
          authority,
          proof: null,
          blockers: Object.freeze(["authority_already_initialized"]),
        };
      }
      const proof =
        await this.dependencies.proofs.collectDirectV2Initialization(
          input.scmRepositoryIdentityId,
          this.dependencies.clock.now(),
        );
      const blockers = reviewMutationAuthorityProofBlockers(proof);
      return {
        status:
          blockers.length === 0
            ? ReviewMutationAuthorityPreflightStatus.Ready
            : ReviewMutationAuthorityPreflightStatus.Blocked,
        operation: input.operation,
        authority: null,
        proof,
        blockers,
      };
    }
    if (!authority) {
      return {
        status: ReviewMutationAuthorityPreflightStatus.Missing,
        operation: input.operation,
      };
    }
    const stateBlockers = modeBlockers(input.operation, authority.mode);
    if (stateBlockers.length > 0) {
      return {
        status: ReviewMutationAuthorityPreflightStatus.Blocked,
        operation: input.operation,
        authority,
        proof: null,
        blockers: stateBlockers,
      };
    }
    const proofKind = proofKindFor(input.operation);
    const proof = proofKind
      ? await this.dependencies.proofs.collect(
          proofKind,
          authority,
          this.dependencies.clock.now(),
        )
      : null;
    const blockers = Object.freeze([
      ...(proof ? reviewMutationAuthorityProofBlockers(proof) : []),
    ]);
    return {
      status:
        blockers.length === 0
          ? ReviewMutationAuthorityPreflightStatus.Ready
          : ReviewMutationAuthorityPreflightStatus.Blocked,
      operation: input.operation,
      authority,
      proof,
      blockers,
    };
  }

  async initialize(input: { readonly scmRepositoryIdentityId: string }) {
    const initializationMode =
      await this.dependencies.initializationPolicy.selectInitializationMode({
        scmRepositoryIdentityId: input.scmRepositoryIdentityId,
        laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
      });
    if (
      initializationMode === ReviewMutationAuthorityInitializationMode.DirectV2
    ) {
      const collectedProof =
        await this.dependencies.proofs.collectDirectV2Initialization(
          input.scmRepositoryIdentityId,
          this.dependencies.clock.now(),
        );
      const proof =
        await this.dependencies.proofs.revalidateDirectV2Initialization(
          input.scmRepositoryIdentityId,
          reviewMutationAuthorityProofReference(collectedProof),
          this.dependencies.clock.now(),
        );
      const transition = initializeDirectV2ReviewMutationAuthority({
        scmRepositoryIdentityId: input.scmRepositoryIdentityId,
        proof: requireProofKind(
          proof,
          ReviewMutationAuthorityProofKind.DirectV2Initialize,
        ),
      });
      return this.dependencies.commands.initializeReviewMutationAuthority(
        transition.authority,
      );
    }
    const transition = initializeReviewMutationAuthority({
      ...input,
      initializedAt: this.dependencies.clock.now(),
    });
    return this.dependencies.commands.initializeReviewMutationAuthority(
      transition.authority,
    );
  }

  async initializeV1(input: { readonly scmRepositoryIdentityId: string }) {
    const transition = initializeReviewMutationAuthority({
      ...input,
      initializedAt: this.dependencies.clock.now(),
    });
    return this.dependencies.commands.initializeReviewMutationAuthority(
      transition.authority,
    );
  }

  async initializeDirectV2(input: {
    readonly scmRepositoryIdentityId: string;
    readonly proof: ReviewMutationAuthorityProofReference;
  }) {
    if (
      input.proof.kind !==
        ReviewMutationAuthorityProofKind.DirectV2Initialize ||
      input.proof.authorityVersion !== 0 ||
      input.proof.scmRepositoryIdentityId !== input.scmRepositoryIdentityId
    ) {
      throw new ReviewRunControlDomainError(
        ReviewRunControlErrorCode.ProofRequired,
        "direct_v2_initialization_proof_command_mismatch",
      );
    }
    const proof =
      await this.dependencies.proofs.revalidateDirectV2Initialization(
        input.scmRepositoryIdentityId,
        input.proof,
        this.dependencies.clock.now(),
      );
    const transition = initializeDirectV2ReviewMutationAuthority({
      scmRepositoryIdentityId: input.scmRepositoryIdentityId,
      proof: requireProofKind(
        proof,
        ReviewMutationAuthorityProofKind.DirectV2Initialize,
      ),
    });
    return this.dependencies.commands.initializeReviewMutationAuthority(
      transition.authority,
    );
  }

  async beginDrain(input: {
    readonly scmRepositoryIdentityId: string;
    readonly expectedVersion: number;
    readonly drainPolicyVersion: number;
    readonly drainWindowMs: number;
  }) {
    return this.transition(
      input.scmRepositoryIdentityId,
      input.expectedVersion,
      (authority) =>
        beginReviewMutationDrain(authority, {
          expectedVersion: input.expectedVersion,
          drainPolicyVersion: input.drainPolicyVersion,
          drainWindowMs: input.drainWindowMs,
          now: this.dependencies.clock.now(),
        }),
    );
  }

  async abortDrain(input: {
    readonly scmRepositoryIdentityId: string;
    readonly expectedVersion: number;
    readonly proof: ReviewMutationAuthorityProofReference;
  }) {
    return this.proofedTransition(
      input.scmRepositoryIdentityId,
      input.expectedVersion,
      input.proof,
      ReviewMutationAuthorityProofKind.AbortDrain,
      (authority, proof) =>
        abortReviewMutationDrain(authority, {
          expectedVersion: input.expectedVersion,
          proof: requireProofKind(
            proof,
            ReviewMutationAuthorityProofKind.AbortDrain,
          ),
        }),
    );
  }

  async activate(input: {
    readonly scmRepositoryIdentityId: string;
    readonly expectedVersion: number;
    readonly proof: ReviewMutationAuthorityProofReference;
  }) {
    return this.proofedTransition(
      input.scmRepositoryIdentityId,
      input.expectedVersion,
      input.proof,
      ReviewMutationAuthorityProofKind.Activate,
      (authority, proof) =>
        activateReviewMutationEpoch(authority, {
          expectedVersion: input.expectedVersion,
          proof: requireProofKind(
            proof,
            ReviewMutationAuthorityProofKind.Activate,
          ),
        }),
    );
  }

  async pause(input: {
    readonly scmRepositoryIdentityId: string;
    readonly expectedVersion: number;
  }) {
    return this.transition(
      input.scmRepositoryIdentityId,
      input.expectedVersion,
      (authority) =>
        pauseReviewMutation(authority, {
          expectedVersion: input.expectedVersion,
          pausedAt: this.dependencies.clock.now(),
        }),
    );
  }

  async resume(input: {
    readonly scmRepositoryIdentityId: string;
    readonly expectedVersion: number;
    readonly proof: ReviewMutationAuthorityProofReference;
  }) {
    return this.proofedTransition(
      input.scmRepositoryIdentityId,
      input.expectedVersion,
      input.proof,
      ReviewMutationAuthorityProofKind.Resume,
      (authority, proof) =>
        resumeReviewMutationEpoch(authority, {
          expectedVersion: input.expectedVersion,
          proof: requireProofKind(
            proof,
            ReviewMutationAuthorityProofKind.Resume,
          ),
        }),
    );
  }

  private async proofedTransition(
    scmRepositoryIdentityId: string,
    expectedVersion: number,
    proofReference: ReviewMutationAuthorityProofReference,
    kind: ReviewMutationAuthorityProofKind,
    decide: (
      authority: ReviewMutationAuthority,
      proof: ReviewMutationAuthorityProof,
    ) => ReviewMutationTransition,
  ) {
    if (
      proofReference.authorityVersion !== expectedVersion ||
      proofReference.scmRepositoryIdentityId !== scmRepositoryIdentityId
    ) {
      throw new ReviewRunControlDomainError(
        ReviewRunControlErrorCode.ProofRequired,
        "mutation_authority_proof_command_mismatch",
      );
    }
    const authority = await this.findAuthority(scmRepositoryIdentityId);
    if (!authority) {
      return { status: ReviewMutationAuthorityWriteStatus.Missing } as const;
    }
    const proof = await this.dependencies.proofs.revalidate(
      kind,
      authority,
      proofReference,
      this.dependencies.clock.now(),
    );
    return this.persistTransition(expectedVersion, decide(authority, proof));
  }

  private async transition(
    scmRepositoryIdentityId: string,
    expectedVersion: number,
    decide: (authority: ReviewMutationAuthority) => ReviewMutationTransition,
  ) {
    const authority = await this.findAuthority(scmRepositoryIdentityId);
    if (!authority) {
      return { status: ReviewMutationAuthorityWriteStatus.Missing } as const;
    }
    return this.persistTransition(expectedVersion, decide(authority));
  }

  private async persistTransition(
    expectedVersion: number,
    transition: ReviewMutationTransition,
  ) {
    if (transition.kind === ReviewMutationTransitionKind.Idempotent) {
      return {
        status: ReviewMutationAuthorityWriteStatus.Restored,
        authority: transition.authority,
      } as const;
    }
    return this.dependencies.commands.compareAndSetReviewMutationAuthority({
      expectedVersion,
      authority: transition.authority,
    });
  }

  private findAuthority(scmRepositoryIdentityId: string) {
    return this.dependencies.queries.findReviewMutationAuthority({
      scmRepositoryIdentityId,
      laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
    });
  }
}

export type ReviewMutationAuthorityOperatorUseCases = Pick<
  ManageReviewMutationAuthority,
  | "preflight"
  | "initializeV1"
  | "initializeDirectV2"
  | "beginDrain"
  | "abortDrain"
  | "activate"
  | "pause"
  | "resume"
>;

function proofKindFor(
  operation: ReviewMutationAuthorityCommandKind,
): ReviewMutationAuthorityProofKind | null {
  switch (operation) {
    case ReviewMutationAuthorityCommandKind.AbortDrain:
      return ReviewMutationAuthorityProofKind.AbortDrain;
    case ReviewMutationAuthorityCommandKind.Activate:
      return ReviewMutationAuthorityProofKind.Activate;
    case ReviewMutationAuthorityCommandKind.Resume:
      return ReviewMutationAuthorityProofKind.Resume;
    case ReviewMutationAuthorityCommandKind.DirectV2Initialize:
    case ReviewMutationAuthorityCommandKind.InitializeV1:
    case ReviewMutationAuthorityCommandKind.BeginDrain:
    case ReviewMutationAuthorityCommandKind.Pause:
      return null;
  }
}

function modeBlockers(
  operation: ReviewMutationAuthorityCommandKind,
  mode: ReviewMutationMode,
): readonly string[] {
  if (operation === ReviewMutationAuthorityCommandKind.InitializeV1) {
    return Object.freeze(["authority_already_initialized"]);
  }
  const ready =
    (operation === ReviewMutationAuthorityCommandKind.BeginDrain &&
      (mode === ReviewMutationMode.V1Open ||
        mode === ReviewMutationMode.V1Draining)) ||
    (operation === ReviewMutationAuthorityCommandKind.AbortDrain &&
      (mode === ReviewMutationMode.V1Open ||
        mode === ReviewMutationMode.V1Draining)) ||
    (operation === ReviewMutationAuthorityCommandKind.Activate &&
      mode === ReviewMutationMode.V1Draining) ||
    (operation === ReviewMutationAuthorityCommandKind.Pause &&
      (mode === ReviewMutationMode.V2Active ||
        mode === ReviewMutationMode.Paused)) ||
    (operation === ReviewMutationAuthorityCommandKind.Resume &&
      mode === ReviewMutationMode.Paused);
  return ready ? [] : Object.freeze([`operation_not_allowed_from_${mode}`]);
}

function requireProofKind<TKind extends ReviewMutationAuthorityProofKind>(
  proof: ReviewMutationAuthorityProof,
  kind: TKind,
): Extract<ReviewMutationAuthorityProof, { readonly kind: TKind }> {
  if (proof.kind !== kind) {
    throw new ReviewRunControlDomainError(
      ReviewRunControlErrorCode.ProofRequired,
      "mutation_authority_proof_kind_mismatch",
    );
  }
  return proof as Extract<
    ReviewMutationAuthorityProof,
    { readonly kind: TKind }
  >;
}
