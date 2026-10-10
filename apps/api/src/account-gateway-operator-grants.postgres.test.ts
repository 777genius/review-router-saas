import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, jwtVerify } from "jose";
import * as c from "@agent-teams/account-gateway/contracts";
import { createManagementClient } from "@agent-teams/account-gateway/http";
import { createPrismaClient } from "@reviewrouter/platform-db";
import { PrismaWorkspaceAccessRepository } from "@reviewrouter/features-auth";
import {
  bindWorkspaceAccount,
  changeOperatorWorkspaceAccountGrant,
  reconcileWorkspaceBindingFences,
  resolveWorkspaceAccountBinding,
  revokeWorkspaceAccountBinding,
  PrismaProviderAccountRepository,
  type ScopedBindingFence,
} from "@reviewrouter/features-provider-accounts";
import { PrismaProviderAccountSynchronization } from "@reviewrouter/features-provider-accounts/synchronization";
import {
  parseReviewConfigurationStrict,
  PrismaReviewConfigurationRepository,
  saveReviewConfiguration,
  safeDefaultReviewConfiguration,
} from "@reviewrouter/features-review-config";
import {
  ReviewTrustDomain,
  type VerifiedScmRunIdentity,
} from "@reviewrouter/features-review-run-control";
import { ProductionReviewRunRuntimeSnapshot } from "./review-run-runtime-snapshot";
import { createRunAccessClient } from "./account-gateway-run-access";

