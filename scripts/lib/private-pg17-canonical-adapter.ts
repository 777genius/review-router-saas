import {
  RolloutStep,
  RedactedProcessCommandAdapter,
  decomposePostgresConnection,
  type StepObservation,
  assertReleaseMigrationTransition,
  createReleaseMigrationTransition,
  targetMigrationReceiptEvidence,
  type ReleaseMigrationPermit,
  type ReleaseMigrationTransitionV1,
  type LegacyAmbiguityEvidence,
} from "../../packages/features/release-rollout/src/index";
import { executePrivateGenerationActivation } from "../activate-private-pg17-generation.mjs";
import {
  executeCanonicalReleaseMigration,
  executeCanonicalRoleBootstrap,
} from "../run-codex-rotating-release-migration.mjs";
import { secureCanonicalRun } from "../private-pg17-secure-canonical";

/** Normalizes canonical script output into application-port observations. */
export class PrivatePg17CanonicalAdapter {
  bootstrapTargetRoles(env: NodeJS.ProcessEnv): StepObservation {
    const facts = executeCanonicalRoleBootstrap(env, secureCanonicalRun);
    return {
      step: RolloutStep.BootstrapTargetRoles,
      observedAt: new Date().toISOString(),
      facts,
    };
  }

  runReleaseMigration(
    env: NodeJS.ProcessEnv,
    transition: ReleaseMigrationTransitionV1,
    permit: ReleaseMigrationPermit,
    sourceLegacyAmbiguity: LegacyAmbiguityEvidence,
  ): StepObservation {
    assertReleaseMigrationTransition(
      transition,
      createReleaseMigrationTransition({
        commitSha: String(env.REVIEW_ROUTER_RELEASE_COMMIT_SHA),
        releaseImageDigest: String(env.REVIEW_ROUTER_RELEASE_IMAGE_DIGEST),
      }),
    );
    const observeManifestIdentity = () => {
      const connection = decomposePostgresConnection(
        String(env.REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL),
      );
      try {
        return new RedactedProcessCommandAdapter()
          .execute(
            "psql",
            [
              ...connection.args,
              "--no-psqlrc",
              "--tuples-only",
              "--no-align",
              "--command",
              "SELECT 'sha256:' || encode(pg_catalog.sha256(convert_to(coalesce(string_agg(migration_name || ':' || checksum, ',' ORDER BY migration_name), ''), 'UTF8')), 'hex') FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
            ],
            { env: connection.env },
          )
          .stdout.trim();
      } finally {
        connection.cleanup();
      }
    };
    const resumeManifestIdentity = observeManifestIdentity();
    if (
      !transition.allowedResumeManifestIdentities.includes(
        resumeManifestIdentity,
      )
    )
      throw new Error("private_pg17_rollout_resume_manifest_untrusted");
    const facts = executeCanonicalReleaseMigration(
      {
        ...env,
        REVIEW_ROUTER_RELEASE_ACL_GATE_MODE: "closed",
        REVIEW_ROUTER_MIGRATION_PERMIT_TARGET_SYSTEM_IDENTIFIER:
          permit.targetSystemIdentifier,
        REVIEW_ROUTER_MIGRATION_PERMIT_TARGET_RECOVERY_WITNESS_SHA256:
          permit.targetRecoveryWitnessSha256,
        REVIEW_ROUTER_MIGRATION_PERMIT_TRANSITION_SHA256:
          permit.transitionSha256,
        REVIEW_ROUTER_MIGRATION_PERMIT_PREVIOUS_RECEIPT_SHA256:
          permit.expectedPreviousReceiptSha256,
        REVIEW_ROUTER_MIGRATION_PERMIT_EPOCH: String(permit.epoch),
        REVIEW_ROUTER_MIGRATION_PERMIT_NONCE: permit.nonce,
        REVIEW_ROUTER_MIGRATION_PERMIT_SOURCE_LEGACY_AMBIGUITY_BASE64URL:
          Buffer.from(JSON.stringify(sourceLegacyAmbiguity)).toString(
            "base64url",
          ),
        REVIEW_ROUTER_MIGRATION_PERMIT_ELIGIBILITY_CUTOFF:
          permit.eligibilityCutoff,
      },
      secureCanonicalRun,
    );
    if ((facts as { aclGateState?: string }).aclGateState !== "closed")
      throw new Error("private_pg17_rollout_acl_gate_not_closed");
    const migrationChecksum = observeManifestIdentity();
    if (!/^sha256:[a-f0-9]{64}$/u.test(migrationChecksum))
      throw new Error("private_pg17_rollout_migration_checksum_unproven");
    if (migrationChecksum !== transition.postManifestIdentity)
      throw new Error("private_pg17_rollout_post_manifest_mismatch");
    const targetReceiptEvidence = targetMigrationReceiptEvidence(
      (facts as { targetMigrationReceipt?: unknown }).targetMigrationReceipt,
    );
    return {
      step: RolloutStep.RunReleaseMigration,
      observedAt: new Date().toISOString(),
      facts: {
        ...(facts as Record<string, unknown>),
        migrationChecksum,
        transitionSha256: transition.transitionSha256,
        migrationArtifactDigest: transition.migrationArtifactDigest,
        migrationBundleSha256: transition.migrationBundleSha256,
        preManifestIdentity: transition.preManifestIdentity,
        postManifestIdentity: transition.postManifestIdentity,
        postCatalogDigest: transition.postCatalogDigest,
        permitEpoch: permit.epoch,
        permitNonce: permit.nonce,
        ...targetReceiptEvidence,
        targetSystemIdentifier: permit.targetSystemIdentifier,
        targetRecoveryWitnessSha256: permit.targetRecoveryWitnessSha256,
        sourceLegacyAmbiguitySha256:
          permit.sourceLegacyAmbiguity.inventorySha256,
        eligibilityCutoff: permit.eligibilityCutoff,
      },
    };
  }

  activateTarget(env: NodeJS.ProcessEnv, rolloutId: string): StepObservation {
    const activationEnv = { ...env };
    delete activationEnv.REVIEW_ROUTER_ACTIVATION_PERMIT_INSTALLER_DATABASE_URL;
    return executePrivateGenerationActivation({
      ...activationEnv,
      REVIEW_ROUTER_ROLLOUT_ID: rolloutId,
    }) as StepObservation;
  }
}
