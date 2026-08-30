import {
  codexRotatingOidcClaimsSchema,
  assertCanonicalCodexRotatingProviderId,
  canonicalCodexRotatingProviderId,
  validateCodexRotatingPrelease,
  assertActiveVersionedSecretWorkflowAttestation,
  assertSameVersionedProviderSecretNamespace,
  type CodexRotatingOidcClaims,
  isCertifiedForkReviewWorkflowSchemaVersion,
} from "@reviewrouter/features-codex-oauth-rotating";
import type { Clock } from "@reviewrouter/shared";
import type { ActionControlPlaneRepositoryPort } from "../ports/action-control-plane-repository-port.js";
import type { ActionOidcReplayNonceStorePort } from "../ports/action-oidc-replay-nonce-store-port.js";
import {
  CodexRotatingPreleaseNotAcquiredError,
  type CodexRotatingOAuthRepositoryPort,
  type CodexRotatingWorkflowSourceVerifierPort,
} from "../ports/codex-rotating-oauth-repository-port.js";
import type { GitHubActionsOidcTokenVerifierPort } from "../ports/github-actions-oidc-token-verifier-port.js";
import {
  isManagedV2SessionBootstrapSource,
  managedCodexWorkflowPath,
  type ActionRepositoryContext,
} from "../../domain/action-control-plane.js";
import type { HostedReviewPreleaseGatePort } from "../ports/hosted-review-prelease-gate-port.js";
import type {
  CertifiedForkReviewBinding,
  CertifiedForkReviewAdmissionPort,
  CertifiedForkReviewClaimPort,
  CertifiedForkReviewGatewayPort,
} from "../ports/certified-fork-review-port.js";
import {
  certifiedForkReviewBindingHash,
  certifiedForkReviewLeaseBindingKey,
  certifiedForkReviewClaimScope,
  certifiedForkReviewReservationOwner,
  certifiedForkReviewWorkflowSchemaVersion,
  assertCertifiedForkReviewPromptPacketSize,
} from "./certified-fork-review-binding.js";

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
  readonly certifiedForkReviewPreleaseGateway?: Pick<
    CertifiedForkReviewGatewayPort,
    "prepareContext"
  >;
  readonly certifiedForkReviewAdmission?: CertifiedForkReviewAdmissionPort;
  readonly certifiedForkReviewClaims?: CertifiedForkReviewClaimPort;
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
  readonly forkReviewBinding?: CertifiedForkReviewBinding | undefined;
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
  readonly status?: "ready" | undefined;
  readonly certifiedForkReviewContextHash?: string | undefined;
};

