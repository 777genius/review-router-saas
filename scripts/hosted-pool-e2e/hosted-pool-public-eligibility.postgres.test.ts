import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../packages/platform/db/src/index";
import {
  CredentialEnvelopeVault,
  EnvCredentialKeyring,
  PrismaHostedAccountRepository,
  PrismaHostedCredentialEnrollment,
  PrismaHostedPoolBindingRepository,
  PrismaHostedPoolRepository,
  PrismaInvocationGrantRepository,
  PrismaHostedCommentTokenMintLedger,
  createDefaultHostedAccountPool,
  issueHostedPoolInvocationGrant,
  hostedAccountId,
  hostedBindingId,
  hostedPoolId,
  invocationGrantId,
  invocationId,
  repositoryId,
  workspaceId,
} from "../../packages/features/hosted-account-pool/src/index";

// Explicitly supplied, disposable, fully migrated PG17 only. Missing evidence
// is a skip, never a successful PostgreSQL certification. No provider is called.
const databaseUrl = process.env.REVIEW_ROUTER_HOSTED_POOL_E2E_DATABASE_URL;
const custodyUrl =
  process.env.REVIEW_ROUTER_HOSTED_POOL_E2E_CUSTODY_DATABASE_URL;
const enabled = process.env.REVIEW_ROUTER_RUN_HOSTED_POOL_PUBLIC_PG === "1";
if (enabled) {
  for (const value of [databaseUrl, custodyUrl]) {
    if (!value)
      throw new Error("public_eligibility_disposable_database_required");
    const parsed = new URL(value);
    if (
      !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
      !parsed.pathname.startsWith("/reviewrouter_hosted_pool_e2e_")
    ) {
      throw new Error("public_eligibility_disposable_loopback_required");
    }
  }
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const prefix = `public-eligibility-${randomUUID()}`;
const workspace = workspaceId(`${prefix}-workspace`);
const pool = hostedPoolId(`${prefix}-pool`);
const installation = `${prefix}-installation`;
const now = new Date();
let prisma: ReturnType<typeof createPrismaClient>;
let custody: ReturnType<typeof createPrismaClient>;
let epoch: bigint;
let ordinal = 0;
// Distinct safe fake GitHub IDs in a disposable database, never provider IDs.
const githubInstallationId = BigInt(Date.now());

beforeAll(async () => {
  if (!enabled) return;
  prisma = createPrismaClient({ databaseUrl: databaseUrl!, poolMax: 2 });
  custody = createPrismaClient({ databaseUrl: custodyUrl!, poolMax: 2 });
  const version = await prisma.$queryRaw<
    Array<{ version: string }>
  >`SHOW server_version_num`;
  expect(Number(Object.values(version[0]!)[0])).toBeGreaterThanOrEqual(170000);
  expect(Number(Object.values(version[0]!)[0])).toBeLessThan(180000);
  const migrations = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) FROM "_prisma_migrations"
    WHERE migration_name = '000096_hosted_pool_public_repository_eligibility'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL
  `;
  expect(Number(migrations[0]?.count)).toBe(1);
  const gate = await prisma.hostedCodexRuntimeGate.findUniqueOrThrow({
    where: { id: "global" },
  });
  // The orchestrator must supply an authorized active disposable fixture. This
  // suite does not disable triggers, repair the gate, or bypass closure custody.
  if (gate.status !== "active")
    throw new Error("public_eligibility_active_disposable_gate_required");
  epoch = gate.authzEpoch;
  await prisma.workspace.create({
    data: { id: workspace, slug: prefix, name: "Public eligibility fixture" },
  });
  await prisma.gitHubInstallation.create({
    data: {
      id: installation,
      workspaceId: workspace,
      githubInstallationId,
      accountLogin: prefix,
      accountType: "Organization",
      repositorySelection: "selected",
      status: "active",
    },
  });
  await new PrismaHostedPoolRepository(prisma).insertDefault(
    createDefaultHostedAccountPool({ id: pool, workspaceId: workspace, now }),
  );
  const vault = new CredentialEnvelopeVault(
    new EnvCredentialKeyring({
      REVIEW_ROUTER_HOSTED_CODEX_KEK_CURRENT_ID: "fixture",
      REVIEW_ROUTER_HOSTED_CODEX_KEK_KEYRING_JSON: JSON.stringify({
        fixture: Buffer.alloc(32, 17).toString("base64"),
      }),
    }),
  );
  const claims = Buffer.from(
    JSON.stringify({
      iss: "https://auth.openai.com",
      sub: prefix,
      "https://api.openai.com/auth": { chatgpt_account_id: prefix },
    }),
  ).toString("base64url");
  await new PrismaHostedCredentialEnrollment(
    prisma,
    vault,
    "disposable-incarnation",
    "disposable-resource",
    Buffer.alloc(32, 29),
  ).importCodexAuth({
    workspaceId: workspace,
    poolId: pool,
    accountId: hostedAccountId(`${prefix}-account`),
    label: "Fake account",
    priority: 0,
    expectedPoolRevision: 1,
    authJsonBytes: Buffer.from(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "fake-access",
          refresh_token: "fake-refresh",
          id_token: `e30.${claims}.signature`,
        },
        last_refresh: now.toISOString(),
      }),
    ),
    now,
  });
}, 60_000);

afterAll(async () => {
  if (!enabled) return;
  await custody?.$disconnect();
  await prisma?.$disconnect();
  // Immutable ledgers belong to this entire disposable database; the supplying
  // orchestrator destroys it after the batch. Never weaken deletion guards.
});

describe.skipIf(!enabled)(
  "public eligibility on actual PostgreSQL guards",
  () => {
    it.each(["public", "private", "internal"] as const)(
      "binds and prepares/dispatched mint authority for %s",
      async (visibility) => {
        const fixture = await repositoryFixture(visibility);
        const prepared = await prepare(fixture);
        expect(prepared.state).toBe("prepared");
        await expect(dispatchMint(fixture)).resolves.toBeUndefined();
        const mint = await prisma.hostedCodexCommentTokenMint.findUniqueOrThrow(
          { where: { id: `${fixture.id}-mint` } },
        );
        expect(mint.state).toBe("dispatching");
      },
    );

    it.each([
      ["unselected", { selected: false }],
      ["archived", { archived: true }],
    ] as const)(
      "rejects a public repository that becomes %s before dispatch",
      async (_label, data) => {
        const fixture = await repositoryFixture("public");
        await prepare(fixture);
        await prisma.repositoryConnection.update({
          where: { id: fixture.repository },
          data,
        });
        await expect(dispatchMint(fixture)).rejects.toThrow(
          "hosted_comment_mint_dispatch_conflict",
        );
      },
    );

    it("rejects a stale binding at mint preparation", async () => {
      const fixture = await repositoryFixture("public");
      await expect(prepare(fixture, 2)).rejects.toThrow(
        "hosted_comment_mint_authority_mismatch",
      );
    });

    it("rejects a foreign workspace at binding creation", async () => {
      const fixture = await repositoryFixture("public");
      await expect(
        new PrismaHostedPoolBindingRepository(prisma).save({
          binding: {
            ...fixture.binding,
            bindingId: hostedBindingId(`${prefix}-foreign`),
            workspaceId: workspaceId(`${prefix}-foreign-workspace`),
          },
          expectedRevision: null,
          expectedStateVersion: null,
        }),
      ).resolves.toBe(false);
    });

    it("revoked installation denies public mint dispatch", async () => {
      const fixture = await repositoryFixture("public");
      await prepare(fixture);
      try {
        await prisma.gitHubInstallation.update({
          where: { id: installation },
          data: { status: "suspended" },
        });
        await expect(dispatchMint(fixture)).rejects.toThrow(
          "hosted_comment_mint_dispatch_conflict",
        );
      } finally {
        await prisma.gitHubInstallation.update({
          where: { id: installation },
          data: { status: "active" },
        });
      }
    });

    it("keeps both installed guards and their security attributes", async () => {
      const rows = await prisma.$queryRaw<
        Array<{
          name: string;
          definer: boolean;
          config: string[];
          enabled: string;
        }>
      >`
      SELECT p.proname AS name, p.prosecdef AS definer, p.proconfig AS config, t.tgenabled::text AS enabled
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_trigger t ON t.tgfoid=p.oid
      WHERE n.nspname='public' AND p.proname IN
        ('hosted_codex_comment_token_mint_guard', 'hosted_codex_comment_token_prepare_authority_complete')
      ORDER BY p.proname
    `;
      expect(rows).toEqual([
        {
          name: "hosted_codex_comment_token_mint_guard",
          definer: false,
          config: ["search_path=pg_catalog, pg_temp"],
          enabled: "O",
        },
        {
          name: "hosted_codex_comment_token_prepare_authority_complete",
          definer: true,
          config: ["search_path=pg_catalog, pg_temp"],
          enabled: "O",
        },
      ]);
    });
  },
);

async function repositoryFixture(
  visibility: "public" | "private" | "internal",
) {
  const id = `${prefix}-${++ordinal}`;
  const repo = repositoryId(`${id}-repo`);
  const bindingId = hostedBindingId(`${id}-binding`);
  const githubRepositoryId = githubInstallationId + BigInt(ordinal);
  await prisma.repositoryConnection.create({
    data: {
      id: repo,
      workspaceId: workspace,
      provider: "github",
      externalRepositoryId: String(githubRepositoryId),
      installationId: installation,
      githubRepositoryId,
      owner: prefix,
      name: id,
      fullName: `${prefix}/${id}`,
      defaultBranch: "main",
      visibility,
      selected: true,
      archived: false,
    },
  });
  const binding = {
    bindingId,
    repositoryId: repo,
    workspaceId: workspace,
    poolId: pool,
    authMode: "codex_subscription_oauth_hosted_pool" as const,
    status: "pending_activation" as const,
    revision: 1,
    stateVersion: 1,
    attestedBindingRevision: null,
    activatedAt: null,
    drainingAt: null,
    boundAt: now,
    updatedAt: now,
  };
  expect(
    await new PrismaHostedPoolBindingRepository(prisma).save({
      binding,
      expectedRevision: null,
      expectedStateVersion: null,
    }),
  ).toBe(true);
  // Fixture-only canonical attestation, no GitHub calls or workflow mutations.
  await prisma.hostedCodexRepositoryBinding.update({
    where: { id: bindingId },
    data: {
      status: "active",
      stateVersion: 2n,
      activatedAt: now,
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowActionRef: `777genius/review-router@${"a".repeat(40)}`,
      workflowSourceCommitSha: "b".repeat(40),
      workflowSourceBlobSha: "c".repeat(40),
      workflowSourceSha256: "d".repeat(64),
      workflowSemanticSha256: "e".repeat(64),
      workflowSourceTrust: "trusted_default_branch_revision",
      attestedGithubRepositoryId: githubRepositoryId,
      attestedBindingRevision: 1n,
    },
  });
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 600_000);
  const grants = new PrismaInvocationGrantRepository(prisma);
  const issued = await issueHostedPoolInvocationGrant(
    {
      id: invocationGrantId(`${id}-grant`),
      invocationId: invocationId(`${id}-invocation`),
      repositoryId: repo,
      workspaceId: workspace,
      authority: {
        repositoryBindingId: bindingId,
        reviewRequestId: `${id}-review`,
        providerInvocationKey: `${id}-provider`,
        runId: `${id}-run`,
        runAttempt: 1,
        model: "fixture-model",
        policyFingerprint: sha256(id),
        runtimeConfigVersion: 1,
        bindingRevision: 1,
        authzEpoch: 1n,
      },
      runtimeAuthzEpoch: epoch,
      budget: {
        expiresAt,
        maxRequests: 4,
        maxConcurrentRequests: 2,
        maxRequestBytes: 16384,
        maxResponseBytes: 65536,
        maxOutputTokens: 4096,
      },
      commentRefreshBudget: { expiresAt, maxUses: 2 },
      now: issuedAt,
    },
    {
      pools: new PrismaHostedPoolRepository(prisma),
      bindings: new PrismaHostedPoolBindingRepository(prisma),
      accounts: new PrismaHostedAccountRepository(prisma),
      grants,
      commentRefreshCapabilities: grants,
      capabilities: {
        issue: async () => ({
          plaintextToken: sha256(`${id}-token`),
          tokenHash: sha256(sha256(`${id}-token`)),
        }),
      },
    },
  );
  return { id, repository: repo, binding, grantId: issued.grant.id };
}

async function prepare(
  fixture: Awaited<ReturnType<typeof repositoryFixture>>,
  bindingVersion = 1,
) {
  const instant = new Date();
  return new PrismaHostedCommentTokenMintLedger(custody).prepare({
    mintId: `${fixture.id}-mint`,
    purpose: "initial",
    ownerIdHash: sha256(fixture.id),
    logicalKeyHash: sha256(`${fixture.id}-logical`),
    requestFingerprintHash: sha256(`${fixture.id}-fingerprint`),
    grantId: fixture.grantId,
    bindingId: fixture.binding.bindingId,
    bindingVersion,
    now: instant,
    leaseExpiresAt: new Date(instant.getTime() + 30_000),
  });
}

async function dispatchMint(
  fixture: Awaited<ReturnType<typeof repositoryFixture>>,
) {
  const instant = new Date();
  return new PrismaHostedCommentTokenMintLedger(custody).authorizeDispatch({
    mintId: `${fixture.id}-mint`,
    ownerIdHash: sha256(fixture.id),
    now: instant,
    dispatchAuthorizedUntil: new Date(instant.getTime() + 15_000),
    unsafeUntil: new Date(instant.getTime() + 61 * 60_000),
  });
}
