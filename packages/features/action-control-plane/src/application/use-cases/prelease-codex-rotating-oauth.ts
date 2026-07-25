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
import type { ActionRepositoryContext } from "../../domain/action-control-plane.js";
import type { HostedReviewPreleaseGatePort } from "../ports/hosted-review-prelease-gate-port.js";

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
  readonly hostedReviewPreleaseGate?: HostedReviewPreleaseGatePort;
  readonly clock: Clock;
};

type CodexRotatingPreleaseInput = {
  readonly oidcToken: string;
  readonly audience: string;
  readonly providerInstanceId: string;
  readonly workflowSchemaVersion: number;
};

export type CodexRotatingPreleaseLeaseResponse = {
  readonly protocolVersion: 1;
  readonly leaseId: string;
  readonly providerInstanceId: string;
  readonly repository: string;
  readonly generationHashSalt: string;
  readonly currentGeneration: number;
  readonly currentGenerationHash?: string | undefined;
  readonly expiresAt: string;
};

export type CodexRotatingPreleaseSkipResponse = {
  readonly protocolVersion: 1;
  readonly status: "skipped";
  readonly reason: "max_changed_lines_exceeded";
  readonly changedLines: number;
  readonly maxChangedLines: number;
  readonly decisionHash: string;
};

export async function preleaseCodexRotatingOAuth(
  input: CodexRotatingPreleaseInput,
  dependencies: PreleaseCodexRotatingOAuthDependencies,
): Promise<
  CodexRotatingPreleaseLeaseResponse | CodexRotatingPreleaseSkipResponse
> {
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
  const expectedActionOwnerRepo = binding.actionRef.split("@")[0]!;
  const verifiedWorkflow =
    await dependencies.codexRotatingWorkflowSourceVerifier.verifyWorkflowSource(
      {
        repository,
        workflowSha: claims.workflow_sha,
        workflowPath: binding.workflowPath,
        expectedActionOwnerRepo,
        expectedProviderInstanceId: input.providerInstanceId,
        expectedWorkflowSchemaVersion: input.workflowSchemaVersion,
      },
    );
  if (
    verifiedWorkflow.binding.actionRef.split("@")[0]!.toLowerCase() !==
    expectedActionOwnerRepo.toLowerCase()
  ) {
    throw new Error("codex_rotating_workflow_action_ref_not_allowed");
  }
  validateCodexRotatingPrelease({
    claims,
    binding: verifiedWorkflow.binding,
    requestedProviderInstanceId: input.providerInstanceId,
    requestedWorkflowSchemaVersion: input.workflowSchemaVersion,
    now: dependencies.clock.now(),
  });
  const pullRequestNumber = await resolvePullRequestNumber({
    claims,
    repository,
    workflowSourceVerifier: dependencies.codexRotatingWorkflowSourceVerifier,
  });
  if (dependencies.hostedReviewPreleaseGate) {
    const admission = await dependencies.hostedReviewPreleaseGate.evaluate({
      repository,
      sourceRunId: claims.run_id,
      sourceRunAttempt: claims.run_attempt,
      now: dependencies.clock.now(),
    });
    if (admission.status === "skipped") {
      return { protocolVersion: 1, ...admission };
    }
    if (
      admission.status === "not_applicable" &&
      pullRequestNumber !== undefined
    ) {
      throw new Error("review_request_intent_required");
    }
  }
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
    ...(pullRequestNumber ? { pullRequestNumber } : {}),
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

async function resolvePullRequestNumber(input: {
  readonly claims: CodexRotatingOidcClaims;
  readonly repository: ActionRepositoryContext;
  readonly workflowSourceVerifier: CodexRotatingWorkflowSourceVerifierPort;
}): Promise<number | undefined> {
  if (input.claims.event_name === "pull_request") {
    const match = /^refs\/pull\/([1-9][0-9]*)\/(?:merge|head)$/.exec(
      input.claims.ref ?? "",
    );
    if (!match) throw new Error("oidc_pull_request_ref_invalid");
    const pullRequestNumber = Number(match[1]);
    if (!Number.isSafeInteger(pullRequestNumber)) {
      throw new Error("oidc_pull_request_ref_invalid");
    }
    return pullRequestNumber;
  }
  if (input.claims.event_name !== "pull_request_target") return undefined;
  const resolve = input.workflowSourceVerifier.resolveWorkflowRunPullRequest;
  if (!resolve) {
    throw new Error("codex_rotating_workflow_run_resolver_unavailable");
  }
  return await resolve.call(input.workflowSourceVerifier, {
    repository: input.repository,
    githubRunId: input.claims.run_id,
    githubRunAttempt: input.claims.run_attempt,
    eventName: input.claims.event_name,
  });
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
