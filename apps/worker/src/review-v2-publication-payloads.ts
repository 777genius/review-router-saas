import { createHash } from "node:crypto";
import type { FinalizedReviewProjectionArtifact } from "@reviewrouter/features-review-executions";
import {
  ReviewPublicationInlineReviewDelivery,
  ReviewPublicationKind,
  ReviewPublicationLifecycleSemantic,
  ReviewPublicationProjectionCoverage,
  ReviewPublicationSummarySemantic,
  publishedReviewProjectionPublicationEnvelopeVersion,
  renderCanonicalReviewPublication,
  type PublishedReviewProjectionPublicationEnvelope,
  type ReviewPublicationOperation,
  type ReviewPublicationPermitIdentity,
} from "@reviewrouter/features-review-publishing/v2";
import {
  LineageHintEvictionReason,
  LineageHintState,
  SnapshotOccurrenceState,
  type LineageHintIndex,
  type OccurrenceProvenanceDto,
} from "@reviewrouter/features-review-snapshots/v2";
import type { ReviewCompletionProjectionMapperPort } from "./review-v2-context-adapters";

export enum ReviewV2PublicationPayloadKind {
  Summary = "summary",
  ManagedCheck = "managed_check",
  PendingReviewCreate = "pending_review_create",
  PendingReviewSubmit = "pending_review_submit",
  SubmittedReview = "submitted_review",
  ThreadLifecycle = "thread_lifecycle",
}

type ReviewV2PublicationPayloadIdentity = {
  readonly marker: string;
  readonly markerHash: string;
  readonly bodyHash: string;
  readonly bodyByteCount: number;
};

export type ReviewV2PublicationPayload =
  | (ReviewV2PublicationPayloadIdentity & {
      readonly kind: ReviewV2PublicationPayloadKind.Summary;
      readonly body: string;
    })
  | (ReviewV2PublicationPayloadIdentity & {
      readonly kind: ReviewV2PublicationPayloadKind.ManagedCheck;
      readonly name: string;
      readonly title: string;
      readonly summary: string;
      readonly conclusion: "success" | "failure" | "neutral";
    })
  | (ReviewV2PublicationPayloadIdentity & {
      readonly kind:
        | ReviewV2PublicationPayloadKind.PendingReviewCreate
        | ReviewV2PublicationPayloadKind.SubmittedReview;
      readonly body: string;
      readonly comments: readonly {
        readonly path: string;
        readonly line: number;
        readonly startLine: number | null;
        readonly body: string;
      }[];
    })
  | (ReviewV2PublicationPayloadIdentity & {
      readonly kind: ReviewV2PublicationPayloadKind.PendingReviewSubmit;
      readonly body: string;
    })
  | (ReviewV2PublicationPayloadIdentity & {
      readonly kind: ReviewV2PublicationPayloadKind.ThreadLifecycle;
      readonly threadId: string;
      readonly resolve: boolean;
    });

export interface ReviewV2PublicationPayloadPort {
  resolve(input: {
    readonly permit: ReviewPublicationPermitIdentity;
    readonly operation: ReviewPublicationOperation;
  }): Promise<ReviewV2PublicationPayload | null>;
}

export interface ReviewV2FinalizedArtifactQueryPort {
  findArtifact(executionId: string): Promise<{
    readonly artifact: FinalizedReviewProjectionArtifact;
    readonly protocolLimitsProfileId: string;
    readonly limitsDigest: string;
  } | null>;
}

/**
 * Worker anti-corruption adapter for the Action-owned projection envelope. It
 * exposes only canonical publication payloads and bounded snapshot DTOs.
 */
