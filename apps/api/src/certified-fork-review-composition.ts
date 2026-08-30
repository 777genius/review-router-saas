import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@reviewrouter/platform-db";
import { Prisma } from "@prisma/client";
import type {
  CertifiedForkReviewLeasePort,
  CertifiedForkReviewOutputPort,
  CertifiedForkReviewTicket,
  CertifiedForkReviewTicketPort,
  ActionControlPlaneRepositoryPort,
  ActionOidcReplayNonceStorePort,
  CodexRotatingOAuthRepositoryPort,
  GitHubActionsOidcTokenVerifierPort,
  CertifiedForkReviewPublishLockPort,
  CertifiedForkReviewClaimPort,
  CertifiedForkReviewClaimScope,
  CertifiedForkReviewAdmissionPort,
  CertifiedForkReviewBinding,
} from "@reviewrouter/features-action-control-plane";
import {
  certifiedForkReviewBindingHash,
  certifiedForkReviewLeaseBindingKey,
} from "@reviewrouter/features-action-control-plane";
import { createReviewFindingsArtifactFromModelOutput } from "@reviewrouter/features-review-publishing";
import { OctokitCertifiedForkReviewGateway } from "./github/octokit-certified-fork-review-gateway.js";

export function composeCertifiedForkReview(input: {
  prisma: PrismaClient;
  appId: string;
  privateKey: string;
  appSlug: string;
  ticketSecret: string;
  oidcVerifier: GitHubActionsOidcTokenVerifierPort;
  replayNonces: ActionOidcReplayNonceStorePort;
  clock: { now(): Date };
  repositories: ActionControlPlaneRepositoryPort;
  codexRotatingOAuth: CodexRotatingOAuthRepositoryPort;
  enabled: boolean;
  approvedRepositories: readonly string[];
}) {
  const certifiedForkReviewGateway = new OctokitCertifiedForkReviewGateway({
    appId: input.appId,
    privateKey: input.privateKey,
    appSlug: input.appSlug,
  });
  return {
    oidcVerifier: input.oidcVerifier,
    replayNonces: input.replayNonces,
    clock: input.clock,
    certifiedForkReviewLeases: new PrismaCertifiedForkReviewLease(
      input.prisma,
      input.repositories,
      input.codexRotatingOAuth,
      input.clock,
    ),
    certifiedForkReviewGateway,
    certifiedForkReviewTickets: new HmacCertifiedForkReviewTickets(
      input.ticketSecret,
    ),
    certifiedForkReviewOutput: new StrictCertifiedForkReviewOutput(),
    certifiedForkReviewPublishLock: new PrismaCertifiedForkReviewPublishLock(
      input.prisma,
    ),
    certifiedForkReviewClaims: new PrismaCertifiedForkReviewClaims(
      input.prisma,
    ),
    certifiedForkReviewAdmission: new StaticCertifiedForkReviewAdmission(
      input.enabled,
      new Set(input.approvedRepositories),
    ),
  };
}

export class StaticCertifiedForkReviewAdmission implements CertifiedForkReviewAdmissionPort {
  constructor(
    private readonly enabled: boolean,
    private readonly approvedRepositories: ReadonlySet<string>,
  ) {}

  assertEnabled(binding: CertifiedForkReviewBinding): void {
    if (
      !this.enabled ||
      !this.approvedRepositories.has(binding.baseRepository.toLowerCase())
    )
      throw new Error("certified_fork_v5_not_enabled");
  }
}

export class PrismaCertifiedForkReviewClaims implements CertifiedForkReviewClaimPort {
  constructor(private readonly prisma: PrismaClient) {}

