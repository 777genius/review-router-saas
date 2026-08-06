import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type {
  RegisterReviewPublicationRequestV2RoutesDependencies,
  RegisterReviewSnapshotReadV2RoutesDependencies,
} from "@reviewrouter/features-action-control-plane/v2";
import { ReviewActionV2RouteFailure } from "@reviewrouter/features-action-control-plane/v2";
import {
  ReviewCoverageState,
  type ReviewExecutionQueryPort,
  type FinalizedReviewProjectionArtifact,
  type ReviewExecutionSnapshot,
} from "@reviewrouter/features-review-executions";
import { PrismaReviewExecutionStore } from "@reviewrouter/features-review-executions/composition";
import {
  CurrentMutationAuthorityStatus,
  CurrentPublicationPermitStatus,
  CurrentReviewRevisionStatus,
  CurrentReviewSafetyDecisionStatus,
  RequestReviewPublicationStatus,
  ReviewPublicationAttemptState,
  ReviewPublicationAdjudicationEvidenceStatus,
  ReviewPublicationCapability,
  ReviewPublicationGateRejectedError,
  ReviewPublicationGateRejectionReason,
  ReviewPublicationPlanningError,
  ReviewPublicationPlanningErrorCode,
  ReviewPublicationProjectionCoverage,
  ReviewPublicationLifecycleObservationVersion,
  ReviewPublicationLifecycleExpectationStatus,
  ReviewPublicationRunControlStatus,
  ResolveCurrentPublicationLifecycle,
  renderCanonicalReviewPublication,
  resolveReviewPublicationRenderPolicyVersion,
  resolveCurrentReviewPublicationOperationIdentity,
  reviewPublicationAttemptId,
  planReviewPublicationOperations,
  publishedReviewProjectionPublicationEnvelopeVersion,
  reviewPublicationLifecycleExpectationFromProjection,
  type LiveReviewPublicationLifecyclePort,
  type PublishedReviewProjectionPublicationEnvelope,
  type ReviewPublicationAttemptView,
  type ReviewPublicationAttemptQueryPort,
  type ReviewPublicationDecisionPorts,
  type ReviewPublicationPermitIdentity,
  type ReviewPublicationPlanningLimits,
} from "@reviewrouter/features-review-publishing/v2";
import {
  PrismaReviewPublicationRepository,
  createReviewPublicationV2Application,
} from "@reviewrouter/features-review-publishing/v2/composition";
import {
  ProducerReleaseState,
  ReviewMutationLaneKind,
  ReviewMutationMode,
  ReviewRunAuthorizationState,
  ReviewRunAuthorizationTokenResolutionStatus,
  ReviewSafetyDecisionKind,
  canonicalJson,
  type ProducerReleaseQueryPort,
  type ReviewMutationAuthorityQueryPort,
  type ReviewProtocolLimitsProfileQueryPort,
  type ReviewRunAuthorization,
  type ReviewRunAuthorizationQueryPort,
  type ReviewSafetyDecisionResolverPort,
} from "@reviewrouter/features-review-run-control";
import {
  ReviewSnapshotV2RestoreMode,
  ReviewSnapshotV2RestoreStatus,
  restoreReviewSnapshotV2,
  type ReviewSnapshotV2QueryPort,
} from "@reviewrouter/features-review-snapshots/v2";
import { PrismaReviewSnapshotV2Repository } from "@reviewrouter/features-review-snapshots/v2/composition";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  canonicalizeReviewActionV2Request,
  ReviewActionV2OperationId,
  ReviewActionV2ProtocolErrorCode,
  ReviewPublicationRequestResultStatus,
  ReviewPublicationStatusResultStatus,
  ReviewSnapshotRestoreResultStatus,
  type ReviewPublicationRequest,
  type ReviewPublicationStatusRequest,
  type ReviewSnapshotRestoreRequest,
} from "@reviewrouter/protocol-review-action-v2";
import type {
  ReviewActionV2AuthorizationResolverPort,
  ReviewActionV2DigestPort,
} from "./review-action-v2-execution-evidence-composition.js";
import type { ReviewActionV2RouteFailureStatus } from "@reviewrouter/features-action-control-plane/v2";
import type {
  ReviewActionV2ExecutionEvidenceCapabilityAdapter,
  VerifiedReviewActionV2PublicationPermit,
} from "./review-action-v2-execution-evidence-capabilities.js";

type Runtime = Pick<
  RegisterReviewSnapshotReadV2RoutesDependencies,
  "readServerTime" | "createRequestId"
>;

type ReleaseQueries = ProducerReleaseQueryPort &
  ReviewProtocolLimitsProfileQueryPort;
type FinalizedExecutionQueries = Pick<
  ReviewExecutionQueryPort,
  "findExecution"
>;

export interface ReviewPublicationContextPolicyPort {
  assertCurrentPolicy(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly snapshot: ReviewExecutionSnapshot;
  }): Promise<void>;
}

