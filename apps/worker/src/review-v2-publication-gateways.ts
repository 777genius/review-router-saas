import { createHash } from "node:crypto";
import { decodeProtectedHeader } from "jose";
import { App } from "@octokit/app";
import {
  CapabilityAudience,
  CapabilityKind,
  JoseRotatingCapabilityCodec,
  type CapabilityKeyRingPort,
  type SignedCapabilityCodecPort,
} from "@reviewrouter/platform-signed-capabilities";
import {
  ReviewPublicationExternalEffectKind,
  ReviewPublicationReceiptStatus,
  type ReviewPublicationGatewayObject,
  type ReviewPublicationPermitIdentity,
  type ReviewPublicationOperation,
  type ReviewPublicationOperationCapabilityFacts,
} from "@reviewrouter/features-review-publishing/v2";
import {
  ReviewV2ScmMutationError,
  ReviewV2ScmMutationFailureOutcome,
  ReviewV2ScmCredentialPurpose,
  ReviewV2ScmProvider,
  type ReviewV2PublicationClockPort,
  type ReviewV2OpaqueSignedOperationCapability,
  type ReviewV2OperationCapabilityIssuerPort,
  type ReviewV2OperationCapabilityVerifierPort,
  type ReviewV2ScmCredentialAcquisitionPort,
  type ReviewV2ScmGatewaySession,
  type ReviewV2ScmLiveRevisionPort,
} from "./review-v2-publication-ports";
import {
  ReviewV2PublicationPayloadKind,
  type ReviewV2PublicationPayload,
  type ReviewV2PublicationPayloadPort,
} from "./review-v2-publication-payloads";

export interface ReviewV2ProviderPublicationClientPort {
  findAllByMarker(input: {
    readonly operation: ReviewPublicationOperation;
    readonly cursor: string | null;
  }): Promise<{
    readonly objects: readonly ReviewPublicationGatewayObject[];
    readonly nextCursor: string | null;
  }>;
  applyOperation(input: {
    readonly operation: ReviewPublicationOperation;
    readonly capability: ReviewPublicationOperationCapabilityFacts;
  }): Promise<ReviewPublicationGatewayObject>;
  markStaleOrDelete(input: {
    readonly operation: ReviewPublicationOperation;
    readonly canonicalExternalObjectId: string;
    readonly duplicateExternalObjectIds: readonly string[];
    readonly compensateCanonical: boolean;
  }): Promise<ReviewPublicationReceiptStatus>;
}

export type ReviewV2ProviderPublicationClientSession = {
  readonly client: ReviewV2ProviderPublicationClientPort;
  close(): Promise<void>;
};

/** Production implementations may hold a token internally but never return it. */
export interface ReviewV2ProviderCredentialPort {
  readonly provider: ReviewV2ScmProvider;
  acquireClient(input: {
    readonly purpose: ReviewV2ScmCredentialPurpose;
    readonly permit: ReviewPublicationPermitIdentity;
    readonly capability: ReviewPublicationOperationCapabilityFacts;
  }): Promise<ReviewV2ProviderPublicationClientSession>;
}

export class ProviderNeutralReviewV2ScmCredentialRouter implements ReviewV2ScmCredentialAcquisitionPort {
  private readonly providers: ReadonlyMap<
    ReviewV2ScmProvider,
    ReviewV2ProviderCredentialPort
  >;

  constructor(
    providers: readonly ReviewV2ProviderCredentialPort[],
    private readonly capabilityVerifier: ReviewV2OperationCapabilityVerifierPort,
  ) {
    const byProvider = new Map<
      ReviewV2ScmProvider,
      ReviewV2ProviderCredentialPort
    >();
    for (const provider of providers) {
      if (byProvider.has(provider.provider)) {
        throw new Error("review_v2_scm_credential_provider_duplicate");
      }
      byProvider.set(provider.provider, provider);
    }
    this.providers = byProvider;
  }

  async acquire(
    input: Parameters<ReviewV2ScmCredentialAcquisitionPort["acquire"]>[0],
  ): Promise<ReviewV2ScmGatewaySession> {
    const provider = this.providers.get(input.provider);
    if (!provider) {
      throw new Error("review_v2_scm_credential_provider_missing");
    }
    await this.capabilityVerifier.verify({
      signedCapability: input.signedCapability,
      permit: input.permit,
      operation: input.operation,
      capability: input.capability,
      claim: input.claim,
    });
    const session = await provider.acquireClient({
      purpose: input.purpose,
      permit: input.permit,
      capability: input.capability,
    });
    const gateway = createProviderGateway(input.provider, session.client);
    if (input.purpose === ReviewV2ScmCredentialPurpose.Mutate) {
      return {
        purpose: input.purpose,
        gateway,
        close: () => session.close(),
      };
    }
    return {
      purpose: input.purpose,
      gateway: {
        findAllByMarker: (request) => gateway.findAllByMarker(request),
        markStaleOrDelete: (request) => gateway.markStaleOrDelete(request),
      },
      close: () => session.close(),
    };
  }
}

export class RotatingReviewV2OperationCapabilityIssuer implements ReviewV2OperationCapabilityIssuerPort {
  constructor(
    private readonly keyRing: CapabilityKeyRingPort,
    private readonly clock: ReviewV2PublicationClockPort,
    private readonly issuer = "reviewrouter-review-v2-worker",
  ) {}