  async claimPrelease(input: {
    scope: CertifiedForkReviewClaimScope;
    reservationOwner: string;
  }) {
    const scopeKey = claimScopeKey(input.scope);
    try {
      await this.prisma.certifiedForkReviewClaim.create({
        data: {
          scopeKey,
          ...input.scope,
          reservationOwner: input.reservationOwner,
          reservationExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      return { status: "ready" as const };
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
    }
    const existing = await this.readExact(scopeKey, input.scope);
    if (existing.status === "published") {
      if (!existing.commentId) throw new Error("certified_fork_claim_invalid");
      return {
        status: "already_published" as const,
        commentId: existing.commentId,
        ...(existing.commentUrl ? { commentUrl: existing.commentUrl } : {}),
      };
    }
    if (existing.status !== "pending")
      throw new Error("certified_fork_claim_conflict");
    if (
      existing.reservationOwner === input.reservationOwner &&
      existing.executionId === null &&
      existing.recoveryState === "reserved"
    )
      return { status: "resume" as const };
    return { status: "in_progress" as const };
  }

  async abandonPrelease(input: {
    scope: CertifiedForkReviewClaimScope;
    reservationOwner: string;
  }): Promise<void> {
    await this.prisma.certifiedForkReviewClaim.deleteMany({
      where: {
        scopeKey: claimScopeKey(input.scope),
        status: "pending",
        reservationOwner: input.reservationOwner,
        executionId: null,
        outputDigest: null,
      },
    });
  }

  async markPreleaseAmbiguous(input: {
    scope: CertifiedForkReviewClaimScope;
    reservationOwner: string;
  }): Promise<void> {
    await this.prisma.certifiedForkReviewClaim.updateMany({
      where: {
        scopeKey: claimScopeKey(input.scope),
        status: "pending",
        reservationOwner: input.reservationOwner,
        executionId: null,
      },
      data: { recoveryState: "ambiguous" },
    });
  }

  async recoverAmbiguousPrelease(input: {
    scope: CertifiedForkReviewClaimScope;
    reservationOwner: string;
    noProviderEffectEvidenceHash: string;
  }): Promise<void> {
    assertDigest(input.noProviderEffectEvidenceHash);
    const scopeKey = claimScopeKey(input.scope);
    const recovered = await this.prisma.certifiedForkReviewClaim.updateMany({
      where: {
        scopeKey,
        status: "pending",
        recoveryState: "ambiguous",
        reservationOwner: input.reservationOwner,
        executionId: null,
        outputDigest: null,
      },
      data: {
        status: "recovered",
        recoveryEvidenceHash: input.noProviderEffectEvidenceHash,
        scopeKey: `${scopeKey}:recovered:${input.noProviderEffectEvidenceHash}`,
      },
    });
    if (recovered.count !== 1)
      throw new Error("certified_fork_claim_recovery_conflict");
  }

  async claimPrepare(input: {
    scope: CertifiedForkReviewClaimScope;
    reservationOwner: string;
    executionId: string;
  }) {
    const scopeKey = claimScopeKey(input.scope);
    const existing = await this.readExact(scopeKey, input.scope);
    if (existing.status === "published") {
      if (!existing.commentId) throw new Error("certified_fork_claim_invalid");
      return {
        status: "already_published" as const,
        commentId: existing.commentId,
        ...(existing.commentUrl ? { commentUrl: existing.commentUrl } : {}),
      };
    }
    if (
      existing.status !== "pending" ||
      existing.reservationOwner !== input.reservationOwner
    )
      throw new Error("certified_fork_claim_reservation_mismatch");
    if (existing.executionId !== null)
      return existing.executionId === input.executionId
        ? { status: "resume" as const }
        : { status: "in_progress" as const };
    const updated = await this.prisma.certifiedForkReviewClaim.updateMany({
      where: {
        id: existing.id,
        status: "pending",
        reservationOwner: input.reservationOwner,
        executionId: null,
      },
      data: { executionId: input.executionId },
    });
    if (updated.count !== 1) return { status: "in_progress" as const };
    return { status: "ready" as const };
  }

  async beginPublish(input: {
    scope: CertifiedForkReviewClaimScope;
    executionId: string;
    outputDigest: string;
  }) {
    assertDigest(input.outputDigest);
    const scopeKey = claimScopeKey(input.scope);
    const existing = await this.readExact(scopeKey, input.scope);
    if (existing.executionId !== input.executionId)
      throw new Error("certified_fork_claim_execution_mismatch");
    if (existing.status === "published") {
      if (existing.outputDigest !== input.outputDigest || !existing.commentId)
        throw new Error("certified_fork_publish_digest_conflict");
      return {
        status: "already_published" as const,
        commentId: existing.commentId,
        ...(existing.commentUrl ? { commentUrl: existing.commentUrl } : {}),
      };
    }
    if (
      existing.status !== "pending" ||
      (existing.outputDigest !== null &&
        existing.outputDigest !== input.outputDigest)
    )
      throw new Error("certified_fork_publish_digest_conflict");
    const updated = await this.prisma.certifiedForkReviewClaim.updateMany({
      where: {
        id: existing.id,
        status: "pending",
        OR: [{ outputDigest: null }, { outputDigest: input.outputDigest }],
      },
      data: { outputDigest: input.outputDigest },
    });
    if (updated.count !== 1) throw new Error("certified_fork_claim_conflict");
    return { status: "ready" as const };
  }

  async completePublished(input: {
    scope: CertifiedForkReviewClaimScope;
    executionId: string;
    outputDigest: string;
    commentId: string;
    commentUrl?: string;
  }): Promise<void> {
    assertDigest(input.outputDigest);
    const updated = await this.prisma.certifiedForkReviewClaim.updateMany({
      where: {
        scopeKey: claimScopeKey(input.scope),
        executionId: input.executionId,
        status: "pending",
        outputDigest: input.outputDigest,
      },
      data: {
        status: "published",
        commentId: input.commentId,
        ...(input.commentUrl ? { commentUrl: input.commentUrl } : {}),
        publishedAt: new Date(),
      },
    });
    if (updated.count !== 1)
      throw new Error("certified_fork_claim_completion_conflict");
  }

  private async readExact(
    scopeKey: string,
    scope: CertifiedForkReviewClaimScope,
  ) {
    const row = await this.prisma.certifiedForkReviewClaim.findUnique({
      where: { scopeKey },
    });
    if (!row || !sameClaimScope(row, scope))
      throw new Error("certified_fork_claim_conflict");
    return row;
  }
}

export class PrismaCertifiedForkReviewPublishLock implements CertifiedForkReviewPublishLockPort {
  constructor(private readonly prisma: PrismaClient) {}

  async withLock<T>(
    key: string,
    run: (claims: CertifiedForkReviewClaimPort) => Promise<T>,
  ): Promise<T> {
    if (!key || key.length > 500)
      throw new Error("certified_fork_publish_lock_invalid");
    return await this.prisma.$transaction(
      async (transaction) => {
        await transaction.$queryRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
        );
        return await run(
          new PrismaCertifiedForkReviewClaims(transaction as PrismaClient),
        );
      },
      { maxWait: 60_000, timeout: 300_000 },
    );
  }
}

export class PrismaCertifiedForkReviewLease implements CertifiedForkReviewLeasePort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly repositories: ActionControlPlaneRepositoryPort,
    private readonly codexRotatingOAuth: CodexRotatingOAuthRepositoryPort,
    private readonly clock: { now(): Date },
  ) {}
  async assertFinalizedV5ForkLease(
    input: Parameters<
      CertifiedForkReviewLeasePort["assertFinalizedV5ForkLease"]
    >[0],
  ) {
    const lease = await this.prisma.codexOAuthLease.findUnique({
      where: { id: input.leaseId },
      select: {
        providerInstanceId: true,
        githubRunId: true,
        githubRunAttempt: true,
        pullRequestNumber: true,
        leaseKey: true,
        status: true,
        finalizedAt: true,
        completedAt: true,
        repository: {
          select: {
            githubRepositoryId: true,
            fullName: true,
            selected: true,
            archived: true,
            visibility: true,
            installation: {
              select: { status: true, githubInstallationId: true },
            },
          },
        },
      },
    });
    if (
      !lease ||
      lease.providerInstanceId !== input.providerInstanceId ||
      lease.githubRunId !== input.claims.run_id ||
      lease.githubRunAttempt !== input.claims.run_attempt ||
      lease.pullRequestNumber !== input.binding.pullRequestNumber ||
      !lease.leaseKey.endsWith(
        `:${certifiedForkReviewLeaseBindingKey(
          certifiedForkReviewBindingHash(input.binding),
        )}`,
      ) ||
      lease.status !== "completed" ||
      !lease.finalizedAt ||
      !lease.completedAt ||
      lease.completedAt.getTime() <
        this.clock.now().getTime() - 60 * 60 * 1000 ||
      String(lease.repository.githubRepositoryId) !==
        input.binding.baseRepositoryId ||
      lease.repository.fullName.toLowerCase() !==
        input.binding.baseRepository.toLowerCase() ||
      !lease.repository.selected ||
      lease.repository.archived ||
      lease.repository.visibility !== "public" ||
      lease.repository.installation?.status !== "active"
    )
      throw new Error("certified_fork_lease_not_finalized");
    const repository = await this.repositories.findSelectedRepositoryByGithubId(
      input.binding.baseRepositoryId,
    );
    if (!repository) throw new Error("certified_fork_lease_not_finalized");
    const providerBinding = await this.codexRotatingOAuth.findProviderBinding({
      repository,
      providerInstanceId: input.providerInstanceId,
      workflowSha: input.claims.workflow_sha!,
      workflowSchemaVersion: 5,
    });
    if (
      !providerBinding ||
      providerBinding.workflowPath !==
        ".github/workflows/reviewrouter-codex.yml"
    )
      throw new Error("certified_fork_lease_not_finalized");
    return {
      githubInstallationId: String(
        lease.repository.installation.githubInstallationId,
      ),
    };
  }
}

