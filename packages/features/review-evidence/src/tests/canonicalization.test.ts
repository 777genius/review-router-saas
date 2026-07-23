import { describe, expect, it } from "vitest";
import {
  ProviderExecutionProfile,
  ProviderRequestMessageRole,
  ReviewTaskKind,
  buildProviderInvocationIdentity,
  canonicalizeProviderInvocationManifest,
  canonicalizeProviderRequestEnvelope,
  findingLineageCandidatePreimage,
  hashProviderRequestEnvelope,
  prepareReviewObservationPayload,
  reviewEvidenceMaxPayloadBytes,
  type ProviderRequestEnvelope,
} from "../index";
import { NodeSha256DigestAdapter } from "../testing";
import { hash, manifest, payload } from "./fixtures";

const digest = new NodeSha256DigestAdapter();

describe("review evidence canonicalization", () => {
  it("produces stable golden manifest bytes and invocation identities", async () => {
    const candidate = manifest({
      taskKindSet: [
        ReviewTaskKind.LifecycleRevalidation,
        ReviewTaskKind.FindingDiscovery,
      ],
      executionProfile: ProviderExecutionProfile.PromptOnlyEnvelopeV1,
      lifecycleTargetSetHash: hash("8"),
      liveLifecycleStateHash: hash("9"),
    });

    const bytes = canonicalizeProviderInvocationManifest(candidate);
    const identity = await buildProviderInvocationIdentity(digest, {
      manifest: candidate,
      providerVoteIdentityHash: hash("a"),
    });

    expect(new TextDecoder().decode(bytes)).toBe(GOLDEN_MANIFEST_BYTES);
    expect(identity.manifestKey).toBe(GOLDEN_MANIFEST_KEY);
    expect(identity.providerInvocationKey).toBe(GOLDEN_INVOCATION_KEY);
    expect(identity.manifest.taskKindSet).toEqual([
      ReviewTaskKind.FindingDiscovery,
      ReviewTaskKind.LifecycleRevalidation,
    ]);
  });

  it("hashes exact request semantics while canonicalizing object key order", async () => {
    const first = requestEnvelope({
      inferenceOptions: {
        temperature: 0,
        response: { format: "json", strict: true },
      },
    });
    const reordered = requestEnvelope({
      inferenceOptions: {
        response: { strict: true, format: "json" },
        temperature: 0,
      },
    });
    const reorderedMessages = requestEnvelope({
      messages: [...first.messages].reverse(),
    });

    await expect(hashProviderRequestEnvelope(digest, first)).resolves.toBe(
      GOLDEN_REQUEST_HASH,
    );
    await expect(hashProviderRequestEnvelope(digest, reordered)).resolves.toBe(
      GOLDEN_REQUEST_HASH,
    );
    await expect(
      hashProviderRequestEnvelope(digest, reorderedMessages),
    ).resolves.not.toBe(GOLDEN_REQUEST_HASH);
    expect(canonicalizeProviderRequestEnvelope(first)).not.toEqual(
      canonicalizeProviderRequestEnvelope(
        requestEnvelope({ developerInstruction: "" }),
      ),
    );
  });

  it("rejects duplicate set values, unknown profiles and credential-shaped config", () => {
    expect(() =>
      canonicalizeProviderInvocationManifest(
        manifest({
          taskKindSet: [
            ReviewTaskKind.FindingDiscovery,
            ReviewTaskKind.FindingDiscovery,
          ],
        }),
      ),
    ).toThrow("review_evidence_task_kind_duplicate");
    expect(() =>
      canonicalizeProviderInvocationManifest(
        manifest({ executionProfile: ProviderExecutionProfile.Unknown }),
      ),
    ).toThrow("provider_execution_profile_unknown");
    expect(() =>
      canonicalizeProviderRequestEnvelope(
        requestEnvelope({
          resolvedProviderConfiguration: {
            endpoint: "local",
            apiToken: "unsafe",
          },
        }),
      ),
    ).toThrow("provider_configuration_sensitive_key_forbidden");
  });

  it("redacts credential material before hashing and rejects whole oversized payloads", () => {
    const prepared = prepareReviewObservationPayload(
      payload({
        normalizedFindings: [
          {
            ...payload().normalizedFindings[0]!,
            message:
              "Bearer abcdefghijklmnop token=super-secret-value eyJabcdefghijk.abcdefghijk.abcdefghijk",
          },
        ],
      }),
    );
    expect(prepared.payload.normalizedFindings[0]?.message).toBe(
      "Bearer [REDACTED] token=[REDACTED] [REDACTED_JWT]",
    );
    expect(new TextDecoder().decode(prepared.canonicalBytes)).not.toContain(
      "super-secret-value",
    );

    const oversizedFindings = Array.from({ length: 40 }, (_, index) => ({
      ...payload().normalizedFindings[0]!,
      title: `Finding ${index}`,
      message: "x".repeat(15_000),
    }));
    expect(() =>
      prepareReviewObservationPayload(
        payload({
          normalizedFindings: oversizedFindings,
        }),
      ),
    ).toThrow("review_evidence_payload_too_large");
    expect(
      oversizedFindings.reduce(
        (sum, finding) => sum + finding.message.length,
        0,
      ),
    ).toBeGreaterThan(reviewEvidenceMaxPayloadBytes);
    expect(Object.isFrozen(prepared.payload)).toBe(true);
    expect(Object.isFrozen(prepared.payload.normalizedFindings)).toBe(true);
    expect(
      Object.isFrozen(prepared.payload.normalizedFindings[0]?.evidence),
    ).toBe(true);
  });

  it("keeps severity and placement outside lineage candidate identity", () => {
    const candidate = {
      scmRepositoryIdentityId: "scm-repository-1",
      pullRequestNumber: 42,
      category: "correctness",
      normalizedFailureModeHash: hash("8"),
      symbolAnchor: "Store.commit",
      trustedMarker: "rr-marker-1",
    } as const;

    expect(findingLineageCandidatePreimage(candidate)).toEqual(
      findingLineageCandidatePreimage({ ...candidate }),
    );
    expect(Object.keys(candidate)).not.toContain("severity");
    expect(Object.keys(candidate)).not.toContain("path");
    expect(Object.keys(candidate)).not.toContain("lineageId");
  });
});