  async issue(
    input: Parameters<ReviewV2OperationCapabilityIssuerPort["issue"]>[0],
  ): Promise<ReviewV2OpaqueSignedOperationCapability> {
    const now = this.clock.now();
    const signingKey = await this.keyRing.verificationKey(
      input.capability.capabilitySigningKeyId,
      now,
    );
    if (!signingKey) {
      throw new Error("review_v2_operation_capability_signing_key_unavailable");
    }
    assertOperationCapabilityContext(input);
    const ownershipExpiresAt = operationCapabilityOwnershipExpiry(input);
    if (
      now >= ownershipExpiresAt ||
      now >= input.capability.effectReportUntil
    ) {
      throw new Error("review_v2_operation_capability_expired");
    }
    const signer = new JoseRotatingCapabilityCodec({
      activeSigningKey: async () => signingKey,
      verificationKey: async (keyId) =>
        keyId === signingKey.keyId ? signingKey : null,
    });
    const payload = operationCapabilityPayload(input);
    const signed = await signer.sign({
      capabilityId: input.capability.capabilityId,
      kind: CapabilityKind.PublicationOperation,
      audience: CapabilityAudience.ReviewPublicationOperation,
      issuer: this.issuer,
      subject: input.operation.publicationOperationId,
      issuedAt: now,
      notBefore: now,
      ownershipExpiresAt,
      expiresAt: input.capability.effectReportUntil,
      payload,
    });
    if (signed.signingKeyId !== input.capability.capabilitySigningKeyId) {
      throw new Error("review_v2_operation_capability_key_mismatch");
    }
    return signed;
  }
}

type SignedCapabilityVerificationPort = Pick<
  SignedCapabilityCodecPort,
  "verify"
>;

export class SignedReviewV2OperationCapabilityVerifier implements ReviewV2OperationCapabilityVerifierPort {
  constructor(
    private readonly verifier: SignedCapabilityVerificationPort,
    private readonly clock: ReviewV2PublicationClockPort,
    private readonly issuer = "reviewrouter-review-v2-worker",
  ) {}

  async verify(
    input: Parameters<ReviewV2OperationCapabilityVerifierPort["verify"]>[0],
  ): Promise<void> {
    const now = this.clock.now();
    assertOperationCapabilityContext(input);
    const header = decodeProtectedHeader(input.signedCapability.token);
    if (
      header.kid !== input.signedCapability.signingKeyId ||
      header.kid !== input.capability.capabilitySigningKeyId
    ) {
      throw new Error("review_v2_operation_capability_key_mismatch");
    }
    const verified = await this.verifier.verify({
      token: input.signedCapability.token,
      expectedIssuer: this.issuer,
      expectedAudience: CapabilityAudience.ReviewPublicationOperation,
      expectedKind: CapabilityKind.PublicationOperation,
      now,
    });
    const payload = operationCapabilityPayload(input);
    const ownershipExpiresAt = operationCapabilityOwnershipExpiry(input);
    if (
      verified.capabilityId !== input.capability.capabilityId ||
      input.signedCapability.capabilityId !== input.capability.capabilityId ||
      input.signedCapability.signingKeyId !==
        input.capability.capabilitySigningKeyId ||
      verified.subject !== input.operation.publicationOperationId ||
      verified.ownershipExpiresAt?.getTime() !==
        truncateToSeconds(ownershipExpiresAt).getTime() ||
      verified.expiresAt.getTime() !==
        truncateToSeconds(input.capability.effectReportUntil).getTime() ||
      input.signedCapability.expiresAt.getTime() !==
        input.capability.effectReportUntil.getTime() ||
      now >= ownershipExpiresAt ||
      now >= input.capability.effectReportUntil ||
      canonicalJson(verified.payload) !== canonicalJson(payload)
    ) {
      throw new Error("review_v2_operation_capability_claim_mismatch");
    }
  }
}

function operationCapabilityPayload(
  input: Parameters<ReviewV2OperationCapabilityIssuerPort["issue"]>[0],
) {
  return Object.freeze({
    signingKeyId: input.capability.capabilitySigningKeyId,
    publicationAttemptId: input.capability.publicationAttemptId,
    publicationOperationId: input.operation.publicationOperationId,
    operationAttemptId: input.capability.operationAttemptId,
    effectReportId: input.capability.effectReportId,
    operationClaimId: input.capability.claimId,
    operationClaimFence: input.capability.claimFencingToken.toString(),
    claimId: input.claim.claimId,
    claimFence: input.claim.fencingToken.toString(),
    claimOwnerIdHash: input.claim.ownerIdHash,
    permitEpoch: input.permit.permitEpoch.toString(),
    mutationEpoch: input.capability.mutationEpoch.toString(),
    publicationSafetyDecisionHash:
      input.capability.publicationSafetyDecisionHash,
    bodyHash: input.operation.bodyHash,
    targetCommitId: input.operation.targetCommitId,
    targetExternalObjectId: input.capability.targetExternalObjectId ?? "none",
    reviewRevisionHash: input.permit.reviewRevisionHash,
  });
}

