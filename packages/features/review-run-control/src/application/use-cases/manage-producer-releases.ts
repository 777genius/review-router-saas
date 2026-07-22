import type {
  ProducerReleaseCandidate,
  ReviewOperationalSloThresholds,
  ReviewProtocolLimits,
} from "../../domain/producer-release";
import {
  canonicalReviewOperationalSloProfile,
  canonicalReviewProtocolLimits,
  createProducerRelease,
  createReviewOperationalSloProfile,
  createReviewProtocolLimitsProfile,
} from "../../domain/producer-release";
import {
  ProducerReleaseState,
  ReviewRunControlErrorCode,
  ReviewRunControlDomainError,
} from "../../domain/review-run-control-types";
import type { ClockPort, Sha256DigestPort } from "../ports/platform-ports";
import type {
  ProducerReleaseCommandPort,
  ProducerReleaseQueryPort,
  ReviewOperationalSloProfileCommandPort,
  ReviewOperationalSloProfileQueryPort,
  ReviewProtocolLimitsProfileCommandPort,
  ReviewProtocolLimitsProfileQueryPort,
} from "../ports/producer-release-ports";

export class ManageProducerReleases {
  constructor(
    private readonly dependencies: {
      readonly clock: ClockPort;
      readonly digest: Sha256DigestPort;
      readonly protocolLimitsQueries: ReviewProtocolLimitsProfileQueryPort;
      readonly protocolLimitsCommands: ReviewProtocolLimitsProfileCommandPort;
      readonly operationalSloQueries: ReviewOperationalSloProfileQueryPort;
      readonly operationalSloCommands: ReviewOperationalSloProfileCommandPort;
      readonly releaseQueries: ProducerReleaseQueryPort;
      readonly releaseCommands: ProducerReleaseCommandPort;
      readonly absoluteProtocolMaxima: ReviewProtocolLimits;
    },
  ) {}

  async registerProtocolLimitsProfile(input: {
    readonly protocolLimitsProfileId: string;
    readonly limitsDigest: string;
    readonly limits: ReviewProtocolLimits;
  }) {
    const computedDigest = await this.dependencies.digest.digestUtf8(
      canonicalReviewProtocolLimits(input.limits),
    );
    if (computedDigest !== input.limitsDigest) {
      throw new ReviewRunControlDomainError(
        ReviewRunControlErrorCode.ImmutableConflict,
        "protocol_limits_digest_mismatch",
      );
    }
    const profile = createReviewProtocolLimitsProfile({
      ...input,
      absoluteMaxima: this.dependencies.absoluteProtocolMaxima,
      registeredAt: this.dependencies.clock.now(),
    });
    return this.dependencies.protocolLimitsCommands.registerProtocolLimitsProfile(
      profile,
    );
  }

  async registerOperationalSloProfile(input: {
    readonly operationalSloProfileId: string;
    readonly sloDigest: string;
    readonly thresholds: ReviewOperationalSloThresholds;
    readonly ownerRefs: readonly string[];
    readonly runbookRefs: readonly string[];
  }) {
    const computedDigest = await this.dependencies.digest.digestUtf8(
      canonicalReviewOperationalSloProfile(input),
    );
    if (computedDigest !== input.sloDigest) {
      throw new ReviewRunControlDomainError(
        ReviewRunControlErrorCode.ImmutableConflict,
        "operational_slo_digest_mismatch",
      );
    }
    const profile = createReviewOperationalSloProfile({
      ...input,
      registeredAt: this.dependencies.clock.now(),
    });
    return this.dependencies.operationalSloCommands.registerOperationalSloProfile(
      profile,
    );
  }

  async registerProducerRelease(input: {
    readonly candidate: ProducerReleaseCandidate;
    readonly expectedProtocolLimitsDigest: string;
    readonly expectedOperationalSloDigest: string;
  }) {
    const [limits, slo] = await Promise.all([
      this.dependencies.protocolLimitsQueries.findProtocolLimitsProfileById(
        input.candidate.protocolLimitsProfileId,
      ),
      this.dependencies.operationalSloQueries.findOperationalSloProfileById(
        input.candidate.operationalSloProfileId,
      ),
    ]);
    if (!limits || limits.limitsDigest !== input.expectedProtocolLimitsDigest) {
      throw new ReviewRunControlDomainError(
        ReviewRunControlErrorCode.Missing,
        "protocol_limits_profile_missing_or_mismatched",
      );
    }
    if (!slo || slo.sloDigest !== input.expectedOperationalSloDigest) {
      throw new ReviewRunControlDomainError(
        ReviewRunControlErrorCode.Missing,
        "operational_slo_profile_missing_or_mismatched",
      );
    }
    const release = createProducerRelease(
      input.candidate,
      this.dependencies.clock.now(),
    );
    return this.dependencies.releaseCommands.registerProducerRelease(release);
  }

  async revokeProducerRelease(producerReleaseId: string) {
    const release =
      await this.dependencies.releaseQueries.findProducerReleaseById(
        producerReleaseId,
      );
    if (release?.state === ProducerReleaseState.Revoked) {
      return this.dependencies.releaseCommands.revokeProducerRelease({
        producerReleaseId,
        revokedAt: release.revokedAt ?? this.dependencies.clock.now(),
      });
    }
    return this.dependencies.releaseCommands.revokeProducerRelease({
      producerReleaseId,
      revokedAt: this.dependencies.clock.now(),
    });
  }
}
