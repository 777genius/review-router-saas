import type { Prisma } from "@prisma/client";
import {
  ReviewConfigurationWriteConflictError,
  safeDefaultReviewConfiguration,
} from "@reviewrouter/features-review-config";
import { describe, expect, it } from "vitest";
import { PrismaReviewConfigurationOperatorMutation } from "./prisma-review-configuration-operator-mutation.js";

type ProviderRow = {
  gatewayBindingId: string | null;
  gatewayProfileRef: string | null;
  providerKind: string;
  providerAuthMode: string;
  model: string;
  reasoningEffort: string;
  agenticContext: boolean;
  fastMode: boolean;
  requiredHealthy: boolean;
};

type VersionRow = {
  id: string;
  workspaceId: string;
  gatewayBindingId: string | null;
  gatewayProfileRef: string | null;
  version: number;
  schemaVersion: number;
  providerKind: string;
  providerAuthMode: string;
  model: string;
  reasoningEffort: string;
  agenticContext: boolean;
  fastMode: boolean;
  failOnSeverity: string;
  inlineMaxComments: number;
  providerLimit: number;
  providerMaxParallel: number;
  inlineMinAgreement: number;
  targetTokensPerBatch: number;
  reviewLanguage: string | null;
  investigationRecordingEnabled: boolean;
  investigationShadowEnabled: boolean;
  investigationContextCriticEnabled: boolean;
  investigationVerifiedCleanEnabled: boolean;
  investigationCrossRevisionReplayEnabled: boolean;
  investigationProductionEffectsEnabled: boolean;
  providers: ProviderRow[];
};

type ConfigurationRow = {
  id: string;
  workspaceId: string;
  repositoryId: string | null;
  targetKey: string;
  active: boolean;
  versions: VersionRow[];
};

type State = {
  configurations: Map<string, ConfigurationRow>;
  audits: unknown[];
  failAudit: boolean;
  nextId: number;
};

function configurationKey(workspaceId: string, targetKey: string): string {
  return JSON.stringify([workspaceId, targetKey]);
}

const repositoryKey = configurationKey("workspace_1", "repo:repo_1");

function createPrismaStub() {
  let committed = createInitialState();
  let transactionFailures: unknown[] = [];
  let transactionCalls = 0;
  const transactionOptions: { isolationLevel: string }[] = [];
  const events: string[] = [];

  const prisma = {
    async $transaction<T>(
      callback: (transaction: unknown) => Promise<T>,
      options: { isolationLevel: string },
    ) {
      transactionCalls += 1;
      transactionOptions.push(options);
      const failure = transactionFailures.shift();
      if (failure) throw failure;
      const transactionState = cloneState(committed);
      const result = await callback(
        createTransactionClient(transactionState, events),
      );
      committed = transactionState;
      return result;
    },
  };

  return {
    prisma,
    events,
    transactionOptions,
    state: () => committed,
    failNextAudit() {
      committed.failAudit = true;
    },
    replaceWorkspaceRevision(id: string) {
      const workspace = committed.configurations.get(
        configurationKey("workspace_1", "workspace:default"),
      )!;
      workspace.versions[0] = { ...workspace.versions[0]!, id };
    },
    clearRepositoryOverride() {
      committed.configurations.get(repositoryKey)!.active = false;
    },
    queueTransactionFailure(error: unknown) {
      transactionFailures = [...transactionFailures, error];
    },
    transactionCalls: () => transactionCalls,
  };
}

function createInitialState(): State {
  return {
    configurations: new Map([
      [
        configurationKey("workspace_1", "workspace:default"),
        {
          id: "config_workspace",
          workspaceId: "workspace_1",
          repositoryId: null,
          targetKey: "workspace:default",
          active: true,
          versions: [versionRow("workspace_v1", 1, "xhigh")],
        },
      ],
    ]),
    audits: [],
    failAudit: false,
    nextId: 1,
  };
}

function cloneState(state: State): State {
  return {
    configurations: new Map(
      [...state.configurations].map(([key, configuration]) => [
        key,
        {
          ...configuration,
          versions: configuration.versions.map((version) => ({
            ...version,
            providers: version.providers.map((provider) => ({ ...provider })),
          })),
        },
      ]),
    ),
    audits: [...state.audits],
    failAudit: state.failAudit,
    nextId: state.nextId,
  };
}