function assertOperationCapabilityContext(
  input: Parameters<ReviewV2OperationCapabilityIssuerPort["issue"]>[0],
): void {
  if (
    input.capability.publicationOperationId !==
      input.operation.publicationOperationId ||
    input.capability.publicationAttemptId !==
      input.operation.publicationAttemptId ||
    input.claim.publicationAttemptId !==
      input.capability.publicationAttemptId ||
    input.capability.mutationEpoch !== input.permit.permitEpoch ||
    input.capability.reviewRevisionHash !== input.permit.reviewRevisionHash ||
    input.capability.publicationSafetyDecisionHash !==
      input.permit.publicationSafetyDecisionHash ||
    input.operation.targetCommitId !== input.permit.reviewedHeadSha ||
    input.operation.reviewRevisionHash !== input.permit.reviewRevisionHash ||
    input.capability.bodyHash !== input.operation.bodyHash ||
    input.capability.targetCommitId !== input.operation.targetCommitId
  ) {
    throw new Error("review_v2_operation_capability_context_mismatch");
  }
}

function operationCapabilityOwnershipExpiry(
  input: Parameters<ReviewV2OperationCapabilityIssuerPort["issue"]>[0],
): Date {
  return new Date(
    Math.min(
      input.claim.expiresAt.getTime(),
      input.capability.effectReportUntil.getTime(),
    ),
  );
}

function truncateToSeconds(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 1_000) * 1_000);
}

export class GitHubReviewV2PublicationGatewayAdapter {
  constructor(private readonly client: ReviewV2ProviderPublicationClientPort) {}

  findAllByMarker(
    input: Parameters<
      ReviewV2ProviderPublicationClientPort["findAllByMarker"]
    >[0],
  ) {
    return this.client.findAllByMarker(input);
  }

  applyOperation(
    input: Parameters<
      ReviewV2ProviderPublicationClientPort["applyOperation"]
    >[0],
  ) {
    return this.client.applyOperation(input);
  }

  markStaleOrDelete(
    input: Parameters<
      ReviewV2ProviderPublicationClientPort["markStaleOrDelete"]
    >[0],
  ) {
    return this.client.markStaleOrDelete(input);
  }
}

export class GitLabReviewV2PublicationGatewayAdapter {
  constructor(private readonly client: ReviewV2ProviderPublicationClientPort) {}

  findAllByMarker(
    input: Parameters<
      ReviewV2ProviderPublicationClientPort["findAllByMarker"]
    >[0],
  ) {
    return this.client.findAllByMarker(input);
  }

  applyOperation(
    input: Parameters<
      ReviewV2ProviderPublicationClientPort["applyOperation"]
    >[0],
  ) {
    return this.client.applyOperation(input);
  }

  markStaleOrDelete(
    input: Parameters<
      ReviewV2ProviderPublicationClientPort["markStaleOrDelete"]
    >[0],
  ) {
    return this.client.markStaleOrDelete(input);
  }
}

function createProviderGateway(
  provider: ReviewV2ScmProvider,
  client: ReviewV2ProviderPublicationClientPort,
):
  | GitHubReviewV2PublicationGatewayAdapter
  | GitLabReviewV2PublicationGatewayAdapter {
  switch (provider) {
    case ReviewV2ScmProvider.GitHub:
      return new GitHubReviewV2PublicationGatewayAdapter(client);
    case ReviewV2ScmProvider.GitLab:
      return new GitLabReviewV2PublicationGatewayAdapter(client);
  }
}

export type ReviewV2GitHubRepository = {
  readonly githubInstallationId: string;
  readonly owner: string;
  readonly repo: string;
};

export interface ReviewV2GitHubRepositoryQueryPort {
  resolve(
    permit: ReviewPublicationPermitIdentity,
  ): Promise<ReviewV2GitHubRepository | null>;
}

