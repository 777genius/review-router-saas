import {
  findReviewConfiguration,
  findReviewConfigurationOperation,
  isReviewConfigurationWriteConflictError,
  parseReviewConfigurationStrict,
  resolveReviewConfiguration,
  reviewProviderConfigurationSchema,
  saveReviewConfigurationWithOperation,
  type ReviewConfigurationOperationRepositoryPort,
  type ReviewConfigurationRepositoryPort,
  type ReviewConfiguration,
  type ReviewProviderConfiguration,
} from "@reviewrouter/features-review-config";
import {
  ProviderAccountError,
  resolveWorkspaceAccountBinding,
  type ProviderAccountDependencies,
  type WorkspaceAccountActor,
} from "@reviewrouter/features-provider-accounts";
import { z } from "zod";
import { EntitlementDeniedError } from "@reviewrouter/features-entitlements";
import { RateLimitExceededError } from "@reviewrouter/features-rate-limits";
import { reference as accountGatewayReference } from "@agent-teams/account-gateway/contracts";
import type { AccountProfileView } from "./account-gateway-accounts";
import { DashboardMutationRefusedError } from "./dashboard-mutation-errors";
import { isGatewayReviewModelSupported } from "./gateway-review-config-catalog";

export const gatewayBatchTargetLimit = 100;
export type GatewayBatchSelection = Extract<
  ReviewProviderConfiguration,
  { authMode: "codex_account_gateway" }
>;
export type GatewayBatchTarget = {
  readonly repositoryId: string;
  readonly expectedVersion: number | null;
};
export type GatewayBatchRequest = {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly targets: readonly GatewayBatchTarget[];
  readonly selection: GatewayBatchSelection;
};
export type GatewayBatchTargetResult =
  | {
      readonly repositoryId: string;
      readonly status: "applied";
      readonly version: number;
    }
  | {
      readonly repositoryId: string;
      readonly status: "conflict" | "denied" | "unknown";
    };
export type GatewayBatchResult = {
  readonly operationId: string;
  readonly results: readonly GatewayBatchTargetResult[];
};

const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const targets = z
  .array(
    z.strictObject({
      repositoryId: reference,
      expectedVersion: z.number().int().min(1).max(2147483646).nullable(),
    }),
  )
  .min(1)
  .max(gatewayBatchTargetLimit);
const receiptScope = z.strictObject({
  workspaceId: reference,
  operationId: z.uuid(),
  targets,
});
const requestSchema = receiptScope.extend({
  selection: reviewProviderConfigurationSchema.transform((row, context) => {
    if (row.authMode !== "codex_account_gateway" || !row.requiredHealthy) {
      context.addIssue({
        code: "custom",
        message: "one_required_healthy_gateway_provider_required",
      });
      return z.NEVER;
    }
    return row;
  }),
});
export class GatewayBatchDenied extends Error {}

/** Fresh App-scoped facts for this exact repository; inventory is only a mirror. */
export async function assertGatewayBatchRepositoryEligible(
  repository: {
    readonly githubRepositoryId: bigint;
    readonly owner: string;
    readonly name: string;
    readonly fullName: string;
  },
  octokit: {
    request(
      route: string,
      parameters?: Record<string, unknown>,
    ): Promise<{ data: unknown }>;
  },
): Promise<void> {
  const response = await octokit.request("GET /repos/{owner}/{repo}", {
    owner: repository.owner,
    repo: repository.name,
  });
  // Missing facts and transport failures stay unknown, including API refusals.
  const current = z
    .object({
      id: z.union([
        z.number().int().positive().refine(Number.isSafeInteger),
        z.string().regex(/^[1-9][0-9]*$/),
      ]),
      full_name: z.string().min(1),
      archived: z.boolean(),
      disabled: z.boolean(),
    })
    .parse(response.data);
  if (
    String(current.id) !== repository.githubRepositoryId.toString() ||
    current.full_name.toLowerCase() !== repository.fullName.toLowerCase() ||
    current.archived ||
    current.disabled
  )
    throw new GatewayBatchDenied();
}

