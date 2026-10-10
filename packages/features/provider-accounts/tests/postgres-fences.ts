import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AuthenticatedPrincipal } from "../../auth/src/domain/authenticated-principal";
import { PrismaWorkspaceMembershipRepository } from "../../auth/src/infrastructure/prisma/prisma-workspace-membership-repository";
import { PrismaInstallationWorkspaceOwnerGrant } from "../../github-installations/src/infrastructure/prisma/prisma-installation-workspace-owner-grant";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import type { Client } from "pg";
import type { PrismaClient } from "@prisma/client";
import { PrismaPersonalAccountOperations } from "../src/infrastructure/prisma/prisma-personal-account-operations";
import type { PersonalAccountIntent } from "../src/application/use-cases/personal-account-operations";
import { selectBinding } from "../src/domain/provider-account";
import { PrismaProviderAccountRepository } from "../src/infrastructure/prisma/prisma-provider-account-repository";
import { PrismaProviderAccountSynchronization } from "../src/infrastructure/prisma/prisma-provider-account-synchronization";
import {
  bindWorkspaceAccount,
  revokeWorkspaceAccountBinding,
  resolveWorkspaceAccountBinding,
} from "../src/application/use-cases/workspace-account-bindings";
import { reconcileWorkspaceBindingFences } from "../src/application/use-cases/reconcile-workspace-binding-fences";
import {
  ProviderAccountError,
  type ScopedBindingFence,
} from "../src/domain/provider-account";
import type {
  ProviderAccountDependencies,
  WorkspaceAccountActor,
} from "../src/application/use-cases/workspace-account-bindings";
import type {
  BindingFenceResponse,
  WorkspaceBindingFenceDeliveryPort,
} from "../src/application/ports/workspace-binding-fence-port";

const denied = (code: string) => (e: unknown) =>
  e instanceof ProviderAccountError && e.code === code;
const sqlCode = (code: string) => (e: unknown) =>
  typeof e === "object" && e !== null && "code" in e && e.code === code;

