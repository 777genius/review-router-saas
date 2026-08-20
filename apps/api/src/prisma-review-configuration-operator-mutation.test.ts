import {
  ReviewConfigurationWriteConflictError,
  safeDefaultReviewConfiguration,
} from "@reviewrouter/features-review-config";
import { describe, expect, it } from "vitest";
import { PrismaReviewConfigurationOperatorMutation } from "./prisma-review-configuration-operator-mutation.js";

type ProviderRow = {
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
  targetKey: string;
  versions: VersionRow[];
};

type State = {
  configurations: Map<string, ConfigurationRow>;
  audits: unknown[];
  failAudit: boolean;
  nextId: number;
};

function createPrismaStub() {
  let committed = createInitialState();
  let transactionFailures: unknown[] = [];
  let transactionCalls = 0;

  const prisma = {
    async $transaction<T>(callback: (transaction: unknown) => Promise<T>) {
      transactionCalls += 1;
      const failure = transactionFailures.shift();
      if (failure) throw failure;
      const transactionState = cloneState(committed);
      const result = await callback(createTransactionClient(transactionState));
      committed = transactionState;
      return result;
    },
  };

  return {
    prisma,
    state: () => committed,
    failNextAudit() {
      committed.failAudit = true;
    },
    replaceWorkspaceRevision(id: string) {
      const workspace = committed.configurations.get("workspace:default")!;
      workspace.versions[0] = { ...workspace.versions[0]!, id };
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
        "workspace:default",
        {
          id: "config_workspace",
          targetKey: "workspace:default",
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

function createTransactionClient(state: State) {
  return {
    reviewConfiguration: {
      async findUnique(input: {
        where: {
          workspaceId_targetKey: { targetKey: string };
        };
      }) {
        const record = state.configurations.get(
          input.where.workspaceId_targetKey.targetKey,
        );
        return record
          ? { versions: record.versions.slice(-1).reverse() }
          : null;
      },
      async upsert(input: {
        where: {
          workspaceId_targetKey: { targetKey: string };
        };
      }) {
        const targetKey = input.where.workspaceId_targetKey.targetKey;
        let record = state.configurations.get(targetKey);
        if (!record) {
          record = {
            id: `config_${state.nextId++}`,
            targetKey,
            versions: [],
          };
          state.configurations.set(targetKey, record);
        }
        return { id: record.id };
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
        const latest = record?.versions.at(-1);
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
      stub.state().configurations.get("repo:repo_1")?.versions,
    ).toHaveLength(1);
    expect(
      stub.state().configurations.get("repo:repo_1")?.versions[0],
    ).toMatchObject({
      investigationRecordingEnabled: true,
      investigationShadowEnabled: true,
      investigationContextCriticEnabled: false,
      investigationVerifiedCleanEnabled: false,
      investigationCrossRevisionReplayEnabled: false,
      investigationProductionEffectsEnabled: false,
    });
    expect(stub.state().audits).toHaveLength(1);
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
    expect(stub.state().configurations.has("repo:repo_1")).toBe(false);
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
    expect(stub.state().configurations.has("repo:repo_1")).toBe(false);
    expect(stub.state().audits).toEqual([]);
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
    expect(
      stub.state().configurations.get("repo:repo_1")?.versions,
    ).toHaveLength(1);
    expect(stub.state().audits).toHaveLength(1);
  });
});
