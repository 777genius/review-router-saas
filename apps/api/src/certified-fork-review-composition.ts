import { createHmac, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@reviewrouter/platform-db";
import type {
  CertifiedForkReviewBinding,
  CertifiedForkReviewLeasePort,
  CertifiedForkReviewOutputPort,
  CertifiedForkReviewTicket,
  CertifiedForkReviewTicketPort,
  ActionControlPlaneRepositoryPort,
  CodexRotatingOAuthRepositoryPort,
} from "@reviewrouter/features-action-control-plane";
import { createReviewFindingsArtifactFromModelOutput } from "@reviewrouter/features-review-publishing";
import { OctokitCertifiedForkReviewGateway } from "./github/octokit-certified-fork-review-gateway.js";

export function composeCertifiedForkReview(input: {
  prisma: PrismaClient;
  appId: string;
  privateKey: string;
  appSlug: string;
  ticketSecret: string;
  oidcVerifier: any;
  replayNonces: any;
  clock: { now(): Date };
  repositories: ActionControlPlaneRepositoryPort;
  codexRotatingOAuth: CodexRotatingOAuthRepositoryPort;
}) {
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
    certifiedForkReviewGateway: new OctokitCertifiedForkReviewGateway({
      appId: input.appId,
      privateKey: input.privateKey,
      appSlug: input.appSlug,
    }),
    certifiedForkReviewTickets: new HmacCertifiedForkReviewTickets(
      input.ticketSecret,
    ),
    certifiedForkReviewOutput: new StrictCertifiedForkReviewOutput(),
  };
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
    let value: any;
    try {
      value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw new Error("certified_fork_context_mismatch");
    }
    if (value && typeof value === "object" && value.executionId === undefined)
      return { ...value, executionId } as CertifiedForkReviewTicket;
    throw new Error("certified_fork_context_mismatch");
  }
  private sign(value: string) {
    return createHmac("sha256", this.secret).update(value).digest("base64url");
  }
}

export class StrictCertifiedForkReviewOutput implements CertifiedForkReviewOutputPort {
  render(input: Parameters<CertifiedForkReviewOutputPort["render"]>[0]) {
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
      input.marker,
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
            ? `\`${escape(finding.location.filePath)}:${finding.location.newLine ?? finding.location.oldLine}\``
            : "",
          cleanMarkdown(finding.body),
        );
    }
    const body = lines.filter((line) => line !== "").join("\n");
    if (Buffer.byteLength(body, "utf8") > 60_000)
      throw new Error("certified_fork_model_output_invalid");
    return { body };
  }
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
    !value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  );
}
function escape(value: string) {
  return value.replaceAll("`", "\\`");
}
function cleanMarkdown(value: string) {
  return value
    .replace(/<!--[^]*?-->/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim();
}
