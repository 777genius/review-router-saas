import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  getOperatorReviewConfiguration,
  HashedReviewConfigurationOperatorAuthorization,
  ReviewConfigurationOperatorError,
  ReviewConfigurationOperatorErrorCode,
  ReviewConfigurationOperatorOperation,
  ReviewReasoningEffort,
  reviewConfigurationTargetKey,
  safeDefaultReviewConfiguration,
  setOperatorReviewReasoningEffort,
  type OperatorReviewConfigurationDependencies,
  type PersistedReviewConfiguration,
  type ReviewConfigurationOperatorAuditEvent,
  type ReviewConfigurationOperatorRepository,
  type ReviewConfigurationRepositoryPort,
  ReviewConfigurationWriteConflictError,
} from "../index";

const credential = "operator-credential-with-at-least-32-characters";
const repository = {
  id: "repo_1",
  workspaceId: "workspace_1",
  workspaceSlug: "workspace-one",
  provider: "github",
  fullName: "777genius/example",
} satisfies ReviewConfigurationOperatorRepository;

class InMemoryConfigurations implements ReviewConfigurationRepositoryPort {
  readonly versions = new Map<string, PersistedReviewConfiguration[]>();
  saveCount = 0;
  conflictNextSave = false;

  async findLatest(
    target: Parameters<ReviewConfigurationRepositoryPort["findLatest"]>[0],
  ) {
    return (
      this.versions.get(reviewConfigurationTargetKey(target))?.at(-1) ?? null
    );
  }

  async saveNextVersion(
    input: Parameters<ReviewConfigurationRepositoryPort["saveNextVersion"]>[0],
  ) {
    if (this.conflictNextSave) {
      this.conflictNextSave = false;
      throw new ReviewConfigurationWriteConflictError();
    }
    const key = reviewConfigurationTargetKey(input.target);
    const records = this.versions.get(key) ?? [];
    const persisted = {
      version: (records.at(-1)?.version ?? 0) + 1,
      config: input.config,
    } satisfies PersistedReviewConfiguration;
    this.versions.set(key, [...records, persisted]);
    this.saveCount += 1;
    return persisted;
  }

  async deleteTarget(
    target: Parameters<ReviewConfigurationRepositoryPort["deleteTarget"]>[0],
  ) {
    return this.versions.delete(reviewConfigurationTargetKey(target));
  }
}

class CapturingAuditLog {
  readonly events: ReviewConfigurationOperatorAuditEvent[] = [];

  async record(event: ReviewConfigurationOperatorAuditEvent): Promise<void> {
    this.events.push(event);
  }
}

function createDependencies(
  candidates: readonly ReviewConfigurationOperatorRepository[] = [repository],
) {
  const configurations = new InMemoryConfigurations();
  const auditLog = new CapturingAuditLog();
  const dependencies = {
    authorization: new HashedReviewConfigurationOperatorAuthorization(
      "operator:test",
      createHash("sha256").update(credential).digest("hex"),
    ),
    repositories: {
      async findActiveCandidates() {
        return candidates;
      },
    },
    rateLimits: {
      async consume() {
        return true;
      },
    },
    configurations,
    audit: auditLog,
  } satisfies OperatorReviewConfigurationDependencies;
  return { dependencies, configurations, auditLog };
}