export class CanonicalReviewV2ProjectionAdapter
  implements
    ReviewCompletionProjectionMapperPort,
    ReviewV2PublicationPayloadPort
{
  constructor(private readonly artifacts: ReviewV2FinalizedArtifactQueryPort) {}

  async publicationEnvelope(
    artifact: FinalizedReviewProjectionArtifact,
  ): Promise<PublishedReviewProjectionPublicationEnvelope | null> {
    const loaded = await this.loadMatching(artifact.publicationPermit);
    if (!loaded) return null;
    const projection = parseProjection(artifact.projectionEnvelopeJson);
    const catalog = buildCatalog(projection, artifact);
    const partial = artifact.coverageState === "partial";
    return {
      envelopeVersion: publishedReviewProjectionPublicationEnvelopeVersion,
      producerReleaseId: artifact.publicationPermit.producerReleaseId,
      protocolLimitsProfileId: loaded.protocolLimitsProfileId,
      limitsDigest: loaded.limitsDigest,
      projectionHash: artifact.projectionHash,
      coverage: partial
        ? ReviewPublicationProjectionCoverage.Partial
        : ReviewPublicationProjectionCoverage.Completed,
      targetCommitId: artifact.reviewedHeadSha,
      reviewRevisionHash: artifact.reviewRevisionHash,
      renderPolicyVersion: 1,
      publicationNotAfter: new Date(
        artifact.publicationPermit.publicationNotAfter,
      ),
      summary: {
        ...facts(catalog.summary),
        semantic: partial
          ? ReviewPublicationSummarySemantic.PartialCoverage
          : projection.publishing.summary.allClear
            ? ReviewPublicationSummarySemantic.AllClear
            : ReviewPublicationSummarySemantic.Findings,
      },
      managedCheck:
        catalog.managedCheck === null ? null : facts(catalog.managedCheck),
      inlineReviews: partial
        ? []
        : catalog.inlineChunks.map((chunk) => ({
            chunkIndex: chunk.chunkIndex,
            delivery: ReviewPublicationInlineReviewDelivery.PendingThenSubmit,
            create: facts(chunk.create),
            submit: facts(chunk.submit),
          })),
      lifecycle: partial
        ? []
        : catalog.lifecycle.map((entry, chunkIndex) => ({
            chunkIndex,
            ...facts(entry.payload),
            semantic: entry.payload.resolve
              ? ReviewPublicationLifecycleSemantic.Resolve
              : ReviewPublicationLifecycleSemantic.Reopen,
          })),
    };
  }

  async snapshotProjection(artifact: FinalizedReviewProjectionArtifact) {
    const projection = parseProjection(artifact.projectionEnvelopeJson);
    return {
      occurrences: projection.occurrences.map(toOccurrence),
      lineageHints: toLineageHints(projection, artifact.createdAt),
      expiresAt: new Date(artifact.retainUntil),
    };
  }

  async resolve(input: {
    readonly permit: ReviewPublicationPermitIdentity;
    readonly operation: ReviewPublicationOperation;
  }): Promise<ReviewV2PublicationPayload | null> {
    const loaded = await this.loadMatching(input.permit);
    if (!loaded) return null;
    const catalog = buildCatalog(
      parseProjection(loaded.artifact.projectionEnvelopeJson),
      loaded.artifact,
    );
    const payload = payloadForOperation(catalog, input.operation);
    if (
      !payload ||
      payload.markerHash !== input.operation.markerHash ||
      payload.bodyHash !== input.operation.bodyHash
    ) {
      return null;
    }
    return payload;
  }

  private async loadMatching(permit: ReviewPublicationPermitIdentity) {
    const loaded = await this.artifacts.findArtifact(permit.executionId);
    if (
      !loaded ||
      loaded.artifact.generation !== permit.generation ||
      loaded.artifact.projectionHash !== permit.projectionHash ||
      loaded.artifact.reviewRevisionHash !== permit.reviewRevisionHash
    ) {
      return null;
    }
    return loaded;
  }
}

type ProjectionEnvelope = {
  readonly envelopeVersion: "review_projection.v1";
  readonly lifecycleStateHash: string;
  readonly commandLedgerWatermark: string;
  readonly occurrences: readonly ProjectionOccurrence[];
  readonly publishing: {
    readonly summary: {
      readonly marker: string;
      readonly body: string;
      readonly allClear: boolean;
    };
    readonly check: {
      readonly marker: string;
      readonly name: string;
      readonly title: string;
      readonly summary: string;
      readonly conclusion: "success" | "failure" | "neutral";
    };
    readonly inlineReviewChunks: readonly {
      readonly chunkIndex: number;
      readonly marker: string;
      readonly comments: readonly {
        readonly marker: string;
        readonly path: string;
        readonly startLine?: number;
        readonly line: number;
        readonly body: string;
      }[];
    }[];
    readonly lifecycle: readonly {
      readonly targetId: string;
      readonly threadId: string;
      readonly verdict: string;
      readonly mutationEligible: boolean;
    }[];
  };
  readonly snapshot: {
    readonly lineageHints: readonly {
      readonly lineageId: string;
      readonly active: boolean;
      readonly [key: string]: unknown;
    }[];
  };
};

