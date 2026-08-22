import {
  CredentialEnvelopeVault,
  FetchHostedCodexStreamingRelay,
  HostedCodexMutationFenceLeaseStore,
  HostedCodexSessionRuntime,
  HostedCodexSessionStore,
  PrismaHostedCodexMutationFence,
  PrismaHostedCodexRelayAuthorization,
  PrismaHostedCodexSessionPersistence,
  PrismaInvocationGrantRepository,
  resolveHostedCodexKeyring,
  PrismaHostedCodexUpstreamEffectLedger,
  startHostedCodexEffectSweeper,
  type RegisterHostedCodexRelayRoutesDependencies,
} from "@reviewrouter/features-hosted-account-pool";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  isHostedCodexAdmissionEnabled,
  isHostedCodexCustodyEnabled,
  isHostedCodexFailoverEnabled,
  isHostedCodexPoolEnabled,
  isHostedCodexRelayEnabled,
} from "@reviewrouter/platform-config";
import { SystemClock } from "@reviewrouter/shared";
import { OctokitGitHubAppCommentTokenIssuer } from "./github/octokit-github-app-comment-token-issuer.js";
import { OctokitHostedWorkflowSourceReader } from "./github/octokit-hosted-workflow-source-reader.js";
import { HostedCodexCommentTokenIssuer } from "./hosted-codex-comment-token-composition.js";
import { createProductionHostedCodexGrantIssuer } from "./hosted-codex-grant-composition.js";

export type HostedCodexFeatureFlags = {
  readonly custody: boolean;
  readonly admission: boolean;
  readonly relay: boolean;
  readonly failover: boolean;
};

export function readHostedCodexFeatureFlags(
  env: Readonly<Record<string, string | undefined>>,
): HostedCodexFeatureFlags {
  const processEnv = env as NodeJS.ProcessEnv;
  const master = isHostedCodexPoolEnabled(processEnv);
  return {
    custody: master && isHostedCodexCustodyEnabled(processEnv),
    admission: master && isHostedCodexAdmissionEnabled(processEnv),
    relay: master && isHostedCodexRelayEnabled(processEnv),
    failover: master && isHostedCodexFailoverEnabled(processEnv),
  };
}

export function composeHostedCodexRelayRoutes(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly dependencies: Omit<
    RegisterHostedCodexRelayRoutesDependencies,
    "enabled"
  >;
}): RegisterHostedCodexRelayRoutesDependencies {
  const flags = readHostedCodexFeatureFlags(input.env);
  return {
    ...input.dependencies,
    enabled: flags.custody && flags.relay,
    grants: flags.admission
      ? input.dependencies.grants
      : closedAdmissionGrantIssuer,
  };
}

export function composeProductionHostedCodexRelayRoutes(input: {
  readonly prisma: PrismaClient;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly publicApiUrl: string;
  readonly githubAppId: string;
  readonly githubAppPrivateKey: string;
}): RegisterHostedCodexRelayRoutesDependencies {
  const flags = readHostedCodexFeatureFlags(input.env);
  const enabled = flags.custody && flags.relay;
  if (!enabled) {
    // These dependencies are deliberately unreachable while the rollout gate is off.
    return { enabled: false } as RegisterHostedCodexRelayRoutesDependencies;
  }
  const databaseIncarnation =
    input.env.REVIEW_ROUTER_HOSTED_CODEX_DATABASE_INCARNATION?.trim();
  if (!databaseIncarnation) {
    throw new Error("hosted_codex_database_incarnation_missing");
  }
  const databaseResourceIdentity =
    input.env.REVIEW_ROUTER_HOSTED_CODEX_DATABASE_RESOURCE_IDENTITY?.trim();
  if (!databaseResourceIdentity || databaseResourceIdentity.length < 16) {
    throw new Error("hosted_codex_database_resource_identity_invalid");
  }
  const fingerprintPepper = Buffer.from(
    input.env.REVIEW_ROUTER_HOSTED_CODEX_FINGERPRINT_PEPPER ?? "",
    "base64",
  );
  if (fingerprintPepper.byteLength < 32) {
    throw new Error("hosted_codex_fingerprint_pepper_invalid");
  }
  const clock = new SystemClock();
  const githubCommentTokens = new OctokitGitHubAppCommentTokenIssuer({
    appId: input.githubAppId,
    privateKey: input.githubAppPrivateKey,
  });
  const workflowSources = new OctokitHostedWorkflowSourceReader({
    appId: input.githubAppId,
    privateKey: input.githubAppPrivateKey,
  });
  const ledger = new PrismaInvocationGrantRepository(input.prisma);
  startHostedCodexEffectSweeper(
    new PrismaHostedCodexUpstreamEffectLedger(input.prisma),
  );
  const keyring = resolveHostedCodexKeyring({
    env: input.env,
    purpose: "relay",
  });
  const vault = new CredentialEnvelopeVault(keyring, "relay");
  const runtime = new HostedCodexSessionRuntime({
    sessionStore: new HostedCodexSessionStore(
      new PrismaHostedCodexSessionPersistence(
        input.prisma,
        vault,
        databaseIncarnation,
        databaseResourceIdentity,
        fingerprintPepper,
        input.env.NODE_ENV === "production" ? keyring.currentKeyId : undefined,
      ),
    ),
    leaseStore: new HostedCodexMutationFenceLeaseStore(
      new PrismaHostedCodexMutationFence(input.prisma),
    ),
  });
  const relayUrl = `${input.publicApiUrl.replace(/\/+$/u, "")}/api/action/v1/hosted-codex/responses`;
  return {
    enabled: true,
    grants: flags.admission
      ? createProductionHostedCodexGrantIssuer({
          prisma: input.prisma,
          env: input.env,
          relayUrl,
          workflowSources,
          commentTokens: githubCommentTokens,
          clock,
        })
      : closedAdmissionGrantIssuer,
    commentTokens: new HostedCodexCommentTokenIssuer({
      prisma: input.prisma,
      commentTokens: githubCommentTokens,
      clock,
      grants: ledger,
    }),
    authorization: new PrismaHostedCodexRelayAuthorization(
      input.prisma,
      flags.failover,
    ),
    relay: new FetchHostedCodexStreamingRelay(runtime, ledger, fetch, {
      failoverEnabled: flags.failover,
    }),
  };
}

const closedAdmissionGrantIssuer = Object.freeze({
  async issue(): Promise<never> {
    throw new Error("hosted_codex_admission_unavailable");
  },
});