export type GitHubInstallationClient = {
  request(
    route: string,
    parameters?: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly data: unknown }>;
  graphql<T>(
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<T>;
};

/** GitHub App credentials stay inside this adapter and are never returned. */
export class GitHubAppReviewV2CredentialProvider
  implements ReviewV2ProviderCredentialPort, ReviewV2ScmLiveRevisionPort
{
  readonly provider = ReviewV2ScmProvider.GitHub;
  private readonly app: App;
  private botLogin: string | null = null;

  constructor(
    options: { readonly appId: string; readonly privateKey: string },
    private readonly repositories: ReviewV2GitHubRepositoryQueryPort,
    private readonly payloads: ReviewV2PublicationPayloadPort,
  ) {
    this.app = new App(options);
  }

  async acquireClient(
    input: Parameters<ReviewV2ProviderCredentialPort["acquireClient"]>[0],
  ): Promise<ReviewV2ProviderPublicationClientSession> {
    const repository = await this.repositories.resolve(input.permit);
    if (!repository) {
      throw new Error("review_v2_github_repository_unavailable");
    }
    if (!/^[1-9][0-9]*$/u.test(repository.githubInstallationId)) {
      throw new Error("review_v2_github_installation_invalid");
    }
    const [octokit, botLogin] = await Promise.all([
      this.app.getInstallationOctokit(
        Number(repository.githubInstallationId),
      ) as Promise<GitHubInstallationClient>,
      this.resolveBotLogin(),
    ]);
    return {
      client: new GitHubReviewV2PublicationClient({
        octokit,
        repository,
        permit: input.permit,
        capability: input.capability,
        payloads: this.payloads,
        botLogin,
      }),
      close: async () => undefined,
    };
  }

  async readLiveRevision(permit: ReviewPublicationPermitIdentity) {
    const repository = await this.repositories.resolve(permit);
    if (
      !repository ||
      !/^[1-9][0-9]*$/u.test(repository.githubInstallationId)
    ) {
      return null;
    }
    const octokit = (await this.app.getInstallationOctokit(
      Number(repository.githubInstallationId),
    )) as GitHubInstallationClient;
    return readGitHubReviewV2LiveRevision(octokit, repository, permit);
  }

  private async resolveBotLogin(): Promise<string> {
    if (this.botLogin) return this.botLogin;
    const response = await this.app.octokit.request("GET /app");
    if (!isRecord(response.data) || typeof response.data.slug !== "string") {
      throw new Error("review_v2_github_app_identity_unavailable");
    }
    this.botLogin = `${response.data.slug.toLowerCase()}[bot]`;
    return this.botLogin;
  }
}

export async function readGitHubReviewV2LiveRevision(
  octokit: GitHubInstallationClient,
  repository: ReviewV2GitHubRepository,
  permit: ReviewPublicationPermitIdentity,
) {
  const loadPointer = async () => {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: repository.owner,
        repo: repository.repo,
        pull_number: permit.pullRequestNumber,
      },
    );
    const row = requireRecord(response.data, "github_pull_request_invalid");
    const base = requireRecord(row.base, "github_pull_request_base_invalid");
    const head = requireRecord(row.head, "github_pull_request_head_invalid");
    return {
      baseSha: requiredCommitId(base.sha, "github_pull_request_base_invalid"),
      headSha: requiredCommitId(head.sha, "github_pull_request_head_invalid"),
    };
  };
  const before = await loadPointer();
  const comparison = await octokit.request(
    "GET /repos/{owner}/{repo}/compare/{basehead}",
    {
      owner: repository.owner,
      repo: repository.repo,
      basehead: `${before.baseSha}...${before.headSha}`,
    },
  );
  const comparisonRow = requireRecord(
    comparison.data,
    "github_compare_invalid",
  );
  const mergeBase = requireRecord(
    comparisonRow.merge_base_commit,
    "github_merge_base_invalid",
  );
  const mergeBaseSha = requiredCommitId(
    mergeBase.sha,
    "github_merge_base_invalid",
  );
  const after = await loadPointer();
  if (before.baseSha !== after.baseSha || before.headSha !== after.headSha) {
    return null;
  }
  return {
    baseSha: before.baseSha,
    mergeBaseSha,
    headSha: before.headSha,
    reviewRevisionHash: sha256(
      canonicalJson({
        workspaceId: permit.workspaceId,
        repositoryConnectionId: permit.repositoryConnectionId,
        scmRepositoryIdentityId: permit.scmRepositoryIdentityId,
        pullRequestNumber: permit.pullRequestNumber,
        baseSha: before.baseSha,
        mergeBaseSha,
        headSha: before.headSha,
      }),
    ),
  };
}

export class GitHubReviewV2PublicationClient implements ReviewV2ProviderPublicationClientPort {
  constructor(
    private readonly options: {
      readonly octokit: GitHubInstallationClient;
      readonly repository: ReviewV2GitHubRepository;
      readonly permit: ReviewPublicationPermitIdentity;
      readonly capability: ReviewPublicationOperationCapabilityFacts;
      readonly payloads: ReviewV2PublicationPayloadPort;
      readonly botLogin: string;
    },
  ) {}

  async findAllByMarker(input: {
    readonly operation: ReviewPublicationOperation;
    readonly cursor: string | null;
  }) {
    const payload = await this.requirePayload(input.operation);
    switch (payload.kind) {
      case ReviewV2PublicationPayloadKind.Summary:
        return this.findIssueComments(payload, input.cursor);
      case ReviewV2PublicationPayloadKind.ManagedCheck:
        return this.findCheckRuns(payload, input.operation, input.cursor);
      case ReviewV2PublicationPayloadKind.PendingReviewCreate:
      case ReviewV2PublicationPayloadKind.SubmittedReview:
        return this.findReviews(payload, input.cursor);
      case ReviewV2PublicationPayloadKind.PendingReviewSubmit:
        return this.findSubmittedReview(payload, input.operation);
      case ReviewV2PublicationPayloadKind.ThreadLifecycle:
        return this.findLifecycle(payload);
    }
  }

  async applyOperation(input: {
    readonly operation: ReviewPublicationOperation;
    readonly capability: ReviewPublicationOperationCapabilityFacts;
  }): Promise<ReviewPublicationGatewayObject> {
    const payload = await this.requirePayload(input.operation);
    try {
      switch (payload.kind) {
        case ReviewV2PublicationPayloadKind.Summary:
          return this.createIssueComment(payload, input.operation);
        case ReviewV2PublicationPayloadKind.ManagedCheck:
          return this.createCheckRun(payload, input.operation);
        case ReviewV2PublicationPayloadKind.PendingReviewCreate:
        case ReviewV2PublicationPayloadKind.SubmittedReview:
          return this.createReview(payload, input.operation);
        case ReviewV2PublicationPayloadKind.PendingReviewSubmit:
          return this.submitReview(payload, input.operation, input.capability);
        case ReviewV2PublicationPayloadKind.ThreadLifecycle:
          return this.mutateLifecycle(payload, input.operation);
      }
    } catch (error) {
      if (error instanceof ReviewV2ScmMutationError) throw error;
      throw githubMutationError(error);
    }
  }

