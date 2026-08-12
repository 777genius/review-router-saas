import {
  RolloutStep,
  type ActivationFence,
  type StepObservation,
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

  runReleaseMigration(env: NodeJS.ProcessEnv): StepObservation {
    const facts = executeCanonicalReleaseMigration(
      { ...env, REVIEW_ROUTER_RELEASE_ACL_GATE_MODE: "closed" },
      secureCanonicalRun,
    );
    if ((facts as { aclGateState?: string }).aclGateState !== "closed")
      throw new Error("private_pg17_rollout_acl_gate_not_closed");
    return {
      step: RolloutStep.RunReleaseMigration,
      observedAt: new Date().toISOString(),
      facts,
    };
  }

  activateTarget(
    env: NodeJS.ProcessEnv,
    fence: ActivationFence,
  ): StepObservation {
    return executePrivateGenerationActivation(
      env,
      undefined,
      fence,
    ) as StepObservation;
  }
}
