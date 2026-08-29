import {
  codexRotatingOidcClaimsSchema,
  assertCanonicalCodexRotatingProviderId,
  canonicalCodexRotatingProviderId,
  validateCodexRotatingPrelease,
  assertActiveVersionedSecretWorkflowAttestation,
  assertSameVersionedProviderSecretNamespace,
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
import {
  isManagedV2SessionBootstrapSource,
  managedCodexWorkflowPath,
  type ActionRepositoryContext,
} from "../../domain/action-control-plane.js";
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
  readonly reviewIntentAdmissionRequired?: boolean;
  readonly codexRotatingNewWorkAdmission: {
    assertAdmitted(input: { readonly repositoryFullName: string }): void;
  };
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
  readonly accountFingerprintSalt: string;
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
  const canonicalProviderInstanceId = canonicalCodexRotatingProviderId(
    repository.githubRepositoryId,
  );
  assertCanonicalCodexRotatingProviderId({
    providerInstanceId: input.providerInstanceId,
    githubRepositoryId: repository.githubRepositoryId,
  });
  await dependencies.codexRotatingRuntimeGate?.assertCodexRotatingOAuthEnabled({
    repositoryFullName: repository.fullName,
  });
  const binding = await dependencies.codexRotatingOAuth.findProviderBinding({
    repository,
    providerInstanceId: canonicalProviderInstanceId,
    workflowSha: claims.workflow_sha,
    workflowSchemaVersion: input.workflowSchemaVersion,
  });
  if (!binding) {
    throw new Error("codex_rotating_provider_binding_not_found");
  }
  const trustedActionRefs = new Set(
    [binding.actionRef, ...(binding.allowedActionRefs ?? [])].map((ref) => {
      if (!isImmutableActionRef(ref)) {
        throw new Error("codex_rotating_workflow_action_ref_not_allowed");
      }
      return ref.toLowerCase();
    }),
  );
  const expectedActionOwnerRepo = binding.actionRef.split("@")[0]!;
  const verifiedWorkflow =
    await dependencies.codexRotatingWorkflowSourceVerifier.verifyWorkflowSource(
      {
        repository,
        workflowSha: claims.workflow_sha,
        workflowRef: claims.workflow_ref,
        workflowPath: binding.workflowPath,
        expectedActionOwnerRepo,
        expectedProviderInstanceId: canonicalProviderInstanceId,
        expectedWorkflowSchemaVersion: input.workflowSchemaVersion,
      },
    );
  if (
    !isImmutableActionRef(verifiedWorkflow.binding.actionRef) ||
    verifiedWorkflow.binding.actionRef.split("@")[0]!.toLowerCase() !==
      expectedActionOwnerRepo.toLowerCase() ||
    !trustedActionRefs.has(verifiedWorkflow.binding.actionRef.toLowerCase())
  ) {
    throw new Error("codex_rotating_workflow_action_ref_not_allowed");
  }
  if (binding.activeSecretNamespace) {
    if (
      !binding.activeWorkflowSource ||
      !verifiedWorkflow.attestation ||
      !verifiedWorkflow.binding.activeSecretNamespace
    ) {
      throw new Error("workflow_source_attestation_missing");
    }
    assertActiveVersionedSecretWorkflowAttestation({
      attestation: verifiedWorkflow.attestation,
      repositoryId: repository.githubRepositoryId,
      workflowPath: binding.workflowPath,
      workflowSourceCommitSha: claims.workflow_sha,
      activeSecretNamespace: binding.activeSecretNamespace,
      expectedWorkflowSource: binding.activeWorkflowSource,
    });
    assertSameVersionedProviderSecretNamespace({
      expected: binding.activeSecretNamespace,
      actual: verifiedWorkflow.binding.activeSecretNamespace,
    });
  }
  validateCodexRotatingPrelease({
    claims,
    binding: verifiedWorkflow.binding,
    requestedProviderInstanceId: canonicalProviderInstanceId,
    requestedWorkflowSchemaVersion: input.workflowSchemaVersion,
    now: dependencies.clock.now(),
  });
  assertCanonicalCodexRotatingProviderId({
    providerInstanceId: verifiedWorkflow.binding.providerInstanceId,
    githubRepositoryId: repository.githubRepositoryId,
  });
  await dependencies.codexRotatingOAuth.ensureVerifiedProviderBinding({
    repository,
    binding: verifiedWorkflow.binding,
  });
  const pullRequestNumber = await resolvePullRequestNumber({
    claims,
    repository,
    workflowSourceVerifier: dependencies.codexRotatingWorkflowSourceVerifier,
  });
  const intentRequired =
    reviewIntentRequired({
      claims,
      actionRef: verifiedWorkflow.binding.actionRef,
      workflowPath: verifiedWorkflow.binding.workflowPath,
      pullRequestNumber,
    }) && dependencies.reviewIntentAdmissionRequired !== false;
  if (dependencies.hostedReviewPreleaseGate) {
    const admission = await dependencies.hostedReviewPreleaseGate.evaluate({
      repository,
      sourceRunId: claims.run_id,
      sourceRunAttempt: claims.run_attempt,
      intentRequired,
      now: dependencies.clock.now(),
    });
    if (admission.status === "skipped") {
      return { protocolVersion: 1, ...admission };
    }
    if (admission.status === "not_applicable" && intentRequired) {
      throw new Error("review_request_intent_required");
    }
  }
  const assertNewWorkAdmitted = () =>
    dependencies.codexRotatingNewWorkAdmission.assertAdmitted({
      repositoryFullName: repository.fullName,
    });
  assertNewWorkAdmitted();
  await consumeCodexRotatingOidcReplayNonce({
    claims,
    now: dependencies.clock.now(),
    replayNonces: dependencies.replayNonces,
  });
  const lease = await dependencies.codexRotatingOAuth.acquirePrelease({
    repository,
    providerInstanceId: canonicalProviderInstanceId,
    githubRunId: claims.run_id,
    githubRunAttempt: claims.run_attempt,
    ...(pullRequestNumber ? { pullRequestNumber } : {}),
    verifiedWorkflowAttestation: verifiedWorkflow.attestation ?? null,
    newWorkAdmissionBarrier: {
      assertAdmitted: assertNewWorkAdmitted,
    },
  });
  if (lease.status === "conflict") {
    throw new Error("codex_rotating_lease_conflict");
  }
  return {
    protocolVersion: 1,
    leaseId: lease.leaseId,
    providerInstanceId: canonicalProviderInstanceId,
    repository: repository.fullName,
    generationHashSalt: lease.generationHashSalt,
    accountFingerprintSalt: lease.accountFingerprintSalt,
    currentGeneration: lease.currentGeneration,
    ...(lease.currentGenerationHash
      ? { currentGenerationHash: lease.currentGenerationHash }
      : {}),
    expiresAt: lease.expiresAt.toISOString(),
  };
}

