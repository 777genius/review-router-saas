export type HostedPoolCanaryPhase =
  | "simultaneous_a"
  | "simultaneous_b"
  | "unauthorized"
  | "rate_limited"
  | "dropped_response";

export type CanaryRunEvidence = Readonly<{
  runId: number;
  sourceRunAttempt: 2;
  sourceHeadSha: string;
  sourceExecutionId: string;
  grantId: string;
  invocationId: string;
  workspaceId: string;
  githubRepositoryId: string;
  actionRef: string;
  activeAccountId: string;
  primaryAccountId: string;
  backupAccountId: string | null;
  failoverCount: number;
  grantStatus: string;
  grantRevokedAt: string | null;
  commentRefreshRevokedAt: string | null;
  repositoryBindingId: string;
  bindingRevision: string;
  issuedAt: string;
  completedAt: string | null;
  requestId: string;
  requestOrdinal: number;
  requestErrorCode: string | null;
  requestReceivedAt: string;
  requestStartedAt: string | null;
  successfulResponseStartedAt: string | null;
  providerInvocationKey: string;
  providerResponseIdHash: string | null;
  publicationAttemptId: string | null;
  appBotPublicationCount: number;
  nonAppBotPublicationCount: number;
  publicationObjects: readonly HostedPoolPublicationObjectEvidence[];
  faultPlanConsumptionCount: number;
  faultPlanConsumptions: readonly Readonly<{
    planIdHash: string;
    phase:
      | "synthetic_unauthorized"
      | "synthetic_rate_limited"
      | "drop_after_response_started";
    repositoryId: string;
    runAttempt: number;
    actionRef: string;
    bindingId: string;
    bindingRevision: string;
    requestOrdinal: number;
    attemptOrdinal: number;
    injectionPoint: "before_provider_fetch" | "after_response_started";
    consumedAt: string;
  }>[];
  requestStatuses: readonly string[];
  attempts: readonly Readonly<{
    attemptId: string;
    relayRequestId: string;
    grantId: string;
    ordinal: number;
    state: string;
    errorCode: string | null;
    accountId: string;
    credentialGeneration: string;
    dispatchStartedAt: string | null;
    responseStartedAt: string | null;
    providerResponseIdHash: string | null;
    completedAt: string | null;
    createdAt: string;
  }>[];
}>;

export type HostedPoolCanaryConfig = Readonly<{
  repositoryId: number;
  installationId: number;
  allowlistedRepositoryId: number;
  appSlug: string;
  actionSha: string;
  releasePullRequestNumber: number;
  releaseHeadSha: string;
  poolId: string;
  accountIds: readonly [string, string];
  faultPlans: Readonly<
    Record<"unauthorized" | "rate_limited" | "dropped_response", string>
  >;
  runs: Readonly<Record<HostedPoolCanaryPhase, number>>;
}>;

/** GitHub dispatch and observation boundary; it has no service-control authority. */
export type HostedPoolCanaryPort = Readonly<{
  preflight(config: HostedPoolCanaryConfig): Promise<Record<string, unknown>>;
  rerun(runId: number): Promise<void>;
  waitForCompletion(
    runId: number,
    expectedConclusion: "success" | "failure",
  ): Promise<void>;
  evidence(runId: number): Promise<CanaryRunEvidence>;
}>;

export type HostedPoolDeploymentEvidence = Readonly<{
  serviceId: string;
  serviceName: "reviewrouter-api" | "reviewrouter-web";
  deployId: string;
  commitSha: string;
  status: "live";
  observedAt: string;
}>;

/** Read-only Render evidence boundary; it has no deployment authority. */
export type HostedPoolDeploymentEvidencePort = Readonly<{
  readExactRevision(
    expectedCommitSha: string,
  ): Promise<readonly HostedPoolDeploymentEvidence[]>;
}>;

export type HostedPoolGitHubRequestPort = Readonly<{
  request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown>;
}>;

export type HostedPoolLifecycleEvidence = Readonly<{
  threadId: string;
  resolve: boolean;
  changed: boolean;
}>;

export type HostedPoolPublicationEvidence = Readonly<{
  lifecycleThreads?: readonly HostedPoolLifecycleEvidence[];
  appBotPublicationCount: number;
  nonAppBotPublicationCount: number;
  publicationObjects: readonly HostedPoolPublicationObjectEvidence[];
}>;

export type HostedPoolPublicationObjectEvidence = Readonly<{
  kind: "issue_comment" | "review_comment" | "review" | "check_run";
  externalObjectId: string;
  bodyHash: string;
  authorLogin: string;
  publishedAt: string;
  headSha?: string;
  state?: string;
  parentReviewId?: string;
  placementHash?: string;
  submitHash?: string;
}>;