export function composeReviewActionV2SnapshotPublicationRoutes(input: {
  readonly runtime: Runtime;
  readonly prisma: PrismaClient;
  readonly authorizations: ReviewActionV2AuthorizationResolverPort;
  readonly authorizationQueries: ReviewRunAuthorizationQueryPort;
  readonly releases: ReleaseQueries;
  readonly authorities: ReviewMutationAuthorityQueryPort;
  readonly safety: ReviewSafetyDecisionResolverPort;
  readonly executions: PrismaReviewExecutionStore;
  readonly capabilities: ReviewActionV2ExecutionEvidenceCapabilityAdapter;
  readonly digest: ReviewActionV2DigestPort;
  readonly liveLifecycle: LiveReviewPublicationLifecyclePort;
  readonly contextPolicy: ReviewPublicationContextPolicyPort;
  readonly now: () => Date;
}): Readonly<{
  snapshot: RegisterReviewSnapshotReadV2RoutesDependencies;
  publication: RegisterReviewPublicationRequestV2RoutesDependencies;
}> {
  const snapshots = new PrismaReviewSnapshotV2Repository(input.prisma);
  const publications = new PrismaReviewPublicationRepository(input.prisma);
  const publicationApplication = createReviewPublicationV2Application({
    clock: { now: input.now },
    decisions: productionPublicationDecisions({
      executions: input.executions,
      releases: input.releases,
      authorizations: input.authorizations,
      authorizationQueries: input.authorizationQueries,
      authorities: input.authorities,
      safety: input.safety,
      liveLifecycle: input.liveLifecycle,
      contextPolicy: input.contextPolicy,
    }),
    attempts: publications,
    idempotency: publications,
    adjudicationEvidence: {
      async resolve() {
        return {
          status: ReviewPublicationAdjudicationEvidenceStatus.Unavailable,
          reason: "operator_adjudication_requires_live_inventory",
        };
      },
    },
    commands: {
      requests: publications,
      claims: publications,
      claimRenewals: publications,
      operationBegins: publications,
      effects: publications,
      completions: publications,
      terminalizations: publications,
      adjudications: publications,
    },
    enabledCapabilities: new Set([ReviewPublicationCapability.Request]),
  });

  return createReviewActionV2SnapshotPublicationRoutes({
    runtime: input.runtime,
    authorizations: input.authorizations,
    executions: input.executions,
    releases: input.releases,
    snapshots,
    publications,
    requestPublication: publicationApplication.request,
    capabilities: input.capabilities,
    digest: input.digest,
    contextPolicy: input.contextPolicy,
    now: input.now,
  });
}

export function createReviewActionV2SnapshotPublicationRoutes(input: {
  readonly runtime: Runtime;
  readonly authorizations: ReviewActionV2AuthorizationResolverPort;
  readonly executions: FinalizedExecutionQueries;
  readonly releases: ReleaseQueries;
  readonly snapshots: ReviewSnapshotV2QueryPort;
  readonly publications: ReviewPublicationAttemptQueryPort;
  readonly requestPublication: ReturnType<
    typeof createReviewPublicationV2Application
  >["request"];
  readonly capabilities: ReviewActionV2ExecutionEvidenceCapabilityAdapter;
  readonly digest: ReviewActionV2DigestPort;
  readonly contextPolicy: ReviewPublicationContextPolicyPort;
  readonly now: () => Date;
}): Readonly<{
  snapshot: RegisterReviewSnapshotReadV2RoutesDependencies;
  publication: RegisterReviewPublicationRequestV2RoutesDependencies;
}> {
  return Object.freeze({
    snapshot: {
      ...input.runtime,
      restore: {
        capabilityEnabled: true,
        execute: (request) =>
          restoreSnapshot(request, {
            authorizations: input.authorizations,
            snapshots: input.snapshots,
            now: input.now,
          }),
      },
    },
    publication: {
      ...input.runtime,
      request: {
        capabilityEnabled: true,
        execute: (request) =>
          requestPublication(request, {
            authorizations: input.authorizations,
            executions: input.executions,
            releases: input.releases,
            publications: input.publications,
            requestPublication: input.requestPublication,
            capabilities: input.capabilities,
            digest: input.digest,
            contextPolicy: input.contextPolicy,
            now: input.now,
          }),
      },
      status: {
        capabilityEnabled: true,
        execute: (request) =>
          readPublicationStatus(request, {
            authorizations: input.authorizations,
            publications: input.publications,
            now: input.now,
          }),
      },
    },
  });
}

async function restoreSnapshot(
  request: ReviewSnapshotRestoreRequest,
  dependencies: {
    readonly authorizations: ReviewActionV2AuthorizationResolverPort;
    readonly snapshots: ReviewSnapshotV2QueryPort;
    readonly now: () => Date;
  },
) {
  const authorization = await requireAuthorization(
    request.authorizationToken,
    dependencies.authorizations,
  );
  if (request.reviewRevisionHash !== authorization.reviewRevisionHash) {
    return {
      statusCode: 200,
      result: { status: ReviewSnapshotRestoreResultStatus.RevisionChanged },
    } as const;
  }
  const restored = await restoreReviewSnapshotV2(
    {
      scope: authorizationScope(authorization),
      now: dependencies.now(),
      trustedRepositoryBinding: true,
      reviewRevisionHash: request.reviewRevisionHash,
      mode: ReviewSnapshotV2RestoreMode.ExactProjection,
    },
    { snapshots: dependencies.snapshots },
  );
  if (restored.status !== ReviewSnapshotV2RestoreStatus.Found) {
    return {
      statusCode: 200,
      result: { status: snapshotRestoreStatus(restored.status) },
    } as const;
  }
  return {
    statusCode: 200,
    result: {
      status: ReviewSnapshotRestoreResultStatus.Found,
      snapshotVersion: restored.snapshot.version,
      sourceExecutionId: restored.snapshot.sourceExecutionId,
      sourceExecutionGeneration:
        restored.snapshot.sourceExecutionGeneration.toString(10),
      restoreMode: restored.mode,
      payloadCanonicalJson: canonicalJson(restored.payload),
      lineageHintsCanonicalJson: canonicalJson(restored.lineageHints),
    },
  } as const;
}

