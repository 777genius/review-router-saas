import {
  ReviewPublicationInlineReviewDelivery,
  ReviewPublicationLifecycleSemantic,
  ReviewPublicationProjectionCoverage,
  ReviewPublicationSummarySemantic,
  type CanonicalReviewPublicationBodyFacts,
} from "./review-publication-operation-planning";
import { canonicalReviewPublicationJson } from "./canonical-review-publication-json";

export const legacyReviewProjectionPolicyVersion =
  "review-projection-policy.v2-t0";
export const clearPartialReviewProjectionPolicyVersion =
  "review-projection-policy.v3-t0";
export const currentReviewProjectionPolicyVersion =
  "review-projection-policy.v4-t0";

export enum CanonicalReviewPublicationRenderPolicyVersion {
  LegacyV1 = 1,
  ClearPartialV2 = 2,
  HiddenMarkersV3 = 3,
}

export const legacyPartialReviewPublicationSummary =
  "Review incomplete: required coverage did not finish. This result is not an all-clear and must not be used as approval evidence.";
export const partialReviewPublicationSummary = [
  "## Review incomplete ⚠️",
  "",
  "ReviewRouter could not finish all required review tasks for this revision. No approval was issued, and partial findings were withheld to avoid a misleading result.",
  "",
  "<sub>Eligible completed evidence is preserved for a safe retry. This status is not an all-clear.</sub>",
].join("\n");

