import {
  codexRotatingOidcClaimsSchema,
  validateCodexRotatingPrelease,
  type CodexRotatingOidcClaims,
} from "@reviewrouter/features-codex-oauth-rotating";
import type { Clock } from "@reviewrouter/shared";
import type { ActionControlPlaneRepositoryPort } from "../ports/action-control-plane-repository-port.js";
import type { ActionOidcReplayNonceStorePort } from "../ports/action-oidc-replay-nonce-store-port.js";
import type {
  CodexRotatingOAuthRepositoryPort,
  CodexRotatingWorkflowSourceVerifierPort,
} from "../ports/codex-rotating-oauth-repository-port.js";
import type { GitHubActionsOidcTokenVerifierPort } from "../ports/github-actions-oidc-token-verifier-port.js";

export type PreleaseCodexRotatingOAuthDependencies = {
  readonly oidcVerifier: GitHubActionsOidcTokenVerifierPort;
  readonly repositories: ActionControlPlaneRepositoryPort;
  readonly codexRotatingOAuth: CodexRotatingOAuthRepositoryPort;
  readonly codexRotatingWorkflowSourceVerifier: CodexRotatingWorkflowSourceVerifierPort;
  readonly codexRotatingRuntimeGate?: {
    assertCodexRotatingOAuthEnabled(input: {
      readonly repositoryFullName: string;
    }): Promise<void> | void;
  };
  readonly replayNonces: ActionOidcReplayNonceStorePort;
  readonly clock: Clock;
};

export async function preleaseCodexRotatingOAuth(
  input: {
    readonly oidcToken: string;
    readonly audience: string;
    readonly providerInstanceId: string;
    readonly workflowSchemaVersion: number;
  },
  dependencies: PreleaseCodexRotatingOAuthDependencies,
): Promise<{
  readonly protocolVersion: 1;
  readonly leaseId: string;
  readonly providerInstanceId: string;
  readonly repository: string;
  readonly generationHashSalt: string;
  readonly currentGeneration: number;
  readonly currentGenerationHash?: string | undefined;
  readonly expiresAt: string;
}> {
  const claims = codexRotatingOidcClaimsSchema.parse(
    await dependencies.oidcVerifier.verify({
      token: input.oidcToken,
      audience: input.audience,
    }),
  );
  const repository =
    await dependencies.repositories.findSelectedRepositoryByGithubId(
      claims.repository_id,
    );
  if (!repository) {
    throw new Error("repository_not_registered");
  }
  if (!repository.selected || repository.installationStatus !== "active") {
    throw new Error("repository_not_selected");
  }
  await dependencies.codexRotatingRuntimeGate?.assertCodexRotatingOAuthEnabled({
    repositoryFullName: repository.fullName,
  });
  const binding = await dependencies.codexRotatingOAuth.findProviderBinding({
    repository,
    providerInstanceId: input.providerInstanceId,
    workflowSha: claims.workflow_sha,
  });
  if (!binding) {
    throw new Error("codex_rotating_provider_binding_not_found");
  }
  const verifiedWorkflow =
    await dependencies.codexRotatingWorkflowSourceVerifier.verifyWorkflowSource(
      {
        repository,
        workflowSha: claims.workflow_sha,
        workflowPath: binding.workflowPath,
        expectedActionOwnerRepo: binding.actionRef.split("@")[0]!,
        expectedActionRef: binding.actionRef,
        expectedActionRefs: trustedActionRefsForBinding(binding),
        expectedProviderInstanceId: input.providerInstanceId,
        expectedWorkflowSchemaVersion: input.workflowSchemaVersion,
      },
    );
  if (!isTrustedActionRef(verifiedWorkflow.binding.actionRef, binding)) {
    throw new Error("codex_rotating_workflow_action_ref_mismatch");
  }
  validateCodexRotatingPrelease({
    claims,
    binding: verifiedWorkflow.binding,
    requestedProviderInstanceId: input.providerInstanceId,
    requestedWorkflowSchemaVersion: input.workflowSchemaVersion,
    now: dependencies.clock.now(),
  });
  await consumeCodexRotatingOidcReplayNonce({
    claims,
    now: dependencies.clock.now(),
    replayNonces: dependencies.replayNonces,
  });
  const lease = await dependencies.codexRotatingOAuth.acquirePrelease({
    repository,
    providerInstanceId: input.providerInstanceId,
    githubRunId: claims.run_id,
    githubRunAttempt: claims.run_attempt,
    now: dependencies.clock.now(),
  });
  if (lease.status === "conflict") {
    throw new Error("codex_rotating_lease_conflict");
  }
  return {
    protocolVersion: 1,
    leaseId: lease.leaseId,
    providerInstanceId: input.providerInstanceId,
    repository: repository.fullName,
    generationHashSalt: lease.generationHashSalt,
    currentGeneration: lease.currentGeneration,
    ...(lease.currentGenerationHash
      ? { currentGenerationHash: lease.currentGenerationHash }
      : {}),
    expiresAt: lease.expiresAt.toISOString(),
  };
}

function normalizeActionRef(actionRef: string): string {
  return actionRef.trim().toLowerCase();
}

function trustedActionRefsForBinding(input: {
  readonly actionRef: string;
  readonly allowedActionRefs?: readonly string[] | undefined;
}): readonly string[] {
  return [
    ...new Set(
      [input.actionRef, ...(input.allowedActionRefs ?? [])].map((actionRef) =>
        normalizeActionRef(actionRef),
      ),
    ),
  ];
}

function isTrustedActionRef(
  actionRef: string,
  binding: {
    readonly actionRef: string;
    readonly allowedActionRefs?: readonly string[] | undefined;
  },
): boolean {
  const trusted = new Set(trustedActionRefsForBinding(binding));
  return trusted.has(normalizeActionRef(actionRef));
}

async function consumeCodexRotatingOidcReplayNonce(input: {
  readonly claims: CodexRotatingOidcClaims;
  readonly now: Date;
  readonly replayNonces: ActionOidcReplayNonceStorePort;
}): Promise<void> {
  const consumed = await input.replayNonces.tryConsumeNonce({
    key: `${input.claims.iss}:${input.claims.jti}`,
    expiresAt: new Date(input.claims.exp * 1000),
    now: input.now,
  });
  if (!consumed) {
    throw new Error("oidc_replay_detected");
  }
}