async function requestPublication(
  request: ReviewPublicationRequest,
  dependencies: {
    readonly authorizations: ReviewActionV2AuthorizationResolverPort;
    readonly executions: FinalizedExecutionQueries;
    readonly releases: ReleaseQueries;
    readonly publications: ReviewPublicationAttemptQueryPort;
    readonly requestPublication: ReturnType<
      typeof createReviewPublicationV2Application
    >["request"];
    readonly capabilities: ReviewActionV2ExecutionEvidenceCapabilityAdapter;
    readonly digest: ReviewActionV2DigestPort;
    readonly contextPolicy: ReviewPublicationContextPolicyPort;
    readonly now: () => Date;
  },
) {
  await assertRequestBodyHash(request, dependencies.digest);
  const authorization = await requireAuthorization(
    request.authorizationToken,
    dependencies.authorizations,
  );
  const now = dependencies.now();
  const verified = await verifyPublicationPermit(
    request.publicationPermit,
    now,
    dependencies.capabilities,
  );
  const snapshot = await dependencies.executions.findExecution(
    verified.executionId,
  );
  if (!snapshot?.artifact) {
    throw routeFailure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "artifact_missing",
    );
  }
  const artifact = snapshot.artifact;
  assertArtifactAuthority({ authorization, artifact, verified });
  if (request.projectionHash !== artifact.projectionHash) {
    throw routeFailure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "publication_projection_mismatch",
    );
  }
  const release = await dependencies.releases.findProducerReleaseById(
    artifact.publicationPermit.producerReleaseId,
  );
  const limits = await dependencies.releases.findProtocolLimitsProfileById(
    authorization.protocolLimitsProfileId,
  );
  if (
    !release ||
    release.state !== ProducerReleaseState.Registered ||
    !limits ||
    release.protocolLimitsProfileId !== limits.protocolLimitsProfileId ||
    Buffer.byteLength(request.operationsCanonicalJson, "utf8") >
      limits.maxPublicationBodyBytes
  ) {
    throw routeFailure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "publication_release_or_limits_invalid",
    );
  }
  const envelope = publishedEnvelope({
    artifact,
    projectionCanonicalJson: artifact.projectionEnvelopeJson,
    requestedPublishingCanonicalJson: request.operationsCanonicalJson,
    protocolLimitsProfileId: limits.protocolLimitsProfileId,
    limitsDigest: limits.limitsDigest,
  });
  const publicationAttemptId = reviewPublicationAttemptId({
    executionId: artifact.executionId,
    artifactId: artifact.artifactId,
    projectionHash: artifact.projectionHash,
    digestUtf8: sha256,
  });
  const existing =
    await dependencies.publications.findById(publicationAttemptId);
  const command = resolvePublicationCommand({
    artifact,
    envelope,
    limits: publicationLimits(
      artifact.publicationPermit.producerReleaseId,
      limits,
    ),
    publicationAttemptId,
    existing,
  });
  if (existing) {
    if (existing.attempt.requestHash !== command.requestHash) {
      return {
        statusCode: 200,
        result: {
          status: ReviewPublicationRequestResultStatus.Conflict,
          publicationAttemptId: null,
          publicationState: null,
          pollAfterMs: null,
        },
      } as const;
    }
    return {
      statusCode: 200,
      result: {
        status: ReviewPublicationRequestResultStatus.Restored,
        publicationAttemptId: existing.attempt.publicationAttemptId,
        publicationState: existing.attempt.state,
        pollAfterMs:
          existing.attempt.state === ReviewPublicationAttemptState.Terminal
            ? null
            : 1_000,
      },
    } as const;
  }
  await assertCurrentPublicationContextPolicy({
    contextPolicy: dependencies.contextPolicy,
    authorization,
    snapshot,
  });
  let result;
  try {
    result = await dependencies.requestPublication(command);
    if (
      result.status === RequestReviewPublicationStatus.IdentityConflict ||
      result.status === RequestReviewPublicationStatus.RequestConflict
    ) {
      const recovered = await recoverPublicationRequest({
        artifact,
        envelope,
        limits: publicationLimits(
          artifact.publicationPermit.producerReleaseId,
          limits,
        ),
        publicationAttemptId: command.publicationAttemptId,
        command,
        publications: dependencies.publications,
        requestPublication: dependencies.requestPublication,
      });
      if (recovered) return recovered;
    }
  } catch (error) {
    if (error instanceof ReviewPublicationGateRejectedError) {
      if (
        error.reason ===
        ReviewPublicationGateRejectionReason.PublicationFactsUnavailable
      ) {
        throw routeFailure(
          429,
          ReviewActionV2ProtocolErrorCode.CapacityLimited,
          error.reason,
        );
      }
      throw routeFailure(
        412,
        ReviewActionV2ProtocolErrorCode.StalePrecondition,
        error.reason,
      );
    }
    const recovered = await recoverPublicationRequest({
      artifact,
      envelope,
      limits: publicationLimits(
        artifact.publicationPermit.producerReleaseId,
        limits,
      ),
      publicationAttemptId: command.publicationAttemptId,
      command,
      publications: dependencies.publications,
      requestPublication: dependencies.requestPublication,
    });
    if (recovered) return recovered;
    throw error;
  }
  switch (result.status) {
    case RequestReviewPublicationStatus.Applied:
      return {
        statusCode: 201,
        result: {
          status: ReviewPublicationRequestResultStatus.Accepted,
          publicationAttemptId: result.attempt.publicationAttemptId,
          publicationState: result.attempt.state,
          pollAfterMs: 1_000,
        },
      } as const;
    case RequestReviewPublicationStatus.Restored:
      return {
        statusCode: 200,
        result: {
          status: ReviewPublicationRequestResultStatus.Restored,
          publicationAttemptId: result.attempt.publicationAttemptId,
          publicationState: result.attempt.state,
          pollAfterMs:
            result.attempt.state === ReviewPublicationAttemptState.Terminal
              ? null
              : 1_000,
        },
      } as const;
    case RequestReviewPublicationStatus.IdentityConflict:
    case RequestReviewPublicationStatus.RequestConflict:
      return {
        statusCode: 200,
        result: {
          status: ReviewPublicationRequestResultStatus.Conflict,
          publicationAttemptId: null,
          publicationState: null,
          pollAfterMs: null,
        },
      } as const;
  }
}

