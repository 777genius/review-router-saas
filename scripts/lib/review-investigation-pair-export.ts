import type { ReviewObservationQueryPort } from "../../packages/features/review-evidence/src/application/ports/review-observation-ports";
import type { InvestigationShadowEvidenceQueryPort } from "../../packages/features/review-evidence/src/application/ports/investigation-shadow-evidence-ports";
import {
  createReviewObservation,
  prepareReviewObservationPayload,
  type ReviewObservation,
} from "../../packages/features/review-evidence/src/domain/review-observation";
import {
  assertInvestigationShadowEvidenceCertificate,
  canonicalInvestigationShadowCertificate,
  createInvestigationShadowEvidence,
  investigationShadowScopeCanonicalValue,
  investigationShadowEvidenceRecordCanonicalValue,
  prepareInvestigationShadowTerminalPayload,
  type InvestigationShadowEvidence,
  type InvestigationShadowEvidenceCertificate,
  type InvestigationShadowEvidenceScope,
  type InvestigationShadowEvidenceRevision,
} from "../../packages/features/review-evidence/src/domain/investigation-shadow-evidence";
import {
  stableJson,
  type CanonicalJsonValue,
} from "../../packages/features/review-evidence/src/domain/provider-invocation-manifest";
import { NodeSha256DigestAdapter } from "../../packages/features/review-evidence/src/infrastructure/node/node-sha256-digest-adapter";

export const legacyKeys = [
  "sourceExecutionId",
  "sourceWorkSlotId",
  "providerVoteIdentityHash",
  "providerKind",
  "requestedModel",
  "actualModel",
  "executionProfile",
  "attemptId",
  "sourceRunId",
  "sourceRunAttempt",
  "manifestKey",
  "providerInvocationKey",
  "producerReleaseId",
  "providerRuntimeVersion",
  "selectedProtocolVersion",
  "trustedCapabilityProfile",
  "sourceLeaseId",
  "sourceFencingToken",
  "sourceAuthorizationId",
  "sourcePlanHash",
  "evidenceWriteSafetyDecisionHash",
] as const;
export const shadowKeys = [
  "executionId",
  "workSlotId",
  "stableReviewUnitKey",
  "providerVoteLaneId",
  "producerReleaseId",
  "terminalProviderKind",
  "terminalActualModel",
] as const;
export type PairSelection = {
  version: 1;
  pairing: "same_execution";
  legacyObservationId: string;
  shadowEvidenceId: string;
  investigationId: string;
  certificateId: string;
  scope: InvestigationShadowEvidenceScope;
  revision: InvestigationShadowEvidenceRevision;
  legacy: Pick<ReviewObservation, (typeof legacyKeys)[number]>;
  investigation: Pick<InvestigationShadowEvidence, (typeof shadowKeys)[number]>;
};
/** Supplied independently by the trusted operator policy, never from the selector. */
export type TrustedPairScope = {
  repository: "777genius/review-router-saas-e2e";
  immutableRepositoryId: "1228051727";
  scope: InvestigationShadowEvidenceScope;
  privacyExportAllowed: true;
  validUntilMs: number;
};
const fail = () => {
  throw new Error("pair_export_unavailable_or_denied");
};
const equal = (a: unknown, b: unknown) => {
  if (json(a) !== json(b)) fail();
};
const json = (v: unknown) => stableJson(v as CanonicalJsonValue);
const digest = new NodeSha256DigestAdapter();
const hash = (v: string | Uint8Array) =>
  digest.digest(typeof v === "string" ? new TextEncoder().encode(v) : v);
