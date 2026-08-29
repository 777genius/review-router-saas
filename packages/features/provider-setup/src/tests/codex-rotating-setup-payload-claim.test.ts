import { describe, expect, it } from "vitest";
import {
  assertCodexRotatingAccountIdentityTransition,
  assertCodexRotatingRunNamespace,
  codexRotatingForcedRecoveryAttemptTransitions,
  codexRotatingForcedRecoveryClaimTransitions,
  codexRotatingSetupIdentityBearingClaimStatuses,
  codexRotatingSetupAttemptStatuses,
  codexRotatingSetupClaimStatuses,
  codexRotatingSetupLiveAttemptStatuses,
  codexRotatingSetupLiveClaimStatuses,
  codexRotatingSetupTerminalAttemptStatuses,
  codexRotatingSetupTerminalClaimStatuses,
  authorizeCodexRotatingSetupDispatch,
  getCodexRotatingSetupStatus,
  InMemoryCodexRotatingSetupPayloadClaim,
  prepareCodexRotatingSetup,
  recordCodexRotatingSetupDispatchOutcome,
} from "../index";

const claim = {
  payloadVersion: 2 as const,
  canonicalizationVersion: 1 as const,
  operationId: "operation:payload-claim-0001",
  repositoryId: "900001",
  providerInstanceId: "codex-rotating:900001",
  setupNonce: "stp:payload-claim-0001",
  manifestDigest: "a".repeat(64),
  recoveryEpoch: "7",
  generationHash: "g".repeat(43),
  accountIdentityHash: "i".repeat(43),
  accountIdentityAlgorithm: "provider_issuer_subject_account_v1" as const,
  authByteSize: 1234,
  installerVersion: "2026.08.09",
  installerDigest: "b".repeat(64),
};