describe("operator review configuration", () => {
  it("rejects invalid credentials without repository lookup or audit output", async () => {
    const { dependencies, auditLog } = createDependencies();
    let repositoryLookups = 0;
    const guardedDependencies = {
      ...dependencies,
      repositories: {
        async findActiveCandidates() {
          repositoryLookups += 1;
          return [repository];
        },
      },
    };

    await expect(
      getOperatorReviewConfiguration(
        {
          credential: "wrong",
          repositoryFullName: repository.fullName,
          provider: "github",
        },
        guardedDependencies,
      ),
    ).rejects.toMatchObject({
      code: ReviewConfigurationOperatorErrorCode.Unauthorized,
    });
    expect(repositoryLookups).toBe(0);
    expect(auditLog.events).toEqual([]);
  });

  it("reports missing and ambiguous repositories explicitly", async () => {
    const missing = createDependencies([]);
    await expect(
      getOperatorReviewConfiguration(
        {
          credential,
          repositoryFullName: repository.fullName,
          provider: "github",
        },
        missing.dependencies,
      ),
    ).rejects.toEqual(
      new ReviewConfigurationOperatorError(
        ReviewConfigurationOperatorErrorCode.RepositoryNotFound,
      ),
    );

    const ambiguous = createDependencies([
      repository,
      { ...repository, id: "repo_2", workspaceId: "workspace_2" },
    ]);
    await expect(
      getOperatorReviewConfiguration(
        {
          credential,
          repositoryFullName: repository.fullName,
          provider: "github",
        },
        ambiguous.dependencies,
      ),
    ).rejects.toMatchObject({
      code: ReviewConfigurationOperatorErrorCode.RepositoryAmbiguous,
    });
  });

  it("creates a repository override even when the inherited effort is equal", async () => {
    const { dependencies, configurations, auditLog } = createDependencies();

    const result = await setOperatorReviewReasoningEffort(
      {
        credential,
        repositoryFullName: repository.fullName,
        provider: "github",
        effort: ReviewReasoningEffort.XHigh,
      },
      dependencies,
    );

    expect(result).toMatchObject({
      changed: true,
      previousSource: "default",
      source: "repository",
      reasoningEffort: ReviewReasoningEffort.XHigh,
    });
    expect(configurations.saveCount).toBe(1);
    expect(auditLog.events).toHaveLength(1);
    expect(auditLog.events[0]).toMatchObject({
      actor: "operator:test",
      action: "review_config.operator_reasoning_effort_set",
      metadata: {
        changed: true,
        previousSource: "default",
        effort: "xhigh",
      },
    });
    expect(JSON.stringify(auditLog.events)).not.toContain(credential);
  });

  it("updates only the runtime-selected Codex-backed provider and is idempotent", async () => {
    const { dependencies, configurations, auditLog } = createDependencies();
    const workspaceTarget = {
      scope: "workspace" as const,
      workspaceId: repository.workspaceId,
    };
    const secondProvider = {
      ...safeDefaultReviewConfiguration.provider,
      kind: "openrouter" as const,
      authMode: "openrouter_api_key" as const,
      model: "openai/gpt-5.5",
      requiredHealthy: false,
    };
    await configurations.saveNextVersion({
      target: workspaceTarget,
      config: {
        ...safeDefaultReviewConfiguration,
        providers: [safeDefaultReviewConfiguration.provider, secondProvider],
        execution: {
          providerLimit: 2,
          providerMaxParallel: 1,
          inlineMinAgreement: 1,
        },
      },
    });
    configurations.saveCount = 0;

    const first = await setOperatorReviewReasoningEffort(
      {
        credential,
        repositoryFullName: repository.fullName,
        provider: "github",
        effort: ReviewReasoningEffort.High,
      },
      dependencies,
    );
    const second = await setOperatorReviewReasoningEffort(
      {
        credential,
        repositoryFullName: repository.fullName,
        provider: "github",
        effort: ReviewReasoningEffort.High,
      },
      dependencies,
    );

    expect(first).toMatchObject({
      changed: true,
      previousSource: "workspace",
      providers: 2,
      reasoningEffort: ReviewReasoningEffort.High,
    });
    expect(second).toMatchObject({
      changed: false,
      previousSource: "repository",
      providers: 2,
    });
    expect(configurations.saveCount).toBe(1);
    const savedConfig = configurations.versions
      .get(
        reviewConfigurationTargetKey({
          scope: "repository",
          workspaceId: repository.workspaceId,
          repositoryId: repository.id,
        }),
      )
      ?.at(-1)?.config;
    expect(savedConfig?.providers[0]?.reasoningEffort).toBe("high");
    expect(savedConfig?.providers[1]?.reasoningEffort).toBe("xhigh");
    expect(auditLog.events).toHaveLength(2);
    expect(auditLog.events[1]?.metadata).toMatchObject({ changed: false });
  });

  it("returns the effective source and records a sanitized read audit", async () => {
    const { dependencies, auditLog } = createDependencies();

    const result = await getOperatorReviewConfiguration(
      {
        credential,
        repositoryFullName: repository.fullName,
        provider: "github",
      },
      dependencies,
    );

    expect(result).toMatchObject({
      repository: repository.fullName,
      workspaceSlug: repository.workspaceSlug,
      source: "default",
      version: 1,
      reasoningEffort: ReviewReasoningEffort.XHigh,
    });
    expect(auditLog.events[0]).toMatchObject({
      action: "review_config.operator_read",
      targetId: repository.id,
    });
    expect(JSON.stringify(auditLog.events)).not.toContain(credential);
  });

  it("fails before repository lookup when the operator rate limit is exhausted", async () => {
    const { dependencies } = createDependencies();
    let repositoryLookups = 0;

    await expect(
      getOperatorReviewConfiguration(
        {
          credential,
          repositoryFullName: repository.fullName,
          provider: "github",
        },
        {
          ...dependencies,
          rateLimits: {
            async consume() {
              return false;
            },
          },
          repositories: {
            async findActiveCandidates() {
              repositoryLookups += 1;
              return [repository];
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      code: ReviewConfigurationOperatorErrorCode.RateLimited,
    });
    expect(repositoryLookups).toBe(0);
  });

  it("maps an optimistic write conflict to a stable operator error", async () => {
    const { dependencies, configurations, auditLog } = createDependencies();
    configurations.conflictNextSave = true;

    await expect(
      setOperatorReviewReasoningEffort(
        {
          credential,
          repositoryFullName: repository.fullName,
          provider: "github",
          effort: ReviewReasoningEffort.High,
        },
        dependencies,
      ),
    ).rejects.toMatchObject({
      code: ReviewConfigurationOperatorErrorCode.ConfigurationChanged,
    });
    expect(auditLog.events).toEqual([]);
  });

  it("rejects effort updates when no Codex-backed provider exists", async () => {
    const { dependencies, configurations } = createDependencies();
    const claudeProvider = {
      ...safeDefaultReviewConfiguration.provider,
      kind: "claude" as const,
      authMode: "claude_code_oauth" as const,
      model: "sonnet",
    };
    await configurations.saveNextVersion({
      target: {
        scope: "workspace",
        workspaceId: repository.workspaceId,
      },
      config: {
        ...safeDefaultReviewConfiguration,
        provider: claudeProvider,
        providers: [claudeProvider],
      },
    });

    await expect(
      setOperatorReviewReasoningEffort(
        {
          credential,
          repositoryFullName: repository.fullName,
          provider: "github",
          effort: ReviewReasoningEffort.High,
        },
        dependencies,
      ),
    ).rejects.toMatchObject({
      code: ReviewConfigurationOperatorErrorCode.ReviewProviderNotFound,
    });
  });
});

describe("hashed operator authorization", () => {
  it("uses the configured digest and rejects malformed configuration", async () => {
    const authorization = new HashedReviewConfigurationOperatorAuthorization(
      "operator:test",
      createHash("sha256").update(credential).digest("hex"),
    );

    await expect(
      authorization.authenticate({
        credential,
        operation: ReviewConfigurationOperatorOperation.Read,
      }),
    ).resolves.toEqual({ operatorId: "operator:test" });
    await expect(
      authorization.authenticate({
        credential: `${credential}-wrong`,
        operation: ReviewConfigurationOperatorOperation.Read,
      }),
    ).resolves.toBeNull();
    expect(
      () =>
        new HashedReviewConfigurationOperatorAuthorization(
          "operator:test",
          "not-a-digest",
        ),
    ).toThrow("review_configuration_operator_credential_hash_invalid");
  });
});
