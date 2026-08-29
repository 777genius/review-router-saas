import type {
  CodexRotatingDispatchAttempt,
  CodexRotatingSetupClaimAdmissionStatus,
  CodexRotatingSetupPayloadClaimPort,
} from "../../application/ports/codex-rotating-setup-payload-claim-port";
import type {
  CodexRotatingCurrentWorkflowAttestationPort,
  CodexRotatingWorkflowReattestationPersistencePort,
  CodexRotatingWorkflowReattestationTransition,
} from "../../application/ports/codex-rotating-workflow-reattestation-port";
import {
  assertCodexRotatingAccountIdentityTransition,
  codexRotatingSetupRecoveryFencesMatch,
  codexRotatingSetupPayloadClaimsMatch,
  isCodexRotatingSetupIdentityBearingClaimStatus,
  isCodexRotatingSetupTerminalClaimStatus,
  retireCodexRotatingSetupAttemptStatus,
  reserveCodexRotatingSetupDispatchAuthorityWindow,
  retireCodexRotatingSetupClaimStatus,
  type CodexRotatingActivation,
  type CodexRotatingSetupPayloadClaim,
  type CodexRotatingSetupClaimStatus,
  type CodexRotatingSetupRecoveryFence,
  type CodexRotatingSetupStatus,
} from "../../domain/codex-rotating-setup-payload-claim";
import {
  allocateVersionedProviderSecretNamespace,
  assertProviderSecretAuthorizationUnexpired,
  assertSameVersionedProviderSecretNamespace,
  createVersionedProviderSecretNamespace,
  createVersionedSecretWorkflowSourceAttestation,
  fingerprintDatabaseRecoveryWitness,
  type VersionedSecretWorkflowSourceAttestation,
  WorkflowSourceTrust,
} from "@reviewrouter/features-codex-oauth-rotating";

type Stored = {
  claim: CodexRotatingSetupPayloadClaim;
  claimId: string;
  status: CodexRotatingSetupClaimStatus;
  attempts: Map<string, CodexRotatingDispatchAttempt>;
  attemptOrder: string[];
  prepareReplayExpiresAt: Date;
  recoveryExpiresAt: Date;
  workflowAttestation: VersionedSecretWorkflowSourceAttestation | null;
};