function createTransactionClient(state: State, events: string[]) {
  return {
    async $queryRaw(sql: Prisma.Sql) {
      events.push(sql.text.includes("lock_shared(") ? "shared" : "exclusive");
      return [];
    },
    reviewConfiguration: {
      async findUnique(input: {
        where: {
          workspaceId_targetKey: { workspaceId: string; targetKey: string };
        };
      }) {
        events.push("read");
        const { workspaceId, targetKey } = input.where.workspaceId_targetKey;
        const record = state.configurations.get(
          configurationKey(workspaceId, targetKey),
        );
        return record
          ? {
              active: record.active,
              versions: [...record.versions]
                .sort((left, right) => right.version - left.version)
                .slice(0, 1),
            }
          : null;
      },
      async upsert(input: {
        where: {
          workspaceId_targetKey: { workspaceId: string; targetKey: string };
        };
        update: { repositoryId: string | null };
        create: {
          workspaceId: string;
          repositoryId: string | null;
          targetKey: string;
        };
      }) {
        events.push("write");
        const { workspaceId, targetKey } = input.where.workspaceId_targetKey;
        const key = configurationKey(workspaceId, targetKey);
        let record = state.configurations.get(key);
        if (!record) {
          if (
            input.create.workspaceId !== workspaceId ||
            input.create.targetKey !== targetKey
          )
            throw new Error("fixture_configuration_scope_mismatch");
          record = {
            id: `config_${state.nextId++}`,
            ...input.create,
            // Prisma's persisted default for a newly created override.
            active: true,
            versions: [],
          };
          state.configurations.set(key, record);
        } else Object.assign(record, input.update);
        return {
          id: record.id,
          workspaceId: record.workspaceId,
          active: record.active,
        };
      },
      async update(input: {
        where: { id: string };
        data: { active: boolean };
      }) {
        const record = [...state.configurations.values()].find(
          (configuration) => configuration.id === input.where.id,
        );
        if (!record) throw new Error("fixture_configuration_not_found");
        record.active = input.data.active;
        events.push("reactivate");
        return { ...record };
      },
      async deleteMany() {
        return { count: 0 };
      },
    },
    reviewConfigurationVersion: {
      async findFirst(input: { where: { configurationId: string } }) {
        const record = [...state.configurations.values()].find(
          (configuration) => configuration.id === input.where.configurationId,
        );
        const latest = [...(record?.versions ?? [])].sort(
          (left, right) => right.version - left.version,
        )[0];
        return latest ? { version: latest.version } : null;
      },
      async create(input: {
        data: Omit<VersionRow, "id" | "providers"> & {
          configurationId: string;
          providers: { create: ProviderRow[] };
        };
      }) {
        const record = [...state.configurations.values()].find(
          (configuration) => configuration.id === input.data.configurationId,
        )!;
        if (record.workspaceId !== input.data.workspaceId)
          throw new Error("fixture_version_workspace_mismatch");
        const created = {
          ...input.data,
          id: `version_${state.nextId++}`,
          providers: input.data.providers.create,
        };
        record.versions.push(created);
        return created;
      },
    },
    auditEvent: {
      async create(input: unknown) {
        if (state.failAudit) {
          throw new Error("audit_store_failed");
        }
        state.audits.push(input);
        return {};
      },
    },
  };
}

function versionRow(
  id: string,
  version: number,
  effort: "high" | "xhigh",
): VersionRow {
  const provider = safeDefaultReviewConfiguration.provider;
  return {
    id,
    workspaceId: "workspace_1",
    gatewayBindingId: null,
    gatewayProfileRef: null,
    version,
    schemaVersion: 2,
    providerKind: provider.kind,
    providerAuthMode: provider.authMode,
    model: provider.model,
    reasoningEffort: effort,
    agenticContext: provider.agenticContext,
    fastMode: provider.fastMode,
    failOnSeverity:
      safeDefaultReviewConfiguration.blockingPolicy.failOnSeverity,
    inlineMaxComments: safeDefaultReviewConfiguration.limits.inlineMaxComments,
    providerLimit: 1,
    providerMaxParallel: 1,
    inlineMinAgreement: 1,
    targetTokensPerBatch:
      safeDefaultReviewConfiguration.limits.targetTokensPerBatch,
    reviewLanguage: null,
    investigationRecordingEnabled: false,
    investigationShadowEnabled: false,
    investigationContextCriticEnabled: false,
    investigationVerifiedCleanEnabled: false,
    investigationCrossRevisionReplayEnabled: false,
    investigationProductionEffectsEnabled: false,
    providers: [
      {
        gatewayBindingId: null,
        gatewayProfileRef: null,
        providerKind: provider.kind,
        providerAuthMode: provider.authMode,
        model: provider.model,
        reasoningEffort: effort,
        agenticContext: provider.agenticContext,
        fastMode: provider.fastMode,
        requiredHealthy: true,
      },
    ],
  };
}

function mutationInput() {
  const provider = {
    ...safeDefaultReviewConfiguration.provider,
    reasoningEffort: "high" as const,
  };
  return {
    target: {
      scope: "repository" as const,
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
    },
    expectedRevisionToken: "db:workspace_v1",
    config: {
      ...safeDefaultReviewConfiguration,
      provider,
      providers: [provider],
      investigationRollout: {
        recordingEnabled: true,
        shadowEnabled: true,
        contextCriticEnabled: false,
        verifiedCleanEnabled: false,
        crossRevisionReplayEnabled: false,
        productionEffectsEnabled: false,
      },
    },
    auditEvent: {
      workspaceId: "workspace_1",
      actor: "operator:test",
      action: "review_config.operator_investigation_rollout_set",
      targetType: "repository",
      targetId: "repo_1",
      metadata: {
        repository: "777genius/example",
        reason: "test",
      },
    },
  };
}

