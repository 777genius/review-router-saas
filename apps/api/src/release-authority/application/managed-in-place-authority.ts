import {
  assertManagedInPlaceEffectReceipt,
  assertManagedInPlaceOperationPermit,
  assertManagedInPlaceTopology,
  assertManagedInPlaceTransition,
  managedInPlaceTargetManifest,
  reconcileManagedInPlaceCommit,
  type ManagedInPlaceCommitDecision,
  type ManagedInPlaceEffectReceipt,
  type ManagedInPlaceOperationPermit,
  type ManagedInPlaceTopology,
  type ManagedInPlaceTransitionV1,
} from "@reviewrouter/features-release-rollout";
import {
  ManagedInPlaceReadinessPhase,
  managedInPlaceDatabaseIsReady,
  type ManagedInPlaceCustodyReadiness,
  type TrustedManagedInPlaceIdentity,
} from "./readiness.js";
import type { ReleaseAuthorityFencedAttestation } from "./services.js";

/**
 * Field-by-field topology equality. Used both when binding a freshly opened
 * permit to the request that opened it, and when binding an epoch-advanced
 * permit to the one it was advanced from - in-place topology never changes
 * mid-operation, so any drift here is a custody-port defect, not a retry.
 */
function managedInPlaceTopologyMatches(
  a: ManagedInPlaceTopology,
  b: ManagedInPlaceTopology,
): boolean {
  return (
    a.providerDatabaseResourceId === b.providerDatabaseResourceId &&
    a.systemIdentifier === b.systemIdentifier &&
    a.databaseOid === b.databaseOid &&
    a.databaseName === b.databaseName &&
    a.recoveryWitnessSha256 === b.recoveryWitnessSha256
  );
}

/**
 * Application service for the typed in-place mode.
 *
 * `ReleaseAuthorityService` keeps its relocation semantics untouched, including
 * the `target.systemIdentifier === input.sourceSystemIdentifier` rejections in
 * claim and begin. This service is the other mode: it REQUIRES the two to be
 * the same database and refuses anything else. Both services run through the
 * same fenced-attestation boundary shape, so the in-place mode reuses the
 * existing trusted boundary rather than opening a second, weaker one.
 */
export type ExecuteFencedManagedInPlaceMutation = <Result>(
  mutation: (
    attestation: ReleaseAuthorityFencedAttestation,
  ) => Promise<Result> | Result,
  phase: ManagedInPlaceReadinessPhase,
) => Promise<Result>;

export interface ManagedInPlaceHighRiskMutationGate {
  execute<Result>(
    sequence: (
      executeFresh: ExecuteFencedManagedInPlaceMutation,
    ) => Promise<Result> | Result,
  ): Promise<Result>;
}

export type ManagedInPlaceClaimBinding = Readonly<{
  operationId: string;
  transition: ManagedInPlaceTransitionV1;
  admissionIdentityDigest: string;
  externalFenceSha256: string;
  terminalCatalogDigest: string;
  generation: number;
  nonce: string;
  source: ManagedInPlaceTopology;
  target: ManagedInPlaceTopology;
}>;

export interface ManagedInPlaceCustodyPort {
  openOperation(
    input: Omit<
      ManagedInPlaceClaimBinding,
      "transition" | "source" | "target"
    > & {
      transitionSha256: string;
      topology: ManagedInPlaceTopology;
    },
  ): Promise<ManagedInPlaceOperationPermit>;
  currentPermit(
    operationId: string,
  ): Promise<ManagedInPlaceOperationPermit | null>;
  advanceEpoch(input: {
    permit: ManagedInPlaceOperationPermit;
    nextNonce: string;
  }): Promise<ManagedInPlaceOperationPermit>;
  /** Read through the restricted reader, never through the coordinator. */
  readEffectReceipt(
    operationId: string,
  ): Promise<ManagedInPlaceEffectReceipt | null>;
}

export interface ManagedInPlaceBoundaryPort {
  observe(): Promise<ManagedInPlaceCustodyReadiness>;
}

export class ManagedInPlaceAuthorityService {
  constructor(
    private readonly custody: ManagedInPlaceCustodyPort,
    private readonly boundary: ManagedInPlaceBoundaryPort,
    private readonly highRiskGate: ManagedInPlaceHighRiskMutationGate,
    private readonly trustedTransition?: ManagedInPlaceTransitionV1,
    private readonly trustedIdentity?: TrustedManagedInPlaceIdentity,
  ) {}

  private trusted(): {
    transition: ManagedInPlaceTransitionV1;
    identity: TrustedManagedInPlaceIdentity;
  } {
    if (!this.trustedTransition || !this.trustedIdentity)
      throw new Error("managed_in_place_transition_missing");
    return {
      transition: this.trustedTransition,
      identity: this.trustedIdentity,
    };
  }

  private async attest(
    phase: ManagedInPlaceReadinessPhase,
    topology: ManagedInPlaceTopology,
    attestation: ReleaseAuthorityFencedAttestation,
  ): Promise<void> {
    const { identity } = this.trusted();
    if (
      attestation.systemIdentifier !== topology.systemIdentifier ||
      attestation.recoveryWitnessSha256 !== topology.recoveryWitnessSha256
    )
      throw new Error("managed_in_place_identity_untrusted");
    const readiness = await this.boundary.observe();
    if (
      readiness.systemIdentifier !== topology.systemIdentifier ||
      readiness.recoveryWitnessSha256 !== topology.recoveryWitnessSha256 ||
      !managedInPlaceDatabaseIsReady(readiness, identity, phase)
    )
      throw new Error("managed_in_place_boundary_not_ready");
  }