export class HmacCertifiedForkReviewTickets implements CertifiedForkReviewTicketPort {
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret) < 32)
      throw new Error("certified_fork_ticket_secret_invalid");
  }
  async issue(input: Omit<CertifiedForkReviewTicket, "executionId">) {
    const payload = Buffer.from(JSON.stringify(input)).toString("base64url");
    const signature = this.sign(payload);
    return { ...input, executionId: `${payload}.${signature}` };
  }
  async verify(executionId: string): Promise<CertifiedForkReviewTicket> {
    const [payload, signature, ...rest] = executionId.split(".");
    if (
      !payload ||
      !signature ||
      rest.length ||
      !safeEqual(signature, this.sign(payload))
    )
      throw new Error("certified_fork_context_mismatch");
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw new Error("certified_fork_context_mismatch");
    }
    if (record(value) && value.executionId === undefined)
      return { ...value, executionId } as CertifiedForkReviewTicket;
    throw new Error("certified_fork_context_mismatch");
  }
  async signPublication(input: {
    executionDigest: string;
    outputDigest: string;
  }): Promise<string> {
    assertDigest(input.executionDigest);
    assertDigest(input.outputDigest);
    return createHmac("sha256", this.secret)
      .update(
        `certified-fork-publication:${input.executionDigest}:${input.outputDigest}`,
      )
      .digest("hex");
  }
  private sign(value: string) {
    return createHmac("sha256", this.secret).update(value).digest("base64url");
  }
}