export class InMemoryCodexRotatingSetupPayloadClaim
  implements
    CodexRotatingSetupPayloadClaimPort,
    CodexRotatingCurrentWorkflowAttestationPort,
    CodexRotatingWorkflowReattestationPersistencePort
{
  readonly #claims = new Map<string, Stored>();
  readonly #epochs = new Map<string, string>();
  readonly #recoveryFences = new Map<string, CodexRotatingSetupRecoveryFence>();
  #sequence = 0;

  constructor(
    private readonly clock: Readonly<{ now(): Date }> = {
      now: () => new Date(),
    },
  ) {}

  async claim(claim: CodexRotatingSetupPayloadClaim) {
    const key = `${claim.providerInstanceId}:${claim.operationId}`;
    const epochKey = `${claim.providerInstanceId}:${claim.recoveryEpoch}`;
    const existingKey = this.#epochs.get(epochKey);
    const existing = this.#claims.get(existingKey ?? key);
    if (existing) {
      const now = this.clock.now();
      if (isCodexRotatingSetupTerminalClaimStatus(existing.status)) {
        throw new Error("codex_rotating_setup_recovery_required");
      }
      if (existing.status === "active") {
        throw new Error("codex_rotating_setup_confirmation_stale_epoch");
      }
      this.#assertRecoveryUnexpired(existing, now);
      if (existing.status === "prepared") {
        this.#assertUnexpired(existing.prepareReplayExpiresAt, now);
      }
      if (!codexRotatingSetupPayloadClaimsMatch(existing.claim, claim)) {
        throw new Error("codex_rotating_setup_payload_claim_conflict");
      }
      return this.#claimResult(
        existing,
        existing.status === "prepared" ? "prepared_replay" : existing.status,
      );
    }
    const prior = [...new Set(this.#claims.values())]
      .filter(
        (stored) =>
          stored.claim.providerInstanceId === claim.providerInstanceId &&
          isCodexRotatingSetupIdentityBearingClaimStatus(stored.status),
      )
      .sort((left, right) =>
        BigInt(left.claim.recoveryEpoch) < BigInt(right.claim.recoveryEpoch)
          ? 1
          : -1,
      )[0];
    assertCodexRotatingAccountIdentityTransition({
      priorAccountIdentityHash: prior?.claim.accountIdentityHash ?? null,
      nextAccountIdentityHash: claim.accountIdentityHash,
      // The in-memory adapter has no durable recovery-request authority and
      // therefore cannot infer an account switch.
      recoveryMode: null,
    });
    const now = this.clock.now();
    const claimSequence = ++this.#sequence;
    const claimId = `codex_claim_00000000-0000-4000-8000-${claimSequence
      .toString(16)
      .padStart(12, "0")}`;
    const stored: Stored = {
      claim: { ...claim },
      claimId,
      status: "prepared",
      attempts: new Map(),
      attemptOrder: [],
      prepareReplayExpiresAt: new Date(now.getTime() + 15 * 60_000),
      recoveryExpiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
      workflowAttestation: null,
    };
    this.#claims.set(key, stored);
    this.#claims.set(claimId, stored);
    this.#epochs.set(epochKey, key);
    return this.#claimResult(stored, "prepared");
  }

  async authorizeDispatch(input: { claimId: string; idempotencyKey: string }) {
    const stored = this.#required(input.claimId);
    this.#assertNotRetired(stored);
    const now = this.clock.now();
    this.#assertRecoveryUnexpired(stored, now);
    const replay = stored.attempts.get(input.idempotencyKey);
    if (replay) {
      try {
        this.#assertUnexpired(new Date(replay.dispatchExpiresAt), now);
      } catch (error) {
        if (replay.status === "dispatch_authorized") {
          stored.attempts.set(input.idempotencyKey, {
            ...replay,
            status: "retired_ambiguous",
          });
        }
        throw error;
      }
      return this.#attemptResult(replay);
    }
    const previous = stored.attemptOrder.at(-1);
    if (previous) {
      const old = stored.attempts.get(previous)!;
      if (old.status === "dispatch_authorized") {
        stored.attempts.set(previous, { ...old, status: "retired_ambiguous" });
      } else if (old.status === "confirmed") {
        throw new Error("codex_rotating_setup_already_confirmed");
      }
    }
    const ordinal = stored.attemptOrder.length + 1;
    if (ordinal > 3) throw new Error("codex_rotating_setup_attempt_limit");
    const sequence = ++this.#sequence;
    const allocated = allocateVersionedProviderSecretNamespace({
      scope: {
        repositoryId: stored.claim.repositoryId,
        providerInstanceId: stored.claim.providerInstanceId,
      },
      epoch: sequence,
      randomBytes: (size) =>
        Uint8Array.from(
          { length: size },
          (_, index) => (sequence + index) & 0xff,
        ),
    });
    const attempt: CodexRotatingDispatchAttempt = {
      claimId: stored.claimId,
      attemptId: `attempt:${sequence}`,
      namespaceId: allocated.namespaceId,
      namespaceEpoch: String(sequence),
      secretName: allocated.name,
      status: "dispatch_authorized",
      dispatchExpiresAt:
        reserveCodexRotatingSetupDispatchAuthorityWindow(now).toISOString(),
    };
    stored.attempts.set(input.idempotencyKey, attempt);
    stored.attemptOrder.push(input.idempotencyKey);
    return this.#attemptResult(attempt);
  }

  async recordDispatchOutcome(input: {
    claimId: string;
    attemptId: string;
    outcome: "definite_success" | "unknown";
    responseCode?: 201 | 204;
  }) {
    const stored = this.#required(input.claimId);
    this.#assertNotRetired(stored);
    const now = this.clock.now();
    this.#assertRecoveryUnexpired(stored, now);
    const entry = [...stored.attempts.entries()].find(
      ([, attempt]) => attempt.attemptId === input.attemptId,
    );
    if (!entry) throw new Error("codex_rotating_setup_attempt_not_found");
    const [key, attempt] = entry;
    if (attempt.status === "retired_ambiguous") {
      if (input.outcome === "unknown")
        return { status: "retired_ambiguous" as const };
      throw new Error("codex_rotating_setup_namespace_retired");
    }
    try {
      this.#assertUnexpired(new Date(attempt.dispatchExpiresAt), now);
    } catch (error) {
      stored.attempts.set(key, { ...attempt, status: "retired_ambiguous" });
      throw error;
    }
    if (attempt.status === "confirmed") {
      return { status: "confirmed_candidate" as const };
    }
    if (input.outcome === "unknown") {
      stored.attempts.set(key, { ...attempt, status: "retired_ambiguous" });
      return { status: "retired_ambiguous" as const };
    }
    stored.attempts.set(key, { ...attempt, status: "confirmed" });
    stored.status = "confirmed_candidate";
    return { status: "confirmed_candidate" as const };
  }

  async status(claimId: string): Promise<CodexRotatingSetupStatus> {
    const stored = this.#required(claimId);
    const key = stored.attemptOrder.at(-1);
    const attempt = key ? stored.attempts.get(key)! : null;
    return {
      status: stored.status,
      claimId: stored.claimId,
      databaseIncarnation: "in_memory_writer",
      databaseRecoveryWitnessFingerprint: fingerprintDatabaseRecoveryWitness(
        "in_memory_database_recovery_witness_generation_one",
      ),
      attempt: attempt ? this.#attemptResult(attempt) : null,
    };
  }

  async activate(attestation: CodexRotatingActivation) {
    const stored = this.#required(attestation.claimId);
    this.#assertNotRetired(stored);
    const now = this.clock.now();
    this.#assertRecoveryUnexpired(stored, now);
    const attempt = [...stored.attempts.values()].find(
      (candidate) => candidate.attemptId === attestation.attemptId,
    );
    if (
      stored.status !== "confirmed_candidate" ||
      !attempt ||
      attempt.status !== "confirmed" ||
      attempt.namespaceId !== attestation.namespaceId ||
      attempt.namespaceEpoch !== attestation.namespaceEpoch ||
      attempt.secretName !== attestation.secretName ||
      stored.claim.repositoryId !== attestation.repositoryId
    ) {
      throw new Error("codex_rotating_setup_activation_mismatch");
    }
    stored.workflowAttestation = createVersionedSecretWorkflowSourceAttestation(
      {
        repositoryId: attestation.repositoryId,
        workflowPath: attestation.workflowPath,
        workflowSourceCommitSha: attestation.workflowSourceCommitSha,
        workflowSourceBlobSha: attestation.workflowSourceBlobSha,
        workflowSourceSha256: attestation.workflowSourceSha256,
        workflowSemanticSha256: attestation.workflowSemanticSha256,
        sourceTrust: WorkflowSourceTrust.TrustedDefaultBranchRevision,
        workflowSchemaVersion: attestation.workflowSchemaVersion,
        secretNamespace: createVersionedProviderSecretNamespace({
          scope: {
            repositoryId: attestation.repositoryId,
            providerInstanceId: stored.claim.providerInstanceId,
          },
          namespaceId: attestation.namespaceId,
          epoch: attestation.namespaceEpoch,
          name: attestation.secretName,
        }),
      },
    );
    stored.status = "active";
    return { status: "active" as const };
  }

  async readActiveWorkflowAttestation(
    namespace: Parameters<
      CodexRotatingCurrentWorkflowAttestationPort["readActiveWorkflowAttestation"]
    >[0],
  ) {
    const stored = [...new Set(this.#claims.values())].find(
      (candidate) =>
        candidate.status === "active" &&
        candidate.workflowAttestation !== null &&
        sameExactNamespace(
          candidate.workflowAttestation.secretNamespace,
          namespace,
        ),
    );
    if (!stored?.workflowAttestation) return null;
    return createVersionedSecretWorkflowSourceAttestation(
      stored.workflowAttestation,
    );
  }

  async replaceActiveWorkflowSource(
    transition: CodexRotatingWorkflowReattestationTransition,
  ) {
    const stored = this.#required(transition.target.claimId);
    const attempt = [...stored.attempts.values()].find(
      (candidate) => candidate.attemptId === transition.target.attemptId,
    );
    const persisted = stored.workflowAttestation;
    if (
      stored.status !== "active" ||
      !attempt ||
      attempt.status !== "confirmed" ||
      stored.claim.repositoryId !== transition.target.repositoryId ||
      stored.claim.generationHash !==
        transition.target.expectedGenerationHash ||
      !persisted ||
      !sameExactWorkflowAttestation(persisted, transition.expectedCurrent)
    ) {
      throw new Error("codex_rotating_workflow_reattestation_stale");
    }
    try {
      assertSameVersionedProviderSecretNamespace({
        expected: transition.target.namespace,
        actual: persisted.secretNamespace,
      });
      assertSameVersionedProviderSecretNamespace({
        expected: persisted.secretNamespace,
        actual: transition.replacement.secretNamespace,
      });
    } catch {
      throw new Error("codex_rotating_workflow_reattestation_stale");
    }
    if (
      persisted.workflowSchemaVersion !== 4 ||
      transition.replacement.workflowSchemaVersion !== 5 ||
      transition.replacement.repositoryId !== persisted.repositoryId ||
      transition.replacement.workflowPath !== persisted.workflowPath ||
      transition.replacement.sourceTrust !== persisted.sourceTrust ||
      transition.replacement.workflowSourceSha256 ===
        persisted.workflowSourceSha256 ||
      transition.replacement.workflowSemanticSha256 ===
        persisted.workflowSemanticSha256
    ) {
      throw new Error("codex_rotating_workflow_reattestation_stale");
    }
    stored.workflowAttestation = createVersionedSecretWorkflowSourceAttestation(
      transition.replacement,
    );
    return { status: "active" as const };
  }

  /** Seeds the recovery-owned provider fence supplied by the memory recovery adapter. */
  authorizeRecoveryFence(input: CodexRotatingSetupRecoveryFence): void {
    this.#recoveryFences.set(input.providerInstanceId, { ...input });
  }

  async retireProviderGeneration(
    input: CodexRotatingSetupRecoveryFence,
  ): Promise<void> {
    if (
      !codexRotatingSetupRecoveryFencesMatch(
        this.#recoveryFences.get(input.providerInstanceId) ?? null,
        input,
      )
    ) {
      throw new Error("codex_rotating_setup_recovery_required");
    }
    for (const stored of new Set(this.#claims.values())) {
      if (
        stored.claim.providerInstanceId !== input.providerInstanceId ||
        isCodexRotatingSetupTerminalClaimStatus(stored.status)
      ) {
        continue;
      }
      stored.status = retireCodexRotatingSetupClaimStatus(stored.status);
      for (const [key, attempt] of stored.attempts) {
        if (
          attempt.status === "dispatch_authorized" ||
          attempt.status === "confirmed"
        ) {
          stored.attempts.set(key, {
            ...attempt,
            status: retireCodexRotatingSetupAttemptStatus(attempt.status),
          });
        }
      }
    }
  }

  #required(key: string): Stored {
    const stored = this.#claims.get(key);
    if (!stored) throw new Error("codex_rotating_setup_claim_not_found");
    return stored;
  }

  #claimResult(stored: Stored, status: CodexRotatingSetupClaimAdmissionStatus) {
    return {
      status,
      claimId: stored.claimId,
      claimVersion: 1,
      prepareReplayExpiresAt: stored.prepareReplayExpiresAt.toISOString(),
      recoveryExpiresAt: stored.recoveryExpiresAt.toISOString(),
    };
  }

  #attemptResult(
    attempt: CodexRotatingDispatchAttempt,
  ): CodexRotatingDispatchAttempt {
    // Match the persistence adapter's value semantics. Leaking the object held
    // in the map would let a test/client cast away readonly and revive terminal
    // evidence without going through a state transition.
    return { ...attempt };
  }

  #assertNotRetired(stored: Stored): void {
    if (isCodexRotatingSetupTerminalClaimStatus(stored.status)) {
      throw new Error("codex_rotating_setup_namespace_retired");
    }
  }

  #assertRecoveryUnexpired(stored: Stored, now: Date): void {
    this.#assertUnexpired(stored.recoveryExpiresAt, now);
  }

  #assertUnexpired(authorizationExpiresAt: Date, now: Date): void {
    try {
      assertProviderSecretAuthorizationUnexpired({
        authorizationExpiresAt,
        now,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "provider_secret_transition_authorization_expired"
      ) {
        throw new Error("codex_rotating_setup_authorization_expired", {
          cause: error,
        });
      }
      throw error;
    }
  }
}

