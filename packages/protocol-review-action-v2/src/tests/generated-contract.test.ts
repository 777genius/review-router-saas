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
  ReviewActionV2OperationId,
  ReviewContextGatewayOpenResultStatus,
  ReviewContextGatewaySealResultStatus,
  ReviewContextReplayCommitResultStatus,
  ReviewEvidenceLookupResultStatus,
  ReviewInvestigationMutationResultStatus,
  ReviewInvestigationNextAction,
  ReviewInvestigationOpenResultStatus,
  ReviewInvestigationPublishedAbortReason,
  ReviewInvestigationPublishedRuntimeProfile,
  ReviewInvestigationPublishedState,
  ReviewInvestigationRestoreResultStatus,
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

  it("publishes all twenty-eight strict operation schemas and fixtures", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL("../generated/review-action-v2.schema.json", import.meta.url),
        "utf8",
      ),
    ) as { readonly $defs: Readonly<Record<string, unknown>> };

    expect(reviewActionV2Operations).toHaveLength(28);
    expect(Object.keys(reviewActionV2GoldenFixtures)).toHaveLength(28);
    expect(Object.keys(schema.$defs)).toHaveLength(56);
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
      contextDependencyAttestationId: expect.any(Object),
      contextDependencyAttestationHash: expect.any(Object),
      contextReplayCapability: expect.any(Object),
      contextReplayPlanCanonicalJson: expect.any(Object),
      contextReplayPlanHash: expect.any(Object),
    });
    expect(
      successResultProperties(schema, "review_evidence_commit"),
    ).toHaveProperty("eligibilityPolicyVersion");
    expect(
      successResultProperties(schema, "review_invocation_lease_renew"),
    ).toHaveProperty("leaseCapability");
    expect(
      successResultProperties(schema, "review_context_gateway_open"),
    ).toMatchObject({
      sessionId: expect.any(Object),
      eventChainSeedHash: expect.any(Object),
      gatewaySessionSecret: {
        anyOf: [
          expect.objectContaining({
            type: "string",
            maxLength: 32_768,
            pattern: "^\\S+$",
          }),
          { type: "null" },
        ],
      },
      sealCapability: expect.any(Object),
      expiresAt: expect.any(Object),
    });
    expect(
      successResultProperties(schema, "review_context_gateway_seal"),
    ).toMatchObject({
      attestationId: expect.any(Object),
      attestationHash: expect.any(Object),
    });
    expect(
      successResultProperties(schema, "review_context_replay_commit"),
    ).toMatchObject({
      replayProofId: expect.any(Object),
      replayProofHash: expect.any(Object),
      attachmentCapability: expect.any(Object),
    });
    expect(
      new Set(reviewActionV2Operations.map((item) => item.callerAuthority)),
    ).toEqual(new Set(Object.values(ReviewActionV2CallerAuthority)));
  });

  it("publishes the context-attestation trust chain without making the session secret semantic", async () => {
    const sources = await loadCompiledContractSources();
    expect(sources.semanticFragments).toHaveLength(7);
    const fragment = sources.semanticFragments.find(
      (candidate) => candidate.boundedContext === "review_context_attestation",
    );
    expect(fragment).toBeDefined();
    expect(
      fragment?.operations.map((operation) => operation.operationId),
    ).toEqual([
      ReviewActionV2OperationId.ReviewContextGatewayOpen,
      ReviewActionV2OperationId.ReviewContextGatewaySeal,
      ReviewActionV2OperationId.ReviewContextReceiptReplayCommit,
      ReviewActionV2OperationId.ReviewContextReplayCommit,
    ]);

    const open = reviewActionV2Operations.find(
      (operation) =>
        operation.operationId ===
        ReviewActionV2OperationId.ReviewContextGatewayOpen,
    );
    const seal = reviewActionV2Operations.find(
      (operation) =>
        operation.operationId ===
        ReviewActionV2OperationId.ReviewContextGatewaySeal,
    );
    const replay = reviewActionV2Operations.find(
      (operation) =>
        operation.operationId ===
        ReviewActionV2OperationId.ReviewContextReplayCommit,
    );

    expect(open).toMatchObject({
      boundedContext: "review_context_attestation",
      path: "/api/action/v2/review-context/gateway/open",
      callerAuthority:
        ReviewActionV2CallerAuthority.RunAuthorizationAndLeaseCapability,
      semanticRetryClass: "same_request",
      bodyLimitBytes: 65_536,
      successStatuses: [200, 201],
      resultStatuses: Object.values(ReviewContextGatewayOpenResultStatus),
    });
    expect(open?.errorCodes).toContain("capacity_limited");
    expect(seal).toMatchObject({
      boundedContext: "review_context_attestation",
      path: "/api/action/v2/review-context/gateway/seal",
      callerAuthority:
        ReviewActionV2CallerAuthority.RunAuthorizationAndLeaseCapability,
      semanticRetryClass: "same_request",
      bodyLimitBytes: 4_194_304,
      successStatuses: [200, 201],
      resultStatuses: Object.values(ReviewContextGatewaySealResultStatus),
    });
    expect(seal?.errorCodes).not.toContain("capacity_limited");
    expect(replay).toMatchObject({
      boundedContext: "review_context_attestation",
      path: "/api/action/v2/review-context/replay/commit",
      callerAuthority: ReviewActionV2CallerAuthority.RunAuthorization,
      semanticRetryClass: "same_request",
      bodyLimitBytes: 4_194_304,
      successStatuses: [200, 201],
      resultStatuses: Object.values(ReviewContextReplayCommitResultStatus),
    });
    expect(replay?.errorCodes).not.toContain("capacity_limited");
    expect(open?.naturalIdempotencyPreimage).not.toContain(
      "gateway_session_secret",
    );

    const fixture = reviewActionV2GoldenFixtures.review_context_gateway_open;
    expect(fixture.request).toMatchObject({
      attemptId: expect.any(String),
      sourceLeaseId: expect.any(String),
      fencingToken: expect.any(String),
      sourceExecutionId: expect.any(String),
      sourceWorkSlotId: expect.any(String),
      sourceReviewRevisionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      checkoutTreeOid: expect.stringMatching(
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u,
      ),
      gatewayPolicyVersion: expect.any(String),
      gatewayBinaryHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      confinementEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(fixture.request).not.toHaveProperty("gatewaySessionSecret");
    expect(fixture.response.result.status).toBe(
      ReviewContextGatewayOpenResultStatus.Opened,
    );
    expect(
      reviewActionV2GoldenFixtures.review_context_gateway_seal.request,
    ).toMatchObject({
      sessionId: expect.any(String),
      sealCapability: expect.any(String),
      attemptId: expect.any(String),
      sourceLeaseId: expect.any(String),
      fencingToken: expect.any(String),
      providerSucceeded: true,
      schemaValidated: true,
      fullyConsumed: true,
      actualModel: expect.any(String),
      terminalOutcomeHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      transcriptCanonicalJson: expect.any(String),
      transcriptHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      replayMaterialCanonicalJson: expect.any(String),
      replayMaterialHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(
      reviewActionV2GoldenFixtures.review_context_replay_commit.request,
    ).toMatchObject({
      executionId: expect.any(String),
      workSlotId: expect.any(String),
      attestationId: expect.any(String),
      attestationHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      targetReviewRevisionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      targetCheckoutTreeOid: expect.stringMatching(
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u,
      ),
      replayCapability: expect.any(String),
      replayResultCanonicalJson: expect.any(String),
      replayResultHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    const schema = JSON.parse(
      await readFile(
        new URL("../generated/review-action-v2.schema.json", import.meta.url),
        "utf8",
      ),
    ) as { readonly $defs: Readonly<Record<string, unknown>> };
    expect(
      requestProperties(schema, "review_context_gateway_open"),
    ).not.toHaveProperty("gatewaySessionSecret");
    expect(
      successResultProperties(schema, "review_context_gateway_open"),
    ).toHaveProperty("gatewaySessionSecret");

    for (const checkoutTreeOid of ["a".repeat(40), "b".repeat(64)]) {
      expect(
        parseReviewActionV2Request(
          ReviewActionV2OperationId.ReviewContextGatewayOpen,
          {
            ...fixture.request,
            checkoutTreeOid,
          },
        ),
      ).toMatchObject({ ok: true });
    }
    expect(
      parseReviewActionV2Request(
        ReviewActionV2OperationId.ReviewContextGatewayOpen,
        {
          ...fixture.request,
          checkoutTreeOid: "c".repeat(41),
        },
      ),
    ).toMatchObject({
      ok: false,
      issues: ["field_invalid:checkoutTreeOid"],
    });
  });

  it("publishes typed investigation operations with bounded retry semantics", async () => {
    const sources = await loadCompiledContractSources();
    const fragment = sources.semanticFragments.find(
      (candidate) => candidate.boundedContext === "review_investigations",
    );
    expect(
      fragment?.operations.map((operation) => operation.operationId),
    ).toEqual([
      ReviewActionV2OperationId.ReviewInvestigationOpen,
      ReviewActionV2OperationId.ReviewInvestigationRestore,
      ReviewActionV2OperationId.ReviewInvestigationTurnPlan,
      ReviewActionV2OperationId.ReviewInvestigationTurnCommit,
      ReviewActionV2OperationId.ReviewInvestigationTurnAbort,
      ReviewActionV2OperationId.ReviewInvestigationReplayPrepare,
      ReviewActionV2OperationId.ReviewInvestigationReplay,
      ReviewActionV2OperationId.ReviewInvestigationConclude,
    ]);
    expect(Object.values(ReviewInvestigationNextAction)).toEqual([
      "run_turn",
      "run_critic",
      "await_capacity",
      "conclude",
      "terminal",
    ]);
    expect(Object.values(ReviewInvestigationPublishedState)).toContain(
      "inconclusive",
    );
    expect(Object.values(ReviewInvestigationPublishedRuntimeProfile)).toContain(
      "gateway_attested_agent_v1",
    );
    expect(Object.values(ReviewInvestigationPublishedAbortReason)).toContain(
      "capacity_unavailable",
    );

    const operations = new Map(
      reviewActionV2Operations.map((operation) => [
        operation.operationId,
        operation,
      ]),
    );
    expect(
      operations.get(ReviewActionV2OperationId.ReviewInvestigationOpen),
    ).toMatchObject({
      boundedContext: "review_investigations",
      semanticRetryClass: "same_request",
      bodyLimitBytes: 524_288,
      successStatuses: [200, 201],
      resultStatuses: Object.values(ReviewInvestigationOpenResultStatus),
    });
    expect(
      operations.get(ReviewActionV2OperationId.ReviewInvestigationRestore),
    ).toMatchObject({
      semanticRetryClass: "read_only",
      resultStatuses: Object.values(ReviewInvestigationRestoreResultStatus),
    });
    expect(
      operations.get(ReviewActionV2OperationId.ReviewInvestigationTurnCommit),
    ).toMatchObject({
      callerAuthority:
        ReviewActionV2CallerAuthority.RunAuthorizationAndLeaseCapability,
      bodyLimitBytes: 2_097_152,
      resultStatuses: Object.values(ReviewInvestigationMutationResultStatus),
    });

    const schema = JSON.parse(
      await readFile(
        new URL("../generated/review-action-v2.schema.json", import.meta.url),
        "utf8",
      ),
    ) as { readonly $defs: Readonly<Record<string, unknown>> };
    expect(
      requestProperties(schema, "review_investigation_open").runtimeProfile,
    ).toEqual({
      enum: Object.values(ReviewInvestigationPublishedRuntimeProfile),
    });
    expect(
      requestProperties(schema, "review_investigation_turn_abort").abortReason,
    ).toEqual({
      enum: Object.values(ReviewInvestigationPublishedAbortReason),
    });
    expect(
      successResultProperties(schema, "review_investigation_turn_plan")
        .nextAction,
    ).toEqual({
      anyOf: [
        { enum: Object.values(ReviewInvestigationNextAction) },
        { type: "null" },
      ],
    });
  });

  it("publishes replay-required lookup fields as nullable target-replay material", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL("../generated/review-action-v2.schema.json", import.meta.url),
        "utf8",
      ),
    ) as { readonly $defs: Readonly<Record<string, unknown>> };
    const lookup = reviewActionV2Operations.find(
      (operation) =>
        operation.operationId ===
        ReviewActionV2OperationId.ReviewEvidenceLookup,
    );

    expect(lookup?.resultStatuses).toEqual(
      Object.values(ReviewEvidenceLookupResultStatus),
    );
    expect(lookup?.resultStatuses).toContain(
      ReviewEvidenceLookupResultStatus.ReplayRequired,
    );
    expect(
      successResultProperties(schema, "review_evidence_lookup"),
    ).toMatchObject({
      contextDependencyAttestationId: {
        anyOf: expect.arrayContaining([{ type: "null" }]),
      },
      contextDependencyAttestationHash: {
        anyOf: expect.arrayContaining([{ type: "null" }]),
      },
      contextReplayCapability: {
        anyOf: expect.arrayContaining([{ type: "null" }]),
      },
      contextReplayPlanCanonicalJson: {
        anyOf: expect.arrayContaining([{ type: "null" }]),
      },
      contextReplayPlanHash: {
        anyOf: expect.arrayContaining([{ type: "null" }]),
      },
    });
  });

  it("binds the evidence-commit context attestation as an all-or-none semantic pair", async () => {
    const fixture = reviewActionV2GoldenFixtures.review_evidence_commit.request;
    expect(fixture).toMatchObject({
      contextDependencyAttestationId: null,
      contextDependencyAttestationHash: null,
    });

    const withAttestation = {
      ...fixture,
      contextDependencyAttestationId: "attestation_fixture",
      contextDependencyAttestationHash: "a".repeat(64),
    };
    expect(
      parseReviewActionV2Request(
        ReviewActionV2OperationId.ReviewEvidenceCommit,
        withAttestation,
      ),
    ).toMatchObject({ ok: true });

    for (const malformed of [
      {
        ...withAttestation,
        contextDependencyAttestationId: null,
      },
      {
        ...withAttestation,
        contextDependencyAttestationHash: null,
      },
    ]) {
      expect(
        parseReviewActionV2Request(
          ReviewActionV2OperationId.ReviewEvidenceCommit,
          malformed,
        ),
      ).toMatchObject({
        ok: false,
        issues: [
          "field_group_all_or_none:contextDependencyAttestationId,contextDependencyAttestationHash",
        ],
      });
    }

    const withoutCanonical = canonicalizeReviewActionV2Request(
      ReviewActionV2OperationId.ReviewEvidenceCommit,
      fixture,
    );
    const withCanonical = canonicalizeReviewActionV2Request(
      ReviewActionV2OperationId.ReviewEvidenceCommit,
      withAttestation,
    );
    expect(sha256(withCanonical)).not.toBe(sha256(withoutCanonical));
    expect(JSON.parse(withCanonical)).toMatchObject({
      contextDependencyAttestationId: "attestation_fixture",
      contextDependencyAttestationHash: "a".repeat(64),
    });

    const schema = JSON.parse(
      await readFile(
        new URL("../generated/review-action-v2.schema.json", import.meta.url),
        "utf8",
      ),
    ) as {
      readonly $defs: Readonly<
        Record<
          string,
          {
            readonly properties?: Readonly<Record<string, unknown>>;
            readonly allOf?: readonly unknown[];
          }
        >
      >;
    };
    const commitSchema = schema.$defs.review_evidence_commit_request;
    expect(commitSchema?.properties).toMatchObject({
      contextDependencyAttestationId: expect.any(Object),
      contextDependencyAttestationHash: expect.any(Object),
    });
    expect(commitSchema?.allOf).toHaveLength(2);
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

function requestProperties(
  schema: { readonly $defs: Readonly<Record<string, unknown>> },
  operationId: string,
): Readonly<Record<string, unknown>> {
  const definition = schema.$defs[`${operationId}_request`] as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  return definition.properties ?? {};
}