async function recoverPublicationRequest(input: {
  readonly artifact: FinalizedReviewProjectionArtifact;
  readonly envelope: PublishedReviewProjectionPublicationEnvelope;
  readonly limits: ReviewPublicationPlanningLimits;
  readonly publicationAttemptId: string;
  readonly command: ReturnType<typeof resolvePublicationCommand>;
  readonly publications: ReviewPublicationAttemptQueryPort;
  readonly requestPublication: ReturnType<
    typeof createReviewPublicationV2Application
  >["request"];
}) {
  const byId = await input.publications.findById(input.publicationAttemptId);
  const byPermit =
    byId?.attempt.publicationAttemptId === input.publicationAttemptId
      ? null
      : await input.publications.findByPermitIdentity(input.command.permit);
  for (const existing of [byId, byPermit]) {
    if (!existing) continue;
    if (existing.attempt.requestHash === input.command.requestHash) {
      return restoredPublicationRequest(existing);
    }
    const recovered = resolvePublicationCommand({
      artifact: input.artifact,
      envelope: input.envelope,
      limits: input.limits,
      publicationAttemptId: input.publicationAttemptId,
      existing,
    });
    if (recovered.requestHash === input.command.requestHash) continue;
    try {
      const result = await input.requestPublication(recovered);
      if (
        result.status === RequestReviewPublicationStatus.Applied ||
        result.status === RequestReviewPublicationStatus.Restored
      ) {
        return restoredPublicationAttempt(result.attempt);
      }
    } catch {
      // A racing writer can still make the request idempotent; fall through.
    }
  }
  return null;
}

function restoredPublicationRequest(view: ReviewPublicationAttemptView) {
  return restoredPublicationAttempt(view.attempt);
}

function restoredPublicationAttempt(
  attempt: ReviewPublicationAttemptView["attempt"],
) {
  return {
    statusCode: 200,
    result: {
      status: ReviewPublicationRequestResultStatus.Restored,
      publicationAttemptId: attempt.publicationAttemptId,
      publicationState: attempt.state,
      pollAfterMs:
        attempt.state === ReviewPublicationAttemptState.Terminal ? null : 1_000,
    },
  } as const;
}

async function assertCurrentPublicationContextPolicy(input: {
  readonly contextPolicy: ReviewPublicationContextPolicyPort;
  readonly authorization: ReviewRunAuthorization;
  readonly snapshot: ReviewExecutionSnapshot;
}) {
  try {
    await input.contextPolicy.assertCurrentPolicy({
      authorization: input.authorization,
      snapshot: input.snapshot,
    });
  } catch (error) {
    if (error instanceof ReviewActionV2RouteFailure) throw error;
    throw routeFailure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "publication_context_policy_stale",
    );
  }
}

async function readPublicationStatus(
  request: ReviewPublicationStatusRequest,
  dependencies: {
    readonly authorizations: ReviewActionV2AuthorizationResolverPort;
    readonly publications: ReviewPublicationAttemptQueryPort;
    readonly now: () => Date;
  },
) {
  const authorization = await requireAuthorization(
    request.authorizationToken,
    dependencies.authorizations,
  );
  const view = await dependencies.publications.findById(
    request.publicationAttemptId,
  );
  if (!view) {
    throw routeFailure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "publication_attempt_missing",
    );
  }
  assertPublicationReadAuthority(view, authorization);
  return {
    statusCode: 200,
    result: {
      status: publicationStatus(view.attempt.state),
      publicationAttemptId: view.attempt.publicationAttemptId,
      terminalOutcome: view.attempt.terminalOutcome,
      canonicalReceiptSetHash:
        view.attempt.state === ReviewPublicationAttemptState.Terminal
          ? publicationReceiptSetHash(view)
          : null,
      pollAfterMs:
        view.attempt.state === ReviewPublicationAttemptState.Terminal
          ? null
          : 1_000,
    },
  } as const;
}

