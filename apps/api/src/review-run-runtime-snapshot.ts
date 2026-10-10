import type { Prisma, PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import * as c from "@agent-teams/account-gateway/contracts";
import { z } from "zod";
import { PrismaActionControlPlaneRepository } from "@reviewrouter/features-action-control-plane";
import {
  PrismaProviderAccountRepository,
  selectBinding,
  ProviderAccountError,
  assertOpaqueReference,
} from "@reviewrouter/features-provider-accounts";
import {
  parseReviewConfigurationStrict,
  safeDefaultReviewConfiguration,
  type ReviewConfiguration,
} from "@reviewrouter/features-review-config/review-configuration";
import {
  canonicalJson,
  parseReviewRunRuntimeSnapshot,
  type ReviewRunAuthorizationCandidate,
  type ReviewRunGatewaySelection,
  type ReviewRunGatewayLimits,
  type ReviewRunRuntimeSnapshot,
  type ReviewRunRuntimeSnapshotPort,
  type VerifiedScmRunIdentity,
} from "@reviewrouter/features-review-run-control";

type RuntimeReader = Pick<
  PrismaClient,
  "reviewConfiguration" | "workspaceAccountBinding"
>;

/** Backend configuration only. Never sourced from CI/OIDC/request DTOs. */
export type ServerApprovedReviewRunGatewayPolicy = {
  readonly profiles: readonly {
    readonly profileRef: string;
    readonly limits: ReviewRunGatewayLimits;
  }[];
};

/** Trusted backend configuration. Absence never supplies a default allowance. */
export function readServerApprovedReviewRunGatewayPolicy(
  raw: string | undefined,
): ServerApprovedReviewRunGatewayPolicy | undefined {
  if (raw === undefined) return undefined;
  try {
    if (new TextEncoder().encode(raw).byteLength > 32_768) throw new Error();
    return z
      .strictObject({
        profiles: z
          .array(
            z.strictObject({
              profileRef: c.reference,
              limits: c.limits,
            }),
          )
          .min(1)
          .max(128),
      })
      .parse(JSON.parse(raw));
  } catch {
    throw new Error("review_run_gateway_policy_invalid");
  }
}

/** System-owned selection after real OIDC admission policy, without a user actor.
 * No Gateway HTTP call, credential, epoch inference or allowance is created here.
 */
export class ProductionReviewRunRuntimeSnapshot implements ReviewRunRuntimeSnapshotPort {
  private readonly repositories: PrismaActionControlPlaneRepository;
  private readonly accounts: PrismaProviderAccountRepository;
  private readonly approvedLimits: ReadonlyMap<string, ReviewRunGatewayLimits>;
  constructor(
    private readonly prisma: PrismaClient,
    policy?: ServerApprovedReviewRunGatewayPolicy,
    private readonly operatorWorkspaceId?: string,
  ) {
    if (operatorWorkspaceId !== undefined)
      assertOpaqueReference(operatorWorkspaceId);
    const profiles = new Map<string, ReviewRunGatewayLimits>();
    try {
      if (
        policy &&
        (policy.profiles.length < 1 || policy.profiles.length > 128)
      )
        throw new Error();
      for (const entry of policy?.profiles ?? []) {
        const profileRef = c.reference.parse(entry.profileRef);
        if (profiles.has(profileRef)) throw new Error();
        profiles.set(profileRef, Object.freeze(c.limits.parse(entry.limits)));
      }
    } catch {
      throw new Error("review_run_gateway_policy_invalid");
    }
    this.approvedLimits = profiles;
    this.repositories = new PrismaActionControlPlaneRepository(prisma);
    this.accounts = new PrismaProviderAccountRepository(
      prisma,
      operatorWorkspaceId,
    );
  }

  async capture(
    input: {
      readonly identity: VerifiedScmRunIdentity;
      readonly deadline: Date;
    },
    reader: RuntimeReader = this.prisma,
  ): Promise<ReviewRunRuntimeSnapshot | null> {
    // Retain primitives across all reads; never retain the caller's nested identity.
    const identity = { ...input.identity };
    const deadline = new Date(input.deadline).toISOString();
    const current = await this.repositories.findRuntimeReviewConfiguration(
      {
        workspaceId: identity.workspaceId,
        repositoryId: identity.repositoryConnectionId,
      },
      reader,
      true,
    );
    let configuration: ReviewConfiguration;
    try {
      configuration = parseReviewConfigurationStrict(
        current?.config ?? safeDefaultReviewConfiguration,
      );
    } catch {
      return null;
    }
    const selectedProviders = configuration.providers
      .map((provider, providerIndex) => ({ provider, providerIndex }))
      .filter(({ provider }) => provider.authMode === "codex_account_gateway");
    // A single execution profile is owned by this admission. Multiple gateway
    // profiles need a qualified shared allowance contract, not fresh invocations.
    if (selectedProviders.length > 1) return null;
    const selected = selectedProviders[0];
    let gateway: ReviewRunGatewaySelection | null = null;
    if (selected?.provider.authMode === "codex_account_gateway") {
      const limits = this.approvedLimits.get(
        selected.provider.gatewayProfileRef,
      );
      if (!limits) return null;
      const bindingId = selected.provider.gatewayBindingId;
      const selection = await this.accounts.findBinding(
        { workspaceId: identity.workspaceId, bindingId },
        reader,
      );
      let binding: ReturnType<typeof selectBinding>;
      try {
        binding = selectBinding(
          identity.workspaceId,
          bindingId,
          selection,
          this.operatorWorkspaceId,
        );
      } catch (error) {
        if (error instanceof ProviderAccountError) return null;
        throw error;
      }
      if (binding.profileRef !== selected.provider.gatewayProfileRef)
        return null;
      gateway = {
        providerIndex: selected.providerIndex,
        bindingId: binding.bindingId,
        connectionId: binding.connectionId,
        bindingRevision: binding.bindingRevision,
        policySubject: binding.policySubject,
        policyRevision: binding.policyRevision,
        permittedAccountRef: binding.gatewayAccountRef,
        profileRef: selected.provider.gatewayProfileRef,
        ...reviewRunGatewayPreparationIdentity(identity),
        limits: { ...limits },
      };
    }
    try {
      return parseReviewRunRuntimeSnapshot(
        canonicalJson({
          snapshotVersion: 1,
          configurationSource: current?.source ?? "default",
          configurationVersion: current?.version ?? 1,
          configurationCanonicalJson: canonicalJson(configuration),
          deadline,
          gateway,
        }),
      );
    } catch {
      return null;
    }
  }

  async isLive(
    input: {
      readonly snapshot: ReviewRunRuntimeSnapshot;
      readonly identity: VerifiedScmRunIdentity;
      readonly now: Date;
    },
    reader: RuntimeReader = this.prisma,
  ): Promise<boolean> {
    const identity = { ...input.identity };
    const snapshot = parseReviewRunRuntimeSnapshot(
      canonicalJson(input.snapshot),
    );
    if (!snapshot) return false;
    const configuration = parseReviewConfigurationStrict(
      JSON.parse(snapshot.configurationCanonicalJson),
    );
    if (canonicalJson(configuration) !== snapshot.configurationCanonicalJson)
      return false;
    const gatewayProviders = configuration.providers.filter(
      (provider) => provider.authMode === "codex_account_gateway",
    );
    if (gatewayProviders.length > 1) return false;
    if (input.now >= new Date(snapshot.deadline)) return false;
    const original = snapshot.gateway;
    if (!original) return gatewayProviders.length === 0;
    const provider = configuration.providers[original.providerIndex];
    if (
      gatewayProviders.length !== 1 ||
      provider?.authMode !== "codex_account_gateway" ||
      provider.gatewayBindingId !== original.bindingId ||
      provider.gatewayProfileRef !== original.profileRef
    )
      return false;
    // Original C1 authority only; no current configuration or budget recalculation.
    // Gateway independently enforces its actual epoch/fence at prepare/dispatch.
    try {
      const live = selectBinding(
        identity.workspaceId,
        original.bindingId,
        await this.accounts.findBinding(
          {
            workspaceId: identity.workspaceId,
            bindingId: original.bindingId,
          },
          reader,
        ),
        this.operatorWorkspaceId,
      );
      const stable = reviewRunGatewayPreparationIdentity(identity);
      return (
        live.connectionId === original.connectionId &&
        live.bindingRevision === original.bindingRevision &&
        live.policyRevision === original.policyRevision &&
        live.policySubject === original.policySubject &&
        live.gatewayAccountRef === original.permittedAccountRef &&
        live.profileRef === original.profileRef &&
        stable.invocationId === original.invocationId &&
        stable.attemptId === original.attemptId &&
        stable.operationId === original.operationId
      );
    } catch (error) {
      if (error instanceof ProviderAccountError) return false;
      throw error;
    }
  }

  /** Called inside the EXISTING serializable row+outbox admission transaction.
   * Parent locks fence inserts even when repository override/default is absent.
   * Connection then binding locks match C1's mutation order and retain pending fences.
   */
  async matchesAdmission(
    transaction: Prisma.TransactionClient,
    candidate: ReviewRunAuthorizationCandidate,
  ): Promise<boolean> {
    const original = parseReviewRunRuntimeSnapshot(
      candidate.runtimeSnapshotCanonicalJson,
    );
    if (!original) return false;
    const workspaceId = candidate.workspaceId;
    const targetKey = `repo:${candidate.repositoryConnectionId}`;
    const owned = await transaction.$queryRaw<readonly { id: string }[]>`
      SELECT "id" FROM "Workspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
    if (owned.length !== 1) return false;
    await transaction.$queryRaw`
      SELECT "id" FROM "ReviewConfiguration"
      WHERE "workspaceId" = ${workspaceId} AND "targetKey" IN (${targetKey}, 'workspace:default')
      ORDER BY "id" FOR UPDATE`;
    if (original.gateway) {
      await transaction.$queryRaw`
        SELECT "id" FROM "ProviderAccountConnection"
        WHERE "id" = ${original.gateway.connectionId} FOR UPDATE`;
      await transaction.$queryRaw`
        SELECT "id" FROM "WorkspaceAccountBinding"
        WHERE "id" = ${original.gateway.bindingId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    }
    try {
      const current = await this.capture(
        {
          identity: candidate,
          deadline: candidate.maxExpiresAt,
        },
        transaction,
      );
      return canonicalJson(current) === candidate.runtimeSnapshotCanonicalJson;
    } catch (error) {
      if (error instanceof ProviderAccountError) return false;
      throw error;
    }
  }
}

/** One tuple across tokens, authorization IDs, request IDs, offers and settings.
 * The operation ID remains unchanged even if first prepare's outcome is unknown.
 */
export function reviewRunGatewayPreparationIdentity(
  identity: Pick<
    VerifiedScmRunIdentity,
    | "workspaceId"
    | "repositoryConnectionId"
    | "scmRepositoryIdentityId"
    | "sourceRunId"
    | "sourceRunAttempt"
  >,
): Pick<
  ReviewRunGatewaySelection,
  "invocationId" | "attemptId" | "operationId"
> {
  const run = [
    identity.workspaceId,
    identity.repositoryConnectionId,
    identity.scmRepositoryIdentityId,
    identity.sourceRunId,
  ];
  const digest = (purpose: string, tuple: readonly string[]) =>
    `rr-${createHash("sha256")
      .update(canonicalJson(["review-run-gateway-v1", purpose, ...tuple]))
      .digest("hex")}`;
  const attempt = [...run, identity.sourceRunAttempt];
  return {
    invocationId: digest("invocation", run),
    attemptId: digest("attempt", attempt),
    operationId: digest("prepare", attempt),
  };
}
