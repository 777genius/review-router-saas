import {
  RolloutStep,
  RedactedProcessCommandAdapter,
  decomposePostgresConnection,
  type StepObservation,
} from "../../packages/features/release-rollout/src/index";
import { executePrivateGenerationActivation } from "../activate-private-pg17-generation.mjs";
import {
  executeCanonicalReleaseMigration,
  executeCanonicalRoleBootstrap,
} from "../run-codex-rotating-release-migration.mjs";
import { secureCanonicalRun } from "../private-pg17-secure-canonical";
import { reconcileLegacyAmbiguity } from "../reconcile-codex-rotating-legacy-ambiguity.mjs";

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

  runReleaseMigration(env: NodeJS.ProcessEnv): StepObservation {
    const facts = executeCanonicalReleaseMigration(
      { ...env, REVIEW_ROUTER_RELEASE_ACL_GATE_MODE: "closed" },
      secureCanonicalRun,
    );
    if ((facts as { aclGateState?: string }).aclGateState !== "closed")
      throw new Error("private_pg17_rollout_acl_gate_not_closed");
    const legacyReconciliation = reconcileLegacyAmbiguity(
      {
        databaseUrl: String(env.REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL),
        recoveryWitnessSha256: String(
          env.REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256,
        ),
        rolloutId: String(env.REVIEW_ROUTER_ROLLOUT_ID),
      },
      secureCanonicalRun,
    );
    const connection = decomposePostgresConnection(
      String(env.REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL),
    );
    let migrationChecksum: string;
    try {
      migrationChecksum = new RedactedProcessCommandAdapter()
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
    if (!/^sha256:[a-f0-9]{64}$/u.test(migrationChecksum))
      throw new Error("private_pg17_rollout_migration_checksum_unproven");
    return {
      step: RolloutStep.RunReleaseMigration,
      observedAt: new Date().toISOString(),
      facts: {
        ...(facts as Record<string, unknown>),
        legacyReconciliation,
        migrationChecksum,
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