function productionPublicationDecisions(input: {
  readonly executions: PrismaReviewExecutionStore;
  readonly releases: ProducerReleaseQueryPort;
  readonly authorizations: ReviewActionV2AuthorizationResolverPort;
  readonly authorizationQueries: ReviewRunAuthorizationQueryPort;
  readonly authorities: ReviewMutationAuthorityQueryPort;
  readonly safety: ReviewSafetyDecisionResolverPort;
  readonly liveLifecycle: LiveReviewPublicationLifecyclePort;
  readonly contextPolicy: ReviewPublicationContextPolicyPort;
}): ReviewPublicationDecisionPorts {
  const lifecycle = new ResolveCurrentPublicationLifecycle({
    expectations: {
      async resolve(scope) {
        try {
          const stream = await input.executions.findStream(scope);
          const snapshot = stream?.activeExecutionId
            ? await input.executions.findExecution(stream.activeExecutionId)
            : null;
          const artifact = snapshot?.artifact;
          if (!artifact) {
            return {
              status: ReviewPublicationLifecycleExpectationStatus.Missing,
            };
          }
          const authorization =
            await input.authorizationQueries.findReviewRunAuthorizationById(
              artifact.publicationPermit.authorizationId,
            );
          if (!authorization) {
            return {
              status: ReviewPublicationLifecycleExpectationStatus.Missing,
            };
          }
          return reviewPublicationLifecycleExpectationFromProjection({
            reviewedHeadSha: artifact.reviewedHeadSha,
            lifecycleStateHash: artifact.lifecycleStateHash,
            commandLedgerWatermark: artifact.commandLedgerWatermark,
            projectionEnvelopeJson: artifact.projectionEnvelopeJson,
            legacyObservationBoundary: authorization.createdAt,
          });
        } catch {
          return {
            status: ReviewPublicationLifecycleExpectationStatus.Unavailable,
          };
        }
      },
    },
    live: input.liveLifecycle,
  });
  return {
    permits: {
      async resolve(identity) {
        try {
          const snapshot = await input.executions.findExecution(
            identity.executionId,
          );
          const artifact = snapshot?.artifact;
          if (!artifact) {
            return {
              status: CurrentPublicationPermitStatus.Missing,
              reason: "finalized_artifact_missing",
            };
          }
          const stream = await input.executions.findStream(
            artifact.publicationPermit,
          );
          if (
            artifact.generation !== identity.generation ||
            artifact.projectionHash !== identity.projectionHash ||
            stream?.activeExecutionId !== identity.executionId ||
            stream.lastAllocatedGeneration !== identity.generation
          ) {
            return {
              status: CurrentPublicationPermitStatus.Stale,
              reason: "execution_permit_not_current",
            };
          }
          const authorization =
            await input.authorizationQueries.findReviewRunAuthorizationById(
              artifact.publicationPermit.authorizationId,
            );
          if (!authorization) {
            return {
              status: CurrentPublicationPermitStatus.Stale,
              reason: "execution_context_policy_authorization_missing",
            };
          }
          try {
            await input.contextPolicy.assertCurrentPolicy({
              authorization,
              snapshot,
            });
          } catch {
            return {
              status: CurrentPublicationPermitStatus.Stale,
              reason: "execution_context_policy_stale",
            };
          }
          return {
            status: CurrentPublicationPermitStatus.Current,
            permit: artifact.publicationPermit,
          };
        } catch {
          return {
            status: CurrentPublicationPermitStatus.Unavailable,
            reason: "execution_permit_unavailable",
          };
        }
      },
    },
    runControl: {
      async resolve(identity) {
        try {
          const [authorization, release] = await Promise.all([
            input.authorizationQueries.findReviewRunAuthorizationById(
              identity.authorizationId,
            ),
            input.releases.findProducerReleaseById(identity.producerReleaseId),
          ]);
          if (
            !authorization ||
            !release ||
            authorization.producerReleaseId !== identity.producerReleaseId
          ) {
            return {
              status: ReviewPublicationRunControlStatus.Missing,
              ...identity,
            };
          }
          if (authorization.state === ReviewRunAuthorizationState.Revoked) {
            return {
              status: ReviewPublicationRunControlStatus.AuthorizationRevoked,
              ...identity,
            };
          }
          if (release.state === ProducerReleaseState.Revoked) {
            return {
              status: ReviewPublicationRunControlStatus.ProducerReleaseRevoked,
              ...identity,
            };
          }
          return {
            status: ReviewPublicationRunControlStatus.Allowed,
            ...identity,
          };
        } catch {
          return {
            status: ReviewPublicationRunControlStatus.Unavailable,
            ...identity,
          };
        }
      },
    },
    authority: {
      async resolve(scope) {
        try {
          const authority = await input.authorities.findReviewMutationAuthority(
            {
              scmRepositoryIdentityId: scope.scmRepositoryIdentityId,
              laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
            },
          );
          if (!authority) {
            return {
              status: CurrentMutationAuthorityStatus.Missing,
              mutationEpoch: null,
            };
          }
          return {
            status:
              authority.mode === ReviewMutationMode.V2Active
                ? CurrentMutationAuthorityStatus.Active
                : CurrentMutationAuthorityStatus.Inactive,
            mutationEpoch: authority.epoch,
          };
        } catch {
          return {
            status: CurrentMutationAuthorityStatus.Unavailable,
            mutationEpoch: null,
          };
        }
      },
    },
    revision: {
      async resolve(scope) {
        try {
          const stream = await input.executions.findStream(scope);
          if (!stream?.currentRevision) {
            return {
              status: CurrentReviewRevisionStatus.Missing,
              reviewedHeadSha: null,
              reviewRevisionHash: null,
            };
          }
          return {
            status: CurrentReviewRevisionStatus.Current,
            reviewedHeadSha: stream.currentRevision.headSha,
            reviewRevisionHash: stream.currentRevision.reviewRevisionHash,
          };
        } catch {
          return {
            status: CurrentReviewRevisionStatus.Unavailable,
            reviewedHeadSha: null,
            reviewRevisionHash: null,
          };
        }
      },
    },
    lifecycle: {
      resolve: (scope) => lifecycle.resolve(scope),
    },
    safety: {
      async resolve(request) {
        try {
          const decision = await input.safety.resolveReviewSafetyPolicy({
            decisionKind: ReviewSafetyDecisionKind.PublicationMutation,
            target: request.scope,
          });
          return {
            status: decision.effectAllowed
              ? CurrentReviewSafetyDecisionStatus.Allowed
              : CurrentReviewSafetyDecisionStatus.Disabled,
            decisionHash: decision.safetyDecisionHash,
          };
        } catch {
          return {
            status: CurrentReviewSafetyDecisionStatus.Unavailable,
            decisionHash: null,
          };
        }
      },
    },
  };
}

function publishedEnvelope(input: {
  readonly artifact: FinalizedReviewProjectionArtifact;
  readonly projectionCanonicalJson: string;
  readonly requestedPublishingCanonicalJson: string;
  readonly protocolLimitsProfileId: string;
  readonly limitsDigest: string;
}): PublishedReviewProjectionPublicationEnvelope {
  const projection = parseCanonicalRecord(
    input.projectionCanonicalJson,
    "projection_envelope_invalid",
  );
  if (
    canonicalJson(projection.publishing) !==
    input.requestedPublishingCanonicalJson
  ) {
    throw routeFailure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "publication_payload_mismatch",
    );
  }
  const publishing = publicationProjection(projection.publishing);
  const coverage =
    input.artifact.coverageState === ReviewCoverageState.Partial
      ? ReviewPublicationProjectionCoverage.Partial
      : ReviewPublicationProjectionCoverage.Completed;
  const rendered = renderCanonicalReviewPublication(
    {
      coverage,
      renderPolicyVersion: resolveReviewPublicationRenderPolicyVersion(
        input.artifact.projectionPolicyVersion,
      ),
      targetCommitId: input.artifact.reviewedHeadSha,
      source: publishing,
    },
    {
      digestUtf8: sha256,
      utf8ByteLength: (value) => Buffer.byteLength(value, "utf8"),
    },
  );
  return {
    envelopeVersion: publishedReviewProjectionPublicationEnvelopeVersion,
    producerReleaseId: input.artifact.publicationPermit.producerReleaseId,
    protocolLimitsProfileId: input.protocolLimitsProfileId,
    limitsDigest: input.limitsDigest,
    projectionHash: input.artifact.projectionHash,
    coverage,
    targetCommitId: input.artifact.reviewedHeadSha,
    reviewRevisionHash: input.artifact.reviewRevisionHash,
    renderPolicyVersion: resolveReviewPublicationRenderPolicyVersion(
      input.artifact.projectionPolicyVersion,
    ),
    publicationNotAfter: new Date(
      input.artifact.publicationPermit.publicationNotAfter,
    ),
    summary: {
      semantic: rendered.summary.semantic,
      ...bodyFactsOf(rendered.summary),
    },
    managedCheck:
      rendered.managedCheck === null
        ? null
        : bodyFactsOf(rendered.managedCheck),
    inlineReviews: rendered.inlineReviews.map((entry) => ({
      chunkIndex: entry.chunkIndex,
      delivery: entry.delivery,
      create: bodyFactsOf(entry.create),
      submit: bodyFactsOf(entry.submit),
    })),
    lifecycle: rendered.lifecycle.map((entry) => ({
      chunkIndex: entry.chunkIndex,
      semantic: entry.semantic,
      ...bodyFactsOf(entry),
    })),
  };
}

