import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  canonicalizeProviderInvocationManifestV1,
  canonicalizeReviewActionV2Request,
  normalizeProviderInvocationManifestV1,
  parseReviewRunAuthorizeNegotiationRequest,
  parseReviewActionV2Request,
  providerInvocationIdentityPreimageV1,
  providerInvocationManifestV1CanonicalizerDescriptor,
  providerInvocationManifestV1GoldenFixture,
  reviewActionV2GoldenFixtures,
  reviewActionV2Operations,
  reviewActionV2PublishedSchemaDigest,
  reviewActionV2SchemaDigest,
  reviewRunAuthorizeNegotiationGoldenFixture,
  ReviewActionV2CallerAuthority,
  serializeProviderInvocationManifestV1CanonicalWireJson,
} from "../index.js";
import {
  canonicalizeProviderInvocationManifest,
  normalizeProviderInvocationManifest,
  providerInvocationIdentityPreimage,
  providerInvocationManifestV1CanonicalizerDescriptor as domainCanonicalizerDescriptor,
  serializeProviderInvocationManifestCanonicalWireJson,
} from "../../../features/review-evidence/src/index.js";
import {
  assertContractAssembly,
  assertContractSource,
  canonicalJson,
  loadCompiledContractSources,
} from "../../../../scripts/generate-review-action-v2-protocol.mjs";