export class StrictCertifiedForkReviewOutput implements CertifiedForkReviewOutputPort {
  render(input: Parameters<CertifiedForkReviewOutputPort["render"]>[0]) {
    assertCertifiedForkLineBudget(input.modelOutput);
    const artifact = createReviewFindingsArtifactFromModelOutput({
      generatedAt: input.generatedAt,
      modelOutput: input.modelOutput,
    });
    const allowedPaths = new Set(
      input.promptPacket.files.map((file) => file.path),
    );
    for (const finding of artifact.findings)
      if (finding.location) {
        const path = finding.location.filePath;
        const line = finding.location.newLine ?? finding.location.oldLine;
        if (
          !safePath(path) ||
          !allowedPaths.has(path) ||
          !line ||
          line > 1_000_000
        )
          throw new Error("certified_fork_model_output_invalid");
      }
    const lines = [
      "## ReviewRouter certified fork review",
      "",
      cleanMarkdown(artifact.summaryMarkdown ?? "Review complete."),
    ];
    if (artifact.findings.length) {
      lines.push("", "### Findings");
      for (const finding of artifact.findings)
        lines.push(
          "",
          `**[${finding.severity}] ${escape(cleanMarkdown(finding.title))}**`,
          finding.location
            ? `<code>${escapeHtml(finding.location.filePath)}:${finding.location.newLine ?? finding.location.oldLine}</code>`
            : "",
          cleanMarkdown(finding.body),
        );
    }
    const body = lines.filter((line) => line !== "").join("\n");
    return { body: boundRenderedReviewBody(body) };
  }
}