type ProjectionOccurrence = {
  readonly lineageId: string;
  readonly state: keyof typeof occurrenceStateMap;
  readonly observationIds: readonly string[];
  readonly providerVoteKeys: readonly string[];
  readonly placement: { readonly kind: string };
};

type PayloadOfKind<TKind extends ReviewV2PublicationPayloadKind> =
  ReviewV2PublicationPayload & { readonly kind: TKind };

type PublicationCatalog = {
  readonly summary: PayloadOfKind<ReviewV2PublicationPayloadKind.Summary>;
  readonly managedCheck: PayloadOfKind<ReviewV2PublicationPayloadKind.ManagedCheck> | null;
  readonly inlineChunks: readonly {
    readonly chunkIndex: number;
    readonly create: PayloadOfKind<ReviewV2PublicationPayloadKind.PendingReviewCreate>;
    readonly submit: PayloadOfKind<ReviewV2PublicationPayloadKind.PendingReviewSubmit>;
  }[];
  readonly lifecycle: readonly {
    readonly payload: PayloadOfKind<ReviewV2PublicationPayloadKind.ThreadLifecycle>;
  }[];
};

function buildCatalog(
  projection: ProjectionEnvelope,
  artifact: FinalizedReviewProjectionArtifact,
): PublicationCatalog {
  const rendered = renderCanonicalReviewPublication(
    {
      coverage:
        artifact.coverageState === "partial"
          ? ReviewPublicationProjectionCoverage.Partial
          : ReviewPublicationProjectionCoverage.Completed,
      targetCommitId: artifact.reviewedHeadSha,
      source: projection.publishing,
    },
    {
      digestUtf8: sha256,
      utf8ByteLength: (value) => Buffer.byteLength(value, "utf8"),
    },
  );
  const summary: PayloadOfKind<ReviewV2PublicationPayloadKind.Summary> = {
    kind: ReviewV2PublicationPayloadKind.Summary,
    ...payloadFields(rendered.summary),
    body: rendered.summary.body,
  };
  const managedCheck: PublicationCatalog["managedCheck"] =
    rendered.managedCheck === null
      ? null
      : {
          kind: ReviewV2PublicationPayloadKind.ManagedCheck as const,
          ...payloadFields(rendered.managedCheck),
          name: rendered.managedCheck.name,
          title: rendered.managedCheck.title,
          summary: rendered.managedCheck.summary,
          conclusion: rendered.managedCheck.conclusion,
        };
  const inlineChunks = rendered.inlineReviews.map((chunk) => ({
    chunkIndex: chunk.chunkIndex,
    create: {
      kind: ReviewV2PublicationPayloadKind.PendingReviewCreate,
      ...payloadFields(chunk.create),
      body: chunk.create.marker,
      comments: chunk.create.comments,
    } as const,
    submit: {
      kind: ReviewV2PublicationPayloadKind.PendingReviewSubmit,
      ...payloadFields(chunk.submit),
      body: chunk.submit.marker,
    } as const,
  }));
  const lifecycle = rendered.lifecycle.map((entry) => ({
    payload: {
      kind: ReviewV2PublicationPayloadKind.ThreadLifecycle,
      ...payloadFields(entry),
      threadId: entry.threadId,
      resolve: entry.resolve,
    } as const,
  }));
  return { summary, managedCheck, inlineChunks, lifecycle };
}

function payloadFields(value: {
  readonly marker: string;
  readonly markerHash: string;
  readonly bodyHash: string;
  readonly bodyByteCount: number;
}) {
  return {
    marker: value.marker,
    markerHash: value.markerHash,
    bodyHash: value.bodyHash,
    bodyByteCount: value.bodyByteCount,
  };
}