function disposableDatabase() {
  const raw = process.env.RR_S_OPERATOR_GRANTS_PG_TEST_URL ?? "";
  const url = new URL(raw);
  if (
    process.env.RR_S_OPERATOR_GRANTS_DISPOSABLE_CLUSTER !== "1" ||
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^rr_gateway_test_s_[a-z0-9_]+$/.test(url.pathname.slice(1)) ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("s_explicit_migrated_disposable_loopback_cluster_required");
  return raw;
}

// One nearest server boundary qualification: real migrated RR PostgreSQL, signed
// synthetic server context/live membership, actual system-owned selection, and
// pinned SDK over controlled Gateway HTTP. Authorization issuance remains P105's
// fixture. This test makes no real-account, paid-provider, GitHub, or App calls.
describe.skipIf(process.env.RR_S_OPERATOR_GRANTS_PG_TEST !== "1")(
  "S operator canonical grants",
  () => {
    it("grants one canonical account to X/Y, fences X, and preserves owner authority", async () => {
      const db = createPrismaClient({
        databaseUrl: disposableDatabase(),
        poolMax: 4,
      });
      const prefix = `s-${randomUUID()}`;
      const operator = `${prefix}-operator`,
        x = `${prefix}-x`,
        y = `${prefix}-y`,
        paid = `${prefix}-paid`,
        foreign = `${prefix}-foreign`;
      const admin = {
        userId: `${prefix}-admin`,
        githubUserId: "",
        githubLogin: "synthetic",
      };
      const recipient = {
        userId: `${prefix}-recipient`,
        githubUserId: "",
        githubLogin: "synthetic",
      };
      const sessionKey = new TextEncoder().encode(randomUUID());
      const profile = "mimo-responses-v1";
      const limits = {
        requests: 2,
        concurrency: 1,
        requestBytes: 4096,
        outputBytes: 4096,
        tokens: 128,
      };
      const accounts = new PrismaProviderAccountRepository(db, operator);
      const access = new PrismaWorkspaceAccessRepository(db);
      const deps = {
        accounts,
        operatorGrants: accounts,
        workspaceAccess: access,
        operatorWorkspaceId: operator,
      };
      const remote = new Map<string, c.Account>();
      const fences = new Map<string, number>();
      const operations = new Map<string, c.Operation>();
      const prepares: c.Prepare[] = [];
      const admitted: c.Admission[] = [];
      let holdFence = true;
      const gatewayRuntimeToken = randomUUID();
      const gatewayRunControlToken = randomUUID();
      const server = createServer(async (request, response) => {
        try {
          if (
            ![
              `Bearer ${gatewayRuntimeToken}`,
              `Bearer ${gatewayRunControlToken}`,
            ].includes(request.headers.authorization ?? "")
          ) {
            response.writeHead(401).end();
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of request) {
            const saved = Buffer.from(chunk);
            bytes += saved.length;
            if (bytes > 65536) throw new Error();
            chunks.push(saved);
          }
          const body: unknown = chunks.length
            ? JSON.parse(Buffer.concat(chunks).toString())
            : null;
          const path = new URL(request.url ?? "/", "http://fixture").pathname;
          const json = (value: unknown) =>
            response
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify(value));
          if (path === "/v1/policy-fences") {
            const intent = c.fence.parse(body);
            if (holdFence) {
              json({ operationRef: intent.operationId, state: "pending" });
              return;
            }
            fences.set(
              intent.subjectRef,
              Math.max(fences.get(intent.subjectRef) ?? 0, intent.revision),
            );
            const operation: c.Operation = {
              operationRef: intent.operationId,
              state: "applied",
            };
            operations.set(intent.operationId, operation);
            json(operation);
            return;
          }
          if (path.startsWith("/v1/operations/")) {
            const id = path.split("/")[3]!;
            json(operations.get(id) ?? { operationRef: id, state: "pending" });
            return;
          }
          if (path.endsWith("/disable")) {
            const account = remote.get(path.split("/")[3]!)!;
            const intent = c.disable.parse(body);
            if (intent.expectedMetadataRevision !== account.metadataRevision) {
              response.writeHead(409).end();
              return;
            }
            account.state = "disabled";
            account.metadataRevision++;
            account.authorizationEpoch++;
            json({
              operationRef: intent.operationId,
              state: "applied",
              result: {
                kind: "account",
                accountRef: account.accountRef,
                metadataRevision: account.metadataRevision,
                authorizationEpoch: account.authorizationEpoch,
              },
            });
            return;
          }
          if (path === "/internal/v1/run-access") {
            const intent = c.prepare.parse(body);
            prepares.push(intent);
            const account = remote.get(intent.accountRefs[0]!);
            if (
              !account ||
              account.state !== "active" ||
              (fences.get(intent.subjectRef) ?? 0) >= intent.policyRevision
            ) {
              response.writeHead(403).end();
              return;
            }
            const admission: c.Admission = {
              invocationRef: intent.invocationRef,
              attemptRef: intent.attemptRef,
              accountRef: account.accountRef,
              authorizationEpoch: account.authorizationEpoch,
              subjectRef: intent.subjectRef,
              policyRevision: intent.policyRevision,
              bindingRevision: intent.bindingRevision,
              profileId: intent.profileId,
              limits: intent.limits,
              expiresAt: intent.deadline,
            };
            admitted.push(admission);
            json({
              bearer: "synthetic-execution-token",
              admission,
              operation: {
                operationRef: intent.operationId,
                state: "applied",
                result: {
                  kind: "execution",
                  executionRef: `${prefix}-execution-${admitted.length}`,
                  accountRef: account.accountRef,
                  authorizationEpoch: account.authorizationEpoch,
                  deadline: intent.deadline,
                  state: "active",
                },
              },
            });
            return;
          }
          response.writeHead(404).end();
        } catch {
          response.writeHead(500).end();
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        // Reject db-push-only fixtures: actual SQL117/118 guards must be installed.
        const guards = await db.$queryRaw<readonly { tgname: string }[]>`
        SELECT tgname FROM pg_trigger WHERE tgname IN ('ProviderAccountConnection_guard', 'WorkspaceAccountBinding_guard')`;
        expect(guards).toHaveLength(2);
        await db.workspace.createMany({
          data: [operator, x, y, paid, foreign].map((id) => ({
            id,
            slug: id,
            name: "Disposable S fixture",
          })),
        });
        await db.user.createMany({
          data: [{ id: admin.userId }, { id: recipient.userId }],
        });
        await db.workspaceMember.createMany({
          data: [
            { workspaceId: operator, userId: admin.userId, role: "admin" },
            ...[x, y, paid, foreign].map((workspaceId) => ({
              workspaceId,
              userId: recipient.userId,
              role: "admin" as const,
            })),
          ],
        });
        await db.workspaceEntitlement.create({
          data: {
            workspaceId: paid,
            plan: "paid",
            status: "active",
            limits: {},
            flags: { sharedPool: true },
          },
        });
        const connection = await db.providerAccountConnection.create({
          data: {
            id: `${prefix}-canonical`,
            ownerWorkspaceId: operator,
            gatewayAccountRef: `${prefix}-account`,
            profileRef: profile,
            displayName: "Shared synthetic account",
            state: "active",
          },
        });
        const own = await db.providerAccountConnection.create({
          data: {
            id: `${prefix}-byok`,
            ownerWorkspaceId: x,
            gatewayAccountRef: `${prefix}-byok-account`,
            profileRef: profile,
            displayName: "Own synthetic BYOK",
            state: "active",
          },
        });
        for (const row of [connection, own])
          remote.set(row.gatewayAccountRef, {
            accountRef: row.gatewayAccountRef,
            ownerRef: `${prefix}-owner`,
            profileId: profile,
            displayName: row.displayName,
            state: "active",
            metadataRevision: 1,
            authorizationEpoch: 1,
          });
        const context = (userId: string) =>
          new SignJWT({})
            .setProtectedHeader({ alg: "HS256" })
            .setSubject(userId)
            .setIssuer("s-synthetic-server")
            .setAudience("s-grants")
            .setExpirationTime("5m")
            .sign(sessionKey);
        // Only a verified stable identity enters application authority; workspace,
        // connection owner and operator designation never come from session claims.
        async function actor(context: string) {
          const { payload } = await jwtVerify(context, sessionKey, {
            algorithms: ["HS256"],
            issuer: "s-synthetic-server",
            audience: "s-grants",
          });
          if (typeof payload.sub !== "string")
            throw new Error("s_invalid_context");
          return {
            userId: payload.sub,
            githubUserId: "",
            githubLogin: "synthetic",
          };
        }
        const signedAdmin = await context(admin.userId),
          signedRecipient = await context(recipient.userId);
        const grant = {
          workspaceId: x,
          connectionId: connection.id,
          expectedRevision: 0,
          state: "active" as const,
        };
        await expect(
          changeOperatorWorkspaceAccountGrant(
            { ...grant, actor: await actor(signedRecipient) },
            deps,
          ),
        ).rejects.toMatchObject({ code: "workspace_forbidden" });
        await expect(
          bindWorkspaceAccount(
            {
              workspaceId: paid,
              connectionId: connection.id,
              expectedRevision: 0,
              actor: await actor(signedRecipient),
            },
            deps,
          ),
        ).rejects.toMatchObject({ code: "connection_unavailable" });
        await expect(
          changeOperatorWorkspaceAccountGrant(
            { ...grant, actor: await actor(signedRecipient) },
            { ...deps, localAdminGithubLogins: ["synthetic"] },
          ),
        ).rejects.toMatchObject({ code: "workspace_forbidden" });
        await expect(
          changeOperatorWorkspaceAccountGrant(
            { ...grant, actor: await actor(signedAdmin) },
            { accounts, workspaceAccess: access, operatorGrants: accounts },
          ),
        ).rejects.toMatchObject({ code: "workspace_forbidden" });
        // Real membership removal during the application/storage gap must deny.
        const staleAccess = new PrismaWorkspaceAccessRepository(db);
        staleAccess.findWorkspaceRoleByUserId = async () => {
          await db.workspaceMember.update({
            where: {
              workspaceId_userId: {
                workspaceId: operator,
                userId: admin.userId,
              },
            },
            data: { role: "member" },
          });
          return "admin";
        };
        await expect(
          changeOperatorWorkspaceAccountGrant(
            { ...grant, actor: await actor(signedAdmin) },
            { ...deps, workspaceAccess: staleAccess },
          ),
        ).rejects.toMatchObject({ code: "workspace_forbidden" });
        await db.workspaceMember.update({
          where: {
            workspaceId_userId: { workspaceId: operator, userId: admin.userId },
          },
          data: { role: "admin" },
        });
        expect(
          await accounts.findConnectionBinding({
            workspaceId: x,
            connectionId: connection.id,
          }),
        ).toBeNull();
        const gx = await changeOperatorWorkspaceAccountGrant(
          { ...grant, actor: await actor(signedAdmin) },
          deps,
        );
        const gy = await changeOperatorWorkspaceAccountGrant(
          { ...grant, workspaceId: y, actor: await actor(signedAdmin) },
          deps,
        );
        expect(gx.id).not.toBe(gy.id);
        const ordinaryDeps = {
          accounts: new PrismaProviderAccountRepository(db),
          workspaceAccess: access,
        };
        const byok = await bindWorkspaceAccount(
          {
            workspaceId: x,
            connectionId: own.id,
            expectedRevision: 0,
            actor: await actor(signedRecipient),
          },
          ordinaryDeps,
        );
        const selections = await Promise.all(
          [gx.id, gy.id].map(async (bindingId, index) =>
            resolveWorkspaceAccountBinding(
              {
                workspaceId: index ? y : x,
                bindingId,
                actor: await actor(signedRecipient),
              },
              deps,
            ),
          ),
        );
        expect(selections.map((row) => row.gatewayAccountRef)).toEqual([
          connection.gatewayAccountRef,
          connection.gatewayAccountRef,
        ]);
        await expect(
          resolveWorkspaceAccountBinding(
            {
              workspaceId: x,
              bindingId: gx.id,
              actor: await actor(signedRecipient),
            },
            ordinaryDeps,
          ),
        ).rejects.toMatchObject({ code: "connection_unavailable" });
        expect(
          await resolveWorkspaceAccountBinding(
            {
              workspaceId: x,
              bindingId: byok.id,
              actor: await actor(signedRecipient),
            },
            ordinaryDeps,
          ),
        ).toMatchObject({ gatewayAccountRef: own.gatewayAccountRef });
        await expect(
          resolveWorkspaceAccountBinding(
            {
              workspaceId: paid,
              bindingId: gx.id,
              actor: await actor(signedRecipient),
            },
            deps,
          ),
        ).rejects.toMatchObject({ code: "binding_unavailable" });
        expect(
          await accounts.findConnectionBinding({
            workspaceId: paid,
            connectionId: connection.id,
          }),
        ).toBeNull();
        expect(
          (
            await accounts.listOperatorGrantedBindings({
              workspaceId: x,
              limit: 25,
            })
          ).map((row) => row.binding.id),
        ).toEqual([gx.id]);
        // Foreign credential-management lookups retain the owner boundary.
        expect(
          await accounts.findOwnedConnection({
            workspaceId: x,
            connectionId: connection.id,
          }),
        ).toBeNull();
        const canonicalBeforeConsumerSync =
          await db.providerAccountConnection.findUniqueOrThrow({
            where: { id: connection.id },
          });
        await expect(
          new PrismaProviderAccountSynchronization(db).synchronizeMetadata({
            workspaceId: x,
            connectionId: connection.id,
            expectedRevision: 1,
            gatewayOperationRef: null,
            profileRef: profile,
            displayName: "Forbidden rename",
            state: "active",
          }),
        ).rejects.toMatchObject({ code: "revision_conflict" });
        expect(
          await db.providerAccountConnection.findUniqueOrThrow({
            where: { id: connection.id },
          }),
        ).toEqual(canonicalBeforeConsumerSync);
        const configurations = new PrismaReviewConfigurationRepository(
          db,
          operator,
        );
        const snapshots = new ProductionReviewRunRuntimeSnapshot(
          db,
          { profiles: [{ profileRef: profile, limits }] },
          operator,
        );
        const ordinarySnapshots = new ProductionReviewRunRuntimeSnapshot(db, {
          profiles: [{ profileRef: profile, limits }],
        });
        const identity = (
          workspaceId: string,
          sourceRunId = "1",
        ): VerifiedScmRunIdentity => ({
          workspaceId,
          repositoryConnectionId: `${workspaceId}-repo`,
          scmRepositoryIdentityId: `${workspaceId}-identity`,
          pullRequestNumber: 1,
          sourceRunId,
          sourceRunAttempt: "1",
          headSha: "a".repeat(40),
          baseSha: "b".repeat(40),
          mergeBaseSha: "b".repeat(40),
          reviewRevisionHash: "d".repeat(64),
          workflowIdentityHash: "c".repeat(64),
          trustDomain: ReviewTrustDomain.TrustedManaged,
        });
        async function configure(
          workspaceId: string,
          bindingId: string,
          expectedVersion: number | null = null,
        ) {
          return saveReviewConfiguration(
            {
              target: { scope: "workspace", workspaceId },
              expectedVersion,
              config: parseReviewConfigurationStrict({
                ...safeDefaultReviewConfiguration,
                providers: [
                  {
                    kind: "codex",
                    authMode: "codex_account_gateway",
                    model: "mimo-v2-pro",
                    reasoningEffort: "high",
                    fastMode: false,
                    agenticContext: true,
                    gatewayBindingId: bindingId,
                    gatewayProfileRef: profile,
                  },
                ],
              }),
            },
            { configurations },
          );
        }
        const foreignOwnerBinding = await db.workspaceAccountBinding.create({
          data: { workspaceId: y, connectionId: own.id, state: "active" },
        });
        await expect(configure(y, foreignOwnerBinding.id)).rejects.toThrow(
          "review_configuration_gateway_binding_unavailable",
        );
        expect(
          await configurations.findLatest({
            scope: "workspace",
            workspaceId: y,
          }),
        ).toBeNull();
        await configure(x, gx.id);
        await configure(y, gy.id);
        const deadline = new Date(Date.now() + 60000);
        const pinX = await snapshots.capture({
            identity: identity(x),
            deadline,
          }),
          pinY = await snapshots.capture({ identity: identity(y), deadline });
        expect(pinX?.gateway).toMatchObject({
          permittedAccountRef: connection.gatewayAccountRef,
          bindingRevision: gx.revision,
          policyRevision: gx.policyRevision,
        });
        expect(pinY?.gateway).toMatchObject({
          permittedAccountRef: connection.gatewayAccountRef,
          bindingRevision: gy.revision,
          policyRevision: gy.policyRevision,
        });
        expect(
          await ordinarySnapshots.capture({ identity: identity(x), deadline }),
        ).toBeNull();
        const runAccess = createRunAccessClient({
          origin,
          runControlBearer: gatewayRunControlToken,
          timeoutMs: 2000,
        });
        const toIntent = (snapshot: NonNullable<typeof pinX>): c.Prepare => {
          const g = snapshot.gateway!;
          return {
            operationId: g.operationId,
            invocationRef: g.invocationId,
            attemptRef: g.attemptId,
            accountRefs: [g.permittedAccountRef],
            subjectRef: g.policySubject,
            policyRevision: g.policyRevision,
            bindingRevision: g.bindingRevision,
            profileId: g.profileRef,
            limits: c.limits.parse(g.limits),
            deadline: snapshot.deadline,
          };
        };
        if (!pinX || !pinY) throw new Error("s_pin_missing");
        await runAccess.prepare(toIntent(pinX));
        await runAccess.prepare(toIntent(pinY));
        expect(admitted.map((row) => row.accountRef)).toEqual([
          connection.gatewayAccountRef,
          connection.gatewayAccountRef,
        ]);
        expect(admitted[0]!.subjectRef).not.toBe(admitted[1]!.subjectRef);
        const revoked = await changeOperatorWorkspaceAccountGrant(
          {
            ...grant,
            state: "revoked",
            expectedRevision: gx.revision,
            actor: await actor(signedAdmin),
          },
          deps,
        );
        expect(revoked).toMatchObject({
          state: "revoked",
          revision: 2,
          policyRevision: 2,
          pendingFence: { policySubject: gx.id, policyRevision: 2 },
        });
        expect(
          await snapshots.isLive({
            snapshot: pinX,
            identity: identity(x),
            now: new Date(),
          }),
        ).toBe(false);
        expect(
          await snapshots.capture({
            identity: identity(x, "new-id"),
            deadline,
          }),
        ).toBeNull();
        expect(
          await snapshots.isLive({
            snapshot: pinY,
            identity: identity(y),
            now: new Date(),
          }),
        ).toBe(true);
        await expect(
          changeOperatorWorkspaceAccountGrant(
            { ...grant, expectedRevision: 2, actor: await actor(signedAdmin) },
            deps,
          ),
        ).rejects.toMatchObject({ code: "binding_unavailable" });
        const gateway = createManagementClient({
          role: "management",
          origin,
          token: gatewayRuntimeToken,
          timeoutMs: 2000,
        });
        const receipt = (
          operation: c.Operation,
          intent: ScopedBindingFence,
        ) => {
          const ack = c.acknowledgementOperation.parse(operation);
          return ack.state === "applied" &&
            ack.operationRef === intent.operationId
            ? {
                state: "applied" as const,
                operationId: intent.operationId,
                policySubject: intent.policySubject,
                policyRevision: intent.policyRevision,
              }
            : { state: "pending" as const };
        };
        const delivery = {
          submitFence: async (intent: ScopedBindingFence) =>
            receipt(
              await gateway.fence({
                operationId: intent.operationId,
                subjectRef: intent.policySubject,
                revision: intent.policyRevision,
              }),
              intent,
            ),
          readFenceOperation: async (intent: ScopedBindingFence) =>
            receipt(await gateway.operation(intent.operationId), intent),
        };
        // Restrict delivery to this test's fresh bindings even when other
        // disposable scenarios have retained unresolved fence evidence.
        const reconcile = (repository = accounts) =>
          reconcileWorkspaceBindingFences(
            { limit: 2 },
            {
              accounts: {
                listPendingBindingFences: async () =>
                  (
                    await Promise.all(
                      [x, y].map((workspaceId) =>
                        repository.findConnectionBinding({
                          workspaceId,
                          connectionId: connection.id,
                        }),
                      ),
                    )
                  ).flatMap((binding) =>
                    binding?.pendingFence ? [binding] : [],
                  ),
                acknowledgeBindingFence: (intent) =>
                  repository.acknowledgeBindingFence(intent),
              },
              delivery,
            },
          );
        expect((await reconcile()).results).toContainEqual({
          bindingId: gx.id,
          requiredPolicyRevision: 2,
          remoteFenceDelivery: "remote_pending",
        });
        const restarted = new PrismaProviderAccountRepository(db, operator);
        expect(
          (await restarted.findConnectionBinding({
            workspaceId: x,
            connectionId: connection.id,
          }))!.pendingFence!.operationId,
        ).toBe(revoked.pendingFence!.operationId);
        holdFence = false;
        expect((await reconcile(restarted)).results).toContainEqual({
          bindingId: gx.id,
          requiredPolicyRevision: 2,
          remoteFenceDelivery: "remote_applied",
        });
        expect(
          (await restarted.findConnectionBinding({
            workspaceId: x,
            connectionId: connection.id,
          }))!.fenceAck!.operationId,
        ).toBe(revoked.pendingFence!.operationId);
        await expect(runAccess.prepare(toIntent(pinX))).rejects.toThrow();
        await expect(
          runAccess.prepare({
            ...toIntent(pinX),
            operationId: `${prefix}-new-operation`,
            invocationRef: `${prefix}-new-invocation`,
            attemptRef: `${prefix}-new-attempt`,
          }),
        ).rejects.toThrow();
        await runAccess.prepare(toIntent(pinY));
        expect(
          await restarted.findConnectionBinding({
            workspaceId: y,
            connectionId: connection.id,
          }),
        ).toMatchObject({
          state: "active",
          revision: 1,
          policyRevision: 1,
          pendingFence: null,
        });
        // Recipient detach cannot reauthorize foreign use, even after fence ACK.
        await revokeWorkspaceAccountBinding(
          {
            workspaceId: y,
            connectionId: connection.id,
            expectedRevision: 1,
            actor: await actor(signedRecipient),
          },
          deps,
        );
        await reconcile();
        await expect(
          bindWorkspaceAccount(
            {
              workspaceId: y,
              connectionId: connection.id,
              expectedRevision: 2,
              actor: await actor(signedRecipient),
            },
            deps,
          ),
        ).rejects.toMatchObject({ code: "connection_unavailable" });
        await changeOperatorWorkspaceAccountGrant(
          {
            ...grant,
            workspaceId: y,
            expectedRevision: 2,
            actor: await actor(signedAdmin),
          },
          deps,
        );
        const newY = await snapshots.capture({
          identity: identity(y, "fresh-granted"),
          deadline,
        });
        await configure(x, byok.id, 1);
        const ownPin = await ordinarySnapshots.capture({
          identity: identity(x),
          deadline,
        });
        if (!ownPin || !newY) throw new Error("s_fresh_pin_missing");
        expect(
          await snapshots.isLive({
            snapshot: pinX,
            identity: identity(x),
            now: new Date(),
          }),
        ).toBe(false);
        await runAccess.prepare(toIntent(ownPin));
        await changeOperatorWorkspaceAccountGrant(
          { ...grant, expectedRevision: 2, actor: await actor(signedAdmin) },
          deps,
        );
        await configure(x, gx.id, 2);
        const freshX = await snapshots.capture({
          identity: identity(x, "fresh-granted"),
          deadline,
        });
        if (!freshX) throw new Error("s_regranted_x_missing");
        // Privileged fixture rows cannot authorize arbitrary foreign/user sharing.
        for (const owner of [
          { ownerWorkspaceId: foreign },
          { ownerUserId: recipient.userId },
        ]) {
          const bad = await db.providerAccountConnection.create({
            data: {
              ...owner,
              gatewayAccountRef: `${prefix}-${randomUUID()}`,
              displayName: "Forbidden foreign",
              state: "active",
              profileRef: profile,
            },
          });
          const badBinding = await db.workspaceAccountBinding.create({
            data: { workspaceId: x, connectionId: bad.id, state: "active" },
          });
          await expect(
            resolveWorkspaceAccountBinding(
              {
                workspaceId: x,
                bindingId: badBinding.id,
                actor: await actor(signedRecipient),
              },
              deps,
            ),
          ).rejects.toMatchObject({ code: "connection_unavailable" });
          await expect(
            changeOperatorWorkspaceAccountGrant(
              {
                ...grant,
                connectionId: bad.id,
                actor: await actor(signedAdmin),
              },
              deps,
            ),
          ).rejects.toMatchObject({ code: "connection_unavailable" });
        }
        await expect(
          db.providerAccountConnection.update({
            where: { id: connection.id },
            data: { ownerWorkspaceId: x },
          }),
        ).rejects.toThrow();
        const operation = await gateway.disable(connection.gatewayAccountRef, {
          operationId: `${prefix}-global-disable`,
          expectedMetadataRevision: 1,
        });
        expect(operation.state).toBe("applied");
        await new PrismaProviderAccountSynchronization(db).synchronizeMetadata({
          workspaceId: operator,
          connectionId: connection.id,
          expectedRevision: 1,
          gatewayOperationRef: operation.operationRef,
          profileRef: profile,
          displayName: connection.displayName,
          state: "disabled",
        });
        expect(
          remote.get(connection.gatewayAccountRef)!.authorizationEpoch,
        ).toBe(2);
        for (const [snapshot, workspaceId] of [
          [freshX, x],
          [newY, y],
        ] as const) {
          expect(
            await snapshots.isLive({
              snapshot,
              identity: identity(workspaceId, "fresh-granted"),
              now: new Date(),
            }),
          ).toBe(false);
          expect(
            await snapshots.capture({
              identity: identity(workspaceId, "after-disable"),
              deadline,
            }),
          ).toBeNull();
          await expect(runAccess.prepare(toIntent(snapshot))).rejects.toThrow();
        }
        expect(
          await ordinarySnapshots.isLive({
            snapshot: ownPin,
            identity: identity(x),
            now: new Date(),
          }),
        ).toBe(true);
        // Operator use revocation also cleans up an already disabled canonical
        // account. It must retain the exact scoped fence without requiring a new
        // live-account permission or revoking Y's separate binding.
        await expect(
          changeOperatorWorkspaceAccountGrant(
            {
              ...grant,
              state: "revoked",
              expectedRevision: freshX.gateway!.bindingRevision,
              actor: await actor(signedAdmin),
            },
            deps,
          ),
        ).resolves.toMatchObject({
          state: "revoked",
          revision: 4,
          policyRevision: 4,
          pendingFence: { policySubject: gx.id, policyRevision: 4 },
        });
        expect(
          await accounts.findConnectionBinding({
            workspaceId: y,
            connectionId: connection.id,
          }),
        ).toMatchObject({ state: "active", revision: 3, policyRevision: 3 });
        expect(prepares.length).toBeGreaterThanOrEqual(8);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await db.$disconnect();
      }
    }, 60000);
  },
);