export type ReviewPublicationRenderingSource = {
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
      readonly startLine?: number | null;
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

type RenderedPayloadIdentity = CanonicalReviewPublicationBodyFacts & {
  readonly marker: string;
  readonly body: string;
};

export type CanonicalReviewPublicationRendering = {
  readonly summary: RenderedPayloadIdentity & {
    readonly semantic: ReviewPublicationSummarySemantic;
  };
  readonly managedCheck:
    | (RenderedPayloadIdentity & {
        readonly name: string;
        readonly title: string;
        readonly summary: string;
        readonly conclusion: "success" | "failure" | "neutral";
      })
    | null;
  readonly inlineReviews: readonly {
    readonly chunkIndex: number;
    readonly delivery: ReviewPublicationInlineReviewDelivery.PendingThenSubmit;
    readonly create: RenderedPayloadIdentity & {
      readonly reviewBody: string;
      readonly comments: readonly {
        readonly path: string;
        readonly line: number;
        readonly startLine: number | null;
        readonly body: string;
      }[];
    };
    readonly submit: RenderedPayloadIdentity & { readonly reviewBody: string };
  }[];
  readonly lifecycle: readonly (RenderedPayloadIdentity & {
    readonly chunkIndex: number;
    readonly semantic: ReviewPublicationLifecycleSemantic;
    readonly threadId: string;
    readonly resolve: boolean;
  })[];
};

export type CanonicalReviewPublicationRenderingPrimitives = {
  readonly digestUtf8: (value: string) => string;
  readonly utf8ByteLength: (value: string) => number;
};

export function resolveReviewPublicationRenderPolicyVersion(
  projectionPolicyVersion: string,
): CanonicalReviewPublicationRenderPolicyVersion {
  switch (projectionPolicyVersion) {
    case legacyReviewProjectionPolicyVersion:
      return CanonicalReviewPublicationRenderPolicyVersion.LegacyV1;
    case clearPartialReviewProjectionPolicyVersion:
      return CanonicalReviewPublicationRenderPolicyVersion.ClearPartialV2;
    case currentReviewProjectionPolicyVersion:
      return CanonicalReviewPublicationRenderPolicyVersion.HiddenMarkersV3;
    default:
      throw new Error(
        `review_publication_projection_policy_unsupported:${projectionPolicyVersion}`,
      );
  }
}

/**
 * Publishing-owned rendering policy. Planning and execution must consume this
 * same result so a persisted operation identity cannot drift from its payload.
 */
export function renderCanonicalReviewPublication(
  input: {
    readonly coverage: ReviewPublicationProjectionCoverage;
    readonly renderPolicyVersion: CanonicalReviewPublicationRenderPolicyVersion;
    readonly targetCommitId: string;
    readonly source: ReviewPublicationRenderingSource;
  },
  primitives: CanonicalReviewPublicationRenderingPrimitives,
): CanonicalReviewPublicationRendering {
  const partial =
    input.coverage === ReviewPublicationProjectionCoverage.Partial;
  const summary = payload(
    input.source.summary.marker,
    withMarker(
      partial
        ? partialSummary(input.renderPolicyVersion)
        : input.source.summary.body,
      input.source.summary.marker,
      input.renderPolicyVersion,
    ),
    primitives,
  );

  if (partial) {
    return {
      summary: {
        ...summary,
        semantic: ReviewPublicationSummarySemantic.PartialCoverage,
      },
      managedCheck: null,
      inlineReviews: [],
      lifecycle: [],
    };
  }

  const checkSummary = withMarker(
    input.source.check.summary,
    input.source.check.marker,
    input.renderPolicyVersion,
  );
  const managedCheck = payload(
    input.source.check.marker,
    canonicalReviewPublicationJson({
      conclusion: input.source.check.conclusion,
      name: input.source.check.name,
      summary: checkSummary,
      title: input.source.check.title,
    }),
    primitives,
  );
  const inlineReviews = input.source.inlineReviewChunks.map((chunk) => {
    const comments = chunk.comments.map((comment) => ({
      body: withMarker(comment.body, comment.marker, input.renderPolicyVersion),
      line: comment.line,
      path: comment.path,
      startLine: comment.startLine ?? null,
    }));
    const submitMarker = `${chunk.marker}:submitted`;
    const createReviewBody = markerForBody(
      chunk.marker,
      input.renderPolicyVersion,
    );
    const submitReviewBody = markerForBody(
      submitMarker,
      input.renderPolicyVersion,
    );
    return {
      chunkIndex: chunk.chunkIndex,
      delivery:
        ReviewPublicationInlineReviewDelivery.PendingThenSubmit as const,
      create: {
        ...payload(
          chunk.marker,
          canonicalReviewPublicationJson({
            body: createReviewBody,
            comments,
            commitId: input.targetCommitId,
          }),
          primitives,
        ),
        reviewBody: createReviewBody,
        comments,
      },
      submit: {
        ...payload(
          submitMarker,
          canonicalReviewPublicationJson({
            body: submitReviewBody,
            event: "COMMENT",
          }),
          primitives,
        ),
        reviewBody: submitReviewBody,
      },
    };
  });
  const lifecycle = input.source.lifecycle
    .filter(
      (entry) =>
        entry.mutationEligible &&
        (entry.verdict === "resolved" || entry.verdict === "still_valid"),
    )
    .map((entry, chunkIndex) => {
      const resolve = entry.verdict === "resolved";
      const marker = `reviewrouter-lifecycle:${entry.targetId}:${resolve ? "resolved" : "open"}`;
      return {
        chunkIndex,
        semantic: resolve
          ? ReviewPublicationLifecycleSemantic.Resolve
          : ReviewPublicationLifecycleSemantic.Reopen,
        threadId: entry.threadId,
        resolve,
        ...payload(
          marker,
          canonicalReviewPublicationJson({ resolve, threadId: entry.threadId }),
          primitives,
        ),
      };
    });

  return {
    summary: {
      ...summary,
      semantic: input.source.summary.allClear
        ? ReviewPublicationSummarySemantic.AllClear
        : ReviewPublicationSummarySemantic.Findings,
    },
    managedCheck: {
      ...managedCheck,
      name: input.source.check.name,
      title: input.source.check.title,
      summary: checkSummary,
      conclusion: input.source.check.conclusion,
    },
    inlineReviews,
    lifecycle,
  };
}

function partialSummary(
  version: CanonicalReviewPublicationRenderPolicyVersion,
): string {
  switch (version) {
    case CanonicalReviewPublicationRenderPolicyVersion.LegacyV1:
      return legacyPartialReviewPublicationSummary;
    case CanonicalReviewPublicationRenderPolicyVersion.ClearPartialV2:
    case CanonicalReviewPublicationRenderPolicyVersion.HiddenMarkersV3:
      return partialReviewPublicationSummary;
  }
}

function payload(
  marker: string,
  body: string,
  primitives: CanonicalReviewPublicationRenderingPrimitives,
): RenderedPayloadIdentity {
  assertBoundedString(marker, "publication_marker_invalid", 4_096, primitives);
  assertBoundedString(body, "publication_body_invalid", 1_000_000, primitives);
  return {
    marker,
    body,
    markerHash: primitives.digestUtf8(marker),
    bodyHash: primitives.digestUtf8(body),
    bodyByteCount: primitives.utf8ByteLength(body),
  };
}

function withMarker(
  body: string,
  marker: string,
  version: CanonicalReviewPublicationRenderPolicyVersion,
): string {
  const renderedMarker = markerForBody(marker, version);
  if (body.includes(renderedMarker)) return body;
  if (body.includes(marker)) return body.split(marker).join(renderedMarker);
  return `${body}\n\n${renderedMarker}`;
}

function markerForBody(
  marker: string,
  version: CanonicalReviewPublicationRenderPolicyVersion,
): string {
  if (
    version !== CanonicalReviewPublicationRenderPolicyVersion.HiddenMarkersV3 ||
    marker.trim().startsWith("<!--")
  ) {
    return marker;
  }
  return `<!-- ${marker} -->`;
}

function assertBoundedString(
  value: unknown,
  code: string,
  maxBytes: number,
  primitives: CanonicalReviewPublicationRenderingPrimitives,
): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    primitives.utf8ByteLength(value) > maxBytes
  ) {
    throw new Error(code);
  }
}