function publicationProjection(value: unknown) {
  const root = exactRecordWithOptional(
    value,
    ["summary", "check", "inlineReviewChunks", "lifecycle"],
    ["lifecycleObservationVersion"],
    "publication_projection_shape_invalid",
  );
  const lifecycleObservationVersion = publicationLifecycleObservationVersion(
    root.lifecycleObservationVersion,
  );
  const summary = exactRecord(
    root.summary,
    ["marker", "body", "allClear", "occurrenceCounts"],
    "publication_summary_shape_invalid",
  );
  const occurrenceCounts = occurrenceCountsOf(summary.occurrenceCounts);
  const check = exactRecord(
    root.check,
    ["marker", "name", "title", "summary", "conclusion"],
    "publication_check_shape_invalid",
  );
  if (
    !Array.isArray(root.inlineReviewChunks) ||
    !Array.isArray(root.lifecycle)
  ) {
    throw routeFailure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "publication_projection_shape_invalid",
    );
  }
  return {
    ...(lifecycleObservationVersion === null
      ? {}
      : { lifecycleObservationVersion }),
    summary: {
      marker: boundedString(summary.marker, 4_096),
      body: boundedString(summary.body, 1_000_000),
      allClear: boolean(summary.allClear),
      occurrenceCounts,
    },
    check: {
      marker: boundedString(check.marker, 4_096),
      name: boundedString(check.name, 512),
      title: boundedString(check.title, 4_096),
      summary: boundedString(check.summary, 1_000_000),
      conclusion: conclusion(check.conclusion),
    },
    inlineReviewChunks: root.inlineReviewChunks.map((value, index) => {
      const chunk = exactRecord(
        value,
        ["chunkIndex", "marker", "bodyHash", "comments"],
        "publication_chunk_shape_invalid",
      );
      if (chunk.chunkIndex !== index || !Array.isArray(chunk.comments)) {
        throw routeFailure(
          422,
          ReviewActionV2ProtocolErrorCode.InvariantViolation,
          "publication_chunk_order_invalid",
        );
      }
      return {
        chunkIndex: index,
        marker: boundedString(chunk.marker, 4_096),
        bodyHash: sha256String(chunk.bodyHash),
        comments: chunk.comments.map((value) => {
          const comment = publicationComment(value);
          boundedString(comment.lineageId, 512);
          optionalPositiveInteger(comment.endLine);
          return {
            marker: boundedString(comment.marker, 4_096),
            path: boundedString(comment.path, 4_096),
            startLine: optionalPositiveInteger(comment.startLine),
            line: positiveInteger(comment.line),
            body: boundedString(comment.body, 1_000_000),
          };
        }),
      };
    }),
    lifecycle: root.lifecycle.map((value) => {
      const entry = exactRecordWithOptional(
        value,
        [
          "targetId",
          "threadId",
          "verdict",
          "reasonCodes",
          "mutationEligible",
          ...(lifecycleObservationVersion === null
            ? []
            : ["markerFingerprint", "threadStateHash"]),
        ],
        ["lineageId"],
        "publication_lifecycle_shape_invalid",
      );
      optionalBoundedString(entry.lineageId, 512);
      boundedStringArray(entry.reasonCodes, 256, 512);
      const observation =
        lifecycleObservationVersion === null
          ? {}
          : {
              markerFingerprint: lifecycleMarkerFingerprint(
                entry.markerFingerprint,
              ),
              threadStateHash: sha256String(entry.threadStateHash),
            };
      return {
        targetId: boundedString(entry.targetId, 512),
        threadId: boundedString(entry.threadId, 512),
        verdict: boundedString(entry.verdict, 64),
        mutationEligible: boolean(entry.mutationEligible),
        ...observation,
      };
    }),
  };
}

function publicationLifecycleObservationVersion(
  value: unknown,
): ReviewPublicationLifecycleObservationVersion | null {
  if (value === undefined) return null;
  if (value !== ReviewPublicationLifecycleObservationVersion.ThreadStateV1) {
    throw routeFailure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "publication_lifecycle_observation_version_invalid",
    );
  }
  return value;
}

function lifecycleMarkerFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{24,64}$/u.test(value)) {
    throw routeFailure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "publication_lifecycle_marker_fingerprint_invalid",
    );
  }
  return value;
}

function deterministicPublicationCommand(
  publicationAttemptId: string,
  artifact: FinalizedReviewProjectionArtifact,
  operations: ReturnType<typeof planReviewPublicationOperations>,
) {
  const requestIdHash = sha256(
    `rr.publication-request.v2\0${publicationAttemptId}`,
  );
  const createdAt = new Date(artifact.createdAt);
  const retainUntil = new Date(artifact.retainUntil);
  const permit = artifact.publicationPermit;
  return {
    publicationAttemptId,
    requestIdHash,
    requestHash: sha256(
      canonicalJson({
        publicationAttemptId,
        requestIdHash,
        permit,
        operations,
        createdAt,
        retainUntil,
      }),
    ),
    permit,
    operations,
    createdAt,
    retainUntil,
  };
}

