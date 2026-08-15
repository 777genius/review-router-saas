import { readFileSync } from "node:fs";
import { createPrismaClient } from "../packages/platform/db/src/index";

const databaseUrl = process.env.REVIEW_ROUTER_PRISMA_EVIDENCE_DATABASE_URL_FILE
  ? readFileSync(
      process.env.REVIEW_ROUTER_PRISMA_EVIDENCE_DATABASE_URL_FILE,
      "utf8",
    ).trim()
  : process.env.REVIEW_ROUTER_PRISMA_EVIDENCE_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("REVIEW_ROUTER_PRISMA_EVIDENCE_DATABASE_URL is required");
}

const identitiesSource = process.env.REVIEW_ROUTER_PRISMA_EVIDENCE_IDENTITIES;
if (!identitiesSource) {
  throw new Error("REVIEW_ROUTER_PRISMA_EVIDENCE_IDENTITIES is required");
}
const identities = JSON.parse(identitiesSource) as Record<string, unknown>;
for (const key of [
  "claimId",
  "attemptId",
  "namespaceId",
  "providerId",
  "repositoryId",
  "workspaceId",
]) {
  if (typeof identities[key] !== "string" || identities[key].length === 0) {
    throw new Error(`invalid Prisma evidence identity: ${key}`);
  }
}
const exact = identities as Record<
  | "claimId"
  | "attemptId"
  | "namespaceId"
  | "providerId"
  | "repositoryId"
  | "workspaceId",
  string
>;

const prisma = createPrismaClient({ databaseUrl, poolMax: 1 });

try {
  const destructiveCleanupAttempts = [
    {
      expectedReasons: ["codex_oauth_setup_attempt_delete_forbidden"],
      run: () =>
        prisma.codexOAuthSetupDispatchAttempt.delete({
          where: { id: exact.attemptId },
        }),
    },
    {
      expectedReasons: ["codex_oauth_setup_claim_delete_forbidden"],
      run: () =>
        prisma.codexOAuthSetupPayloadClaim.delete({
          where: { id: exact.claimId },
        }),
    },
    {
      expectedReasons: ["codex_oauth_secret_namespace_delete_forbidden"],
      run: () =>
        prisma.codexOAuthSecretNamespace.delete({
          where: { id: exact.namespaceId },
        }),
    },
    {
      expectedReasons: [
        "codex_oauth_setup_manifest_delete_forbidden",
        "CodexOAuthSetupPayloadClaim_provider_fkey",
        "CodexOAuthSecretNamespace_provider_fkey",
      ],
      run: () =>
        prisma.codexOAuthProviderInstance.delete({
          where: { id: exact.providerId },
        }),
    },
    {
      expectedReasons: [
        "codex_oauth_setup_manifest_delete_forbidden",
        "CodexOAuthSetupPayloadClaim_repository_fkey",
        "CodexOAuthSetupPayloadClaim_provider_fkey",
        "CodexOAuthSecretNamespace_provider_fkey",
      ],
      run: () =>
        prisma.repositoryConnection.delete({
          where: { id: exact.repositoryId },
        }),
    },
    {
      expectedReasons: [
        "codex_oauth_setup_manifest_delete_forbidden",
        "CodexOAuthSetupPayloadClaim_workspace_fkey",
        "CodexOAuthSetupPayloadClaim_repository_fkey",
        "CodexOAuthSetupPayloadClaim_provider_fkey",
        "CodexOAuthSecretNamespace_provider_fkey",
      ],
      run: () => prisma.workspace.delete({ where: { id: exact.workspaceId } }),
    },
  ];

  for (const attempt of destructiveCleanupAttempts) {
    let rejected = false;
    try {
      await attempt.run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rejected = attempt.expectedReasons.some((expectedReason) =>
        message.includes(expectedReason),
      );
      if (!rejected) {
        throw new Error(
          `Prisma cleanup failed for the wrong reason; expected one of ${attempt.expectedReasons.join(",")}`,
          { cause: error },
        );
      }
    }
    if (!rejected) {
      throw new Error("Prisma cleanup unexpectedly erased permanent evidence");
    }
  }

  const retained = await prisma.$queryRaw<
    Array<{
      claims: bigint;
      attempts: bigint;
      namespaces: bigint;
    }>
  >`
    SELECT
      (SELECT count(*) FROM "CodexOAuthSetupPayloadClaim" WHERE "id" = ${exact.claimId}) AS claims,
      (SELECT count(*) FROM "CodexOAuthSetupDispatchAttempt" WHERE "id" = ${exact.attemptId}) AS attempts,
      (SELECT count(*) FROM "CodexOAuthSecretNamespace" WHERE "id" = ${exact.namespaceId} AND "permanentlyRetired") AS namespaces
  `;
  const counts = retained[0];
  if (
    counts?.claims !== 1n ||
    counts.attempts !== 1n ||
    counts.namespaces !== 1n
  ) {
    throw new Error("Prisma cleanup changed permanent evidence row counts");
  }
} finally {
  await prisma.$disconnect();
}