function deduplicate(
  input: readonly GatewayBatchTarget[],
): GatewayBatchTarget[] {
  const unique = new Map<string, GatewayBatchTarget>();
  for (const target of input) {
    const prior = unique.get(target.repositoryId);
    if (prior && prior.expectedVersion !== target.expectedVersion)
      throw new Error("gateway_batch_inconsistent_version");
    unique.set(target.repositoryId, { ...target });
  }
  return [...unique.values()];
}
function failure(
  error: unknown,
  writeEntered: boolean,
): "conflict" | "denied" | "unknown" {
  if (isReviewConfigurationWriteConflictError(error)) return "conflict";
  // A refusal proves no write only at a pre-write authority check. Once the
  // writer is entered, even a familiar error needs the exact durable receipt.
  if (
    !writeEntered &&
    (error instanceof EntitlementDeniedError ||
      error instanceof RateLimitExceededError ||
      error instanceof GatewayBatchDenied ||
      error instanceof ProviderAccountError ||
      error instanceof DashboardMutationRefusedError)
  )
    return "denied";
  return "unknown";
}

function receiptMatchesSelection(
  saved: { readonly version: number; readonly config: ReviewConfiguration },
  selection: ReviewProviderConfiguration,
): boolean {
  // Compare the original operation receipt, never the latest configuration.
  // The receipt boundary checks captured expectedVersion against the original
  // intent hash. Null CAS may append retained history at any actual version.
  return (
    saved.config.providers.length === 1 &&
    JSON.stringify(
      reviewProviderConfigurationSchema.parse(saved.config.provider),
    ) === JSON.stringify(reviewProviderConfigurationSchema.parse(selection)) &&
    JSON.stringify(
      reviewProviderConfigurationSchema.parse(saved.config.providers[0]),
    ) === JSON.stringify(reviewProviderConfigurationSchema.parse(selection))
  );
}

/** The only write is P111's versioned config + durable operation receipt.
 * No latest-config comparison is accepted as evidence of this operation's effect.
 */