  async markStaleOrDelete(input: {
    readonly operation: ReviewPublicationOperation;
    readonly canonicalExternalObjectId: string;
    readonly duplicateExternalObjectIds: readonly string[];
    readonly compensateCanonical: boolean;
  }): Promise<ReviewPublicationReceiptStatus> {
    const payload = await this.requirePayload(input.operation);
    const staleObjectIds = [
      ...new Set([
        ...(input.compensateCanonical ? [input.canonicalExternalObjectId] : []),
        ...input.duplicateExternalObjectIds,
      ]),
    ];
    switch (payload.kind) {
      case ReviewV2PublicationPayloadKind.Summary:
        await Promise.all(
          staleObjectIds.map((id) =>
            this.request(
              "DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}",
              {
                comment_id: externalNumericId(id, "issue-comment"),
              },
            ),
          ),
        );
        return input.compensateCanonical
          ? ReviewPublicationReceiptStatus.Compensated
          : ReviewPublicationReceiptStatus.Succeeded;
      case ReviewV2PublicationPayloadKind.ManagedCheck:
        await Promise.all(
          staleObjectIds.map((id) =>
            this.request(
              "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
              {
                check_run_id: externalNumericId(id, "check-run"),
                status: "completed",
                conclusion: "neutral",
                output: {
                  title: "Superseded ReviewRouter result",
                  summary: "This duplicate result is not canonical.",
                },
              },
            ),
          ),
        );
        return input.compensateCanonical
          ? ReviewPublicationReceiptStatus.Compensated
          : ReviewPublicationReceiptStatus.Succeeded;
      case ReviewV2PublicationPayloadKind.ThreadLifecycle: {
        if (!input.compensateCanonical) {
          return ReviewPublicationReceiptStatus.Succeeded;
        }
        await this.loadProvenLifecycleThread(payload.threadId);
        const mutation = payload.resolve
          ? "mutation ReviewRouterUndoResolveThread($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }"
          : "mutation ReviewRouterUndoUnresolveThread($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }";
        await this.options.octokit.graphql(mutation, { id: payload.threadId });
        return ReviewPublicationReceiptStatus.Compensated;
      }
      case ReviewV2PublicationPayloadKind.PendingReviewCreate:
      case ReviewV2PublicationPayloadKind.PendingReviewSubmit:
      case ReviewV2PublicationPayloadKind.SubmittedReview:
        return ReviewPublicationReceiptStatus.StaleVisible;
    }
  }

  private async requirePayload(
    operation: ReviewPublicationOperation,
  ): Promise<ReviewV2PublicationPayload> {
    const payload = await this.options.payloads.resolve({
      permit: this.options.permit,
      operation,
    });
    if (!payload) throw new Error("review_v2_publication_payload_unavailable");
    return payload;
  }

