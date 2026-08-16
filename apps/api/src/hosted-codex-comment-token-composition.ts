import { createHash } from "node:crypto";
import type { PrismaClient } from "@reviewrouter/platform-db";
import type { Clock } from "@reviewrouter/shared";
import type { GitHubAppCommentTokenIssuerPort } from "@reviewrouter/features-action-control-plane";
import {
  consumeHostedCommentTokenRefreshCapability,
  invocationGrantId,
  PrismaInvocationGrantRepository,
  type HostedCodexCommentTokenIssuerPort,
} from "@reviewrouter/features-hosted-account-pool";

export class HostedCodexCommentTokenIssuer implements HostedCodexCommentTokenIssuerPort {
  private readonly grants: PrismaInvocationGrantRepository;

  constructor(
    private readonly dependencies: {
      readonly prisma: PrismaClient;
      readonly commentTokens: GitHubAppCommentTokenIssuerPort;
      readonly clock: Clock;
      readonly grants?: PrismaInvocationGrantRepository;
    },
  ) {
    this.grants =
      dependencies.grants ??
      new PrismaInvocationGrantRepository(dependencies.prisma);
  }

  async issue(
    input: Parameters<HostedCodexCommentTokenIssuerPort["issue"]>[0],
  ) {
    const now = this.dependencies.clock.now();
    const stored =
      await this.dependencies.prisma.hostedCodexInvocationGrant.findUnique({
        where: { id: input.invocationLeaseId },
        include: {
          binding: {
            include: {
              repository: { include: { installation: true } },
              pool: true,
            },
          },
        },
      });
    if (!stored) throw new Error("hosted_comment_refresh_grant_not_found");
    const repository = stored.binding.repository;
    if (
      stored.status !== "issued" ||
      stored.expiresAt <= now ||
      stored.repositoryBindingId !== input.bindingId ||
      toSafeNumber(stored.bindingRevision) !== input.bindingVersion ||
      stored.binding.revision !== stored.bindingRevision ||
      stored.binding.status !== "active" ||
      stored.binding.pool.status !== "active" ||
      stored.binding.pool.authzEpoch !== stored.authzEpoch ||
      repository.provider !== "github" ||
      !repository.selected ||
      repository.archived ||
      (repository.visibility !== "private" &&
        repository.visibility !== "internal") ||
      !repository.githubRepositoryId ||
      !repository.installation ||
      repository.installation.status !== "active"
    ) {
      throw new Error("hosted_comment_refresh_authority_mismatch");
    }
    const consumption = await consumeHostedCommentTokenRefreshCapability(
      {
        grantId: invocationGrantId(stored.id),
        presentedTokenHash: hashCapability(input.opaqueRefreshCapability),
        requestIdHash: sha256(input.idempotencyKey),
        now,
      },
      this.grants,
    );
    if (consumption.status !== "consumed") {
      throw new Error(`hosted_comment_refresh_${consumption.status}`);
    }
    const token = await this.dependencies.commentTokens.issueCommentToken({
      githubInstallationId:
        repository.installation.githubInstallationId.toString(),
      githubRepositoryId: repository.githubRepositoryId.toString(),
      repositoryFullName: repository.fullName,
    });
    return {
      token: token.token,
      repository: token.repository,
      expiresAt: token.expiresAt.toISOString(),
    };
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashCapability(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error("hosted_comment_refresh_capability_invalid");
  }
  return sha256(value);
}

function toSafeNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error("hosted_comment_refresh_revision_invalid");
  }
  return number;
}