// Accept only the existing disposable fixture's clients and persisted actor.
// Separately callable on its pre-migrated store: no migration/role/bootstrap work.
export async function runPersonalWorkspaceIdentityPostgresTests(
  t: TestContext,
  context: {
    db: PrismaClient;
    secondDb: PrismaClient;
    sql: Client;
    actor: WorkspaceAccountActor;
  },
) {
  const { db, secondDb, sql, actor } = context;
  const mirror = new PrismaProviderAccountSynchronization(db);
  // RED: two external principals of one User provision two scopes, adopt a
  // legacy gh-user scope, or concurrent provisioning leaves an orphan P.
  await t.test(
    "stable User provisioning is atomic across external identities",
    async () => {
      const suffix = randomUUID();
      const userId = `identity-${suffix}`;
      const legacyId = `legacy-${suffix}`;
      const legacySlug = `gh-user-${suffix}`;
      const connectionId = `legacy-source-${suffix}`;
      await db.user.create({ data: { id: userId } });
      await db.userExternalIdentity.createMany({
        data: [
          {
            userId,
            provider: "github",
            externalUserId: suffix,
            login: "first-label",
          },
          {
            userId,
            provider: "gitlab",
            externalUserId: `different-${suffix}`,
            login: "second-label",
          },
        ],
      });
      const legacy = await db.workspace.create({
        data: {
          id: legacyId,
          slug: legacySlug,
          name: "Legacy remains independent",
        },
      });
      await mirror.recordWorkspaceConnection({
        id: connectionId,
        workspaceId: legacyId,
        gatewayAccountRef: `legacy-account-${suffix}`,
        gatewayOperationRef: null,
        profileRef: "c2a-profile",
        displayName: "Legacy source",
        state: "active",
      });
      const originalSource =
        await db.providerAccountConnection.findUniqueOrThrow({
          where: { id: connectionId },
        });
      const github: AuthenticatedPrincipal = {
        userId,
        provider: "github",
        externalUserId: suffix,
        login: "first-label",
        githubUserId: suffix,
        githubLogin: "first-label",
        primaryEmail: null,
        avatarUrl: null,
      };
      const gitlab: AuthenticatedPrincipal = {
        ...github,
        provider: "gitlab",
        externalUserId: `different-${suffix}`,
        login: "second-label",
        githubUserId: null,
        githubLogin: null,
      };
      const repositories = [
        new PrismaWorkspaceMembershipRepository(db),
        new PrismaWorkspaceMembershipRepository(secondDb),
      ];
      try {
        const results = await Promise.all([
          repositories[0]!.ensurePersonalWorkspaceOwner(github),
          repositories[1]!.ensurePersonalWorkspaceOwner(gitlab),
          repositories[0]!.ensurePersonalWorkspaceOwner(gitlab),
          repositories[1]!.ensurePersonalWorkspaceOwner(github),
        ]);
        const first = results[0]!;
        for (const result of results) assert.deepEqual(result, first);
        assert.equal(first.role, "owner");
        assert.equal(first.source, "personal");
        assert.match(first.workspaceSlug!, /^personal-[0-9a-f-]{36}$/);
        assert.notEqual(first.workspaceId, legacyId);
        const scopes = await db.workspace.findMany({
          where: { personalOwnerUserId: userId },
        });
        assert.equal(scopes.length, 1);
        assert.equal(scopes[0]!.id, first.workspaceId);
        assert.equal(scopes[0]!.slug, first.workspaceSlug);
        assert.equal(
          await db.workspace.count({
            where: { members: { some: { userId } } },
          }),
          1,
        );
        assert.equal(
          await db.workspaceMember.count({
            where: { workspaceId: first.workspaceId },
          }),
          1,
        );
        assert.deepEqual(
          await db.workspace.findUnique({ where: { id: legacyId } }),
          legacy,
        );
        assert.deepEqual(
          await db.providerAccountConnection.findUnique({
            where: { id: connectionId },
          }),
          originalSource,
        );
        assert.equal(
          await db.workspaceAccountBinding.count({
            where: { workspaceId: first.workspaceId },
          }),
          0,
        );
        assert.equal(
          await db.providerAccountConnection.count({
            where: { ownerUserId: userId },
          }),
          0,
        );
        const repeated = await repositories[0]!.ensurePersonalWorkspaceOwner({
          ...github,
          login: "new-label",
        });
        assert.deepEqual(repeated, first);
        assert.equal(
          (
            await db.workspace.findUniqueOrThrow({
              where: { id: first.workspaceId },
            })
          ).name,
          "@new-label",
        );

        // RED: a caller invents User authority; transaction creates P despite
        // nonexistent persisted User. Counts must remain unchanged on failure.
        const count = await db.workspace.count();
        await assert.rejects(
          repositories[0]!.ensurePersonalWorkspaceOwner({
            ...github,
            userId: `missing-${suffix}`,
          }),
          /personal_workspace_user_not_found/,
        );
        assert.equal(await db.workspace.count(), count);

        // RED: SQL permits duplicate owners, transfer/removal, adoption of a
        // NULL-owned legacy scope, or mutable personal slug even without ORM.
        await assert.rejects(
          sql.query(
            `INSERT INTO "Workspace" ("id", "slug", "name", "personalOwnerUserId", "updatedAt") VALUES ($1, $1, 'Duplicate', $2, now())`,
            [`duplicate-${suffix}`, userId],
          ),
          sqlCode("23505"),
        );
        await assert.rejects(
          sql.query(
            `UPDATE "Workspace" SET "personalOwnerUserId" = $1 WHERE "id" = $2`,
            [actor.userId, first.workspaceId],
          ),
          sqlCode("23514"),
        );
        await assert.rejects(
          sql.query(
            `UPDATE "Workspace" SET "personalOwnerUserId" = NULL WHERE "id" = $1`,
            [first.workspaceId],
          ),
          sqlCode("23514"),
        );
        await assert.rejects(
          sql.query(
            `UPDATE "Workspace" SET "personalOwnerUserId" = $1 WHERE "id" = $2`,
            [userId, legacyId],
          ),
          sqlCode("23514"),
        );
        await assert.rejects(
          sql.query(`UPDATE "Workspace" SET "slug" = $1 WHERE "id" = $2`, [
            `renamed-${suffix}`,
            first.workspaceId,
          ]),
          sqlCode("23514"),
        );
        await assert.rejects(
          sql.query(`UPDATE "Workspace" SET "id" = $1 WHERE "id" = $2`, [
            `replaced-${suffix}`,
            first.workspaceId,
          ]),
          sqlCode("23514"),
        );
        assert.deepEqual(
          await db.workspace.findUnique({ where: { id: legacyId } }),
          legacy,
        );
        assert.equal(
          (
            await db.workspace.findUniqueOrThrow({
              where: { personalOwnerUserId: userId },
            })
          ).id,
          first.workspaceId,
        );
      } finally {
        await db.providerAccountConnection.deleteMany({
          where: { id: connectionId },
        });
        await db.workspace.deleteMany({
          where: { OR: [{ id: legacyId }, { personalOwnerUserId: userId }] },
        });
        await db.user.delete({ where: { id: userId } });
      }
    },
  );

  // RED: login implicitly enrolls an absent installation membership; explicit
  // re-grant/login promotes a demoted User, deletes duplicates or reassigns a
  // login-only/other-User row. Exercise both real production repositories.
  await t.test(
    "installation enrollment is explicit and preserves existing roles",
    async () => {
      const suffix = randomUUID();
      const installWorkspace = `install-${suffix}`;
      const userId = `install-user-${suffix}`;
      const githubId = BigInt(
        800000000 + Number.parseInt(suffix.slice(0, 8), 16),
      );
      const installationId = githubId + 10000000000n;
      const login = `login-${suffix}`;
      const principal: AuthenticatedPrincipal = {
        userId,
        provider: "github",
        externalUserId: String(githubId),
        login,
        githubUserId: String(githubId),
        githubLogin: login,
        primaryEmail: null,
        avatarUrl: null,
      };
      const repository = new PrismaWorkspaceMembershipRepository(db);
      const grants = new PrismaInstallationWorkspaceOwnerGrant(db);
      const grant = {
        githubInstallationId: String(installationId),
        githubUserId: String(githubId),
        githubLogin: login,
      };
      await db.workspace.create({
        data: {
          id: installWorkspace,
          slug: installWorkspace,
          name: "Disposable installation",
        },
      });
      await db.user.create({
        data: { id: userId, githubUserId: githubId, githubLogin: login },
      });
      await db.gitHubInstallation.create({
        data: {
          workspaceId: installWorkspace,
          githubInstallationId: installationId,
          accountLogin: login.toUpperCase(),
          accountType: "User",
          repositorySelection: "all",
          status: "active",
        },
      });
      try {
        assert.deepEqual(
          await repository.ensureGitHubUserInstallationWorkspaceOwners(
            principal,
          ),
          [],
        );
        assert.equal(
          await db.workspaceMember.count({
            where: { workspaceId: installWorkspace },
          }),
          0,
        );
        await grants.grantInstallationActorOwner(grant);
        const member = await db.workspaceMember.findUniqueOrThrow({
          where: {
            workspaceId_userId: { workspaceId: installWorkspace, userId },
          },
        });
        assert.equal(member.role, "owner");
        for (const role of ["member", "admin"] as const) {
          await db.workspaceMember.update({
            where: { id: member.id },
            data: { role },
          });
          const before = await db.workspaceMember.findUniqueOrThrow({
            where: { id: member.id },
          });
          assert.deepEqual(
            await repository.ensureGitHubUserInstallationWorkspaceOwners(
              principal,
            ),
            [
              {
                workspaceId: installWorkspace,
                workspaceSlug: installWorkspace,
                role,
                source: "github_user_installation",
              },
            ],
          );
          await grants.grantInstallationActorOwner(grant);
          assert.deepEqual(
            await db.workspaceMember.findUnique({ where: { id: member.id } }),
            before,
          );
        }
        await db.workspaceMember.update({
          where: { id: member.id },
          data: { githubLogin: `old-${suffix}` },
        });
        const legacy = await db.workspaceMember.create({
          data: {
            workspaceId: installWorkspace,
            githubLogin: login,
            role: "member",
          },
        });
        const before = await db.workspaceMember.findMany({
          where: { workspaceId: installWorkspace },
          orderBy: { id: "asc" },
        });
        await grants.grantInstallationActorOwner(grant);
        assert.deepEqual(
          await db.workspaceMember.findMany({
            where: { workspaceId: installWorkspace },
            orderBy: { id: "asc" },
          }),
          before,
        );
        await db.workspaceMember.delete({ where: { id: member.id } });
        assert.deepEqual(
          await repository.ensureGitHubUserInstallationWorkspaceOwners(
            principal,
          ),
          [],
        );
        await assert.rejects(
          grants.grantInstallationActorOwner(grant),
          /installation_owner_grant_identity_ambiguous/,
        );
        assert.deepEqual(
          await db.workspaceMember.findMany({
            where: { workspaceId: installWorkspace },
          }),
          [legacy],
        );
        await db.workspaceMember.update({
          where: { id: legacy.id },
          data: { userId: actor.userId! },
        });
        await assert.rejects(
          grants.grantInstallationActorOwner(grant),
          /installation_owner_grant_identity_ambiguous/,
        );
        assert.equal(
          (
            await db.workspaceMember.findUniqueOrThrow({
              where: { id: legacy.id },
            })
          ).userId,
          actor.userId,
        );
        assert.deepEqual(
          await repository.ensureGitHubUserInstallationWorkspaceOwners({
            ...principal,
            provider: "gitlab",
            githubLogin: null,
          }),
          [],
        );
      } finally {
        await db.workspace.delete({ where: { id: installWorkspace } });
        await db.user.delete({ where: { id: userId } });
      }
    },
  );
}