function payloadForOperation(
  catalog: PublicationCatalog,
  operation: ReviewPublicationOperation,
): ReviewV2PublicationPayload | null {
  switch (operation.publicationKind) {
    case ReviewPublicationKind.Summary:
      return operation.chunkIndex === 0 ? catalog.summary : null;
    case ReviewPublicationKind.ManagedCheck:
      return operation.chunkIndex === 0 ? catalog.managedCheck : null;
    case ReviewPublicationKind.PendingReviewCreate:
      return (
        catalog.inlineChunks.find(
          (entry) => entry.chunkIndex === operation.chunkIndex,
        )?.create ?? null
      );
    case ReviewPublicationKind.PendingReviewSubmit:
      return (
        catalog.inlineChunks.find(
          (entry) => entry.chunkIndex === operation.chunkIndex,
        )?.submit ?? null
      );
    case ReviewPublicationKind.SubmittedReview:
      return null;
    case ReviewPublicationKind.ThreadLifecycle:
      return catalog.lifecycle[operation.chunkIndex]?.payload ?? null;
  }
}

function facts(payload: ReviewV2PublicationPayload) {
  return {
    markerHash: payload.markerHash,
    bodyHash: payload.bodyHash,
    bodyByteCount: payload.bodyByteCount,
  };
}

const occurrenceStateMap = {
  new: SnapshotOccurrenceState.New,
  reconfirmed: SnapshotOccurrenceState.Reconfirmed,
  changed: SnapshotOccurrenceState.Changed,
  carried_unverified: SnapshotOccurrenceState.CarriedUnverified,
  resolved: SnapshotOccurrenceState.Resolved,
  uncertain: SnapshotOccurrenceState.Uncertain,
  suppressed_by_human: SnapshotOccurrenceState.SuppressedByHuman,
} as const;

function toOccurrence(value: ProjectionOccurrence): OccurrenceProvenanceDto {
  const state = occurrenceStateMap[value.state];
  if (!state) throw new Error("review_v2_projection_occurrence_state_invalid");
  return {
    lineageId: requireIdentifier(value.lineageId, "lineage_id_invalid"),
    state,
    observationIds: boundedIdentifiers(value.observationIds),
    freshProviderVoteKeys: boundedIdentifiers(value.providerVoteKeys),
    placementConfidence: value.placement.kind === "inline" ? 1 : 0,
  };
}

function toLineageHints(
  projection: ProjectionEnvelope,
  createdAt: Date,
): LineageHintIndex {
  return {
    hints: projection.snapshot.lineageHints.map((hint) => ({
      lineageId: requireIdentifier(hint.lineageId, "lineage_id_invalid"),
      fingerprintHash: sha256(canonicalJson(hint)),
      state: hint.active ? LineageHintState.Active : LineageHintState.Resolved,
      lastSeenAt: new Date(createdAt),
    })),
    eviction: {
      [LineageHintEvictionReason.Age]: 0,
      [LineageHintEvictionReason.Count]: 0,
      [LineageHintEvictionReason.Bytes]: 0,
      evictionWatermark: null,
    },
  };
}

function parseProjection(value: string): ProjectionEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("review_v2_projection_invalid_json");
  }
  if (!isRecord(parsed) || canonicalJson(parsed) !== value) {
    throw new Error("review_v2_projection_not_canonical");
  }
  const publishing = parsed.publishing;
  const snapshot = parsed.snapshot;
  if (
    parsed.envelopeVersion !== "review_projection.v1" ||
    !Array.isArray(parsed.occurrences) ||
    !isRecord(publishing) ||
    !isRecord(publishing.summary) ||
    !isRecord(publishing.check) ||
    !Array.isArray(publishing.inlineReviewChunks) ||
    !Array.isArray(publishing.lifecycle) ||
    !isRecord(snapshot) ||
    !Array.isArray(snapshot.lineageHints)
  ) {
    throw new Error("review_v2_projection_shape_invalid");
  }
  return parsed as unknown as ProjectionEnvelope;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireIdentifier(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value
  ) {
    throw new Error(code);
  }
  return value;
}

function boundedIdentifiers(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new Error("review_v2_projection_identifiers_invalid");
  }
  return value.map((entry) => requireIdentifier(entry, "identifier_invalid"));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