  /**
   * Open this operation's custody permit.
   *
   * Source and target must be the SAME database. That is not a relaxation of
   * the relocation rule; it is this mode's own rule, and a payload carrying two
   * different databases is rejected here exactly as an equal pair is rejected
   * by the relocation claim.
   */
  claim = async (input: ManagedInPlaceClaimBinding) => {
    const { transition } = this.trusted();
    assertManagedInPlaceTransition(input.transition, transition);
    const topology = assertManagedInPlaceTopology({
      source: input.source,
      target: input.target,
    });
    return this.highRiskGate.execute((executeFresh) =>
      executeFresh(async (attestation) => {
        await this.attest(
          ManagedInPlaceReadinessPhase.BeforeExecution,
          topology,
          attestation,
        );
        const permit = await this.custody.openOperation({
          operationId: input.operationId,
          transitionSha256: transition.transitionSha256,
          admissionIdentityDigest: input.admissionIdentityDigest,
          externalFenceSha256: input.externalFenceSha256,
          terminalCatalogDigest: input.terminalCatalogDigest,
          generation: input.generation,
          nonce: input.nonce,
          topology,
        });
        assertManagedInPlaceOperationPermit(permit, transition);
        if (
          permit.operationId !== input.operationId ||
          permit.admissionIdentityDigest !== input.admissionIdentityDigest ||
          permit.terminalCatalogDigest !== input.terminalCatalogDigest ||
          permit.externalFenceSha256 !== input.externalFenceSha256 ||
          permit.generation !== input.generation ||
          permit.nonce !== input.nonce ||
          !managedInPlaceTopologyMatches(permit.topology, topology)
        )
          throw new Error("managed_in_place_permit_binding_conflict");
        return permit;
      }, ManagedInPlaceReadinessPhase.BeforeExecution),
    );
  };

  /**
   * Return the permit this attempt may execute under, advancing the epoch when
   * a previous attempt already used the current one. The generation and every
   * identity survive the advance, so a retry stays the same operation.
   */
  begin = async (input: {
    operationId: string;
    expectedEpoch: number;
    nextNonce?: string;
  }) => {
    const { transition } = this.trusted();
    const current = await this.custody.currentPermit(input.operationId);
    if (!current) throw new Error("managed_in_place_permit_absent");
    assertManagedInPlaceOperationPermit(current, transition);
    if (current.state !== "open")
      throw new Error("managed_in_place_permit_terminal");
    if (current.epoch !== input.expectedEpoch)
      throw new Error("managed_in_place_permit_stale");
    if (input.nextNonce === undefined) return current;
    return this.highRiskGate.execute((executeFresh) =>
      executeFresh(async (attestation) => {
        await this.attest(
          ManagedInPlaceReadinessPhase.BeforeExecution,
          current.topology,
          attestation,
        );
        const advanced = await this.custody.advanceEpoch({
          permit: current,
          nextNonce: input.nextNonce!,
        });
        assertManagedInPlaceOperationPermit(advanced, transition);
        if (
          advanced.operationId !== current.operationId ||
          advanced.generation !== current.generation ||
          advanced.epoch !== current.epoch + 1 ||
          advanced.nonce === current.nonce ||
          advanced.nonce !== input.nextNonce ||
          !managedInPlaceTopologyMatches(advanced.topology, current.topology)
        )
          throw new Error("managed_in_place_permit_advance_invalid");
        return advanced;
      }, ManagedInPlaceReadinessPhase.BeforeExecution),
    );
  };

  /**
   * Complete the operation from the protected receipt, read through the
   * restricted reader rather than reported by the coordinator that wrote it.
   */
  complete = async (input: { permit: ManagedInPlaceOperationPermit }) => {
    const { transition } = this.trusted();
    assertManagedInPlaceOperationPermit(input.permit, transition);
    return this.highRiskGate.execute((executeFresh) =>
      executeFresh(async (attestation) => {
        await this.attest(
          ManagedInPlaceReadinessPhase.AfterExecution,
          input.permit.topology,
          attestation,
        );
        const receipt = await this.custody.readEffectReceipt(
          input.permit.operationId,
        );
        if (!receipt) throw new Error("managed_in_place_effect_receipt_absent");
        assertManagedInPlaceEffectReceipt(receipt, input.permit);
        if (receipt.ledgerManifest !== managedInPlaceTargetManifest)
          throw new Error("managed_in_place_effect_receipt_unbound");
        return receipt;
      }, ManagedInPlaceReadinessPhase.AfterExecution),
    );
  };

  /**
   * Resolve an unknown commit. The original backend's terminal state is
   * established by the caller before this is reached; everything unresolved,
   * partial or contradictory stays fenced, and no outcome permits a replay.
   */
  reconcile = async (input: {
    permit: ManagedInPlaceOperationPermit;
    originalBackendState: "terminated" | "alive" | "unknown";
    rollbackConfirmed: boolean;
    externalFenceHeld: boolean;
    ledgerManifest: string | null;
    gateStatus: string;
  }): Promise<ManagedInPlaceCommitDecision> => {
    const { transition } = this.trusted();
    assertManagedInPlaceOperationPermit(input.permit, transition);
    const receipt = await this.custody.readEffectReceipt(
      input.permit.operationId,
    );
    return reconcileManagedInPlaceCommit(
      {
        originalBackendState: input.originalBackendState,
        rollbackConfirmed: input.rollbackConfirmed,
        externalFenceHeld: input.externalFenceHeld,
        ledgerManifest: input.ledgerManifest,
        gateStatus: input.gateStatus,
        receipt,
      },
      input.permit,
    );
  };
}