  private async findIssueComments(
    payload: Extract<
      ReviewV2PublicationPayload,
      { readonly kind: ReviewV2PublicationPayloadKind.Summary }
    >,
    cursor: string | null,
  ) {
    const page = parsePage(cursor);
    const response = await this.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        issue_number: this.options.permit.pullRequestNumber,
        per_page: 100,
        page,
      },
    );
    const rows = requireArray(response.data, "github_issue_comments_invalid");
    const objects = rows.flatMap((row) => {
      if (!isOwnedBody(row, payload.marker, this.options.botLogin)) return [];
      const id = numericId(row);
      const body = requiredString(row.body, "github_comment_body_invalid");
      return [gatewayObject(`issue-comment:${id}`, payload, sha256(body))];
    });
    return pageResult(objects, page, rows.length);
  }

  private async findCheckRuns(
    payload: Extract<
      ReviewV2PublicationPayload,
      { readonly kind: ReviewV2PublicationPayloadKind.ManagedCheck }
    >,
    operation: ReviewPublicationOperation,
    cursor: string | null,
  ) {
    const page = parsePage(cursor);
    const response = await this.request(
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      { ref: operation.targetCommitId, per_page: 100, page },
    );
    const data = requireRecord(response.data, "github_check_runs_invalid");
    const rows = requireArray(data.check_runs, "github_check_runs_invalid");
    const objects = rows.flatMap((row) => {
      const app = isRecord(row.app) ? row.app : null;
      const output = isRecord(row.output) ? row.output : null;
      if (
        app?.slug !== this.options.botLogin.replace(/\[bot\]$/u, "") ||
        typeof output?.summary !== "string" ||
        !output.summary.includes(payload.marker)
      ) {
        return [];
      }
      const bodyHash = sha256(
        canonicalJson({
          name: row.name,
          title: output.title,
          summary: output.summary,
          conclusion: row.conclusion,
        }),
      );
      return [gatewayObject(`check-run:${numericId(row)}`, payload, bodyHash)];
    });
    return pageResult(objects, page, rows.length);
  }

  private async findReviews(
    payload: Extract<
      ReviewV2PublicationPayload,
      {
        readonly kind:
          | ReviewV2PublicationPayloadKind.PendingReviewCreate
          | ReviewV2PublicationPayloadKind.SubmittedReview;
      }
    >,
    cursor: string | null,
  ) {
    const page = parsePage(cursor);
    const response = await this.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      {
        pull_number: this.options.permit.pullRequestNumber,
        per_page: 100,
        page,
      },
    );
    const rows = requireArray(response.data, "github_reviews_invalid");
    const candidates = rows.filter(
      (row) =>
        isReviewStateCompatible(payload.kind, row.state) &&
        isOwnedBody(row, payload.marker, this.options.botLogin),
    );
    const objects = await Promise.all(
      candidates.map((row) => this.reviewObject(row, payload)),
    );
    return pageResult(objects, page, rows.length);
  }

  private async findSubmittedReview(
    payload: Extract<
      ReviewV2PublicationPayload,
      { readonly kind: ReviewV2PublicationPayloadKind.PendingReviewSubmit }
    >,
    operation: ReviewPublicationOperation,
  ) {
    const target = operation.dependsOnOperationId;
    if (!target) throw new Error("github_review_submit_dependency_missing");
    const targetExternalObjectId =
      this.options.capability.targetExternalObjectId;
    const reviewId = targetExternalObjectId
      ? externalNumericId(targetExternalObjectId, "review")
      : null;
    if (reviewId === null) return { objects: [], nextCursor: null };
    const response = await this.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}",
      {
        pull_number: this.options.permit.pullRequestNumber,
        review_id: reviewId,
      },
    );
    const row = requireRecord(response.data, "github_review_invalid");
    if (
      row.state === "PENDING" ||
      !isOwnedBody(row, payload.marker, this.options.botLogin)
    ) {
      return { objects: [], nextCursor: null };
    }
    const comments = await this.loadReviewComments(reviewId);
    return {
      objects: [
        gatewayObject(
          `review:${reviewId}`,
          payload,
          sha256(canonicalJson({ body: row.body, event: "COMMENT" })),
          reviewObservedObjectHash(row, comments),
        ),
      ],
      nextCursor: null,
    };
  }

  private async findLifecycle(
    payload: Extract<
      ReviewV2PublicationPayload,
      { readonly kind: ReviewV2PublicationPayloadKind.ThreadLifecycle }
    >,
  ) {
    const node = await this.loadProvenLifecycleThread(payload.threadId);
    return node.isResolved === payload.resolve
      ? {
          objects: [
            gatewayObject(
              `thread:${payload.threadId}`,
              payload,
              sha256(
                canonicalJson({
                  threadId: payload.threadId,
                  resolve: payload.resolve,
                }),
              ),
              sha256(canonicalJson(node)),
            ),
          ],
          nextCursor: null,
        }
      : { objects: [], nextCursor: null };
  }

  private async createIssueComment(
    payload: Extract<
      ReviewV2PublicationPayload,
      { readonly kind: ReviewV2PublicationPayloadKind.Summary }
    >,
    operation: ReviewPublicationOperation,
  ) {
    const response = await this.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        issue_number: this.options.permit.pullRequestNumber,
        body: payload.body,
      },
    );
    return gatewayObject(
      `issue-comment:${numericId(requireRecord(response.data, "github_comment_invalid"))}`,
      payload,
      operation.bodyHash,
    );
  }

  private async createCheckRun(
    payload: Extract<
      ReviewV2PublicationPayload,
      { readonly kind: ReviewV2PublicationPayloadKind.ManagedCheck }
    >,
    operation: ReviewPublicationOperation,
  ) {
    const response = await this.request(
      "POST /repos/{owner}/{repo}/check-runs",
      {
        name: payload.name,
        head_sha: operation.targetCommitId,
        status: "completed",
        conclusion: payload.conclusion,
        output: { title: payload.title, summary: payload.summary },
      },
    );
    return gatewayObject(
      `check-run:${numericId(requireRecord(response.data, "github_check_run_invalid"))}`,
      payload,
      operation.bodyHash,
    );
  }

  private async createReview(
    payload: Extract<
      ReviewV2PublicationPayload,
      {
        readonly kind:
          | ReviewV2PublicationPayloadKind.PendingReviewCreate
          | ReviewV2PublicationPayloadKind.SubmittedReview;
      }
    >,
    operation: ReviewPublicationOperation,
  ) {
    const response = await this.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      {
        pull_number: this.options.permit.pullRequestNumber,
        commit_id: operation.targetCommitId,
        body: payload.body,
        comments: payload.comments.map((comment) => ({
          path: comment.path,
          line: comment.line,
          ...(comment.startLine === null
            ? {}
            : { start_line: comment.startLine }),
          side: "RIGHT",
          body: comment.body,
        })),
        ...(payload.kind === ReviewV2PublicationPayloadKind.SubmittedReview
          ? { event: "COMMENT" }
          : {}),
      },
    );
    return this.reviewObject(
      requireRecord(response.data, "github_review_invalid"),
      payload,
    );
  }

  private async submitReview(
    payload: Extract<
      ReviewV2PublicationPayload,
      { readonly kind: ReviewV2PublicationPayloadKind.PendingReviewSubmit }
    >,
    operation: ReviewPublicationOperation,
    capability: ReviewPublicationOperationCapabilityFacts,
  ) {
    if (!capability.targetExternalObjectId) {
      throw new ReviewV2ScmMutationError(
        "github_review_submit_target_missing",
        ReviewV2ScmMutationFailureOutcome.DefinitelyNoEffect,
        false,
      );
    }
    const reviewId = externalNumericId(
      capability.targetExternalObjectId,
      "review",
    );
    await this.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/events",
      {
        pull_number: this.options.permit.pullRequestNumber,
        review_id: reviewId,
        event: "COMMENT",
        body: payload.body,
      },
    );
    return gatewayObject(`review:${reviewId}`, payload, operation.bodyHash);
  }

  private async mutateLifecycle(
    payload: Extract<
      ReviewV2PublicationPayload,
      { readonly kind: ReviewV2PublicationPayloadKind.ThreadLifecycle }
    >,
    operation: ReviewPublicationOperation,
  ) {
    await this.loadProvenLifecycleThread(payload.threadId);
    const mutation = payload.resolve
      ? "mutation ReviewRouterResolveThread($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }"
      : "mutation ReviewRouterUnresolveThread($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }";
    await this.options.octokit.graphql(mutation, { id: payload.threadId });
    return gatewayObject(
      `thread:${payload.threadId}`,
      payload,
      operation.bodyHash,
    );
  }

  private async reviewObject(
    row: Readonly<Record<string, unknown>>,
    payload: Extract<
      ReviewV2PublicationPayload,
      {
        readonly kind:
          | ReviewV2PublicationPayloadKind.PendingReviewCreate
          | ReviewV2PublicationPayloadKind.SubmittedReview;
      }
    >,
  ): Promise<ReviewPublicationGatewayObject> {
    if (!isReviewStateCompatible(payload.kind, row.state)) {
      throw new Error("github_review_state_mismatch");
    }
    const reviewId = numericId(row);
    const comments = await this.loadReviewComments(
      reviewId,
      payload.kind === ReviewV2PublicationPayloadKind.PendingReviewCreate
        ? payload.comments
        : undefined,
    );
    const commitId = requiredString(
      row.commit_id,
      "github_review_commit_id_invalid",
    ).toLowerCase();
    const bodyHash = sha256(
      canonicalJson({ body: row.body, commitId, comments }),
    );
    return gatewayObject(
      `review:${reviewId}`,
      payload,
      bodyHash,
      reviewObservedObjectHash(row, comments),
    );
  }

  private async loadReviewComments(
    reviewId: number,
    expectedComments?: readonly ExpectedReviewComment[],
  ) {
    const comments: Array<{
      readonly path: unknown;
      readonly line: unknown;
      readonly startLine: unknown;
      readonly body: unknown;
    }> = [];
    for (let page = 1; page <= 100; page += 1) {
      const response = await this.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments",
        {
          pull_number: this.options.permit.pullRequestNumber,
          review_id: reviewId,
          per_page: 100,
          page,
        },
      );
      const rows = requireArray(
        response.data,
        "github_review_comments_invalid",
      );
      comments.push(
        ...rows.map((comment) => ({
          path: comment.path,
          line: comment.line ?? comment.original_line,
          startLine: comment.start_line ?? comment.original_start_line ?? null,
          body: comment.body,
        })),
      );
      if (rows.length < 100) {
        return expectedComments
          ? normalizePendingReviewComments(comments, expectedComments)
          : comments;
      }
    }
    throw new Error("github_review_comments_pagination_limit_exceeded");
  }

  private async loadProvenLifecycleThread(threadId: string) {
    const response = await this.options.octokit.graphql<{
      readonly node?: {
        readonly id?: string;
        readonly isResolved?: boolean;
        readonly pullRequest?: {
          readonly number?: number;
          readonly repository?: { readonly nameWithOwner?: string } | null;
        } | null;
      } | null;
    }>(
      "query ReviewRouterPublicationThread($id: ID!) { node(id: $id) { ... on PullRequestReviewThread { id isResolved pullRequest { number repository { nameWithOwner } } } } }",
      { id: threadId },
    );
    const node = response.node;
    const expectedRepository =
      `${this.options.repository.owner}/${this.options.repository.repo}`.toLowerCase();
    if (
      node?.id !== threadId ||
      typeof node.isResolved !== "boolean" ||
      node.pullRequest?.number !== this.options.permit.pullRequestNumber ||
      node.pullRequest.repository?.nameWithOwner?.toLowerCase() !==
        expectedRepository
    ) {
      throw new ReviewV2ScmMutationError(
        "github_review_thread_provenance_mismatch",
        ReviewV2ScmMutationFailureOutcome.DefinitelyNoEffect,
        false,
      );
    }
    return {
      id: node.id,
      isResolved: node.isResolved,
      pullRequestNumber: node.pullRequest.number,
      repository: expectedRepository,
    };
  }

  private request(
    route: string,
    parameters: Readonly<Record<string, unknown>>,
  ) {
    return this.options.octokit.request(route, {
      owner: this.options.repository.owner,
      repo: this.options.repository.repo,
      ...parameters,
    });
  }
}

