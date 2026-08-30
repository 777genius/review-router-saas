import { createHash } from "node:crypto";
import type {
  CertifiedForkReviewBinding,
  CertifiedForkReviewOutputPort,
  CertifiedForkReviewPublishLockPort,
} from "../ports/certified-fork-review-port.js";
import {
  consumeFreshOidc,
  verifyCertifiedForkClaims,
  type CertifiedForkReviewDependencies,
} from "./prepare-certified-fork-review.js";
import {
  certifiedForkReviewClaimScope,
  assertCertifiedForkReviewPromptPacketSize,
} from "./certified-fork-review-binding.js";

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
    readonly certifiedForkReviewPublishLock: CertifiedForkReviewPublishLockPort;
  },
) {
  const claims = await verifyCertifiedForkClaims(input, d);
  d.certifiedForkReviewAdmission.assertEnabled(input.forkReviewBinding);
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
  const published = await d.certifiedForkReviewPublishLock.withLock(
    `certified-fork-publish:${input.forkReviewBinding.baseRepositoryId}:${input.forkReviewBinding.pullRequestNumber}:${input.forkReviewBinding.reviewHeadSha.toLowerCase()}`,
    async () => {
      const current = await d.certifiedForkReviewGateway.assertContextCurrent({
        githubInstallationId: lease.githubInstallationId,
        binding: input.forkReviewBinding,
        expectedContextHash: input.contextHash,
      });
      assertCertifiedForkReviewPromptPacketSize(current.promptPacket);
      const rendered = d.certifiedForkReviewOutput.render({
        modelOutput: input.modelOutput,
        binding: input.forkReviewBinding,
        generatedAt: d.clock.now(),
        promptPacket: current.promptPacket,
      });
      const executionDigest = sha256(input.executionId);
      const outputDigest = sha256(rendered.body);
      const scope = certifiedForkReviewClaimScope(
        input.forkReviewBinding,
        input.contextHash,
      );
      const claim = await d.certifiedForkReviewClaims.beginPublish({
        scope,
        executionId: input.executionId,
        outputDigest,
      });
      if (claim.status === "already_published")
        return {
          status: "updated" as const,
          commentId: claim.commentId,
          ...(claim.commentUrl ? { commentUrl: claim.commentUrl } : {}),
        };
      const markerPrefix = `<!-- reviewrouter:certified-fork:${input.forkReviewBinding.reviewHeadSha.toLowerCase()}:`;
      const markerSignature =
        await d.certifiedForkReviewTickets.signPublication({
          executionDigest,
          outputDigest,
        });
      const marker = `${markerPrefix}execution=${executionDigest}:output=${outputDigest}:signature=${markerSignature} -->`;
      const result = await d.certifiedForkReviewGateway.upsertOwnedComment({
        githubInstallationId: lease.githubInstallationId,
        binding: input.forkReviewBinding,
        markerPrefix,
        marker,
        executionDigest,
        outputDigest,
        body: `${marker}\n${rendered.body}`,
      });
      await d.certifiedForkReviewClaims.completePublished({
        scope,
        executionId: input.executionId,
        outputDigest,
        commentId: result.commentId,
        ...(result.commentUrl ? { commentUrl: result.commentUrl } : {}),
      });
      return result;
    },
  );
  return { protocolVersion: 1 as const, ...published };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
