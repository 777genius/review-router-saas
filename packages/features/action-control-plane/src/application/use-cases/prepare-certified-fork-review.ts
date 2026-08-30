import {
  buildActionOidcReplayNonceKey,
  managedCodexWorkflowPath,
  resolveActionOidcReplayNonceExpiresAt,
  type GitHubActionsOidcClaims,
} from "../../domain/action-control-plane.js";
import type { ActionOidcReplayNonceStorePort } from "../ports/action-oidc-replay-nonce-store-port.js";
import type { GitHubActionsOidcTokenVerifierPort } from "../ports/github-actions-oidc-token-verifier-port.js";
import type {
  CertifiedForkReviewBinding,
  CertifiedForkReviewGatewayPort,
  CertifiedForkReviewLeasePort,
  CertifiedForkReviewTicketPort,
} from "../ports/certified-fork-review-port.js";

export const certifiedForkReviewModel = "gpt-5.6-sol";
export const certifiedForkReviewMaxOutputTokens = 12_000;

export type CertifiedForkReviewDependencies = Readonly<{
  oidcVerifier: GitHubActionsOidcTokenVerifierPort;
  replayNonces: ActionOidcReplayNonceStorePort;
  certifiedForkReviewLeases: CertifiedForkReviewLeasePort;
  certifiedForkReviewGateway: CertifiedForkReviewGatewayPort;
  certifiedForkReviewTickets: CertifiedForkReviewTicketPort;
  clock: { now(): Date };
}>;

export async function prepareCertifiedForkReview(
  input: {
    oidcToken: string;
    audience: string;
    leaseId: string;
    providerInstanceId: string;
    workflowSchemaVersion: number;
    forkReviewBinding: CertifiedForkReviewBinding;
  },
  d: CertifiedForkReviewDependencies,
) {
  const claims = await verifyCertifiedForkClaims(input, d);
  const lease = await d.certifiedForkReviewLeases.assertFinalizedV5ForkLease({
    leaseId: input.leaseId,
    providerInstanceId: input.providerInstanceId,
    claims,
    binding: input.forkReviewBinding,
  });
  await consumeFreshOidc(claims, d);
  const prepared = await d.certifiedForkReviewGateway.prepareContext({
    githubInstallationId: lease.githubInstallationId,
    binding: input.forkReviewBinding,
  });
  const ticket = await d.certifiedForkReviewTickets.issue({
    contextHash: prepared.contextHash,
    leaseId: input.leaseId,
    providerInstanceId: input.providerInstanceId,
    githubInstallationId: lease.githubInstallationId,
    githubRunId: claims.run_id,
    githubRunAttempt: claims.run_attempt,
    workflowRef: claims.workflow_ref,
    workflowSha: claims.workflow_sha!,
    binding: input.forkReviewBinding,
  });
  return {
    protocolVersion: 1 as const,
    executionId: ticket.executionId,
    contextHash: prepared.contextHash,
    model: certifiedForkReviewModel,
    maxOutputTokens: certifiedForkReviewMaxOutputTokens,
    promptPacket: prepared.promptPacket,
  };
}

export async function verifyCertifiedForkClaims(
  input: {
    oidcToken: string;
    audience: string;
    workflowSchemaVersion: number;
    forkReviewBinding: CertifiedForkReviewBinding;
  },
  d: Pick<CertifiedForkReviewDependencies, "oidcVerifier">,
): Promise<GitHubActionsOidcClaims> {
  if (input.workflowSchemaVersion !== 5)
    throw new Error("certified_fork_schema_invalid");
  const claims = await d.oidcVerifier.verify({
    token: input.oidcToken,
    audience: input.audience,
  });
  const expectedPrefix = `${input.forkReviewBinding.baseRepository}/${managedCodexWorkflowPath}@`;
  if (
    !["pull_request_target", "workflow_dispatch"].includes(claims.event_name) ||
    claims.repository_id !== input.forkReviewBinding.baseRepositoryId ||
    claims.repository.toLowerCase() !==
      input.forkReviewBinding.baseRepository.toLowerCase() ||
    !claims.workflow_sha ||
    !claims.ref ||
    !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(claims.ref) ||
    claims.workflow_ref !== `${expectedPrefix}${claims.ref}` ||
    !/^[1-9][0-9]*$/.test(claims.run_id) ||
    !/^[1-9][0-9]*$/.test(claims.run_attempt)
  )
    throw new Error("certified_fork_identity_invalid");
  return claims;
}

export async function consumeFreshOidc(
  claims: GitHubActionsOidcClaims,
  d: Pick<CertifiedForkReviewDependencies, "replayNonces" | "clock">,
): Promise<void> {
  const now = d.clock.now();
  if (
    !(await d.replayNonces.tryConsumeNonce({
      key: buildActionOidcReplayNonceKey(claims),
      expiresAt: resolveActionOidcReplayNonceExpiresAt({ claims, now }),
      now,
    }))
  )
    throw new Error("certified_fork_oidc_replay");
}