type ExpectedReviewComment = Extract<
  ReviewV2PublicationPayload,
  {
    readonly kind:
      | ReviewV2PublicationPayloadKind.PendingReviewCreate
      | ReviewV2PublicationPayloadKind.SubmittedReview;
  }
>["comments"][number];

type ObservedReviewComment = {
  readonly path: unknown;
  readonly line: unknown;
  readonly startLine: unknown;
  readonly body: unknown;
};

/**
 * GitHub omits line coordinates while a review is pending and exposes only a
 * diff position. Bind those unavailable coordinates back to the exact payload
 * only after path and marker-bearing body prove a one-to-one match.
 */
function normalizePendingReviewComments(
  observed: readonly ObservedReviewComment[],
  expected: readonly ExpectedReviewComment[],
) {
  if (observed.length !== expected.length) {
    throw new Error("github_review_comment_count_mismatch");
  }
  const candidateIndexes = expected.map((expectedComment) =>
    observed.flatMap((candidate, index) =>
      candidate.path === expectedComment.path &&
      candidate.body === expectedComment.body &&
      coordinateMatches(candidate.line, expectedComment.line) &&
      coordinateMatches(candidate.startLine, expectedComment.startLine)
        ? [index]
        : [],
    ),
  );
  const expectedByObserved = Array<number>(observed.length).fill(-1);
  const matchExpected = (
    expectedIndex: number,
    visitedObserved: Set<number>,
  ): boolean => {
    for (const observedIndex of candidateIndexes[expectedIndex] ?? []) {
      if (visitedObserved.has(observedIndex)) continue;
      visitedObserved.add(observedIndex);
      const previousExpected = expectedByObserved[observedIndex] ?? -1;
      if (
        previousExpected === -1 ||
        matchExpected(previousExpected, visitedObserved)
      ) {
        expectedByObserved[observedIndex] = expectedIndex;
        return true;
      }
    }
    return false;
  };
  for (const expectedIndex of expected.keys()) {
    if (!matchExpected(expectedIndex, new Set())) {
      throw new Error("github_review_comment_identity_mismatch");
    }
  }
  return expected.map((expectedComment) => ({
    path: expectedComment.path,
    line: expectedComment.line,
    startLine: expectedComment.startLine,
    body: expectedComment.body,
  }));
}

