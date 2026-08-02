import { describe, expect, it, vi } from "vitest";
import {
  AcceptReviewObservation,
  AcceptReviewObservationRejectionReason,
  AcceptReviewObservationStatus,
  ActualModelCompatibilityMode,
  ContextAttestationVerificationDenialReason,
  ContextAttestationVerificationStatus,
  InvestigationCertificateConclusion,
  InvestigationCertificateVerificationDenialReason,
  InvestigationCertificateVerificationStatus,
  ProviderExecutionProfile,
  ProviderResultCompletionStatus,
  ReviewExecutionAttemptReportState,
  ReviewObservationQualityFlag,
  ReviewReuseEffectMode,
  type AcceptReviewObservationCommand,
} from "../index";
import {
  FixedClock,
  InMemoryReviewEvidenceSafetyPort,
  InMemoryReviewExecutionAttemptFactsPort,
  InMemoryReviewObservationStore,
  NodeSha256DigestAdapter,
  SequentialReviewObservationIdentityPort,
} from "../testing";
import { PruneReviewEvidence } from "../application/use-cases/prune-review-evidence";
import { attemptFacts, dayMs, hash, nowMs, payload } from "./fixtures";

describe("AcceptReviewObservation", () => {
  it("accepts one immutable redacted success and retries idempotently", async () => {
    const fixture = setup();
    fixture.attempts.put(attemptFacts());
    const first = await fixture.useCase.execute(
      command({
        payload: payload({
          normalizedFindings: [
            {
              ...payload().normalizedFindings[0]!,
              message: "password=plain-text-secret",
            },
          ],
        }),
      }),
    );
    const retried = await fixture.useCase.execute(
      command({
        payload: payload({
          normalizedFindings: [
            {
              ...payload().normalizedFindings[0]!,
              message: "password=plain-text-secret",
            },
          ],
        }),
      }),
    );

    expect(first.status).toBe(AcceptReviewObservationStatus.Accepted);
    expect(retried.status).toBe(AcceptReviewObservationStatus.Idempotent);
    expect(retried.observation?.observationId).toBe(
      first.observation?.observationId,
    );
    expect(fixture.store.all()).toHaveLength(1);
    expect(first.observation?.payload.normalizedFindings[0]?.message).toBe(
      "password=[REDACTED]",
    );
    expect(first.observation?.evidenceWriteSafetyDecisionHash).toBe(hash("f"));
  });

  it("detects a different successful payload for the same attempt as conflict", async () => {
    const fixture = setup();
    fixture.attempts.put(attemptFacts());
    await fixture.useCase.execute(command());

    const result = await fixture.useCase.execute(
      command({
        payload: payload({
          normalizedFindings: [
            {
              ...payload().normalizedFindings[0]!,
              message: "Different result",
            },
          ],
        }),
      }),
    );

    expect(result.status).toBe(AcceptReviewObservationStatus.Conflict);
    expect(fixture.store.all()).toHaveLength(1);
  });

  it.each([
    ProviderResultCompletionStatus.Timeout,
    ProviderResultCompletionStatus.Cancelled,
    ProviderResultCompletionStatus.RateLimited,
    ProviderResultCompletionStatus.Partial,
    ProviderResultCompletionStatus.Invalid,
    ProviderResultCompletionStatus.Unknown,
  ])("does not create reusable evidence for %s", async (completionStatus) => {
    const fixture = setup();
    fixture.attempts.put(attemptFacts());

    const result = await fixture.useCase.execute(command({ completionStatus }));

    expect(result).toEqual({
      status: AcceptReviewObservationStatus.Rejected,
      reason: AcceptReviewObservationRejectionReason.ResultNotReusableSuccess,
    });
    expect(fixture.store.all()).toHaveLength(0);
  });

  it("rejects incomplete schema consumption before persistence", async () => {
    const fixture = setup();
    fixture.attempts.put(attemptFacts());

    await expect(
      fixture.useCase.execute(command({ schemaValidated: false })),
    ).resolves.toMatchObject({
      status: AcceptReviewObservationStatus.Rejected,
      reason: AcceptReviewObservationRejectionReason.ResultNotReusableSuccess,
    });
    await expect(
      fixture.useCase.execute(command({ fullyConsumed: false })),
    ).resolves.toMatchObject({
      status: AcceptReviewObservationStatus.Rejected,
      reason: AcceptReviewObservationRejectionReason.ResultNotReusableSuccess,
    });
  });

  it("rejects missing, mismatched, revoked and expired report authority", async () => {
    const fixture = setup();
    await expect(fixture.useCase.execute(command())).resolves.toMatchObject({
      reason: AcceptReviewObservationRejectionReason.AttemptNotFound,
    });

    fixture.attempts.put(attemptFacts());
    await expect(
      fixture.useCase.execute(command({ ownerIdHash: hash("e") })),
    ).resolves.toMatchObject({
      reason: AcceptReviewObservationRejectionReason.AttemptAuthorityMismatch,
    });

    fixture.attempts.put(
      attemptFacts({
        reportState: ReviewExecutionAttemptReportState.AuthorizationRevoked,
      }),
    );
    await expect(fixture.useCase.execute(command())).resolves.toMatchObject({
      reason: AcceptReviewObservationRejectionReason.AttemptNotReportable,
    });

    fixture.attempts.put(
      attemptFacts({
        reportState: ReviewExecutionAttemptReportState.Reportable,
        resultReportUntilMs: nowMs,
      }),
    );
    await expect(fixture.useCase.execute(command())).resolves.toMatchObject({
      reason: AcceptReviewObservationRejectionReason.ResultReportWindowExpired,
    });
  });

  it("rejects persisted attempt facts whose claimed keys do not match the manifest", async () => {
    const fixture = setup();
    fixture.attempts.put(attemptFacts({ manifestKey: hash("0") }));

    await expect(fixture.useCase.execute(command())).resolves.toMatchObject({
      status: AcceptReviewObservationStatus.Rejected,
      reason: AcceptReviewObservationRejectionReason.AttemptManifestMismatch,
    });
    expect(fixture.store.all()).toHaveLength(0);
  });

  it("accepts a superseded attempt as historical only but cannot claim coverage", async () => {
    const fixture = setup();
    fixture.attempts.put(
      attemptFacts({
        reportState: ReviewExecutionAttemptReportState.SupersededHistoricalOnly,
      }),
    );

    const result = await fixture.useCase.execute(command());

    expect(result.status).toBe(AcceptReviewObservationStatus.Accepted);
    expect(result.historicalOnly).toBe(true);
  });

  it("binds a context attestation to the canonical observation payload hash", async () => {
    const verifyAcceptedAttestation = vi.fn(async (query) => ({
      status: ContextAttestationVerificationStatus.Accepted,
      reason: ContextAttestationVerificationDenialReason.None,
      acceptedAttestationHash: query.attestationHash,
    }));
    const fixture = setup({ verifyAcceptedAttestation });
    fixture.attempts.put(
      attemptFacts({
        executionProfile: ProviderExecutionProfile.ContextGatewayV1,
      }),
    );

    const result = await fixture.useCase.execute(
      command({
        contextDependencyAttestationId: "attestation-1",
        contextDependencyAttestationHash: hash("9"),
      }),
    );

    expect(result.status).toBe(AcceptReviewObservationStatus.Accepted);
    expect(verifyAcceptedAttestation).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalOutcomeHash: result.observation?.payloadHash,
      }),
    );
  });

  it("rejects a context-gateway observation without an accepted attestation", async () => {
    const verifyAcceptedAttestation = vi.fn();
    const fixture = setup({ verifyAcceptedAttestation });
    fixture.attempts.put(
      attemptFacts({
        executionProfile: ProviderExecutionProfile.ContextGatewayV1,
      }),
    );

    const result = await fixture.useCase.execute(command());

    expect(result).toEqual({
      status: AcceptReviewObservationStatus.Rejected,
      reason:
        AcceptReviewObservationRejectionReason.ContextAttestationNotAccepted,
    });
    expect(verifyAcceptedAttestation).not.toHaveBeenCalled();
  });

  it("accepts an investigation observation only through its bound certificate", async () => {
    const verifyAcceptedCertificate = vi.fn(async () => ({
      status: InvestigationCertificateVerificationStatus.Accepted,
      reason: InvestigationCertificateVerificationDenialReason.None,
      acceptedCertificateHash: hash("8"),
      conclusion: InvestigationCertificateConclusion.VerifiedClean,
    }));
    const fixture = setup(undefined, { verifyAcceptedCertificate }, true);
    fixture.attempts.put(
      attemptFacts({
        executionProfile: ProviderExecutionProfile.InvestigationGatewayV1,
      }),
    );

    const result = await fixture.useCase.execute(command({
      investigationCertificateId: "certificate-1",
      investigationCertificateHash: hash("8"),
      payload: payload({ normalizedFindings: [] }),
    }));
    expect(result.status).toBe(AcceptReviewObservationStatus.Accepted);
    expect(verifyAcceptedCertificate).toHaveBeenCalledOnce();
    expect(fixture.store.all()).toHaveLength(1);
  });

  it("keeps investigation certificate acceptance disabled by default", async () => {
    const verifyAcceptedCertificate = vi.fn();
    const fixture = setup(undefined, { verifyAcceptedCertificate });
    fixture.attempts.put(attemptFacts({
      executionProfile: ProviderExecutionProfile.InvestigationGatewayV1,
    }));
    await expect(fixture.useCase.execute(command({
      investigationCertificateId: "certificate-1",
      investigationCertificateHash: hash("8"),
      payload: payload({ normalizedFindings: [] }),
    }))).resolves.toEqual({
      status: AcceptReviewObservationStatus.Rejected,
      reason:
        AcceptReviewObservationRejectionReason.InvestigationCertificatePathDisabled,
    });
    expect(verifyAcceptedCertificate).not.toHaveBeenCalled();
  });

  it("rejects an incomplete context attestation reference", async () => {
    const fixture = setup();
    fixture.attempts.put(
      attemptFacts({
        executionProfile: ProviderExecutionProfile.ContextGatewayV1,
      }),
    );

    await expect(
      fixture.useCase.execute(
        command({
          contextDependencyAttestationId: "attestation-1",
          contextDependencyAttestationHash: null,
        }),
      ),
    ).resolves.toMatchObject({
      status: AcceptReviewObservationStatus.Rejected,
      reason:
        AcceptReviewObservationRejectionReason.ContextAttestationNotAccepted,
    });
  });

  it("fails closed when evidence writes are disabled", async () => {
    const fixture = setup();
    fixture.attempts.put(attemptFacts());
    fixture.safety.writeDecision = {
      effectAllowed: false,
      safetyDecisionHash: hash("f"),
    };

    await expect(fixture.useCase.execute(command())).resolves.toMatchObject({
      status: AcceptReviewObservationStatus.Rejected,
      reason: AcceptReviewObservationRejectionReason.EvidenceWritesDisabled,
    });
  });

  it("prunes only retained observations without live references", async () => {
    const fixture = setup();
    fixture.attempts.put(attemptFacts());
    const accepted = await fixture.useCase.execute(command());
    const id = accepted.observation?.observationId;
    expect(id).toBeDefined();
    fixture.store.protectObservation(id!);
    fixture.clock.set(nowMs + 31 * dayMs);
    const pruner = new PruneReviewEvidence({
      pruner: fixture.store,
      clock: fixture.clock,
    });

    await expect(pruner.execute({ limit: 10 })).resolves.toBe(0);
    fixture.store.releaseObservation(id!);
    await expect(pruner.execute({ limit: 10 })).resolves.toBe(1);
    expect(fixture.store.all()).toHaveLength(0);
  });
});