export function createGatewayRepositoryBatchAdapter(dependencies: {
  readonly configurations: ReviewConfigurationRepositoryPort &
    ReviewConfigurationOperationRepositoryPort;
  readonly bindings: ProviderAccountDependencies;
  authorize(
    workspaceId: string,
    repositoryId: string,
    mode: "save" | "read" | "write",
  ): Promise<WorkspaceAccountActor>;
  profiles(workspaceId: string): Promise<readonly AccountProfileView[]>;
}) {
  async function receipt(
    input: GatewayBatchRequest,
    selected: GatewayBatchTarget,
    intendedConfig?: ReviewConfiguration,
  ): Promise<GatewayBatchTargetResult> {
    const { workspaceId, operationId } = input;
    const { repositoryId, expectedVersion } = selected;
    await dependencies.authorize(workspaceId, repositoryId, "read");
    const saved = await findReviewConfigurationOperation(
      {
        target: { scope: "repository", workspaceId, repositoryId },
        operationId,
        expectedVersion,
      },
      dependencies,
    );
    if (!saved) return { repositoryId, status: "unknown" };
    if (
      !receiptMatchesSelection(saved, input.selection) ||
      (intendedConfig &&
        JSON.stringify(parseReviewConfigurationStrict(saved.config)) !==
          JSON.stringify(parseReviewConfigurationStrict(intendedConfig)))
    )
      return { repositoryId, status: "conflict" };
    return { repositoryId, status: "applied", version: saved.version };
  }
  return {
    async save(request: GatewayBatchRequest): Promise<GatewayBatchResult> {
      // Parse creates a bounded primitive snapshot before the first await.
      const input = requestSchema.parse(request);
      const unique = deduplicate(input.targets);
      const results: GatewayBatchTargetResult[] = [];
      for (const { repositoryId, expectedVersion } of unique) {
        const target = {
          scope: "repository" as const,
          workspaceId: input.workspaceId,
          repositoryId,
        };
        let writeEntered = false;
        let intendedConfig: ReviewConfiguration | undefined;
        try {
          const actor = await dependencies.authorize(
            input.workspaceId,
            repositoryId,
            "save",
          );
          // A previous exact scoped receipt wins over changed current versions.
          // Never attempt a second save for an already applied operation.
          const prior = await findReviewConfigurationOperation(
            { target, operationId: input.operationId, expectedVersion },
            dependencies,
          );
          if (prior) {
            if (!receiptMatchesSelection(prior, input.selection)) {
              results.push({ repositoryId, status: "conflict" });
              continue;
            }
            // P111 compares the full durable intent, including expectedVersion.
            // Reconstruct from the exact receipt, never from latest settings.
            intendedConfig = parseReviewConfigurationStrict({
              ...prior.config,
              provider: input.selection,
              providers: [input.selection],
            });
            writeEntered = true;
            const saved = await saveReviewConfigurationWithOperation(
              {
                target,
                expectedVersion,
                operationId: input.operationId,
                config: intendedConfig,
              },
              dependencies,
            );
            results.push({
              repositoryId,
              status: "applied",
              version: saved.version,
            });
            continue;
          }
          const current = await findReviewConfiguration(target, dependencies);
          if ((current?.version ?? null) !== expectedVersion) {
            results.push({ repositoryId, status: "conflict" });
            continue;
          }
          const effective =
            current ?? (await resolveReviewConfiguration(target, dependencies));
          const config = parseReviewConfigurationStrict({
            ...effective.config,
            provider: input.selection,
            providers: [input.selection],
            execution: {
              providerLimit: 1,
              providerMaxParallel: 1,
              inlineMinAgreement: 1,
            },
          });
          intendedConfig = config;
          const profiles = await dependencies.profiles(input.workspaceId);
          // Fresh authority after intervening reads, on every target. Prisma also
          // checks workspace ownership, active binding/profile and pending fences.
          const freshActor = await dependencies.authorize(
            input.workspaceId,
            repositoryId,
            "write",
          );
          if (
            freshActor.userId !== actor.userId ||
            freshActor.githubUserId !== actor.githubUserId ||
            freshActor.githubLogin !== actor.githubLogin
          )
            throw new GatewayBatchDenied();
          const freshBinding = await resolveWorkspaceAccountBinding(
            {
              workspaceId: input.workspaceId,
              bindingId: input.selection.gatewayBindingId,
              actor: freshActor,
            },
            dependencies.bindings,
          );
          if (
            freshBinding.profileRef !== input.selection.gatewayProfileRef ||
            !isGatewayReviewModelSupported(input.selection, profiles)
          )
            throw new GatewayBatchDenied();
          writeEntered = true;
          const saved = await saveReviewConfigurationWithOperation(
            {
              target,
              config,
              expectedVersion,
              operationId: input.operationId,
            },
            dependencies,
          );
          results.push({
            repositoryId,
            status: "applied",
            version: saved.version,
          });
        } catch (error) {
          let result: GatewayBatchTargetResult = {
            repositoryId,
            status: failure(error, writeEntered),
          };
          if (writeEntered && result.status === "unknown") {
            try {
              result = await receipt(
                input,
                { repositoryId, expectedVersion },
                intendedConfig,
              );
            } catch (recoveryError) {
              result = {
                repositoryId,
                status: isReviewConfigurationWriteConflictError(recoveryError)
                  ? "conflict"
                  : "unknown",
              };
            }
          }
          results.push(result);
        }
      }
      return { operationId: input.operationId, results };
    },
    async read(request: GatewayBatchRequest): Promise<GatewayBatchResult> {
      const input = requestSchema.parse(request);
      const results: GatewayBatchTargetResult[] = [];
      for (const target of deduplicate(input.targets)) {
        const { repositoryId } = target;
        try {
          results.push(await receipt(input, target));
        } catch (error) {
          // Denied/unavailable readback cannot prove a prior write had no effect.
          results.push({
            repositoryId,
            status: isReviewConfigurationWriteConflictError(error)
              ? "conflict"
              : "unknown",
          });
        }
      }
      return { operationId: input.operationId, results };
    },
  };
}

