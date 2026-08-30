import type {
  CertifiedForkReviewBinding,
  CertifiedForkReviewOutputPort,
} from "../ports/certified-fork-review-port.js";
import {
  consumeFreshOidc,
  verifyCertifiedForkClaims,
  type CertifiedForkReviewDependencies,
} from "./prepare-certified-fork-review.js";

export async function publishCertifiedForkReview(
  input: {
    oidcToken: string;
    audience: string;
    leaseId: string;
    providerInstanceId: string;
    workflowSchemaVersion: number;
    forkReviewBinding: CertifiedForkReviewBinding;
    executionId: string;
    contextHash: string;
    modelOutput: unknown;
  },
  d: CertifiedForkReviewDependencies & {
    readonly certifiedForkReviewOutput: CertifiedForkReviewOutputPort;
  },
) {
  const claims = await verifyCertifiedForkClaims(input, d);
  const ticket = await d.certifiedForkReviewTickets.verify(input.executionId);
  assertTicket(input, claims, ticket);
  const lease = await d.certifiedForkReviewLeases.assertFinalizedV5ForkLease({
    leaseId: input.leaseId,
    providerInstanceId: input.providerInstanceId,
    claims,
    binding: input.forkReviewBinding,
  });
  if (lease.githubInstallationId !== ticket.githubInstallationId)
    throw new Error("certified_fork_context_mismatch");
  await consumeFreshOidc(claims, d);
  const current = await d.certifiedForkReviewGateway.assertContextCurrent({
    githubInstallationId: lease.githubInstallationId,
    binding: input.forkReviewBinding,
    expectedContextHash: input.contextHash,
  });
  const marker = `<!-- reviewrouter:certified-fork:${input.forkReviewBinding.reviewHeadSha} -->`;
  const rendered = d.certifiedForkReviewOutput.render({
    modelOutput: input.modelOutput,
    marker,
    binding: input.forkReviewBinding,
    generatedAt: d.clock.now(),
    promptPacket: current.promptPacket,
  });
  const published = await d.certifiedForkReviewGateway.upsertOwnedComment({
    githubInstallationId: lease.githubInstallationId,
    binding: input.forkReviewBinding,
    marker,
    body: rendered.body,
  });
  return { protocolVersion: 1 as const, ...published };
}

function assertTicket(
  input: {
    leaseId: string;
    providerInstanceId: string;
    contextHash: string;
    forkReviewBinding: CertifiedForkReviewBinding;
  },
  claims: {
    run_id: string;
    run_attempt: string;
    workflow_ref: string;
    workflow_sha?: string | undefined;
  },
  ticket: Awaited<
    ReturnType<
      CertifiedForkReviewDependencies["certifiedForkReviewTickets"]["verify"]
    >
  >,
): void {
  if (
    ticket.contextHash !== input.contextHash ||
    ticket.leaseId !== input.leaseId ||
    ticket.providerInstanceId !== input.providerInstanceId ||
    ticket.githubRunId !== claims.run_id ||
    ticket.githubRunAttempt !== claims.run_attempt ||
    ticket.workflowRef !== claims.workflow_ref ||
    ticket.workflowSha !== claims.workflow_sha ||
    JSON.stringify(ticket.binding) !== JSON.stringify(input.forkReviewBinding)
  )
    throw new Error("certified_fork_context_mismatch");
}