describe("Prisma review configuration operator mutation", () => {
  it("commits the config version and audit event together", async () => {
    const stub = createPrismaStub();
    const mutation = new PrismaReviewConfigurationOperatorMutation(
      stub.prisma as never,
    );

    const result = await mutation.commit(mutationInput());

    expect(result).toMatchObject({
      version: 1,
      config: { provider: { reasoningEffort: "high" } },
    });
    expect(
      stub.state().configurations.get(repositoryKey)?.versions,
    ).toHaveLength(1);
    expect(
      stub.state().configurations.get(repositoryKey)?.versions[0],
    ).toMatchObject({
      investigationRecordingEnabled: true,
      investigationShadowEnabled: true,
      investigationContextCriticEnabled: false,
      investigationVerifiedCleanEnabled: false,
      investigationCrossRevisionReplayEnabled: false,
      investigationProductionEffectsEnabled: false,
    });
    expect(stub.state().audits).toHaveLength(1);
    expect(stub.events.slice(0, 4)).toEqual([
      "shared",
      "shared",
      "exclusive",
      "read",
    ]);
    expect(stub.events.filter((event) => event === "exclusive")).toHaveLength(
      1,
    );
    expect(stub.transactionOptions).toEqual([
      { isolationLevel: "Serializable" },
    ]);
    const override = stub.state().configurations.get(repositoryKey)!;
    expect(override).toMatchObject({
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
      active: true,
    });
    expect(result.revisionToken).toBe(`db:${override.versions[0]!.id}`);
    await expect(mutation.commit(mutationInput())).rejects.toBeInstanceOf(
      ReviewConfigurationWriteConflictError,
    );
    expect(
      stub.state().configurations.get(repositoryKey)?.versions,
    ).toHaveLength(1);
    expect(stub.state().audits).toHaveLength(1);

    // Clearing retains history; a CAS-valid inherited write reactivates it.
    stub.clearRepositoryOverride();
    const reactivated = await mutation.commit(mutationInput());
    expect(reactivated.version).toBe(2);
    expect(stub.state().configurations.get(repositoryKey)).toMatchObject({
      active: true,
      versions: [override.versions[0], expect.objectContaining({ version: 2 })],
    });
    expect(stub.events.filter((event) => event === "reactivate")).toHaveLength(
      1,
    );
    expect(stub.state().audits).toHaveLength(2);
  });

  it("rejects a stale inherited revision without creating an override", async () => {
    const stub = createPrismaStub();
    stub.replaceWorkspaceRevision("workspace_v2");
    const mutation = new PrismaReviewConfigurationOperatorMutation(
      stub.prisma as never,
    );

    await expect(mutation.commit(mutationInput())).rejects.toBeInstanceOf(
      ReviewConfigurationWriteConflictError,
    );
    expect(stub.state().configurations.has(repositoryKey)).toBe(false);
    expect(stub.state().audits).toEqual([]);
    const foreignWorkspace = mutationInput();
    foreignWorkspace.target.workspaceId = "workspace_2";
    foreignWorkspace.auditEvent.workspaceId = "workspace_2";
    foreignWorkspace.expectedRevisionToken = "db:workspace_v2";
    await expect(mutation.commit(foreignWorkspace)).rejects.toBeInstanceOf(
      ReviewConfigurationWriteConflictError,
    );
    expect(
      stub
        .state()
        .configurations.has(configurationKey("workspace_2", "repo:repo_1")),
    ).toBe(false);
    expect(stub.state().audits).toEqual([]);
  });

  it("rolls the config version back when audit persistence fails", async () => {
    const stub = createPrismaStub();
    stub.failNextAudit();
    const mutation = new PrismaReviewConfigurationOperatorMutation(
      stub.prisma as never,
    );

    await expect(mutation.commit(mutationInput())).rejects.toThrow(
      "audit_store_failed",
    );
    expect(stub.state().configurations.has(repositoryKey)).toBe(false);
    expect(stub.state().audits).toEqual([]);
    expect(stub.transactionOptions).toEqual([
      { isolationLevel: "Serializable" },
    ]);
  });

  it("retries a serialization conflict without duplicating state", async () => {
    const stub = createPrismaStub();
    stub.queueTransactionFailure({ code: "P2034" });
    const mutation = new PrismaReviewConfigurationOperatorMutation(
      stub.prisma as never,
    );

    await expect(mutation.commit(mutationInput())).resolves.toMatchObject({
      version: 1,
    });
    expect(stub.transactionCalls()).toBe(2);
    expect(stub.transactionOptions).toEqual([
      { isolationLevel: "Serializable" },
      { isolationLevel: "Serializable" },
    ]);
    expect(
      stub.state().configurations.get(repositoryKey)?.versions,
    ).toHaveLength(1);
    expect(stub.state().audits).toHaveLength(1);
  });
});