function assertCertifiedForkLineBudget(modelOutput: unknown): void {
  if (!record(modelOutput) || !Array.isArray(modelOutput.findings)) return;
  for (const finding of modelOutput.findings) {
    if (!record(finding)) continue;
    for (const key of ["startLine", "endLine"] as const) {
      const line = finding[key];
      if (line !== undefined && line !== null && Number(line) > 1_000_000)
        throw new Error("certified_fork_model_output_invalid");
    }
  }
}

const certifiedForkRenderedBodyMaxBytes = 59_500;
const certifiedForkTruncationNotice =
  "\n\n_Output truncated to GitHub comment budget._";

function boundRenderedReviewBody(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= certifiedForkRenderedBodyMaxBytes)
    return value;
  const noticeBytes = Buffer.byteLength(certifiedForkTruncationNotice, "utf8");
  return `${truncateUtf8(value, certifiedForkRenderedBodyMaxBytes - noticeBytes)}${certifiedForkTruncationNotice}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result.trimEnd();
}
function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function safePath(value: string) {
  return (
    value.length <= 500 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("`") &&
    !/[\u202a-\u202e\u2066-\u2069]/u.test(value) &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) &&
    !value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  );
}
function escape(value: string) {
  return value.replaceAll("`", "\\`");
}
function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function cleanMarkdown(value: string) {
  return value
    .replace(/<!--[^]*?-->/gu, "")
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code > 31;
    })
    .join("")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("@", "@\u200b")
    .trim();
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function claimScopeKey(scope: CertifiedForkReviewClaimScope): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        baseRepositoryId: scope.baseRepositoryId,
        pullRequestNumber: scope.pullRequestNumber,
        reviewHeadSha: scope.reviewHeadSha,
        baseSha: scope.baseSha,
        promptPolicyVersion: scope.promptPolicyVersion,
      }),
    )
    .digest("hex");
}

function sameClaimScope(
  row: CertifiedForkReviewClaimScope,
  scope: CertifiedForkReviewClaimScope,
): boolean {
  return (
    row.baseRepositoryId === scope.baseRepositoryId &&
    row.pullRequestNumber === scope.pullRequestNumber &&
    row.reviewHeadSha === scope.reviewHeadSha &&
    row.baseSha === scope.baseSha &&
    row.contextHash === scope.contextHash &&
    row.promptPolicyVersion === scope.promptPolicyVersion
  );
}

function assertDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new Error("certified_fork_publish_digest_invalid");
}

function isUniqueConflict(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002") ||
    (record(error) && error.code === "P2002")
  );
}