function coordinateMatches(observed: unknown, expected: number | null) {
  return observed === null || observed === undefined || observed === expected;
}

function isReviewStateCompatible(
  kind:
    | ReviewV2PublicationPayloadKind.PendingReviewCreate
    | ReviewV2PublicationPayloadKind.SubmittedReview,
  state: unknown,
) {
  return kind === ReviewV2PublicationPayloadKind.PendingReviewCreate
    ? state === "PENDING"
    : typeof state === "string" && state !== "PENDING";
}

function gatewayObject(
  externalObjectId: string,
  payload: ReviewV2PublicationPayload,
  bodyHash: string,
  observedObjectHash = sha256(
    canonicalJson({
      externalObjectId,
      markerHash: payload.markerHash,
      bodyHash,
    }),
  ),
): ReviewPublicationGatewayObject {
  return {
    externalObjectId,
    effectKind: ReviewPublicationExternalEffectKind.MutationAcknowledged,
    markerHash: payload.markerHash,
    bodyHash,
    observedObjectHash,
    observedAt: new Date(),
  };
}

function reviewObservedObjectHash(
  row: Readonly<Record<string, unknown>>,
  comments: readonly unknown[],
): string {
  const user = isRecord(row.user) ? row.user : null;
  const app = isRecord(row.app) ? row.app : null;
  return sha256(
    canonicalJson({
      commitId: row.commit_id,
      author: user?.login ?? null,
      app: app?.slug ?? null,
      state: row.state,
      body: row.body,
      comments,
    }),
  );
}

function githubMutationError(error: unknown): ReviewV2ScmMutationError {
  const status =
    isRecord(error) && typeof error.status === "number" ? error.status : null;
  const definitelyNoEffect =
    status !== null &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 409 &&
    status !== 429;
  return new ReviewV2ScmMutationError(
    status === null
      ? "github_mutation_transport_failure"
      : `github_mutation_http_${status}`,
    definitelyNoEffect
      ? ReviewV2ScmMutationFailureOutcome.DefinitelyNoEffect
      : ReviewV2ScmMutationFailureOutcome.EffectMayExist,
    !definitelyNoEffect,
  );
}

function pageResult(
  objects: readonly ReviewPublicationGatewayObject[],
  page: number,
  rowCount: number,
) {
  return { objects, nextCursor: rowCount === 100 ? String(page + 1) : null };
}

function parsePage(cursor: string | null): number {
  if (cursor === null) return 1;
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value <= 1) {
    throw new Error("github_publication_cursor_invalid");
  }
  return value;
}

function isOwnedBody(
  row: Readonly<Record<string, unknown>>,
  marker: string,
  botLogin: string,
): boolean {
  const user = isRecord(row.user) ? row.user : null;
  return (
    typeof user?.login === "string" &&
    user.login.toLowerCase() === botLogin &&
    typeof row.body === "string" &&
    row.body.includes(marker)
  );
}

function externalNumericId(value: string, prefix: string): number {
  const match = new RegExp(`^${prefix}:([1-9][0-9]*)$`, "u").exec(value);
  if (!match?.[1]) throw new Error("github_external_object_id_invalid");
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id))
    throw new Error("github_external_object_id_invalid");
  return id;
}

function numericId(row: Readonly<Record<string, unknown>>): number {
  if (
    typeof row.id !== "number" ||
    !Number.isSafeInteger(row.id) ||
    row.id <= 0
  ) {
    throw new Error("github_external_object_id_invalid");
  }
  return row.id;
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  return value;
}

function requiredCommitId(value: unknown, code: string): string {
  const commitId = requiredString(value, code).toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commitId)) {
    throw new Error(code);
  }
  return commitId;
}

function requireArray(
  value: unknown,
  code: string,
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error(code);
  return value;
}

function requireRecord(
  value: unknown,
  code: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(code);
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