function setup(
  contextAttestations: ConstructorParameters<
    typeof AcceptReviewObservation
  >[0]["contextAttestations"] | undefined = undefined,
  investigationCertificates: ConstructorParameters<
    typeof AcceptReviewObservation
  >[0]["investigationCertificates"] = {
    verifyAcceptedCertificate: async () => {
      throw new Error("unexpected_investigation_certificate_verification");
    },
  },
  investigationCertificateAcceptanceEnabled = false,
) {
  const resolvedContextAttestations = contextAttestations ?? {
    verifyAcceptedAttestation: async () => {
      throw new Error("unexpected_context_attestation_verification");
    },
  };
  const attempts = new InMemoryReviewExecutionAttemptFactsPort();
  const safety = new InMemoryReviewEvidenceSafetyPort(
    { effectAllowed: true, safetyDecisionHash: hash("f") },
    {
      safetyDecision: {
        evidenceReuseMode: ReviewReuseEffectMode.Enabled,
        promptOnlyReuseMode: ReviewReuseEffectMode.Enabled,
        contextGatewayReuseMode: ReviewReuseEffectMode.Disabled,
        safetyDecisionHash: hash("1"),
      },
      compatibility: {
        registeredProducerReleaseIds: ["release-1"],
        trustedCapabilityProfiles: ["trusted-capability-v1"],
        compatibleProviderRuntimeVersions: ["runtime-v1"],
        actualModelMode: ActualModelCompatibilityMode.Exact,
        compatibleActualModels: [],
      },
    },
  );
  const store = new InMemoryReviewObservationStore();
  const clock = new FixedClock(nowMs);
  return {
    attempts,
    safety,
    store,
    clock,
    useCase: new AcceptReviewObservation({
      attempts,
      safety,
      observations: store,
      identities: new SequentialReviewObservationIdentityPort(),
      contextAttestations: resolvedContextAttestations,
      investigationCertificates,
      investigationCertificateAcceptanceEnabled,
      digest: new NodeSha256DigestAdapter(),
      clock,
      reuseTtlMs: 7 * dayMs,
      retainTtlMs: 30 * dayMs,
    }),
  };
}

function command(
  overrides: Partial<AcceptReviewObservationCommand> = {},
): AcceptReviewObservationCommand {
  return {
    attemptId: "attempt-1",
    leaseCapabilityId: "lease-capability-1",
    sourceLeaseId: "lease-1",
    ownerIdHash: hash("d"),
    sourceFencingToken: "1001",
    completionStatus: ProviderResultCompletionStatus.Success,
    schemaValidated: true,
    fullyConsumed: true,
    actualModel: "gpt-5.3-codex",
    payload: payload(),
    qualityFlags: [ReviewObservationQualityFlag.ProviderWarning],
    transportAttemptCount: 1,
    contextDependencyAttestationId: null,
    contextDependencyAttestationHash: null,
    investigationCertificateId: null,
    investigationCertificateHash: null,
    ...overrides,
  };
}