function sameExactNamespace(
  left: VersionedSecretWorkflowSourceAttestation["secretNamespace"],
  right: VersionedSecretWorkflowSourceAttestation["secretNamespace"],
): boolean {
  return (
    left.mode === right.mode &&
    left.namespaceId === right.namespaceId &&
    left.epoch === right.epoch &&
    left.name === right.name &&
    left.scope.repositoryId === right.scope.repositoryId &&
    left.scope.providerInstanceId === right.scope.providerInstanceId
  );
}

function sameExactWorkflowAttestation(
  left: VersionedSecretWorkflowSourceAttestation,
  right: VersionedSecretWorkflowSourceAttestation,
): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.workflowPath === right.workflowPath &&
    left.workflowSourceCommitSha === right.workflowSourceCommitSha &&
    left.workflowSourceBlobSha === right.workflowSourceBlobSha &&
    left.workflowSourceSha256 === right.workflowSourceSha256 &&
    left.workflowSemanticSha256 === right.workflowSemanticSha256 &&
    left.workflowSchemaVersion === right.workflowSchemaVersion &&
    left.sourceTrust === right.sourceTrust &&
    left.secretNamespace.namespaceId === right.secretNamespace.namespaceId &&
    left.secretNamespace.epoch === right.secretNamespace.epoch &&
    left.secretNamespace.name === right.secretNamespace.name &&
    left.secretNamespace.scope.repositoryId ===
      right.secretNamespace.scope.repositoryId &&
    left.secretNamespace.scope.providerInstanceId ===
      right.secretNamespace.scope.providerInstanceId
  );
}