function keys(
  v: unknown,
  expected: readonly string[],
): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail();
  equal(Object.keys(v as object).sort(), [...expected].sort());
}
export function validateSelection(
  value: unknown,
  trusted: TrustedPairScope,
  nowMs: number,
): PairSelection {
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > 16384) fail();
    keys(value, [
      "version",
      "pairing",
      "legacyObservationId",
      "shadowEvidenceId",
      "investigationId",
      "certificateId",
      "scope",
      "revision",
      "legacy",
      "investigation",
    ]);
    equal(value.version, 1);
    equal(value.pairing, "same_execution");
    for (const k of [
      "legacyObservationId",
      "shadowEvidenceId",
      "investigationId",
      "certificateId",
    ]) {
      if (
        typeof value[k] !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/.test(value[k] as string)
      )
        fail();
    }
    keys(value.scope, [
      "workspaceId",
      "repositoryConnectionId",
      "scmRepositoryIdentityId",
      "pullRequestNumber",
      "trustDomain",
      "authorizationScopeHash",
    ]);
    keys(value.revision, [
      "baseSha",
      "mergeBaseSha",
      "headSha",
      "reviewRevisionHash",
    ]);
    keys(value.legacy, legacyKeys);
    keys(value.investigation, shadowKeys);
    for (const group of [value.legacy, value.investigation, value.revision]) {
      for (const v of Object.values(group))
        if (
          typeof v !== "string" ||
          !v.length ||
          v.length > 512 ||
          // Reject control bytes in operator identifiers.
          // eslint-disable-next-line no-control-regex
          /[\x00-\x1f\x7f*]/.test(v)
        )
          fail();
    }
    if (
      !Number.isSafeInteger(nowMs) ||
      nowMs < 0 ||
      !Number.isSafeInteger(trusted.validUntilMs) ||
      trusted.validUntilMs <= nowMs ||
      trusted.privacyExportAllowed !== true
    )
      fail();
    keys(trusted, [
      "repository",
      "immutableRepositoryId",
      "scope",
      "privacyExportAllowed",
      "validUntilMs",
    ]);
    equal(trusted.repository, "777genius/review-router-saas-e2e");
    equal(trusted.immutableRepositoryId, "1228051727");
    // scmRepositoryIdentityId is an internal identity; the independent policy binds it to the immutable GitHub ID.
    equal(value.scope, trusted.scope);
    equal(value.legacy.sourceExecutionId, value.investigation.executionId);
    equal(value.legacy.sourceWorkSlotId, value.investigation.workSlotId);
    equal(
      value.legacy.providerVoteIdentityHash,
      value.investigation.providerVoteLaneId,
    );
    return value as unknown as PairSelection;
  } catch {
    return fail();
  }
}
export function assertPairBinding(
  s: PairSelection,
  l: ReviewObservation,
  r: InvestigationShadowEvidence,
  nowMs: number,
): void {
  equal(l.observationId, s.legacyObservationId);
  equal(r.shadowEvidenceId, s.shadowEvidenceId);
  equal(r.investigationId, s.investigationId);
  equal(r.certificateId, s.certificateId);
  equal({ ...l.scope, trustDomain: l.trustDomain }, s.scope);
  equal(r.scope, s.scope);
  equal(l.sourceRevision, s.revision);
  equal(r.revision, s.revision);
  for (const k of legacyKeys) equal(l[k], s.legacy[k]);
  for (const k of shadowKeys) equal(r[k], s.investigation[k]);
  equal(l.sourceExecutionId, r.executionId);
  equal(l.sourceWorkSlotId, r.workSlotId);
  equal(l.providerVoteIdentityHash, r.providerVoteLaneId);
  if (
    ![
      "prompt_only_envelope_v1",
      "agentic_unbounded_v1",
      "context_gateway_v1",
    ].includes(l.executionProfile) ||
    l.investigationCertificateId !== null ||
    l.investigationCertificateHash !== null ||
    l.qualityFlags.some((f) => f.startsWith("investigation_"))
  )
    fail();
  if (
    l.retainUntilMs <= nowMs ||
    r.retainUntilMs <= nowMs ||
    l.createdAtMs > nowMs ||
    r.issuedAtMs > nowMs
  )
    fail();
}
export async function verifyPairHashes(
  l: ReviewObservation,
  r: InvestigationShadowEvidence,
) {
  createReviewObservation(l);
  createInvestigationShadowEvidence(r);
  const legacy = prepareReviewObservationPayload(l.payload);
  const terminal = prepareInvestigationShadowTerminalPayload(
    r.terminalObservationCanonicalJson,
  );
  const legacyHash = await hash(legacy.canonicalBytes),
    terminalHash = await hash(terminal.canonicalBytes);
  equal(legacyHash, l.payloadHash);
  equal(legacy.byteCount, l.byteCount);
  equal(legacy.findingCount, l.findingCount);
  equal(terminalHash, r.terminalPayloadHash);
  equal(terminalHash, r.terminalOutcomeHash);
  equal(terminal.byteCount, r.terminalPayloadByteCount);
  equal(terminal.findingCount, r.findingCount);
  const certificate: InvestigationShadowEvidenceCertificate = {
    ...JSON.parse(r.certificateCanonicalJson),
    certificateHash: r.certificateHash,
  };
  assertInvestigationShadowEvidenceCertificate(certificate);
  equal(
    canonicalInvestigationShadowCertificate(certificate),
    r.certificateCanonicalJson,
  );
  const certificateHash = await hash(r.certificateCanonicalJson);
  equal(certificateHash, r.certificateHash);
  const scopeHash = await hash(
    stableJson(investigationShadowScopeCanonicalValue(r.scope)),
  );
  equal(scopeHash, certificate.scopeHash);
  for (const k of [
    "certificateId",
    "investigationId",
    "stableReviewUnitKey",
    "providerVoteLaneId",
    "producerReleaseId",
    "conclusion",
    "terminalProviderKind",
    "terminalActualModel",
    "terminalOutcomeHash",
    "terminalObservationCanonicalJson",
  ] as const)
    equal(certificate[k], r[k]);
  equal(certificate.reviewRevisionHash, r.revision.reviewRevisionHash);
  equal(certificate.investigationVersion + 1, r.investigationVersion);
  equal(Date.parse(certificate.issuedAt), r.issuedAtMs);
  const recordHash = await hash(
    stableJson(investigationShadowEvidenceRecordCanonicalValue(r)),
  );
  equal(recordHash, r.recordHash);
  return {
    legacy: {
      stored: l.payloadHash,
      recomputed: legacyHash,
      byteCount: legacy.byteCount,
      findingCount: legacy.findingCount,
    },
    terminal: {
      stored: r.terminalPayloadHash,
      storedOutcome: r.terminalOutcomeHash,
      recomputed: terminalHash,
      byteCount: terminal.byteCount,
      findingCount: terminal.findingCount,
    },
    certificate: {
      stored: r.certificateHash,
      recomputed: certificateHash,
      byteCount: Buffer.byteLength(r.certificateCanonicalJson),
    },
    scope: { stored: certificate.scopeHash, recomputed: scopeHash },
    record: { stored: r.recordHash, recomputed: recordHash },
  };
}
export async function buildPairExport(
  selection: unknown,
  trusted: TrustedPairScope,
  legacy: ReviewObservation,
  investigation: InvestigationShadowEvidence,
  nowMs: number,
) {
  try {
    const s = validateSelection(selection, trusted, nowMs);
    assertPairBinding(s, legacy, investigation, nowMs);
    const hashes = await verifyPairHashes(legacy, investigation);
    const body = {
      version: "review-investigation-pair.v1",
      exportedAtMs: nowMs,
      selection: s,
      verifiedBindings: {
        pairing: s.pairing,
        trustedScope: trusted,
        revision: s.revision,
      },
      legacy: { label: "legacy", ...legacy },
      investigation: { label: "investigation", ...investigation },
      hashes,
      evaluation: "NotCompared",
      provenanceLimitations:
        "Shadow storage contains no separate invocation, manifest or attempt facts; none inferred. Payload digests do not authenticate execution metadata.",
    };
    const canonicalBody = json(body);
    return {
      body,
      exportBodyHash: await hash(canonicalBody),
      exportBodyByteCount: Buffer.byteLength(canonicalBody),
    };
  } catch {
    return fail();
  }
}
export async function readExactReviewInvestigationPair(
  selection: unknown,
  trusted: TrustedPairScope,
  ports: {
    observations: Pick<ReviewObservationQueryPort, "findById">;
    shadows: Pick<InvestigationShadowEvidenceQueryPort, "findById">;
  },
  nowMs: number,
) {
  try {
    const s = validateSelection(selection, trusted, nowMs);
    const l = await ports.observations.findById(s.legacyObservationId);
    const r = await ports.shadows.findById(s.shadowEvidenceId);
    if (!l || !r) return fail();
    return await buildPairExport(s, trusted, l, r, nowMs);
  } catch {
    return fail();
  }
}
