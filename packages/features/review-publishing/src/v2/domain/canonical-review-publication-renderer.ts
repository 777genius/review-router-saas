import {
  ReviewPublicationInlineReviewDelivery,
  ReviewPublicationLifecycleSemantic,
  ReviewPublicationProjectionCoverage,
  ReviewPublicationSummarySemantic,
  type CanonicalReviewPublicationBodyFacts,
} from "./review-publication-operation-planning";

export const legacyReviewProjectionPolicyVersion =
  "review-projection-policy.v2-t0";
export const currentReviewProjectionPolicyVersion =
  "review-projection-policy.v3-t0";

export enum CanonicalReviewPublicationRenderPolicyVersion {
  LegacyV1 = 1,
  ClearPartialV2 = 2,
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
      readonly comments: readonly {
        readonly path: string;
        readonly line: number;
        readonly startLine: number | null;
        readonly body: string;
      }[];
    };
    readonly submit: RenderedPayloadIdentity;
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
    case currentReviewProjectionPolicyVersion:
      return CanonicalReviewPublicationRenderPolicyVersion.ClearPartialV2;
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
  );
  const managedCheck = payload(
    input.source.check.marker,
    canonicalJson({
      conclusion: input.source.check.conclusion,
      name: input.source.check.name,
      summary: checkSummary,
      title: input.source.check.title,
    }),
    primitives,
  );
  const inlineReviews = input.source.inlineReviewChunks.map((chunk) => {
    const comments = chunk.comments.map((comment) => ({
      body: withMarker(comment.body, comment.marker),
      line: comment.line,
      path: comment.path,
      startLine: comment.startLine ?? null,
    }));
    const submitMarker = `${chunk.marker}:submitted`;
    return {
      chunkIndex: chunk.chunkIndex,
      delivery:
        ReviewPublicationInlineReviewDelivery.PendingThenSubmit as const,
      create: {
        ...payload(
          chunk.marker,
          canonicalJson({
            body: chunk.marker,
            comments,
            commitId: input.targetCommitId,
          }),
          primitives,
        ),
        comments,
      },
      submit: payload(
        submitMarker,
        canonicalJson({ body: submitMarker, event: "COMMENT" }),
        primitives,
      ),
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
          canonicalJson({ resolve, threadId: entry.threadId }),
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

function withMarker(body: string, marker: string): string {
  return body.includes(marker) ? body : `${body}\n\n${marker}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(codeUnitCompare)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