describe("generated Review Action v2 negotiation contract", () => {
  it("keeps the generated schema digest and golden fixtures byte-consistent", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL(
          "../generated/review-action-v2-negotiation.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as unknown;
    const request = JSON.parse(
      await readFile(
        new URL(
          "../generated/fixtures/review-run-authorize.request.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as unknown;
    const response = JSON.parse(
      await readFile(
        new URL(
          "../generated/fixtures/review-run-authorize.unsupported.response.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as unknown;

    expect(sha256(canonicalJson(schema))).toBe(reviewActionV2SchemaDigest);
    expect(request).toEqual(reviewRunAuthorizeNegotiationGoldenFixture.request);
    expect(response).toEqual(
      reviewRunAuthorizeNegotiationGoldenFixture.response,
    );
  });

  it("strictly rejects unknown fields and duplicate protocol offers", () => {
    const fixture = reviewRunAuthorizeNegotiationGoldenFixture.request;

    expect(
      parseReviewRunAuthorizeNegotiationRequest({
        ...fixture,
        unexpected: true,
      }),
    ).toMatchObject({
      ok: false,
      requestId: fixture.requestId,
      issues: ["unknown_field:unexpected"],
    });
    expect(
      parseReviewRunAuthorizeNegotiationRequest({
        ...fixture,
        supportedProtocols: [
          fixture.supportedProtocols[0],
          fixture.supportedProtocols[0],
        ],
      }),
    ).toMatchObject({
      ok: false,
      issues: ["protocol_offer_duplicate"],
    });
  });

  it("rejects duplicate declarative descriptor identities", () => {
    expect(() =>
      assertContractSource({
        contractSourceVersion: 1,
        protocolVersion: "2",
        operations: [
          { operationId: "review_run_authorize" },
          { operationId: "review_run_authorize" },
        ],
        retryClasses: ["never"],
        errors: [
          {
            typeName: "UnsupportedProtocol",
            errorCode: "unsupported_protocol",
            retryClass: "never",
            httpStatus: 426,
          },
        ],
      }),
    ).toThrow("protocol_contract_operation_id_duplicate");
  });

  it("publishes all sixteen strict operation schemas and fixtures", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL("../generated/review-action-v2.schema.json", import.meta.url),
        "utf8",
      ),
    ) as { readonly $defs: Readonly<Record<string, unknown>> };

    expect(reviewActionV2Operations).toHaveLength(16);
    expect(Object.keys(reviewActionV2GoldenFixtures)).toHaveLength(16);
    expect(Object.keys(schema.$defs)).toHaveLength(32);
    expect(sha256(canonicalJson(schema))).toBe(
      reviewActionV2PublishedSchemaDigest,
    );

    for (const operation of reviewActionV2Operations) {
      const fixture = reviewActionV2GoldenFixtures[operation.operationId];
      const parsed = parseReviewActionV2Request(
        operation.operationId,
        fixture.request,
      );
      expect(parsed).toMatchObject({ ok: true });
      expect(
        canonicalizeReviewActionV2Request(
          operation.operationId,
          fixture.request,
        ),
      ).toBe(
        canonicalizeReviewActionV2Request(
          operation.operationId,
          fixture.request,
        ),
      );
    }

    expect(
      successResultProperties(schema, "review_execution_start"),
    ).toHaveProperty("executionVersion");
    expect(
      successResultProperties(schema, "review_execution_restore"),
    ).toHaveProperty("streamVersion");
    expect(
      successResultProperties(schema, "review_evidence_lookup"),
    ).toMatchObject({
      payloadCanonicalJson: expect.any(Object),
      attachmentCapability: expect.any(Object),
      eligibilityPolicyVersion: expect.any(Object),
      sourceLeaseId: expect.any(Object),
      sourceFencingToken: expect.any(Object),
      sourceOwnerIdHash: expect.any(Object),
    });
    expect(
      successResultProperties(schema, "review_evidence_commit"),
    ).toHaveProperty("eligibilityPolicyVersion");
    expect(
      successResultProperties(schema, "review_invocation_lease_renew"),
    ).toHaveProperty("leaseCapability");
    expect(
      new Set(reviewActionV2Operations.map((item) => item.callerAuthority)),
    ).toEqual(new Set(Object.values(ReviewActionV2CallerAuthority)));
  });

  it("keeps the generated manifest canonicalizer byte-identical to Review Evidence", async () => {
    const fixture = providerInvocationManifestV1GoldenFixture;
    const fixtureFile = JSON.parse(
      await readFile(
        new URL(
          "../generated/fixtures/provider-invocation-manifest-v1.golden.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as unknown;
    const domainNormalized = normalizeProviderInvocationManifest(fixture.input);
    const generatedNormalized = normalizeProviderInvocationManifestV1(
      fixture.input,
    );

    expect(providerInvocationManifestV1CanonicalizerDescriptor).toEqual(
      domainCanonicalizerDescriptor,
    );
    expect(fixtureFile).toEqual(fixture);
    expect(generatedNormalized).toEqual(domainNormalized);
    expect(generatedNormalized).toEqual(fixture.normalized);
    expect(Object.isFrozen(generatedNormalized)).toBe(true);
    expect(Object.isFrozen(generatedNormalized.taskKindSet)).toBe(true);
    expect(
      bytes(canonicalizeProviderInvocationManifestV1(fixture.input)),
    ).toEqual(bytes(canonicalizeProviderInvocationManifest(fixture.input)));
    expect(
      new TextDecoder().decode(
        canonicalizeProviderInvocationManifestV1(fixture.input),
      ),
    ).toBe(fixture.canonicalManifestPreimage);
    expect(
      Buffer.from(
        canonicalizeProviderInvocationManifestV1(fixture.input),
      ).toString("hex"),
    ).toBe(fixture.canonicalManifestBytesHex);
    expect(
      serializeProviderInvocationManifestV1CanonicalWireJson(fixture.input),
    ).toBe(serializeProviderInvocationManifestCanonicalWireJson(fixture.input));
    expect(
      serializeProviderInvocationManifestV1CanonicalWireJson(fixture.input),
    ).toBe(fixture.canonicalWireJson);

    const generatedIdentityPreimage = providerInvocationIdentityPreimageV1(
      fixture.manifestKey,
      fixture.providerVoteIdentityHash,
    );
    expect(bytes(generatedIdentityPreimage)).toEqual(
      bytes(
        providerInvocationIdentityPreimage(
          fixture.manifestKey,
          fixture.providerVoteIdentityHash,
        ),
      ),
    );
    expect(new TextDecoder().decode(generatedIdentityPreimage)).toBe(
      fixture.providerInvocationPreimage,
    );
    expect(
      sha256Bytes(canonicalizeProviderInvocationManifestV1(fixture.input)),
    ).toBe(fixture.manifestKey);
    expect(sha256Bytes(generatedIdentityPreimage)).toBe(
      fixture.providerInvocationKey,
    );
  });

  it("matches strict shape, null and task-set failures across both canonicalizers", () => {
    const fixture = providerInvocationManifestV1GoldenFixture.input;
    const cases: readonly unknown[] = [
      { ...fixture, unexpected: true },
      { ...fixture, memoryBundleHash: undefined },
      { ...fixture, taskKindSet: [] },
      { ...fixture, taskKindSet: ["finding_discovery", "finding_discovery"] },
      { ...fixture, taskKindSet: ["unknown"] },
      { ...fixture, providerKind: "unknown" },
    ];
    for (const candidate of cases) {
      expect(
        capturedError(() => normalizeProviderInvocationManifestV1(candidate)),
      ).toBe(
        capturedError(() => normalizeProviderInvocationManifest(candidate)),
      );
    }
  });

  it("keeps the full authorize request compatible with the N-1 bridge parser", () => {
    const request = reviewActionV2GoldenFixtures.review_run_authorize.request;
    expect(parseReviewRunAuthorizeNegotiationRequest(request)).toMatchObject({
      ok: true,
    });
    expect(Object.keys(request).sort()).toEqual(
      Object.keys(reviewRunAuthorizeNegotiationGoldenFixture.request).sort(),
    );
  });

  it("rejects unknown request fields for every generated operation", () => {
    for (const operation of reviewActionV2Operations) {
      const request =
        reviewActionV2GoldenFixtures[operation.operationId].request;
      expect(
        parseReviewActionV2Request(operation.operationId, {
          ...request,
          unexpected: true,
        }),
      ).toMatchObject({
        ok: false,
        issues: ["unknown_field:unexpected"],
      });
    }
  });

  it("rejects duplicate, unbound, undeclared-reference, and reordered assembly", async () => {
    const source = await loadCompiledContractSources();

    const duplicateCanonicalizer = structuredClone(source);
    const evidenceFragment = duplicateCanonicalizer.semanticFragments.find(
      (fragment) => fragment.boundedContext === "review_evidence",
    );
    evidenceFragment.publishedCanonicalizers.push(
      structuredClone(evidenceFragment.publishedCanonicalizers[0]),
    );
    expect(() =>
      assertContractAssembly({
        transportContract: duplicateCanonicalizer.transportContract,
        semanticFragments: duplicateCanonicalizer.semanticFragments,
      }),
    ).toThrow("protocol_assembly_canonicalizer_count_invalid");

    const duplicate = structuredClone(source);
    duplicate.semanticFragments[0].operations.push({
      ...duplicate.semanticFragments[0].operations[0],
    });
    expect(() =>
      assertContractAssembly({
        transportContract: duplicate.transportContract,
        semanticFragments: duplicate.semanticFragments,
      }),
    ).toThrow("protocol_assembly_semantic_operation_id_duplicate");

    const unbound = structuredClone(source);
    unbound.semanticFragments[0].operations.push({
      ...unbound.semanticFragments[0].operations[0],
      operationId: "review_run_unbound",
      requestTypeName: "ReviewRunUnboundRequest",
      resultTypeName: "ReviewRunUnboundResult",
    });
    expect(() =>
      assertContractAssembly({
        transportContract: unbound.transportContract,
        semanticFragments: unbound.semanticFragments,
      }),
    ).toThrow("protocol_assembly_unbound_command:review_run_unbound");

    const missingCommand = structuredClone(source);
    missingCommand.semanticFragments[0].operations.shift();
    expect(() =>
      assertContractAssembly({
        transportContract: missingCommand.transportContract,
        semanticFragments: missingCommand.semanticFragments,
      }),
    ).toThrow("protocol_assembly_binding_without_command:review_run_authorize");

    const badReference = structuredClone(source);
    badReference.semanticFragments[0].operations[0].resultStatusEnum =
      "UndeclaredResultStatus";
    expect(() =>
      assertContractAssembly({
        transportContract: badReference.transportContract,
        semanticFragments: badReference.semanticFragments,
      }),
    ).toThrow("protocol_assembly_ref_undeclared:UndeclaredResultStatus");

    const unknownAuthority = structuredClone(source);
    unknownAuthority.semanticFragments[0].operations[0].callerAuthority =
      "unknown_authority";
    expect(() =>
      assertContractAssembly({
        transportContract: unknownAuthority.transportContract,
        semanticFragments: unknownAuthority.semanticFragments,
      }),
    ).toThrow("protocol_assembly_caller_authority_invalid:unknown_authority");

    const reordered = structuredClone(source);
    [
      reordered.transportContract.operations[0],
      reordered.transportContract.operations[1],
    ] = [
      reordered.transportContract.operations[1],
      reordered.transportContract.operations[0],
    ];
    expect(() =>
      assertContractAssembly({
        transportContract: reordered.transportContract,
        semanticFragments: reordered.semanticFragments,
      }),
    ).toThrow("protocol_assembly_operation_order_invalid");
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function bytes(value: Uint8Array): readonly number[] {
  return [...value];
}

function capturedError(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "no_error";
}

function successResultProperties(
  schema: { readonly $defs: Readonly<Record<string, unknown>> },
  operationId: string,
): Readonly<Record<string, unknown>> {
  const definition = schema.$defs[`${operationId}_response`] as {
    readonly oneOf: readonly {
      readonly properties?: {
        readonly result?: {
          readonly properties?: Readonly<Record<string, unknown>>;
        };
      };
    }[];
  };
  return definition.oneOf[0]?.properties?.result?.properties ?? {};
}