function mutableClock(initial = "2026-08-10T00:00:00.000Z") {
  let current = new Date(initial);
  return {
    clock: { now: () => new Date(current.getTime()) },
    advance(milliseconds: number) {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

describe("versioned rotating setup recovery ledger", () => {
  it("defines one exhaustive live/terminal state model and recovery policy", () => {
    expect([
      ...codexRotatingSetupLiveClaimStatuses,
      ...codexRotatingSetupTerminalClaimStatuses,
    ]).toEqual(codexRotatingSetupClaimStatuses);
    expect([
      ...codexRotatingSetupLiveAttemptStatuses,
      ...codexRotatingSetupTerminalAttemptStatuses,
    ]).toEqual(codexRotatingSetupAttemptStatuses);
    expect(codexRotatingForcedRecoveryClaimTransitions).toEqual({
      prepared: "superseded_predispatch",
      confirmed_candidate: "retired_confirmed",
      active: "retired_active",
    });
    expect(codexRotatingForcedRecoveryAttemptTransitions).toEqual({
      dispatch_authorized: "retired_ambiguous",
      confirmed: "retired_confirmed",
    });
    expect(codexRotatingSetupIdentityBearingClaimStatuses).toEqual([
      "confirmed_candidate",
      "active",
      "retired_confirmed",
      "retired_active",
    ]);
  });

  it("does not accept public repository, provider, or setup-nonce identifiers as the continuation capability", async () => {
    const ledger = new InMemoryCodexRotatingSetupPayloadClaim();
    const prepared = await prepareCodexRotatingSetup(claim, { claims: ledger });
    expect(prepared.claimId).toMatch(
      /^codex_claim_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
    );

    for (const publicIdentifier of [
      claim.repositoryId,
      claim.providerInstanceId,
      claim.setupNonce,
    ]) {
      expect(() =>
        authorizeCodexRotatingSetupDispatch(
          {
            claimId: publicIdentifier,
            idempotencyKey: "dispatch:public-metadata-cannot-authorize",
          },
          { claims: ledger },
        ),
      ).toThrow();
      expect(() =>
        recordCodexRotatingSetupDispatchOutcome(
          {
            claimId: publicIdentifier,
            attemptId: "codex_attempt_00000000-0000-4000-8000-000000000001",
            outcome: "unknown",
          },
          { claims: ledger },
        ),
      ).toThrow();
      expect(() =>
        getCodexRotatingSetupStatus(
          { claimId: publicIdentifier },
          { claims: ledger },
        ),
      ).toThrow();
    }

    const wellFormedGuess = "codex_claim_22222222-2222-4222-8222-222222222222";
    await expect(
      authorizeCodexRotatingSetupDispatch(
        {
          claimId: wellFormedGuess,
          idempotencyKey: "dispatch:well-formed-guess",
        },
        { claims: ledger },
      ),
    ).rejects.toThrow("codex_rotating_setup_claim_not_found");
    await expect(
      recordCodexRotatingSetupDispatchOutcome(
        {
          claimId: wellFormedGuess,
          attemptId: "codex_attempt_22222222-2222-4222-8222-222222222222",
          outcome: "unknown",
        },
        { claims: ledger },
      ),
    ).rejects.toThrow("codex_rotating_setup_claim_not_found");
    await expect(
      getCodexRotatingSetupStatus(
        { claimId: wellFormedGuess },
        { claims: ledger },
      ),
    ).rejects.toThrow("codex_rotating_setup_claim_not_found");

    await expect(ledger.status(prepared.claimId)).resolves.toMatchObject({
      status: "prepared",
      databaseIncarnation: "in_memory_writer",
      databaseRecoveryWitnessFingerprint:
        expect.stringMatching(/^[a-f0-9]{64}$/),
      attempt: null,
    });
    await expect(
      authorizeCodexRotatingSetupDispatch(
        {
          claimId: prepared.claimId,
          idempotencyKey: "dispatch:real-server-capability",
        },
        { claims: ledger },
      ),
    ).resolves.toMatchObject({ status: "dispatch_authorized" });
  });

  it("represents predispatch retirement without reviving an authorized attempt", async () => {
    const ledger = new InMemoryCodexRotatingSetupPayloadClaim();
    const prepared = await ledger.claim(claim);
    const attempt = await ledger.authorizeDispatch({
      claimId: prepared.claimId,
      idempotencyKey: "dispatch:predispatch-retirement",
    });

    ledger.authorizeRecoveryFence({
      providerInstanceId: claim.providerInstanceId,
      recoveryRequestId: "recovery:predispatch-retirement",
      recoveryEpoch: 8n,
    });
    await ledger.retireProviderGeneration({
      providerInstanceId: claim.providerInstanceId,
      recoveryRequestId: "recovery:predispatch-retirement",
      recoveryEpoch: 8n,
    });

    await expect(ledger.status(prepared.claimId)).resolves.toMatchObject({
      status: "superseded_predispatch",
      attempt: { status: "retired_ambiguous" },
    });
    await expect(
      ledger.authorizeDispatch({
        claimId: prepared.claimId,
        idempotencyKey: "dispatch:predispatch-retirement",
      }),
    ).rejects.toThrow("codex_rotating_setup_namespace_retired");
    await expect(
      ledger.recordDispatchOutcome({
        claimId: prepared.claimId,
        attemptId: attempt.attemptId,
        outcome: "unknown",
      }),
    ).rejects.toThrow("codex_rotating_setup_namespace_retired");
  });

  it("keeps forced-retirement evidence terminal across every setup operation", async () => {
    const ledger = new InMemoryCodexRotatingSetupPayloadClaim();
    const prepared = await ledger.claim(claim);
    const attempt = await ledger.authorizeDispatch({
      claimId: prepared.claimId,
      idempotencyKey: "dispatch:retirement-parity",
    });
    await ledger.recordDispatchOutcome({
      claimId: prepared.claimId,
      attemptId: attempt.attemptId,
      outcome: "definite_success",
      responseCode: 204,
    });
    ledger.authorizeRecoveryFence({
      providerInstanceId: claim.providerInstanceId,
      recoveryRequestId: "recovery:retirement-parity",
      recoveryEpoch: 8n,
    });
    await ledger.retireProviderGeneration({
      providerInstanceId: claim.providerInstanceId,
      recoveryRequestId: "recovery:retirement-parity",
      recoveryEpoch: 8n,
    });

    await expect(ledger.claim(claim)).rejects.toThrow(
      "codex_rotating_setup_recovery_required",
    );
    await expect(
      ledger.authorizeDispatch({
        claimId: prepared.claimId,
        idempotencyKey: "dispatch:retirement-parity",
      }),
    ).rejects.toThrow("codex_rotating_setup_namespace_retired");
    await expect(
      ledger.authorizeDispatch({
        claimId: prepared.claimId,
        idempotencyKey: "dispatch:after-retirement",
      }),
    ).rejects.toThrow("codex_rotating_setup_namespace_retired");
    await expect(
      ledger.recordDispatchOutcome({
        claimId: prepared.claimId,
        attemptId: attempt.attemptId,
        outcome: "definite_success",
        responseCode: 204,
      }),
    ).rejects.toThrow("codex_rotating_setup_namespace_retired");
    await expect(
      ledger.activate({
        claimId: prepared.claimId,
        attemptId: attempt.attemptId,
        repositoryId: claim.repositoryId,
        namespaceId: attempt.namespaceId,
        namespaceEpoch: attempt.namespaceEpoch,
        secretName: attempt.secretName,
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        workflowSourceCommitSha: "d".repeat(40),
        workflowSourceBlobSha: "e".repeat(40),
        workflowSourceSha256: "c".repeat(64),
        workflowSemanticSha256: "f".repeat(64),
        sourceTrust: "trusted_default_branch_revision",
        workflowSchemaVersion: 5,
      }),
    ).rejects.toThrow("codex_rotating_setup_namespace_retired");
    await expect(ledger.status(prepared.claimId)).resolves.toMatchObject({
      status: "retired_confirmed",
      attempt: { status: "retired_confirmed" },
    });
    await expect(
      ledger.claim({
        ...claim,
        operationId: "operation:post-retirement-account-switch",
        recoveryEpoch: "8",
        accountIdentityHash: "z".repeat(43),
      }),
    ).rejects.toThrow("codex_rotating_account_switch_epoch_required");
  });

  it("does not expose mutable aliases that can revive retired attempt evidence", async () => {
    const ledger = new InMemoryCodexRotatingSetupPayloadClaim();
    const prepared = await ledger.claim(claim);
    const returnedAttempt = await ledger.authorizeDispatch({
      claimId: prepared.claimId,
      idempotencyKey: "dispatch:terminal-alias",
    });
    (returnedAttempt as { status: "retired_confirmed" }).status =
      "retired_confirmed";

    await expect(ledger.status(prepared.claimId)).resolves.toMatchObject({
      status: "prepared",
      attempt: { status: "dispatch_authorized" },
    });
    const returnedReplay = await ledger.authorizeDispatch({
      claimId: prepared.claimId,
      idempotencyKey: "dispatch:terminal-alias",
    });
    (returnedReplay as { status: "retired_ambiguous" }).status =
      "retired_ambiguous";
    await expect(ledger.status(prepared.claimId)).resolves.toMatchObject({
      status: "prepared",
      attempt: { status: "dispatch_authorized" },
    });

    ledger.authorizeRecoveryFence({
      providerInstanceId: claim.providerInstanceId,
      recoveryRequestId: "recovery:terminal-alias",
      recoveryEpoch: 8n,
    });
    await ledger.retireProviderGeneration({
      providerInstanceId: claim.providerInstanceId,
      recoveryRequestId: "recovery:terminal-alias",
      recoveryEpoch: 8n,
    });

    const terminalSnapshot = await ledger.status(prepared.claimId);
    (terminalSnapshot.attempt as { status: "dispatch_authorized" }).status =
      "dispatch_authorized";
    await expect(ledger.status(prepared.claimId)).resolves.toMatchObject({
      status: "superseded_predispatch",
      attempt: { status: "retired_ambiguous" },
    });
    await expect(
      ledger.authorizeDispatch({
        claimId: prepared.claimId,
        idempotencyKey: "dispatch:terminal-alias",
      }),
    ).rejects.toThrow("codex_rotating_setup_namespace_retired");
  });

  it("keeps an activated claim retired across every replay path", async () => {
    const ledger = new InMemoryCodexRotatingSetupPayloadClaim();
    const prepared = await ledger.claim(claim);
    const attempt = await ledger.authorizeDispatch({
      claimId: prepared.claimId,
      idempotencyKey: "dispatch:active-retirement",
    });
    await ledger.recordDispatchOutcome({
      claimId: prepared.claimId,
      attemptId: attempt.attemptId,
      outcome: "definite_success",
      responseCode: 201,
    });
    const activation = {
      claimId: prepared.claimId,
      attemptId: attempt.attemptId,
      repositoryId: claim.repositoryId,
      namespaceId: attempt.namespaceId,
      namespaceEpoch: attempt.namespaceEpoch,
      secretName: attempt.secretName,
      workflowPath: ".github/workflows/reviewrouter-codex.yml" as const,
      workflowSourceCommitSha: "d".repeat(40),
      workflowSourceBlobSha: "e".repeat(40),
      workflowSourceSha256: "c".repeat(64),
      workflowSemanticSha256: "f".repeat(64),
      sourceTrust: "trusted_default_branch_revision" as const,
      workflowSchemaVersion: 5,
    };
    await ledger.activate(activation);
    await expect(ledger.claim(claim)).rejects.toThrow(
      "codex_rotating_setup_confirmation_stale_epoch",
    );
    ledger.authorizeRecoveryFence({
      providerInstanceId: claim.providerInstanceId,
      recoveryRequestId: "recovery:active-retirement",
      recoveryEpoch: 8n,
    });
    await ledger.retireProviderGeneration({
      providerInstanceId: claim.providerInstanceId,
      recoveryRequestId: "recovery:active-retirement",
      recoveryEpoch: 8n,
    });
    await ledger.retireProviderGeneration({
      providerInstanceId: claim.providerInstanceId,
      recoveryRequestId: "recovery:active-retirement",
      recoveryEpoch: 8n,
    });

    await expect(ledger.claim(claim)).rejects.toThrow(
      "codex_rotating_setup_recovery_required",
    );
    await expect(
      ledger.authorizeDispatch({
        claimId: prepared.claimId,
        idempotencyKey: "dispatch:active-retirement",
      }),
    ).rejects.toThrow("codex_rotating_setup_namespace_retired");
    await expect(
      ledger.recordDispatchOutcome({
        claimId: prepared.claimId,
        attemptId: attempt.attemptId,
        outcome: "definite_success",
        responseCode: 201,
      }),
    ).rejects.toThrow("codex_rotating_setup_namespace_retired");
    await expect(ledger.activate(activation)).rejects.toThrow(
      "codex_rotating_setup_namespace_retired",
    );
    await expect(ledger.status(prepared.claimId)).resolves.toMatchObject({
      status: "retired_active",
      attempt: { status: "retired_confirmed" },
    });
  });

  it("requires the exact recovery request and epoch before retirement", async () => {
    const ledger = new InMemoryCodexRotatingSetupPayloadClaim();
    const prepared = await ledger.claim(claim);
    const exactFence = {
      providerInstanceId: claim.providerInstanceId,
      recoveryRequestId: "recovery:exact-memory-fence",
      recoveryEpoch: 8n,
    } as const;

    await expect(ledger.retireProviderGeneration(exactFence)).rejects.toThrow(
      "codex_rotating_setup_recovery_required",
    );
    ledger.authorizeRecoveryFence(exactFence);
    await expect(
      ledger.retireProviderGeneration({
        ...exactFence,
        recoveryRequestId: "recovery:wrong-memory-fence",
      }),
    ).rejects.toThrow("codex_rotating_setup_recovery_required");
    await expect(
      ledger.retireProviderGeneration({
        ...exactFence,
        recoveryEpoch: 9n,
      }),
    ).rejects.toThrow("codex_rotating_setup_recovery_required");

    await expect(
      ledger.retireProviderGeneration(exactFence),
    ).resolves.toBeUndefined();
    await expect(
      ledger.retireProviderGeneration(exactFence),
    ).resolves.toBeUndefined();
    await expect(ledger.status(prepared.claimId)).resolves.toMatchObject({
      status: "superseded_predispatch",
    });
  });

  it("fails closed when a prepared replay reaches its immutable deadline", async () => {
    const time = mutableClock();
    const ledger = new InMemoryCodexRotatingSetupPayloadClaim(time.clock);
    const prepared = await ledger.claim(claim);
    time.advance(15 * 60_000);
    await expect(ledger.claim(claim)).rejects.toThrow(
      "codex_rotating_setup_authorization_expired",
    );
    expect((await ledger.status(prepared.claimId)).attempt).toBeNull();
  });

  it("tombstones an expired dispatch replay and rejects its late outcome", async () => {
    const time = mutableClock();
    const ledger = new InMemoryCodexRotatingSetupPayloadClaim(time.clock);
    const prepared = await ledger.claim(claim);
    const attempt = await ledger.authorizeDispatch({
      claimId: prepared.claimId,
      idempotencyKey: "dispatch:expired-replay",
    });
    time.advance(10 * 60_000);
    await expect(
      ledger.authorizeDispatch({
        claimId: prepared.claimId,
        idempotencyKey: "dispatch:expired-replay",
      }),
    ).rejects.toThrow("codex_rotating_setup_authorization_expired");
    expect((await ledger.status(prepared.claimId)).attempt?.status).toBe(
      "retired_ambiguous",
    );
    await expect(
      ledger.recordDispatchOutcome({
        claimId: prepared.claimId,
        attemptId: attempt.attemptId,
        outcome: "definite_success",
        responseCode: 204,
      }),
    ).rejects.toThrow("namespace_retired");
  });

  it("allows confirmed activation after dispatch expiry within the recovery window", async () => {
    const time = mutableClock();
    const ledger = new InMemoryCodexRotatingSetupPayloadClaim(time.clock);
    const prepared = await ledger.claim(claim);
    const attempt = await ledger.authorizeDispatch({
      claimId: prepared.claimId,
      idempotencyKey: "dispatch:delayed-activation",
    });
    await ledger.recordDispatchOutcome({
      claimId: prepared.claimId,
      attemptId: attempt.attemptId,
      outcome: "definite_success",
      responseCode: 204,
    });
    time.advance(10 * 60_000);
    await expect(
      ledger.activate({
        claimId: prepared.claimId,
        attemptId: attempt.attemptId,
        repositoryId: claim.repositoryId,
        namespaceId: attempt.namespaceId,
        namespaceEpoch: attempt.namespaceEpoch,
        secretName: attempt.secretName,
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        workflowSourceCommitSha: "d".repeat(40),
        workflowSourceBlobSha: "e".repeat(40),
        workflowSourceSha256: "c".repeat(64),
        workflowSemanticSha256: "f".repeat(64),
        sourceTrust: "trusted_default_branch_revision",
        workflowSchemaVersion: 5,
      }),
    ).resolves.toEqual({ status: "active" });
    await expect(
      ledger.authorizeDispatch({
        claimId: prepared.claimId,
        idempotencyKey: "dispatch:delayed-activation",
      }),
    ).rejects.toThrow("codex_rotating_setup_authorization_expired");
    await expect(
      ledger.recordDispatchOutcome({
        claimId: prepared.claimId,
        attemptId: attempt.attemptId,
        outcome: "definite_success",
        responseCode: 204,
      }),
    ).rejects.toThrow("codex_rotating_setup_authorization_expired");
  });
  it("requires an explicitly authorized account-switch epoch for changed identity", () => {
    expect(() =>
      assertCodexRotatingAccountIdentityTransition({
        priorAccountIdentityHash: "a".repeat(43),
        nextAccountIdentityHash: "b".repeat(43),
        recoveryMode: "forced_reseed",
      }),
    ).toThrow("codex_rotating_account_switch_epoch_required");
    expect(() =>
      assertCodexRotatingAccountIdentityTransition({
        priorAccountIdentityHash: "a".repeat(43),
        nextAccountIdentityHash: "b".repeat(43),
        recoveryMode: "forced_reseed_account_switch",
      }),
    ).not.toThrow();
    expect(() =>
      assertCodexRotatingAccountIdentityTransition({
        priorAccountIdentityHash: "a".repeat(43),
        nextAccountIdentityHash: "a".repeat(43),
        recoveryMode: null,
      }),
    ).not.toThrow();
  });
  it("replays a lost prepare without authorizing a PUT", async () => {
    const ledger = new InMemoryCodexRotatingSetupPayloadClaim();
    const first = await prepareCodexRotatingSetup(claim, { claims: ledger });
    const replay = await prepareCodexRotatingSetup(claim, { claims: ledger });
    expect(first.status).toBe("prepared");
    expect(replay).toMatchObject({
      status: "prepared_replay",
      claimId: first.claimId,
    });
    expect((await ledger.status(first.claimId)).attempt).toBeNull();
  });

  it("serializes concurrent payload claim identities", async () => {
    const ledger = new InMemoryCodexRotatingSetupPayloadClaim();
    const results = await Promise.allSettled([
      prepareCodexRotatingSetup(claim, { claims: ledger }),
      prepareCodexRotatingSetup(
        { ...claim, accountIdentityHash: "z".repeat(43) },
        { claims: ledger },
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  it("fails closed across epochs when no durable account-switch authority exists", async () => {
    const ledger = new InMemoryCodexRotatingSetupPayloadClaim();
    const prepared = await ledger.claim(claim);
    const attempt = await ledger.authorizeDispatch({
      claimId: prepared.claimId,
      idempotencyKey: "dispatch:identity-baseline",
    });
    await ledger.recordDispatchOutcome({
      claimId: prepared.claimId,
      attemptId: attempt.attemptId,
      outcome: "definite_success",
      responseCode: 204,
    });
    await expect(
      ledger.claim({
        ...claim,
        operationId: "operation:payload-claim-0002",
        recoveryEpoch: "8",
        accountIdentityHash: "z".repeat(43),
      }),
    ).rejects.toThrow("codex_rotating_account_switch_epoch_required");
  });

  it("retires an ambiguous name forever and allocates a distinct replacement", async () => {
    const ledger = new InMemoryCodexRotatingSetupPayloadClaim();
    const prepared = await ledger.claim(claim);
    const oldAttempt = await ledger.authorizeDispatch({
      claimId: prepared.claimId,
      idempotencyKey: "dispatch:old-0001",
    });
    await ledger.recordDispatchOutcome({
      claimId: prepared.claimId,
      attemptId: oldAttempt.attemptId,
      outcome: "unknown",
    });
    const replacement = await ledger.authorizeDispatch({
      claimId: prepared.claimId,
      idempotencyKey: "dispatch:new-0002",
    });
    expect(replacement.secretName).not.toBe(oldAttempt.secretName);
    await expect(
      ledger.recordDispatchOutcome({
        claimId: prepared.claimId,
        attemptId: oldAttempt.attemptId,
        outcome: "definite_success",
        responseCode: 204,
      }),
    ).rejects.toThrow("namespace_retired");
  });

  it("repairs a lost confirm through duplicate callback/status without a second dispatch", async () => {
    const ledger = new InMemoryCodexRotatingSetupPayloadClaim();
    const prepared = await ledger.claim(claim);
    const attempt = await ledger.authorizeDispatch({
      claimId: prepared.claimId,
      idempotencyKey: "dispatch:confirm-0001",
    });
    await ledger.recordDispatchOutcome({
      claimId: prepared.claimId,
      attemptId: attempt.attemptId,
      outcome: "definite_success",
      responseCode: 204,
    });
    await expect(
      ledger.recordDispatchOutcome({
        claimId: prepared.claimId,
        attemptId: attempt.attemptId,
        outcome: "definite_success",
        responseCode: 204,
      }),
    ).resolves.toEqual({ status: "confirmed_candidate" });
    expect((await ledger.status(prepared.claimId)).attempt?.attemptId).toBe(
      attempt.attemptId,
    );
  });

  it("requires exact repository/workflow/namespace attestation and rejects old queued runs", async () => {
    const ledger = new InMemoryCodexRotatingSetupPayloadClaim();
    const prepared = await ledger.claim(claim);
    const attempt = await ledger.authorizeDispatch({
      claimId: prepared.claimId,
      idempotencyKey: "dispatch:activate-0001",
    });
    await ledger.recordDispatchOutcome({
      claimId: prepared.claimId,
      attemptId: attempt.attemptId,
      outcome: "definite_success",
      responseCode: 201,
    });
    const attestation = {
      claimId: prepared.claimId,
      attemptId: attempt.attemptId,
      repositoryId: claim.repositoryId,
      namespaceId: attempt.namespaceId,
      namespaceEpoch: attempt.namespaceEpoch,
      secretName: attempt.secretName,
      workflowPath: ".github/workflows/reviewrouter-codex.yml" as const,
      workflowSourceCommitSha: "d".repeat(40),
      workflowSourceBlobSha: "e".repeat(40),
      workflowSourceSha256: "c".repeat(64),
      workflowSemanticSha256: "f".repeat(64),
      sourceTrust: "trusted_default_branch_revision" as const,
      workflowSchemaVersion: 5,
    };
    await expect(
      ledger.activate({
        ...attestation,
        workflowSemanticSha256: "a".repeat(64),
        namespaceEpoch: "999",
      }),
    ).rejects.toThrow("activation_mismatch");
    await expect(ledger.activate(attestation)).resolves.toEqual({
      status: "active",
    });
    expect(() =>
      assertCodexRotatingRunNamespace({
        activeNamespaceId: attempt.namespaceId,
        activeNamespaceEpoch: BigInt(attempt.namespaceEpoch),
        presentedNamespaceId: "namespace:old-queued",
        presentedNamespaceEpoch: 1n,
      }),
    ).toThrow("stale_secret_namespace");
  });

  it("property: no two dispatches ever share a secret name across faults", async () => {
    for (let run = 0; run < 40; run += 1) {
      const ledger = new InMemoryCodexRotatingSetupPayloadClaim();
      const prepared = await ledger.claim({
        ...claim,
        operationId: `operation:property-${run}`,
        recoveryEpoch: String(100 + run),
      });
      const names = new Set<string>();
      for (let ordinal = 0; ordinal < 3; ordinal += 1) {
        const attempt = await ledger.authorizeDispatch({
          claimId: prepared.claimId,
          idempotencyKey: `dispatch:${run}:${ordinal}`,
        });
        expect(names.has(attempt.secretName)).toBe(false);
        names.add(attempt.secretName);
        await ledger.recordDispatchOutcome({
          claimId: prepared.claimId,
          attemptId: attempt.attemptId,
          outcome: "unknown",
        });
      }
    }
  });
});