export type CodexRotatingCertifiedForkPreleaseDispositionResponse =
  | { readonly protocolVersion: 1; readonly status: "in_progress" }
  | {
      readonly protocolVersion: 1;
      readonly status: "already_published";
      readonly commentId: string;
      readonly commentUrl?: string;
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
  | CodexRotatingPreleaseLeaseResponse
  | CodexRotatingPreleaseSkipResponse
  | CodexRotatingCertifiedForkPreleaseDispositionResponse
> {
  const claims = codexRotatingOidcClaimsSchema.parse(
    await dependencies.oidcVerifier.verify({
      token: input.oidcToken,
      audience: input.audience,
    }),
  );
  if (
    input.forkReviewBinding &&
    !isCertifiedForkReviewWorkflowSchemaVersion(input.workflowSchemaVersion)
  ) {
    throw new Error("fork_review_binding_schema_invalid");
  }
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
  if (input.forkReviewBinding) {
    assertCertifiedForkPreleaseIdentity({
      claims,
      repository,
      workflowSchemaVersion: input.workflowSchemaVersion,
      binding: input.forkReviewBinding,
    });
    if (!dependencies.certifiedForkReviewAdmission)
      throw new Error("certified_fork_v5_not_enabled");
    dependencies.certifiedForkReviewAdmission.assertEnabled(
      input.forkReviewBinding,
    );
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
  const certifiedForkReview = await resolveCertifiedForkReviewPrelease({
    claims,
    repository,
    workflowSchemaVersion: input.workflowSchemaVersion,
    binding: input.forkReviewBinding,
    workflowSourceVerifier: dependencies.codexRotatingWorkflowSourceVerifier,
    gateway: dependencies.certifiedForkReviewPreleaseGateway,
  });
  const pullRequestNumber =
    certifiedForkReview?.binding.pullRequestNumber ??
    (await resolvePullRequestNumber({
      claims,
      repository,
      workflowSchemaVersion: input.workflowSchemaVersion,
      workflowSourceVerifier: dependencies.codexRotatingWorkflowSourceVerifier,
    }));
  const intentRequired =
    reviewIntentRequired({
      claims,
      actionRef: verifiedWorkflow.binding.actionRef,
      workflowPath: verifiedWorkflow.binding.workflowPath,
      pullRequestNumber,
    }) && dependencies.reviewIntentAdmissionRequired !== false;
  if (!certifiedForkReview && dependencies.hostedReviewPreleaseGate) {
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
  if (certifiedForkReview) {
    if (!dependencies.certifiedForkReviewClaims)
      throw new Error("certified_fork_v5_not_enabled");
    const reservation =
      await dependencies.certifiedForkReviewClaims.claimPrelease({
        scope: certifiedForkReview.scope,
        reservationOwner: certifiedForkReview.reservationOwner,
        expectedLeaseKey: [
          canonicalProviderInstanceId,
          claims.run_id,
          claims.run_attempt,
          certifiedForkReviewLeaseBindingKey(certifiedForkReview.bindingHash),
        ].join(":"),
      });
    if (reservation.status === "in_progress")
      return { protocolVersion: 1, status: "in_progress" };
    if (reservation.status === "already_published")
      return {
        protocolVersion: 1,
        status: "already_published",
        commentId: reservation.commentId,
        ...(reservation.commentUrl
          ? { commentUrl: reservation.commentUrl }
          : {}),
      };
  }
  let lease;
  try {
    lease = await dependencies.codexRotatingOAuth.acquirePrelease({
      repository,
      providerInstanceId: canonicalProviderInstanceId,
      githubRunId: claims.run_id,
      githubRunAttempt: claims.run_attempt,
      ...(pullRequestNumber ? { pullRequestNumber } : {}),
      ...(certifiedForkReview
        ? {
            certifiedForkReviewBindingHash: certifiedForkReview.bindingHash,
          }
        : {}),
      newWorkAdmissionBarrier: {
        assertAdmitted: assertNewWorkAdmitted,
      },
    });
  } catch (error) {
    if (
      certifiedForkReview &&
      error instanceof CodexRotatingPreleaseNotAcquiredError
    )
      await dependencies.certifiedForkReviewClaims!.abandonPrelease({
        scope: certifiedForkReview.scope,
        reservationOwner: certifiedForkReview.reservationOwner,
      });
    else if (certifiedForkReview)
      await dependencies.certifiedForkReviewClaims!.markPreleaseAmbiguous({
        scope: certifiedForkReview.scope,
        reservationOwner: certifiedForkReview.reservationOwner,
      });
    throw error;
  }
  if (lease.status === "conflict") {
    if (certifiedForkReview)
      await dependencies.certifiedForkReviewClaims!.abandonPrelease({
        scope: certifiedForkReview.scope,
        reservationOwner: certifiedForkReview.reservationOwner,
      });
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
    ...(certifiedForkReview
      ? {
          status: "ready" as const,
          certifiedForkReviewContextHash: certifiedForkReview.scope.contextHash,
        }
      : {}),
  };
}

async function resolveCertifiedForkReviewPrelease(input: {
  readonly claims: CodexRotatingOidcClaims;
  readonly repository: ActionRepositoryContext;
  readonly workflowSchemaVersion: number;
  readonly binding: CertifiedForkReviewBinding | undefined;
  readonly workflowSourceVerifier: CodexRotatingWorkflowSourceVerifierPort;
  readonly gateway:
    | Pick<CertifiedForkReviewGatewayPort, "prepareContext">
    | undefined;
}): Promise<
  | {
      readonly binding: CertifiedForkReviewBinding;
      readonly bindingHash: string;
      readonly scope: ReturnType<typeof certifiedForkReviewClaimScope>;
      readonly reservationOwner: string;
    }
  | undefined
> {
  if (!input.binding) return undefined;
  assertCertifiedForkPreleaseIdentity({
    claims: input.claims,
    repository: input.repository,
    workflowSchemaVersion: input.workflowSchemaVersion,
    binding: input.binding,
  });
  if (!input.gateway)
    throw new Error("certified_fork_prelease_gateway_unavailable");
  if (input.claims.event_name === "pull_request_target") {
    const resolve = input.workflowSourceVerifier.resolveWorkflowRunPullRequest;
    if (!resolve)
      throw new Error("codex_rotating_workflow_run_resolver_unavailable");
    const resolved = await resolve.call(input.workflowSourceVerifier, {
      repository: input.repository,
      githubRunId: input.claims.run_id,
      githubRunAttempt: input.claims.run_attempt,
      eventName: input.claims.event_name,
    });
    if (resolved !== input.binding.pullRequestNumber)
      throw new Error("certified_fork_prelease_identity_mismatch");
  }
  const prepared = await input.gateway.prepareContext({
    githubInstallationId: input.repository.githubInstallationId,
    binding: input.binding,
  });
  assertCertifiedForkReviewPromptPacketSize(prepared.promptPacket);
  return {
    binding: input.binding,
    bindingHash: certifiedForkReviewBindingHash(input.binding),
    scope: certifiedForkReviewClaimScope(input.binding, prepared.contextHash),
    reservationOwner: certifiedForkReviewReservationOwner({
      repositoryId: input.claims.repository_id,
      runId: input.claims.run_id,
      runAttempt: input.claims.run_attempt,
      workflowSha: input.claims.workflow_sha,
    }),
  };
}

function assertCertifiedForkPreleaseIdentity(input: {
  readonly claims: CodexRotatingOidcClaims;
  readonly repository: ActionRepositoryContext;
  readonly workflowSchemaVersion: number;
  readonly binding: CertifiedForkReviewBinding;
}): void {
  if (
    input.workflowSchemaVersion !== certifiedForkReviewWorkflowSchemaVersion ||
    !["pull_request_target", "workflow_dispatch"].includes(
      input.claims.event_name,
    ) ||
    input.binding.trustDomain !== "fork" ||
    input.claims.repository_id !== input.binding.baseRepositoryId ||
    input.claims.repository !== input.binding.baseRepository ||
    input.repository.githubRepositoryId !== input.binding.baseRepositoryId ||
    input.repository.fullName !== input.binding.baseRepository
  )
    throw new Error("certified_fork_prelease_identity_mismatch");
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
  readonly workflowSchemaVersion: number;
  readonly workflowSourceVerifier: CodexRotatingWorkflowSourceVerifierPort;
  readonly forkReviewBinding?: CertifiedForkReviewBinding | undefined;
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
  if (isCertifiedForkReviewWorkflowSchemaVersion(input.workflowSchemaVersion)) {
    const resolveBinding =
      input.workflowSourceVerifier.resolveWorkflowRunPullRequestBinding;
    if (!resolveBinding) {
      throw new Error("codex_rotating_v5_pull_request_resolver_unavailable");
    }
    const live = await resolveBinding.call(input.workflowSourceVerifier, {
      repository: input.repository,
      githubRunId: input.claims.run_id,
      githubRunAttempt: input.claims.run_attempt,
      eventName: input.claims.event_name,
    });
    assertLiveBaseRepositoryIdentity(live, input.repository);
    if (input.forkReviewBinding) {
      assertLiveForkReviewBinding(live, input.forkReviewBinding);
    } else {
      assertLiveSameRepositoryReviewBinding(live, input.repository);
    }
    return live.pullRequestNumber;
  }
  if (input.forkReviewBinding) {
    const resolveFork =
      input.workflowSourceVerifier.resolveWorkflowRunForkPullRequest;
    if (!resolveFork) {
      throw new Error("codex_rotating_fork_pull_request_resolver_unavailable");
    }
    const live = await resolveFork.call(input.workflowSourceVerifier, {
      repository: input.repository,
      githubRunId: input.claims.run_id,
      githubRunAttempt: input.claims.run_attempt,
      eventName: input.claims.event_name,
    });
    const expected = input.forkReviewBinding;
    if (
      expected.trustDomain !== "fork" ||
      live.baseRepository !== expected.baseRepository ||
      live.baseRepositoryId !== expected.baseRepositoryId ||
      live.baseRepository !== input.repository.fullName ||
      live.baseRepositoryId !== input.repository.githubRepositoryId ||
      live.sourceRepository !== expected.sourceRepository ||
      live.sourceRepositoryId !== expected.sourceRepositoryId ||
      live.sourceRepository === live.baseRepository ||
      live.pullRequestNumber !== expected.pullRequestNumber ||
      live.reviewHeadSha !== expected.reviewHeadSha.toLowerCase() ||
      live.baseSha !== expected.baseSha.toLowerCase()
    ) {
      throw new Error("codex_rotating_fork_pull_request_identity_mismatch");
    }
    if (
      live.sourceVisibility !== "public" ||
      live.draft ||
      live.authorType === "Bot"
    ) {
      throw new Error("codex_rotating_fork_pull_request_not_admitted");
    }
    return live.pullRequestNumber;
  }
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

type LivePullRequestBinding = Awaited<
  ReturnType<
    NonNullable<
      CodexRotatingWorkflowSourceVerifierPort["resolveWorkflowRunPullRequestBinding"]
    >
  >
>;

function assertLiveBaseRepositoryIdentity(
  live: LivePullRequestBinding,
  repository: ActionRepositoryContext,
): void {
  if (
    live.baseRepository !== repository.fullName ||
    live.baseRepositoryId !== repository.githubRepositoryId ||
    live.draft ||
    live.authorType === "Bot"
  ) {
    throw new Error("codex_rotating_v5_pull_request_identity_mismatch");
  }
}

function assertLiveSameRepositoryReviewBinding(
  live: LivePullRequestBinding,
  repository: ActionRepositoryContext,
): void {
  if (
    live.sourceRepository !== repository.fullName ||
    live.sourceRepositoryId !== repository.githubRepositoryId
  ) {
    throw new Error("codex_rotating_v5_fork_binding_required");
  }
}

function assertLiveForkReviewBinding(
  live: LivePullRequestBinding,
  expected: CertifiedForkReviewBinding,
): void {
  if (
    expected.trustDomain !== "fork" ||
    live.baseRepository !== expected.baseRepository ||
    live.baseRepositoryId !== expected.baseRepositoryId ||
    live.sourceRepository !== expected.sourceRepository ||
    live.sourceRepositoryId !== expected.sourceRepositoryId ||
    live.sourceRepository === live.baseRepository ||
    live.pullRequestNumber !== expected.pullRequestNumber ||
    live.reviewHeadSha !== expected.reviewHeadSha.toLowerCase() ||
    live.baseSha !== expected.baseSha.toLowerCase()
  ) {
    throw new Error("codex_rotating_fork_pull_request_identity_mismatch");
  }
  if (live.sourceVisibility !== "public") {
    throw new Error("codex_rotating_fork_pull_request_not_admitted");
  }
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