export async function runBindingFencePostgresTests(
  t: TestContext,
  context: {
    db: PrismaClient;
    sql: Client;
    workspaceId: string;
    foreignWorkspaceId: string;
    actor: WorkspaceAccountActor;
    dependencies: ProviderAccountDependencies;
    createPrisma: () => PrismaClient;
    targetUrl: string;
    personalOperationsOnly?: true;
  },
) {
  const { db, sql, workspaceId, foreignWorkspaceId, actor, dependencies } =
    context;
  const accounts = new PrismaProviderAccountRepository(db);
  const mirror = new PrismaProviderAccountSynchronization(db);
  const secondDb = context.createPrisma();
  const second = new PrismaProviderAccountRepository(secondDb);
  const x = { workspaceId, connectionId: "c2a-connection-x" };
  const y = { workspaceId, connectionId: "c2a-connection-y" };
  let bindingId = "";
  const resolveX = (repository = accounts) =>
    resolveWorkspaceAccountBinding(
      { workspaceId, bindingId, actor },
      { ...dependencies, accounts: repository },
    );
  let original!: ScopedBindingFence;
  let replacement!: ScopedBindingFence;
  try {
    if (!context.personalOperationsOnly) {
      await runPersonalWorkspaceIdentityPostgresTests(t, {
        db,
        secondDb,
        sql,
        actor,
      });
    }

    // RED: pair/history races, terminal resurrection, old FK adoption, stale
    // lineage reuse or role loss leaves personal authority alive in this real DB.
    await t.test(
      "personal issued lifetime and coordinated eligibility loss",
      async () => {
        const suffix = randomUUID();
        const persistedBinding = (id: string) =>
          db.workspaceAccountBinding.findUniqueOrThrow({ where: { id } });
        const userId = `h-owner-${suffix}`,
          adminId = `h-admin-${suffix}`;
        const store = new PrismaPersonalAccountOperations(db),
          other = new PrismaPersonalAccountOperations(secondDb);
        await db.user.createMany({ data: [{ id: userId }, { id: adminId }] });
        const personalWorkspaceId =
          await store.resolvePersonalWorkspace(userId);
        const orgs = await Promise.all(
          ["x", "y"].map((name) =>
            db.workspace.create({
              data: { slug: `h-${name}-${suffix}`, name },
            }),
          ),
        );
        const orgX = orgs[0]!.id,
          orgY = orgs[1]!.id;
        await db.workspaceMember.createMany({
          data: [
            { workspaceId: orgX, userId, role: "owner" },
            { workspaceId: orgY, userId, role: "owner" },
            { workspaceId: orgX, userId: adminId, role: "admin" },
          ],
        });
        const connect: PersonalAccountIntent & { action: "connect" } = {
          action: "connect",
          actorUserId: userId,
          clientOperationId: randomUUID(),
          personalWorkspaceId,
          proposedSourceId: `h-source-${suffix}`,
          profileId: "fixture-profile",
          displayName: "Canonical",
          ingress: "api-key-create",
        };
        const foreignPersonalWorkspaceId =
          await store.resolvePersonalWorkspace(adminId);
        const reserved = await store.reserveConnect(connect);
        assert.equal(
          await db.providerAccountConnection.count({
            where: { id: connect.proposedSourceId },
          }),
          0,
        ); // reservation is not an absent-row FK
        assert.equal(
          await store.claimConnect(userId, connect.clientOperationId),
          true,
        );
        const created = await store.finalizeConnect(
          userId,
          connect.clientOperationId,
          {
            accountRef: `h-account-${suffix}`,
            profileId: connect.profileId,
            displayName: connect.displayName,
            state: "active",
            metadataRevision: 1,
            authorizationEpoch: 7,
          },
        );
        assert.equal(created.id, reserved.id);
        for (const changed of [
          { personalWorkspaceId: foreignPersonalWorkspaceId },
          { proposedSourceId: `changed-${suffix}` },
          { profileId: "other-profile" },
          { displayName: "Other" },
          { ingress: "oauth-begin" as const },
        ])
          await assert.rejects(
            store.reserveConnect({ ...connect, ...changed }),
            denied("operation_conflict"),
          );
        const attach = (
          targetWorkspaceId: string,
          predecessorBindingId: string | null = null,
          expectedPredecessorRevision: number | null = null,
        ): PersonalAccountIntent & { action: "attach" } => ({
          action: "attach",
          actorUserId: userId,
          clientOperationId: randomUUID(),
          personalWorkspaceId,
          sourceId: connect.proposedSourceId,
          targetWorkspaceId,
          expectedSourceMetadataRevision: 1,
          expectedGatewayRevision: 1,
          predecessorBindingId,
          expectedPredecessorRevision,
        });
        const intents = [attach(orgX), attach(orgX)];
        const raced = await Promise.allSettled([
          store.attach(intents[0]!),
          other.attach(intents[1]!),
        ]);
        assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal(
          await db.workspaceAccountBinding.count({
            where: {
              workspaceId: orgX,
              connectionId: connect.proposedSourceId,
              state: "active",
            },
          }),
          1,
        );
        const root = raced.find((r) => r.status === "fulfilled");
        assert.ok(root && root.status === "fulfilled" && root.value.binding);
        const bx = root.value.binding;
        const y = await store.attach(attach(orgY));
        const config = await db.reviewConfiguration.create({
          data: { workspaceId: orgX, targetKey: "default" },
        });
        const version = await db.reviewConfigurationVersion.create({
          data: {
            configurationId: config.id,
            workspaceId: orgX,
            version: 1,
            schemaVersion: 2,
            gatewayBindingId: bx.id,
            gatewayProfileRef: connect.profileId,
            providerKind: "codex",
            providerAuthMode: "codex_account_gateway",
            model: "fixture",
            reasoningEffort: "high",
            failOnSeverity: "high",
            inlineMaxComments: 10,
            targetTokensPerBatch: 1000,
          },
        });
        const revoke = (
          bindingId: string,
          expectedBindingRevision: number,
          targetWorkspaceId = orgX,
        ): PersonalAccountIntent & { action: "revoke" } => ({
          action: "revoke",
          actorUserId: userId,
          clientOperationId: randomUUID(),
          personalWorkspaceId,
          sourceId: connect.proposedSourceId,
          targetWorkspaceId,
          expectedSourceMetadataRevision: 1,
          expectedGatewayRevision: 1,
          bindingId,
          expectedBindingRevision,
        });
        const member = await db.workspaceMember.findUniqueOrThrow({
          where: { workspaceId_userId: { workspaceId: orgX, userId } },
        });
        await store.changeEligibility({
          actorUserId: adminId,
          workspaceId: orgX,
          memberId: member.id,
          userId,
          expectedRole: "owner",
          nextRole: "admin",
        });
        assert.equal((await persistedBinding(bx.id)).revision, 1); // eligible role change preserves live authority
        const retired = await store.revoke({
          ...revoke(bx.id, 1),
          actorUserId: adminId,
        });
        assert.equal(retired.binding!.state, "revoked");
        await assert.rejects(
          store.attach(attach(orgX, bx.id, 2)),
          denied("operation_conflict"),
        ); // ACK is mandatory
        const fence = {
          bindingId: bx.id,
          workspaceId: orgX,
          ...retired.binding!.pendingFence!,
        };
        assert.equal(await accounts.acknowledgeBindingFence(fence), true); // unchanged-ID exact ACK survives terminal guard
        await assert.rejects(
          sql.query(
            `UPDATE "WorkspaceAccountBinding" SET "state"='active', "revision"="revision"+1, "policyRevision"="policyRevision"+1 WHERE "id"=$1`,
            [bx.id],
          ),
          sqlCode("23514"),
        );
        const successorIntent = attach(orgX, bx.id, 2);
        const successor = await store.attach(successorIntent);
        assert.notEqual(successor.binding!.id, bx.id);
        assert.equal(await accounts.acknowledgeBindingFence(fence), false); // late old ACK cannot clear successor
        assert.equal(
          (
            await db.reviewConfigurationVersion.findUniqueOrThrow({
              where: { id: version.id },
            })
          ).gatewayBindingId,
          bx.id,
        );
        const old = await accounts.findBinding({
          workspaceId: orgX,
          bindingId: bx.id,
        });
        assert.throws(
          () => selectBinding(orgX, bx.id, old),
          denied("binding_unavailable"),
        );
        await assert.rejects(
          store.attach({
            ...attach(orgX),
            actorUserId: adminId,
            personalWorkspaceId: await store.resolvePersonalWorkspace(adminId),
          }),
          denied("connection_unavailable"),
        );
        await assert.rejects(
          store.attach(attach(personalWorkspaceId)),
          denied("connection_unavailable"),
        );
        await assert.rejects(
          store.attach(attach(orgX, created.binding!.id, 1)),
          denied("operation_conflict"),
        ); // P connect is not an org issuance
        const secondRetired = await store.revoke(
          revoke(successor.binding!.id, 1),
        );
        assert.equal(
          await accounts.acknowledgeBindingFence({
            bindingId: successor.binding!.id,
            workspaceId: orgX,
            ...secondRetired.binding!.pendingFence!,
          }),
          true,
        );
        await assert.rejects(
          store.attach(attach(orgX, bx.id, 2)),
          denied("operation_conflict"),
        ); // consumed lineage stays occupied after retirement
        const repeated = await other.attach(successorIntent);
        assert.equal(repeated.binding!.id, successor.binding!.id);
        assert.equal(repeated.available, false);
        for (const query of [
          `UPDATE "PersonalAccountOperation" SET "phase"='rejected', "resultSourceId"=NULL, "resultBindingId"=NULL WHERE "id"=$1`,
          `DELETE FROM "PersonalAccountOperation" WHERE "id"=$1`,
          `UPDATE "PersonalAccountOperation" SET "expectedGatewayRevision"=2 WHERE "id"=$1`,
        ])
          await assert.rejects(
            sql.query(query, [successor.id]),
            sqlCode("23514"),
          );
        assert.equal((await persistedBinding(y.binding!.id)).revision, 1);
        // Actual concurrent mutation and attachment: either attach loses eligibility
        // or it commits first and the same role-loss transaction retires that ID.
        await Promise.allSettled([
          other.attach(attach(orgX, successor.binding!.id, 2)),
          store.changeEligibility({
            actorUserId: adminId,
            workspaceId: orgX,
            memberId: member.id,
            userId,
            expectedRole: "admin",
            nextRole: "member",
          }),
        ]);
        assert.equal(
          (
            await db.workspaceMember.findUniqueOrThrow({
              where: { id: member.id },
            })
          ).role,
          "member",
        );
        assert.equal(
          await db.workspaceAccountBinding.count({
            where: {
              workspaceId: orgX,
              connectionId: connect.proposedSourceId,
              state: "active",
            },
          }),
          0,
        );
        await store.changeEligibility({
          actorUserId: adminId,
          workspaceId: orgX,
          memberId: member.id,
          userId,
          expectedRole: "member",
          nextRole: "owner",
        });
        assert.equal(
          await db.workspaceAccountBinding.count({
            where: {
              workspaceId: orgX,
              connectionId: connect.proposedSourceId,
              state: "active",
            },
          }),
          0,
        ); // rejoin cannot revive
        assert.equal(
          (await persistedBinding(created.binding!.id)).state,
          "active",
        );
        assert.equal((await persistedBinding(y.binding!.id)).state, "active");
        // Owner revoke needs no target membership; a different local admin requires its own current role.
        const local = {
          ...revoke(y.binding!.id, 1, orgY),
          actorUserId: adminId,
        };
        await assert.rejects(
          store.revoke(local),
          denied("workspace_forbidden"),
        );
        await db.workspaceMember.deleteMany({
          where: { workspaceId: orgY, userId },
        });
        assert.equal(
          (await store.revoke(revoke(y.binding!.id, 1, orgY))).binding!.state,
          "revoked",
        );
        // Retain these scoped receipts/history for MAIN inspection in the disposable DB.
      },
    );

    if (context.personalOperationsOnly) return;

    await db.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId, userId: actor.userId! } },
      create: { workspaceId, userId: actor.userId!, role: "admin" },
      update: { role: "admin" },
    });
    for (const scope of [x, y]) {
      await mirror.recordWorkspaceConnection({
        id: scope.connectionId,
        workspaceId,
        gatewayAccountRef: `gateway-${scope.connectionId}`,
        gatewayOperationRef: null,
        profileRef: "c2a-profile",
        displayName: "C2a synthetic account",
        state: "active",
      });
      await bindWorkspaceAccount(
        { ...scope, actor, expectedRevision: 0 },
        dependencies,
      );
    }

    // Regression: migration reconstructs policyRevision from the old CAS version,
    // or forgets already locally revoked uses when installing remote fencing.
    await t.test(
      "118 backfill keeps old CAS versions and independently initializes policy",
      async () => {
        const seeded = await sql.query(
          `SELECT * FROM "WorkspaceAccountBinding" WHERE "workspaceId" = 'c2a-bootstrap-workspace' ORDER BY "id"`,
        );
        assert.equal(seeded.rows.length, 2);
        const active = seeded.rows[0];
        const revoked = seeded.rows[1];
        assert.equal(active.revision, 3);
        assert.equal(active.policyRevision, 1);
        assert.equal(active.pendingFenceOperationId, null);
        assert.equal(revoked.revision, 2);
        assert.equal(revoked.policyRevision, 1);
        assert.equal(
          revoked.pendingFencePolicySubject,
          "c2a-bootstrap-revoked",
        );
        assert.equal(revoked.pendingFencePolicyRevision, 1);
        assert.match(revoked.pendingFenceOperationId, /^[0-9a-f-]{36}$/);
        const bootstrapIntent: ScopedBindingFence = {
          bindingId: "c2a-bootstrap-revoked",
          workspaceId: "c2a-bootstrap-workspace",
          operationId: revoked.pendingFenceOperationId,
          policySubject: "c2a-bootstrap-revoked",
          policyRevision: 1,
        };
        const bootstrapDelivery: WorkspaceBindingFenceDeliveryPort = {
          async submitFence(input): Promise<BindingFenceResponse> {
            return input.bindingId === "c2a-bootstrap-revoked"
              ? {
                  state: "applied",
                  operationId: revoked.pendingFenceOperationId,
                  policySubject: "c2a-bootstrap-revoked",
                  policyRevision: 1,
                }
              : { state: "unknown" };
          },
          async readFenceOperation(): Promise<BindingFenceResponse> {
            return { state: "unknown" };
          },
        };
        await reconcileWorkspaceBindingFences(
          { limit: 100 },
          { accounts: second, delivery: bootstrapDelivery },
        );
        const bootstrapAck = await accounts.findBinding({
          workspaceId: "c2a-bootstrap-workspace",
          bindingId: "c2a-bootstrap-revoked",
        });
        assert.equal(bootstrapAck?.binding.revision, 2);
        assert.equal(bootstrapAck?.binding.policyRevision, 1);
        assert.equal(bootstrapAck?.binding.state, "revoked");
        assert.equal(bootstrapAck?.binding.pendingFence, null);
        assert.deepEqual(bootstrapAck?.binding.fenceAck, {
          operationId: bootstrapIntent.operationId,
          policyRevision: 1,
        });
        const tuple = await accounts.findBinding({
          workspaceId: "c2a-bootstrap-workspace",
          bindingId: "c2a-bootstrap-active",
        });
        assert.ok(tuple);
        const { selectBinding } =
          await import("../src/domain/provider-account");
        assert.deepEqual(
          selectBinding(
            "c2a-bootstrap-workspace",
            "c2a-bootstrap-active",
            tuple,
          ),
          {
            workspaceId: "c2a-bootstrap-workspace",
            bindingId: "c2a-bootstrap-active",
            bindingRevision: 3,
            policySubject: "c2a-bootstrap-active",
            policyRevision: 1,
            connectionId: "c2a-bootstrap-active-connection",
            gatewayAccountRef: "c2a-bootstrap-active-account",
            profileRef: null,
          },
        );
      },
    );

    // Regression: local denial commits without an intent, or X's revoke denies Y.
    await t.test(
      "revoke atomically denies X with exact intent; Y and account mirror stay unchanged",
      async () => {
        const result = await revokeWorkspaceAccountBinding(
          { ...x, actor, expectedRevision: 1 },
          dependencies,
        );
        bindingId = result.id;
        assert.equal(result.localAuthorization, "local_denied");
        assert.equal(result.remoteFenceDelivery, "remote_pending");
        const persisted = (
          await sql.query(
            `SELECT * FROM "WorkspaceAccountBinding" WHERE "id" = $1`,
            [bindingId],
          )
        ).rows[0];
        assert.equal(persisted.state, "revoked");
        assert.equal(persisted.revision, 2);
        assert.equal(persisted.policyRevision, 2);
        assert.equal(persisted.pendingFencePolicySubject, bindingId);
        assert.equal(persisted.pendingFencePolicyRevision, 2);
        assert.equal(persisted.fenceAckOperationId, null);
        assert.match(persisted.pendingFenceOperationId, /^[0-9a-f-]{36}$/);
        original = {
          bindingId,
          workspaceId,
          operationId: persisted.pendingFenceOperationId,
          policySubject: bindingId,
          policyRevision: 2,
        };
        await assert.rejects(resolveX(), denied("binding_unavailable"));
        const yBinding = await db.workspaceAccountBinding.findFirstOrThrow({
          where: y,
          orderBy: [{ state: "asc" }, { createdAt: "desc" }, { id: "desc" }],
        });
        const executableY = await resolveWorkspaceAccountBinding(
          { workspaceId, bindingId: yBinding.id, actor },
          dependencies,
        );
        assert.equal(executableY.bindingRevision, 1);
        assert.equal(executableY.policyRevision, 1);
        const accountX = await db.providerAccountConnection.findUniqueOrThrow({
          where: { id: x.connectionId },
        });
        assert.equal(accountX.metadataRevision, 1);
        assert.equal(accountX.state, "active");
      },
    );

    // Regression: direct SQL ACK fields manufacture authority, wrong scope ACKs
    // clear pending requirements, or identity/negative/overflow guards disappear.
    await t.test(
      "wrong ACKs and direct SQL authority/identity/overflow violations are refused",
      async () => {
        for (const intent of [
          { ...original, operationId: "wrong-operation" },
          { ...original, workspaceId: foreignWorkspaceId },
          { ...original, policyRevision: 1 },
          { ...original, policyRevision: 3 },
        ])
          assert.equal(await second.acknowledgeBindingFence(intent), false);
        for (const intent of [
          { ...original, policySubject: "wrong-binding" },
          { ...original, policyRevision: -1 },
          { ...original, policyRevision: 2147483648 },
        ])
          await assert.rejects(
            second.acknowledgeBindingFence(intent),
            denied("invalid_input"),
          );
        const clauses = [
          `"id" = 'changed-binding'`,
          `"workspaceId" = '${foreignWorkspaceId}'`,
          `"connectionId" = '${y.connectionId}'`,
          `"createdAt" = "createdAt" + interval '1 second'`,
          `"state" = 'active'`,
          `"revision" = 0`,
          `"policyRevision" = -1`,
          `"revision" = 3`,
          `"policyRevision" = 3`,
          `"pendingFencePolicySubject" = 'wrong-binding'`,
          `"pendingFencePolicyRevision" = -1`,
          `"pendingFenceOperationId" = 'changed-operation'`,
          `"pendingFenceOperationId" = NULL, "pendingFencePolicySubject" = NULL, "pendingFencePolicyRevision" = NULL`,
          `"pendingFenceOperationId" = NULL, "pendingFencePolicySubject" = NULL, "pendingFencePolicyRevision" = NULL, "fenceAckOperationId" = 'wrong-operation', "fenceAckPolicyRevision" = 2`,
          `"state" = 'active', "revision" = 3, "policyRevision" = 3, "pendingFenceOperationId" = NULL, "pendingFencePolicySubject" = NULL, "pendingFencePolicyRevision" = NULL`,
          `"state" = 'revoked', "revision" = 3, "policyRevision" = 3, "pendingFencePolicyRevision" = 3`,
          `"state" = 'revoked', "revision" = 3, "policyRevision" = 3, "pendingFencePolicyRevision" = 3, "pendingFenceOperationId" = repeat('a', 161)`,
        ];
        for (const clause of clauses)
          await assert.rejects(
            sql.query(
              `UPDATE "WorkspaceAccountBinding" SET ${clause} WHERE "id" = $1`,
              [bindingId],
            ),
            sqlCode("23514"),
          );
        for (const field of [
          "revision",
          "policyRevision",
          "pendingFencePolicyRevision",
          "fenceAckPolicyRevision",
        ])
          await assert.rejects(
            sql.query(
              `UPDATE "WorkspaceAccountBinding" SET "${field}" = 2147483648 WHERE "id" = $1`,
              [bindingId],
            ),
            sqlCode("22003"),
          );
        await assert.rejects(
          accounts.compareAndSetBinding({
            ...x,
            state: "revoked",
            expectedRevision: 2147483647,
          }),
          denied("invalid_input"),
        );
        const row = await accounts.findBinding({ workspaceId, bindingId });
        assert.deepEqual(row?.binding.pendingFence, {
          operationId: original.operationId,
          policySubject: bindingId,
          policyRevision: 2,
        });
        assert.equal(row?.binding.revision, 2);
        assert.equal(row?.binding.policyRevision, 2);
      },
    );

    // Regression: a consumer crash forgets/recreates the operation; a simulated
    // trusted delivery receipt is confused with successful local bookkeeping.
    await t.test(
      "restart recovers the exact persisted operation after a lost local ACK write",
      async () => {
        await bindWorkspaceAccount(
          { ...x, actor, expectedRevision: 2 },
          dependencies,
        );
        await assert.rejects(resolveX(), denied("binding_unavailable"));
        assert.equal(
          await second.acknowledgeBindingFence({
            ...original,
            operationId: "wrong-operation",
          }),
          false,
        );
        await assert.rejects(resolveX(), denied("binding_unavailable"));
        const seen: ScopedBindingFence[] = [];
        let applied = false;
        const delivery: WorkspaceBindingFenceDeliveryPort = {
          async submitFence(input) {
            if (input.bindingId === bindingId) seen.push(input);
            return { state: "unknown" };
          },
          async readFenceOperation(input): Promise<BindingFenceResponse> {
            return input.bindingId === bindingId && applied
              ? {
                  state: "applied",
                  operationId: original.operationId,
                  policySubject: bindingId,
                  policyRevision: 2,
                }
              : {
                  state:
                    input.bindingId === bindingId ? "unknown" : "not_found",
                };
          },
        };
        const unknown = await reconcileWorkspaceBindingFences(
          { limit: 100 },
          { accounts: second, delivery },
        );
        assert.equal(
          unknown.results.find((r) => r.bindingId === bindingId)
            ?.remoteFenceDelivery,
          "remote_pending",
        );
        await assert.rejects(resolveX(), denied("binding_unavailable"));
        applied = true;
        const lostWrite = {
          listPendingBindingFences:
            accounts.listPendingBindingFences.bind(accounts),
          async acknowledgeBindingFence() {
            throw new Error("synthetic crash before write");
          },
        };
        const lost = await reconcileWorkspaceBindingFences(
          { limit: 100 },
          { accounts: lostWrite, delivery },
        );
        assert.equal(
          lost.results.find((r) => r.bindingId === bindingId)
            ?.remoteFenceDelivery,
          "remote_pending",
        );
        const restarted = context.createPrisma();
        try {
          const reader = new PrismaProviderAccountRepository(restarted);
          const pending = (
            await reader.listPendingBindingFences({ limit: 100 })
          ).find((row) => row.id === bindingId);
          assert.deepEqual(pending?.pendingFence, {
            operationId: original.operationId,
            policySubject: bindingId,
            policyRevision: 2,
          });
          assert.equal(pending?.revision, 3);
          assert.equal(pending?.policyRevision, 3);
          await assert.rejects(resolveX(reader), denied("binding_unavailable"));
          // Read again through the new client without acknowledging.
          await reconcileWorkspaceBindingFences(
            { limit: 100 },
            {
              accounts: {
                listPendingBindingFences:
                  reader.listPendingBindingFences.bind(reader),
                async acknowledgeBindingFence() {
                  return false;
                },
              },
              delivery,
            },
          );
        } finally {
          await restarted.$disconnect();
        }
        assert.deepEqual(seen, [original, original, original]);
        // A new Node process cannot reuse the original repository or its heap.
        const restartedProcess = spawnSync(
          process.execPath,
          [
            "--experimental-transform-types",
            "--import",
            fileURLToPath(
              new URL("./register-source-loader.mjs", import.meta.url),
            ),
            fileURLToPath(
              new URL("./fence-restart.fixture.mts", import.meta.url),
            ),
            context.targetUrl,
            workspaceId,
            bindingId,
          ],
          {
            encoding: "utf8",
            timeout: 15_000,
            env: { PATH: process.env.PATH },
          },
        );
        assert.equal(restartedProcess.error, undefined);
        assert.equal(restartedProcess.status, 0, restartedProcess.stderr);
        assert.deepEqual(JSON.parse(restartedProcess.stdout), original);
        await assert.rejects(resolveX(), denied("binding_unavailable"));
        assert.equal(await second.acknowledgeBindingFence(original), true);
        const acked = await accounts.findBinding({ workspaceId, bindingId });
        assert.equal(acked?.binding.pendingFence, null);
        assert.deepEqual(acked?.binding.fenceAck, {
          operationId: original.operationId,
          policyRevision: 2,
        });
        const selected = await resolveX();
        assert.equal(selected.bindingRevision, 3);
        assert.equal(selected.policyRevision, 3);
        // Leave an exact, still-pending receipt for the existing blocked ACK race.
        const revoked = await revokeWorkspaceAccountBinding(
          { ...x, actor, expectedRevision: 3 },
          dependencies,
        );
        assert.ok(revoked.pendingFence);
        original = { bindingId, workspaceId, ...revoked.pendingFence };
      },
    );

    // Regression: an ACK that matched before waiting on another transaction
    // clears its later, higher replacement. The wait is observed in real PG.
    await t.test(
      "two sessions serialize revoke replacement against a blocked stale ACK",
      async () => {
        const previousAck = (
          await accounts.findBinding({ workspaceId, bindingId })
        )?.binding.fenceAck;
        await sql.query("BEGIN");
        let revoking:
          | ReturnType<typeof revokeWorkspaceAccountBinding>
          | undefined;
        let acknowledging: Promise<boolean> | undefined;
        async function waitForBlockedWriters(count: number) {
          const deadline = Date.now() + 5000;
          let observed = 0;
          while (observed < count && Date.now() < deadline) {
            await sql.query("SELECT pg_stat_clear_snapshot()");
            const activity =
              await sql.query(`SELECT count(*)::int AS blocked FROM pg_stat_activity
            WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
            AND query LIKE '%WorkspaceAccountBinding%'`);
            observed = activity.rows[0].blocked;
            if (observed < count)
              await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(
            observed >= count,
            true,
            "actual repository writers must block on the held row lock",
          );
        }
        try {
          await sql.query(
            `SELECT "id" FROM "WorkspaceAccountBinding" WHERE "id" = $1 FOR UPDATE`,
            [bindingId],
          );
          // Queue the actual authorized revoke first, then the actual old ACK.
          // No persistence/CAS/revision or return value is replaced by the barrier.
          revoking = revokeWorkspaceAccountBinding(
            { ...x, actor, expectedRevision: 4 },
            { ...dependencies, accounts: second },
          );
          await waitForBlockedWriters(1);
          acknowledging = accounts.acknowledgeBindingFence(original);
          await waitForBlockedWriters(2);
        } finally {
          await sql.query("COMMIT");
        }
        assert.equal((await revoking)?.revision, 5);
        assert.equal(await acknowledging, false);
        const persisted = (
          await sql.query(
            `SELECT * FROM "WorkspaceAccountBinding" WHERE "id" = $1`,
            [bindingId],
          )
        ).rows[0];
        assert.match(persisted.pendingFenceOperationId, /^[0-9a-f-]{36}$/);
        assert.notEqual(
          persisted.pendingFenceOperationId,
          original.operationId,
        );
        replacement = {
          bindingId,
          workspaceId,
          operationId: persisted.pendingFenceOperationId,
          policySubject: bindingId,
          policyRevision: 5,
        };
        const row = await second.findBinding({ workspaceId, bindingId });
        assert.deepEqual(row?.binding.pendingFence, {
          operationId: replacement.operationId,
          policySubject: bindingId,
          policyRevision: 5,
        });
        assert.deepEqual(row?.binding.fenceAck, previousAck);
      },
    );

    // Regression: grant drops a still-unacknowledged older requirement; ACK-only
    // bookkeeping advances versions, restores state, or accepts the old ACK.
    await t.test(
      "fresh grant retains the higher requirement until its actual ACK; ACK keeps both versions",
      async () => {
        await bindWorkspaceAccount(
          { ...x, actor, expectedRevision: 5 },
          dependencies,
        );
        const granted = await accounts.findBinding({ workspaceId, bindingId });
        assert.equal(granted?.binding.revision, 6);
        assert.equal(granted?.binding.policyRevision, 6);
        assert.equal(granted?.binding.pendingFence?.policyRevision, 5);
        assert.equal(await second.acknowledgeBindingFence(original), false);
        await assert.rejects(resolveX(), denied("binding_unavailable"));
        const delivery: WorkspaceBindingFenceDeliveryPort = {
          async submitFence(): Promise<BindingFenceResponse> {
            return { state: "pending" };
          },
          async readFenceOperation(input): Promise<BindingFenceResponse> {
            return input.bindingId === bindingId
              ? {
                  state: "applied",
                  operationId: replacement.operationId,
                  policySubject: bindingId,
                  policyRevision: 5,
                }
              : { state: "unknown" };
          },
        };
        const result = await reconcileWorkspaceBindingFences(
          { limit: 100 },
          { accounts: second, delivery },
        );
        assert.equal(
          result.results.find((r) => r.bindingId === bindingId)
            ?.remoteFenceDelivery,
          "remote_applied",
        );
        const acked = await accounts.findBinding({ workspaceId, bindingId });
        assert.equal(acked?.binding.revision, 6);
        assert.equal(acked?.binding.policyRevision, 6);
        assert.equal(acked?.binding.state, "active");
        assert.equal(acked?.binding.pendingFence, null);
        assert.deepEqual(acked?.binding.fenceAck, {
          operationId: replacement.operationId,
          policyRevision: 5,
        });
        assert.equal(
          await accounts.acknowledgeBindingFence(replacement),
          false,
        );
        await revokeWorkspaceAccountBinding(
          { ...x, actor, expectedRevision: 6 },
          dependencies,
        );
        await db.workspaceMember.update({
          where: { workspaceId_userId: { workspaceId, userId: actor.userId! } },
          data: { role: "member" },
        });
        await assert.rejects(
          bindWorkspaceAccount(
            { ...x, actor, expectedRevision: 7 },
            dependencies,
          ),
          denied("workspace_forbidden"),
        );
        await db.workspaceMember.update({
          where: { workspaceId_userId: { workspaceId, userId: actor.userId! } },
          data: { role: "admin" },
        });
        await assert.rejects(resolveX(), denied("binding_unavailable"));
        await bindWorkspaceAccount(
          { ...x, actor, expectedRevision: 7 },
          dependencies,
        );
        await assert.rejects(resolveX(), denied("binding_unavailable"));
        assert.equal(
          await accounts.acknowledgeBindingFence(replacement),
          false,
        );
        const rebound = await accounts.findBinding({ workspaceId, bindingId });
        assert.ok(rebound?.binding.pendingFence);
        assert.equal(
          await accounts.acknowledgeBindingFence({
            bindingId,
            workspaceId,
            ...rebound.binding.pendingFence,
          }),
          true,
        );
        const selected = await resolveWorkspaceAccountBinding(
          { workspaceId, bindingId, actor },
          dependencies,
        );
        assert.equal(selected.bindingRevision, 8);
        assert.equal(selected.policyRevision, 8);
        const unchangedY = await db.workspaceAccountBinding.findFirstOrThrow({
          where: y,
          orderBy: [{ state: "asc" }, { createdAt: "desc" }, { id: "desc" }],
        });
        assert.equal(unchangedY.revision, 1);
        assert.equal(unchangedY.policyRevision, 1);
        assert.equal(
          (
            await db.providerAccountConnection.findUniqueOrThrow({
              where: { id: x.connectionId },
            })
          ).metadataRevision,
          1,
        );
      },
    );
  } finally {
    await secondDb.$disconnect();
  }
}