function resolvePublicationCommand(input: {
  readonly artifact: FinalizedReviewProjectionArtifact;
  readonly envelope: PublishedReviewProjectionPublicationEnvelope;
  readonly limits: ReviewPublicationPlanningLimits;
  readonly publicationAttemptId: string;
  readonly existing: ReviewPublicationAttemptView | null;
}) {
  let operations;
  try {
    operations = planReviewPublicationOperations({
      identity: resolveCurrentReviewPublicationOperationIdentity({
        publicationAttemptId: input.publicationAttemptId,
        projectionHash: input.artifact.projectionHash,
        existingOperationIds:
          input.existing?.attempt.operations.map(
            (operation) => operation.publicationOperationId,
          ) ?? null,
      }),
      envelope: input.envelope,
      limits: input.limits,
    });
  } catch (error) {
    throw mapPlanningFailure(error);
  }
  if (operations.length === 0) {
    throw routeFailure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "publication_operations_empty",
    );
  }
  return deterministicPublicationCommand(
    input.publicationAttemptId,
    input.artifact,
    operations,
  );
}

function assertArtifactAuthority(input: {
  readonly authorization: ReviewRunAuthorization;
  readonly artifact: FinalizedReviewProjectionArtifact;
  readonly verified: VerifiedReviewActionV2PublicationPermit;
}): void {
  const permit = input.artifact.publicationPermit;
  const executionStateValid =
    input.artifact.coverageState === ReviewCoverageState.Completed ||
    input.artifact.coverageState === ReviewCoverageState.Partial;
  if (
    !executionStateValid ||
    permit.authorizationId !== input.authorization.authorizationId ||
    !sameScope(permit, input.authorization) ||
    permit.executionId !== input.verified.executionId ||
    permit.authorizationId !== input.verified.authorizationId ||
    permit.generation !== input.verified.generation ||
    permit.reviewRevisionHash !== input.verified.reviewRevisionHash ||
    permit.reviewedHeadSha !== input.verified.reviewedHeadSha ||
    permit.projectionHash !== input.verified.projectionHash ||
    permit.lifecycleStateHash !== input.verified.lifecycleStateHash ||
    permit.commandLedgerWatermark !== input.verified.commandLedgerWatermark ||
    permit.permitEpoch !== input.verified.permitEpoch ||
    permit.publicationSafetyDecisionHash !==
      input.verified.publicationSafetyDecisionHash ||
    !sameJwtNumericDate(
      permit.publicationNotAfter,
      input.verified.publicationNotAfter,
    )
  ) {
    throw routeFailure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "publication_permit_authority_mismatch",
    );
  }
}

function sameJwtNumericDate(left: Date, right: Date): boolean {
  return (
    Math.floor(left.getTime() / 1_000) === Math.floor(right.getTime() / 1_000)
  );
}

async function requireAuthorization(
  token: string,
  resolver: ReviewActionV2AuthorizationResolverPort,
) {
  let resolved;
  try {
    resolved = await resolver.resolveReviewRunAuthorizationToken({ token });
  } catch {
    throw routeFailure(
      401,
      ReviewActionV2ProtocolErrorCode.InvalidAuthentication,
      "authorization_token_invalid",
    );
  }
  if (resolved.status !== ReviewRunAuthorizationTokenResolutionStatus.Valid) {
    throw routeFailure(
      401,
      ReviewActionV2ProtocolErrorCode.InvalidAuthentication,
      `authorization_${resolved.status}`,
    );
  }
  return resolved.authorization;
}

async function verifyPublicationPermit(
  token: string,
  now: Date,
  capabilities: ReviewActionV2ExecutionEvidenceCapabilityAdapter,
) {
  try {
    return await capabilities.verifyPublicationPermit(token, now);
  } catch {
    throw routeFailure(
      401,
      ReviewActionV2ProtocolErrorCode.InvalidAuthentication,
      "publication_permit_invalid",
    );
  }
}

async function assertRequestBodyHash(
  request: ReviewPublicationRequest,
  digest: ReviewActionV2DigestPort,
) {
  const actual = await digest.digestUtf8(
    canonicalizeReviewActionV2Request(
      ReviewActionV2OperationId.ReviewPublicationRequest,
      request,
    ),
  );
  if (actual !== request.requestBodyHash) {
    throw routeFailure(
      400,
      ReviewActionV2ProtocolErrorCode.InvalidRequest,
      "request_body_hash_mismatch",
    );
  }
}

function publicationLimits(
  producerReleaseId: string,
  limits: NonNullable<
    Awaited<
      ReturnType<
        ReviewProtocolLimitsProfileQueryPort["findProtocolLimitsProfileById"]
      >
    >
  >,
): ReviewPublicationPlanningLimits {
  return {
    producerReleaseId,
    protocolLimitsProfileId: limits.protocolLimitsProfileId,
    limitsDigest: limits.limitsDigest,
    maxPublicationOperations: limits.maxPublicationOperations,
    maxPublicationChunks: limits.maxPublicationChunks,
    maxPublicationBodyBytes: limits.maxPublicationBodyBytes,
    maxReconciliationDurationMs: limits.maxReconciliationDurationMs,
  };
}

function mapPlanningFailure(error: unknown) {
  if (!(error instanceof ReviewPublicationPlanningError)) return error;
  const limit = [
    ReviewPublicationPlanningErrorCode.OperationLimitExceeded,
    ReviewPublicationPlanningErrorCode.ChunkLimitExceeded,
    ReviewPublicationPlanningErrorCode.BodyLimitExceeded,
  ].includes(error.code);
  return routeFailure(
    limit ? 413 : 422,
    limit
      ? ReviewActionV2ProtocolErrorCode.LimitExceeded
      : ReviewActionV2ProtocolErrorCode.InvariantViolation,
    error.code,
  );
}

function publicationReceiptSetHash(view: ReviewPublicationAttemptView): string {
  return sha256(
    canonicalJson(
      [...view.receipts]
        .map((receipt) => ({
          operationId: receipt.publicationOperationId,
          receiptHash: receipt.receiptHash,
          status: receipt.status,
        }))
        .sort((left, right) =>
          left.operationId.localeCompare(right.operationId),
        ),
    ),
  );
}

function publicationStatus(state: ReviewPublicationAttemptState) {
  switch (state) {
    case ReviewPublicationAttemptState.Pending:
      return ReviewPublicationStatusResultStatus.Pending;
    case ReviewPublicationAttemptState.Publishing:
      return ReviewPublicationStatusResultStatus.Publishing;
    case ReviewPublicationAttemptState.Reconciling:
      return ReviewPublicationStatusResultStatus.Reconciling;
    case ReviewPublicationAttemptState.Terminal:
      return ReviewPublicationStatusResultStatus.Terminal;
  }
}