function requestEnvelope(
  overrides: Partial<ProviderRequestEnvelope> = {},
): ProviderRequestEnvelope {
  return {
    envelopeVersion: 1,
    messages: [
      {
        role: ProviderRequestMessageRole.User,
        name: null,
        content: "Review A",
      },
      {
        role: ProviderRequestMessageRole.Assistant,
        name: null,
        content: "Acknowledged",
      },
    ],
    systemInstruction: null,
    developerInstruction: "Return JSON",
    toolDefinitions: [{ name: "read", input: { path: "string" } }],
    inferenceOptions: {
      temperature: 0,
      response: { format: "json", strict: true },
    },
    requestedModel: "gpt-5.3-codex",
    resolvedProviderConfiguration: { endpoint: "local", reasoning: "high" },
    providerExecutionContractVersion: "codex-http-v1",
    ...overrides,
  };
}

const GOLDEN_MANIFEST_BYTES =
  'rr.provider-invocation-manifest.v1\0[1,"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",["finding_discovery","lifecycle_revalidation"],"codex","dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","gpt-5.3-codex","provider-policy-v1","release-1","review-action-v2","eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","1111111111111111111111111111111111111111111111111111111111111111","2222222222222222222222222222222222222222222222222222222222222222","3333333333333333333333333333333333333333333333333333333333333333","4444444444444444444444444444444444444444444444444444444444444444",null,null,"8888888888888888888888888888888888888888888888888888888888888888","9999999999999999999999999999999999999999999999999999999999999999","5555555555555555555555555555555555555555555555555555555555555555","prompt_only_envelope_v1","6666666666666666666666666666666666666666666666666666666666666666","7777777777777777777777777777777777777777777777777777777777777777"]';
const GOLDEN_MANIFEST_KEY =
  "679c6a961fa7afeadabd17144c896ee1daf214b77537d40d801753d11fc22b2c";
const GOLDEN_INVOCATION_KEY =
  "87d0b2e7cd05f7959fe15c20bd0bbf43a3f793f9bd873cc250e6784b702c6a62";
const GOLDEN_REQUEST_HASH =
  "f29e449cdf9237f1e05d4858054900864211dc86be96d5da4f3bf20e0205de20";