function isImmutableActionRef(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/u.test(value);
}

function reviewIntentRequired(input: {
  readonly claims: CodexRotatingOidcClaims;
  readonly actionRef: string;
  readonly workflowPath: string;
  readonly pullRequestNumber: number | undefined;
}): boolean {
  if (input.pullRequestNumber !== undefined) return true;
  if (
    input.claims.event_name !== "workflow_dispatch" ||
    input.workflowPath !== managedCodexWorkflowPath
  ) {
    return isManagedV2SessionBootstrapSource({
      eventName: input.claims.event_name,
      workflowPath: input.workflowPath,
    });
  }

  const jobWorkflowRef = input.claims.job_workflow_ref;
  const jobWorkflowSha = input.claims.job_workflow_sha?.toLowerCase();
  if (!jobWorkflowRef && !jobWorkflowSha) return false;
  if (
    jobWorkflowRef?.toLowerCase() === input.claims.workflow_ref.toLowerCase() &&
    jobWorkflowSha === input.claims.workflow_sha?.toLowerCase()
  ) {
    return false;
  }

  const release = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([a-f0-9]{40})$/i.exec(
    input.actionRef,
  );
  const expectedSha = release?.[2]?.toLowerCase();
  const expectedJobWorkflowRef = release
    ? `${release[1]}/.github/workflows/reviewrouter-execution-reusable.yml@${expectedSha}`
    : null;
  if (
    expectedJobWorkflowRef === null ||
    jobWorkflowRef?.toLowerCase() !== expectedJobWorkflowRef.toLowerCase() ||
    jobWorkflowSha !== expectedSha
  ) {
    throw new Error("codex_rotating_review_job_attestation_invalid");
  }
  return true;
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