export async function gatewayRepositoryBatchServerAdapter() {
  const [
    db,
    auth,
    providers,
    configs,
    mutations,
    entitlements,
    audits,
    rates,
    accounts,
  ] = await Promise.all([
    import("./prisma"),
    import("@reviewrouter/features-auth"),
    import("@reviewrouter/features-provider-accounts"),
    import("@reviewrouter/features-review-config"),
    import("./dashboard-mutations"),
    import("@reviewrouter/features-entitlements"),
    import("@reviewrouter/features-audit-log"),
    import("./dashboard-rate-limits"),
    import("./account-gateway-accounts"),
  ]);
  const configuredOperatorWorkspaceId =
    process.env.ACCOUNT_GATEWAY_OPERATOR_WORKSPACE_ID;
  const operatorWorkspaceId =
    configuredOperatorWorkspaceId === undefined
      ? undefined
      : accountGatewayReference.parse(configuredOperatorWorkspaceId);
  const prisma = db.getPrisma();
  const providerAccounts = new providers.PrismaProviderAccountRepository(
    prisma,
    operatorWorkspaceId,
  );
  return createGatewayRepositoryBatchAdapter({
    configurations: new configs.PrismaReviewConfigurationRepository(
      prisma,
      operatorWorkspaceId,
    ),
    bindings: {
      accounts: providerAccounts,
      operatorGrants: providerAccounts,
      ...(operatorWorkspaceId ? { operatorWorkspaceId } : {}),
      workspaceAccess: new auth.PrismaWorkspaceAccessRepository(prisma),
      localAdminGithubLogins: (
        process.env.REVIEW_ROUTER_LOCAL_ADMIN_GITHUB_LOGINS ?? ""
      )
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    },
    async authorize(workspaceId, repositoryId, mode) {
      const repository = await prisma.repositoryConnection.findUnique({
        where: { id: repositoryId },
        include: { installation: true },
      });
      if (
        !repository ||
        repository.workspaceId !== workspaceId ||
        repository.provider !== "github" ||
        !repository.githubRepositoryId ||
        !repository.installation ||
        (mode !== "read" &&
          (!repository.selected ||
            repository.archived ||
            repository.installation.status !== "active"))
      )
        throw new GatewayBatchDenied();
      if (mode === "write") {
        const octokit = await mutations.createGitHubAppInstallationOctokit(
          repository.installation.githubInstallationId.toString(),
        );
        await assertGatewayBatchRepositoryEligible(
          { ...repository, githubRepositoryId: repository.githubRepositoryId },
          octokit,
        );
        // Recheck local scope after the upstream await. The configuration adapter
        // additionally holds the accepted current-scope guards during its write.
        const current = await prisma.repositoryConnection.findUnique({
          where: { id: repositoryId },
          include: { installation: true },
        });
        if (
          !current ||
          current.workspaceId !== workspaceId ||
          current.provider !== "github" ||
          current.githubRepositoryId !== repository.githubRepositoryId ||
          current.fullName !== repository.fullName ||
          current.owner !== repository.owner ||
          current.name !== repository.name ||
          current.installationId !== repository.installationId ||
          !current.selected ||
          current.archived ||
          !current.githubRepositoryId ||
          !current.installation ||
          current.installation.status !== "active"
        )
          throw new GatewayBatchDenied();
      }
      // Do not relabel authorization transport outages as definite refusals.
      // Reauthorize the actor on the current row after the upstream read.
      const actor =
        await mutations.assertDashboardRepositoryConfigMutationAllowed(
          workspaceId,
          {
            ...repository,
            githubRepositoryId: repository.githubRepositoryId,
            installation: repository.installation,
          },
        );
      if (mode !== "read") {
        await entitlements.assertWorkspaceFeatureEntitlement(
          { workspaceId, actor: actor.actor, feature: "action_control_plane" },
          {
            entitlements: new entitlements.PrismaEntitlementRepository(prisma),
            auditLog: new audits.PrismaAuditLogRepository(prisma),
          },
        );
        if (mode === "save")
          await rates
            .createDashboardRateLimitPolicy(prisma)
            .assertReviewConfigSaveAllowed({
              workspaceId,
              resourceId: repositoryId,
            });
      }
      return {
        userId: actor.userId,
        githubUserId: actor.githubUserId ?? "",
        githubLogin: actor.githubLogin ?? "",
      };
    },
    async profiles(workspaceId) {
      const bootstrap = await accounts.loadAccountsBootstrap(workspaceId);
      if (bootstrap.page.status === "denied") throw new GatewayBatchDenied();
      if (bootstrap.page.status !== "ok")
        throw new Error("gateway_batch_catalog_unavailable");
      return bootstrap.page.value.profiles;
    },
  });
}