function snapshotRestoreStatus(status: ReviewSnapshotV2RestoreStatus) {
  switch (status) {
    case ReviewSnapshotV2RestoreStatus.Missing:
      return ReviewSnapshotRestoreResultStatus.Missing;
    case ReviewSnapshotV2RestoreStatus.Expired:
      return ReviewSnapshotRestoreResultStatus.Expired;
    case ReviewSnapshotV2RestoreStatus.RevisionChanged:
      return ReviewSnapshotRestoreResultStatus.RevisionChanged;
    case ReviewSnapshotV2RestoreStatus.LegacyUntrusted:
      return ReviewSnapshotRestoreResultStatus.LegacyUntrusted;
    case ReviewSnapshotV2RestoreStatus.TrustRejected:
      return ReviewSnapshotRestoreResultStatus.TrustRejected;
    case ReviewSnapshotV2RestoreStatus.Found:
      return ReviewSnapshotRestoreResultStatus.Found;
  }
}

function assertPublicationReadAuthority(
  view: ReviewPublicationAttemptView,
  authorization: ReviewRunAuthorization,
) {
  if (
    view.attempt.permit.authorizationId !== authorization.authorizationId ||
    !sameScope(view.attempt.permit, authorization)
  ) {
    throw routeFailure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "publication_status_scope_mismatch",
    );
  }
}

function sameScope(
  permit: ReviewPublicationPermitIdentity,
  authorization: ReviewRunAuthorization,
) {
  return (
    permit.workspaceId === authorization.workspaceId &&
    permit.repositoryConnectionId === authorization.repositoryConnectionId &&
    permit.scmRepositoryIdentityId === authorization.scmRepositoryIdentityId &&
    permit.pullRequestNumber === authorization.pullRequestNumber
  );
}

function authorizationScope(authorization: ReviewRunAuthorization) {
  return {
    workspaceId: authorization.workspaceId,
    repositoryConnectionId: authorization.repositoryConnectionId,
    scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
    pullRequestNumber: authorization.pullRequestNumber,
  };
}

function bodyFactsOf(value: {
  readonly markerHash: string;
  readonly bodyHash: string;
  readonly bodyByteCount: number;
}) {
  return {
    markerHash: value.markerHash,
    bodyHash: value.bodyHash,
    bodyByteCount: value.bodyByteCount,
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseCanonicalRecord(value: string, issue: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw routeFailure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      issue,
    );
  }
  if (!isRecord(parsed) || canonicalJson(parsed) !== value) {
    throw routeFailure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      issue,
    );
  }
  return parsed;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  issue: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw routeFailure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      issue,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw routeFailure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      issue,
    );
  }
  return value;
}

function exactRecordWithOptional(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  issue: string,
) {
  if (!isRecord(value)) {
    throw routeFailure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      issue,
    );
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const actual = Object.keys(value);
  if (
    requiredKeys.some((key) => !(key in value)) ||
    actual.some((key) => !allowed.has(key))
  ) {
    throw routeFailure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      issue,
    );
  }
  return value;
}

function publicationComment(value: unknown) {
  return exactRecordWithOptional(
    value,
    ["lineageId", "marker", "path", "line", "body"],
    ["startLine", "endLine"],
    "publication_comment_shape_invalid",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxBytes: number) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw routeFailure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "publication_string_invalid",
    );
  }
  return value;
}

function boolean(value: unknown) {
  if (typeof value !== "boolean") {
    throw routeFailure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "publication_boolean_invalid",
    );
  }
  return value;
}

function positiveInteger(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw routeFailure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "publication_line_invalid",
    );
  }
  return value as number;
}

function optionalPositiveInteger(value: unknown) {
  return value === undefined ? null : positiveInteger(value);
}

function optionalBoundedString(value: unknown, maxBytes: number) {
  return value === undefined ? null : boundedString(value, maxBytes);
}

function boundedStringArray(
  value: unknown,
  maxEntries: number,
  maxEntryBytes: number,
) {
  if (!Array.isArray(value) || value.length > maxEntries) {
    throw routeFailure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "publication_string_array_invalid",
    );
  }
  value.forEach((entry) => boundedString(entry, maxEntryBytes));
}

function occurrenceCountsOf(value: unknown) {
  const counts = exactRecord(
    value,
    [
      "new",
      "reconfirmed",
      "changed",
      "carried_unverified",
      "resolved",
      "uncertain",
      "suppressed_by_human",
    ],
    "publication_occurrence_counts_invalid",
  );
  Object.values(counts).forEach((count) => {
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw routeFailure(
        422,
        ReviewActionV2ProtocolErrorCode.InvariantViolation,
        "publication_occurrence_counts_invalid",
      );
    }
  });
  if (
    !Number.isSafeInteger(
      Object.values(counts).reduce<number>(
        (sum, count) => sum + (count as number),
        0,
      ),
    )
  ) {
    throw routeFailure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "publication_occurrence_counts_invalid",
    );
  }
  return {
    new: counts.new as number,
    reconfirmed: counts.reconfirmed as number,
    changed: counts.changed as number,
    carried_unverified: counts.carried_unverified as number,
    resolved: counts.resolved as number,
    uncertain: counts.uncertain as number,
    suppressed_by_human: counts.suppressed_by_human as number,
  };
}

function sha256String(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw routeFailure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "publication_hash_invalid",
    );
  }
  return value;
}

function conclusion(value: unknown): "success" | "failure" | "neutral" {
  if (value !== "success" && value !== "failure" && value !== "neutral") {
    throw routeFailure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "publication_conclusion_invalid",
    );
  }
  return value;
}

function routeFailure(
  statusCode: ReviewActionV2RouteFailureStatus,
  errorCode: ReviewActionV2ProtocolErrorCode,
  issue: string,
) {
  return new ReviewActionV2RouteFailure(statusCode, errorCode, [issue]);
}
