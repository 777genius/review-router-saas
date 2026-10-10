// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createManagementClient } from "@agent-teams/account-gateway/http";
import {
  assertWorkspaceAdminAllowed,
  PrismaWorkspaceAccessRepository,
} from "@reviewrouter/features-auth";
import {
  changeOperatorWorkspaceAccountGrant,
  PrismaProviderAccountRepository,
} from "@reviewrouter/features-provider-accounts";
import {
  assertWorkspaceFeatureEntitlement,
  freeBetaEntitlement,
  freeBetaLimits,
  PrismaEntitlementRepository,
} from "@reviewrouter/features-entitlements";
import { createDashboardRateLimitPolicy } from "./dashboard-rate-limits";
import {
  findReviewConfiguration,
  clearReviewConfiguration,
  PrismaReviewConfigurationRepository,
  safeDefaultReviewConfiguration,
  saveReviewConfiguration,
} from "@reviewrouter/features-review-config";
import {
  GatewayRepositoryBatchControls,
  GatewayRepositoryBatchTargetToggle,
  type GatewayBatchInventoryItem,
} from "../../app/dashboard/gateway-repository-batch-controls";
import type { AccountsResult, AccountsPage } from "./account-gateway-accounts";
import {
  createGatewayRepositoryBatchAdapter,
  assertGatewayBatchRepositoryEligible,
  GatewayBatchDenied,
  gatewayRepositoryBatchServerAdapter,
  type GatewayBatchRequest,
  type GatewayBatchResult,
} from "./gateway-repository-batch-configuration";
import {
  assertDashboardRepositoryConfigMutationAllowed,
  assertDashboardRepositoryRecoveryAllowed,
  getDashboardSignedInActor,
} from "./dashboard-mutations";

// Control external session/configuration and App HTTP facts only. Dashboard
// decisions, workspace authority, permission-cache persistence and both C1 and
// configuration repositories remain the production code against the same PG.
const boundary = vi.hoisted(() => ({
  getServerSession: vi.fn<() => Promise<import("next-auth").Session | null>>(),
  getPrisma: vi.fn<typeof import("./prisma").getPrisma>(),
  authConfigured: true,
  loadAccountsBootstrap:
    vi.fn<typeof import("./account-gateway-accounts").loadAccountsBootstrap>(),
  request:
    vi.fn<
      (
        route: string,
        parameters?: Record<string, unknown>,
      ) => Promise<{ data: unknown }>
    >(),
}));
vi.mock("next-auth", () => ({ getServerSession: boundary.getServerSession }));
vi.mock("../auth/auth-env", () => ({
  getAuthEnvironmentStatus: () => ({
    configured: boundary.authConfigured,
    missing: [],
  }),
}));
vi.mock("../auth/auth-options", () => ({ authOptions: {} }));
vi.mock("./prisma", () => ({ getPrisma: boundary.getPrisma }));
vi.mock("./account-gateway-accounts", () => ({
  loadAccountsBootstrap: boundary.loadAccountsBootstrap,
}));
vi.mock("@reviewrouter/platform-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reviewrouter/platform-config")>()),
  requireGitHubAppPrivateKey: () => "controlled-fixture-only",
}));
vi.mock("@octokit/app", () => ({
  App: class {
    getInstallationOctokit() {
      return { request: boundary.request };
    }
  },
}));

// Plausible failures: batch code overwrites a concurrent single-editor save,
// saves a transferred repo under stale ownership, resets selection on refresh,
// reports partial success as green, or resubmits after a lost response.
// Reusing a scoped nonce with a changed selection/version must not mislabel the
// original receipt as applied to that changed intent, including during recovery.
// Refetching a new profile on the same binding must not silently change the
// user's chosen provider profile even when its model is still eligible.
// Empty inventory must retain the unknown operation and selection while disabling
// saves. Genuine entitlement/rate refusals must allow finishing the results.
// A repository still selected locally may be archived/disabled or replaced at
// the App-scoped endpoint; missing endpoint facts must remain unknown.
// One test crosses the real C1 + P111 Prisma/PostgreSQL boundary and drives the
// visible React/Radix UI. No mocked configuration repository/receipt/auth use case.
// Primary supplies its approved existing disposable loopback fixture with P120.
// This worker never starts this fixture, migrates or reads ambient runtime auth.
// P144 meaningful REDs on fe0: the production binding composition omits the
// trusted operator owner and refuses an active explicit consuming-workspace
// grant; the real dashboard helper throws untyped disabled/sign-in/live
// permission refusals, leaving the UI locked with no possible receipt; and
// after clear the version-sequence guess rejects the exact null-CAS version-2
// receipt while accepting a changed expectedVersion. Compile/import failures
// are never evidence of these behavioral REDs. Qualify P143 + P144 together.
// Rejected qualified v2 behavioral REDs: write with matching user but missing
// role is incorrectly definite denied; a truthy blank legacy login with no local
// mapping is incorrectly definite signed-out; and entered-write recovery drops
// the real receipt hash conflict for a different original CAS into unknown.
// The assertions below require the production decisions and real PG receipts.
test.skipIf(process.env.RR_P114_BATCH_TEST !== "1")(
  "gateway batch preserves CAS, live target scope, selection and exact receipt recovery",
  async () => {
    expect(process.env.RR_P114_BATCH_NEW_DISPOSABLE_CLUSTER).toBe("1");
    const url = new URL(process.env.RR_P114_BATCH_TEST_URL ?? "");
    if (
      !/^\/rr_gateway_test_p114_[a-f0-9]{32}$/.test(url.pathname) ||
      url.hostname !== "127.0.0.1" ||
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !/^[a-zA-Z0-9_]+$/.test(url.username) ||
      !url.port ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("new_p114_disposable_loopback_fixture_required");
    const db = new PrismaClient({
      adapter: new PrismaPg({
        host: "127.0.0.1",
        port: Number(url.port),
        user: url.username,
        database: url.pathname.slice(1),
        password: () => process.env.PGPASSWORD ?? "",
        ssl: false,
        max: 6,
        options: "-c search_path=public",
        client_encoding: "UTF8",
      }),
    });
    const repositoryFacts = new Map<string, Record<string, unknown>>();
    let catalogUnavailable = false;
    const server = createServer((request, response) => {
      const facts = repositoryFacts.get(request.url ?? "");
      if (
        request.method === "GET" &&
        facts &&
        request.headers.authorization === "Bearer fixture-only"
      ) {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(facts));
        return;
      }
      if (
        request.method !== "GET" ||
        request.url !== "/v1/profiles" ||
        request.headers.authorization !== "Bearer fixture-only"
      ) {
        response.writeHead(404).end();
        return;
      }
      if (catalogUnavailable) {
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          profiles: ["fixture-responses", "fixture-alternate"].map(
            (profileId) => ({
              profileId,
              protocol: "openai-responses",
              authKinds: ["api_key"],
              modelIds: ["fixture-model"],
            }),
          ),
        }),
      );
    });
    let fixtureStarted = false;
    try {
      // A populated fixture is a failure, never silently reused by another test.
      expect(await db.workspace.count()).toBe(0);
      expect(await db.user.count()).toBe(0);
      expect(await db.repositoryConnection.count()).toBe(0);
      expect(await db.providerAccountConnection.count()).toBe(0);
      expect(await db.reviewConfiguration.count()).toBe(0);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      fixtureStarted = true;
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("fixture_listener_required");
      const gateway = createManagementClient({
        role: "management",
        origin: `http://127.0.0.1:${address.port}`,
        token: "fixture-only",
        timeoutMs: 2000,
        responseBytes: 65536,
      });
      const workspaceId = "fixture-workspace";
      const foreignWorkspace = "fixture-foreign-workspace";
      const actor = {
        userId: "fixture-user",
        githubUserId: "123",
        githubLogin: "synthetic",
      };
      await db.workspace.createMany({
        data: [workspaceId, foreignWorkspace].map((id) => ({
          id,
          slug: id,
          name: id,
        })),
      });
      await db.user.create({ data: { id: actor.userId } });
      await db.userExternalIdentity.create({
        data: {
          userId: actor.userId,
          provider: "github",
          externalUserId: actor.githubUserId,
          login: actor.githubLogin,
        },
      });
      boundary.getPrisma.mockReturnValue(db);
      const signedInSession = {
        expires: "2099-01-01T00:00:00Z",
        user: {
          githubUserId: actor.githubUserId,
          githubLogin: actor.githubLogin,
        },
      };
      boundary.getServerSession.mockResolvedValue(signedInSession);
      vi.stubEnv("REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS", "1");
      vi.stubEnv("REVIEW_ROUTER_LOCAL_ADMIN_GITHUB_LOGINS", "");
      vi.stubEnv("GITHUB_APP_ID", "fixture-app");
      await db.workspaceMember.create({
        data: { workspaceId, userId: actor.userId, role: "admin" },
      });
      await db.gitHubInstallation.createMany({
        data: [workspaceId, foreignWorkspace].map((id, index) => ({
          id: `${id}-installation`,
          workspaceId: id,
          githubInstallationId: BigInt(index + 1),
          accountLogin: id,
          accountType: "Organization",
          repositorySelection: "all",
          status: "active",
        })),
      });
      const ids = [
        "fixture-applied",
        "fixture-conflict",
        "fixture-denied",
      ] as const;
      for (const [index, id] of ids.entries())
        repositoryFacts.set(`/fixture/repositories/${id}`, {
          id: index + 10,
          full_name: `fixture/${id}`,
          archived: false,
          disabled: false,
        });
      await db.repositoryConnection.createMany({
        data: ids.map((id, index) => ({
          id,
          workspaceId,
          installationId: `${workspaceId}-installation`,
          githubRepositoryId: BigInt(index + 10),
          externalRepositoryId: String(index + 10),
          owner: "fixture",
          name: id,
          fullName: `fixture/${id}`,
          defaultBranch: "main",
          visibility: "private",
          selected: true,
          archived: false,
        })),
      });
      await db.providerAccountConnection.create({
        data: {
          id: "fixture-connection",
          ownerWorkspaceId: workspaceId,
          gatewayAccountRef: "fixture-account",
          profileRef: "fixture-responses",
          displayName: "Fixture account",
          state: "active",
        },
      });
      await db.workspaceAccountBinding.create({
        data: {
          id: "fixture-binding",
          workspaceId,
          connectionId: "fixture-connection",
          state: "active",
          revision: 1,
          policyRevision: 1,
        },
      });
      const configurations = new PrismaReviewConfigurationRepository(db);
      const workspaceConfig = {
        ...safeDefaultReviewConfiguration,
        blockingPolicy: { failOnSeverity: "major" as const },
        limits: { inlineMaxComments: 17, targetTokensPerBatch: 16000 },
        reviewLanguage: "French",
      };
      await saveReviewConfiguration(
        {
          target: { scope: "workspace", workspaceId },
          config: workspaceConfig,
        },
        { configurations },
      );
      const target = (repositoryId: string) => ({
        scope: "repository" as const,
        workspaceId,
        repositoryId,
      });
      const access = new PrismaWorkspaceAccessRepository(db);
      const entitlements = new PrismaEntitlementRepository(db);
      const ratePolicy = createDashboardRateLimitPolicy(db);
      let pauseEntitlementAfterProfiles = false;
      const adapter = createGatewayRepositoryBatchAdapter({
        configurations,
        bindings: {
          accounts: new PrismaProviderAccountRepository(db),
          workspaceAccess: access,
        },
        async authorize(workspace, repositoryId, mode) {
          await assertWorkspaceAdminAllowed(
            { workspaceId: workspace, ...actor },
            { workspaceAccess: access },
          );
          const repository = await db.repositoryConnection.findUnique({
            where: { id: repositoryId },
          });
          if (
            !repository ||
            repository.workspaceId !== workspace ||
            !repository.selected ||
            repository.archived
          )
            throw new GatewayBatchDenied();
          if (mode !== "read") {
            await assertWorkspaceFeatureEntitlement(
              {
                workspaceId: workspace,
                actor: "fixture",
                feature: "action_control_plane",
              },
              { entitlements },
            );
            if (mode === "save")
              await ratePolicy.assertReviewConfigSaveAllowed({
                workspaceId: workspace,
                resourceId: repositoryId,
              });
          }
          if (mode === "write") {
            if (!repository.githubRepositoryId) throw new GatewayBatchDenied();
            // Controlled HTTP exercises the production parser/eligibility guard;
            // this is NOT proof of actual GitHub freshness or App authorization.
            await assertGatewayBatchRepositoryEligible(
              {
                ...repository,
                githubRepositoryId: repository.githubRepositoryId,
              },
              {
                async request() {
                  const response = await fetch(
                    `http://127.0.0.1:${address.port}/fixture/repositories/${repositoryId}`,
                    {
                      headers: { authorization: "Bearer fixture-only" },
                    },
                  );
                  if (!response.ok)
                    throw new Error("fixture_repository_unavailable");
                  return { data: await response.json() };
                },
              },
            );
          }
          return actor;
        },
        async profiles() {
          const catalogue = await gateway.profiles();
          if (pauseEntitlementAfterProfiles)
            await entitlements.upsertWorkspaceEntitlement({
              ...freeBetaEntitlement(workspaceId),
              status: "paused",
            });
          return catalogue.profiles.map((profile) => ({
            id: profile.profileId,
            label: profile.profileId,
            protocol: profile.protocol,
            models: [...profile.modelIds],
          }));
        },
      });
      const accounts: AccountsResult<AccountsPage> = {
        status: "ok",
        value: {
          accounts: [
            {
              connectionId: "fixture-connection",
              label: "Fixture account",
              profileId: "fixture-responses",
              profileLabel: "Fixture responses",
              state: "active",
              gatewayRevision: 1,
              mirrorRevision: 1,
              binding: {
                id: "fixture-binding",
                revision: 1,
                state: "active",
                fencePending: false,
              },
            },
          ],
          profiles: ["fixture-responses", "fixture-alternate"].map((id) => ({
            id,
            label: id,
            protocol: "openai-responses",
            models: ["fixture-model"],
          })),
          nextCursor: null,
        },
      };
      boundary.loadAccountsBootstrap.mockResolvedValue({
        context: "controlled-catalogue",
        page: accounts,
      });
      const permissionFacts = {
        permission: "admin",
        role_name: "admin",
        user: { id: 123, login: "synthetic" },
      };
      function restoreBoundaryFacts() {
        boundary.authConfigured = true;
        boundary.getServerSession.mockResolvedValue(signedInSession);
        vi.stubEnv("REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS", "1");
        boundary.request.mockImplementation(async (route, parameters) => {
          if (route.endsWith("/permission")) return { data: permissionFacts };
          const facts = repositoryFacts.get(
            `/fixture/repositories/${String(parameters?.repo)}`,
          );
          if (!facts) throw new Error("fixture_repository_facts_missing");
          return { data: facts };
        });
      }
      restoreBoundaryFacts();
      // This is the real server composition, not a manually repaired binding
      // dependency object. The same trusted owner reaches C1 and persistence.
      const operatorRepositoryId = "fixture-operator-target";
      repositoryFacts.set(`/fixture/repositories/${operatorRepositoryId}`, {
        id: 20,
        full_name: `fixture/${operatorRepositoryId}`,
        archived: false,
        disabled: false,
      });
      await db.repositoryConnection.create({
        data: {
          id: operatorRepositoryId,
          workspaceId,
          installationId: `${workspaceId}-installation`,
          githubRepositoryId: 20n,
          externalRepositoryId: "20",
          owner: "fixture",
          name: operatorRepositoryId,
          fullName: `fixture/${operatorRepositoryId}`,
          defaultBranch: "main",
          visibility: "private",
          selected: true,
          archived: false,
        },
      });
      const operatorWorkspaceId = "fixture-operator-workspace";
      await db.workspace.create({
        data: {
          id: operatorWorkspaceId,
          slug: operatorWorkspaceId,
          name: operatorWorkspaceId,
        },
      });
      await db.workspaceMember.create({
        data: {
          workspaceId: operatorWorkspaceId,
          userId: actor.userId,
          role: "admin",
        },
      });
      vi.stubEnv("ACCOUNT_GATEWAY_OPERATOR_WORKSPACE_ID", operatorWorkspaceId);
      const productionAdapter = await gatewayRepositoryBatchServerAdapter();
      vi.stubEnv("ACCOUNT_GATEWAY_OPERATOR_WORKSPACE_ID", "invalid/operator");
      await expect(gatewayRepositoryBatchServerAdapter()).rejects.toThrow();
      vi.stubEnv("ACCOUNT_GATEWAY_OPERATOR_WORKSPACE_ID", operatorWorkspaceId);
      const writeSpy = vi.spyOn(
        PrismaReviewConfigurationRepository.prototype,
        "saveNextVersionWithOperation",
      );
      await db.providerAccountConnection.create({
        data: {
          id: "fixture-operator-connection",
          ownerWorkspaceId: operatorWorkspaceId,
          gatewayAccountRef: "fixture-operator-account",
          profileRef: "fixture-responses",
          displayName: "Operator account",
          state: "active",
        },
      });
      const operatorAccounts = new PrismaProviderAccountRepository(
        db,
        operatorWorkspaceId,
      );
      const grant = await changeOperatorWorkspaceAccountGrant(
        {
          workspaceId,
          connectionId: "fixture-operator-connection",
          actor,
          expectedRevision: 0,
          state: "active",
        },
        {
          accounts: operatorAccounts,
          operatorGrants: operatorAccounts,
          workspaceAccess: access,
          operatorWorkspaceId,
        },
      );
      const operatorRequest: GatewayBatchRequest = {
        workspaceId,
        operationId: randomUUID(),
        targets: [
          { repositoryId: operatorRepositoryId, expectedVersion: null },
        ],
        selection: {
          kind: "codex",
          authMode: "codex_account_gateway",
          gatewayBindingId: grant.id,
          gatewayProfileRef: "fixture-responses",
          model: "fixture-model",
          reasoningEffort: "high",
          agenticContext: true,
          fastMode: false,
          requiredHealthy: true,
        },
      };
      expect((await productionAdapter.save(operatorRequest)).results).toEqual([
        { repositoryId: operatorRepositoryId, status: "applied", version: 1 },
      ]);
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(
        (
          await findReviewConfiguration(target(operatorRepositoryId), {
            configurations,
          })
        )?.config.providers,
      ).toEqual([operatorRequest.selection]);
      // Keep the original UI targets empty; this probe uses a separate target
      // within this one existing disposable PG/React scenario.
      await clearReviewConfiguration(target(operatorRepositoryId), {
        configurations,
      });
      const guardRequest = { ...operatorRequest, operationId: randomUUID() };
      for (const bindingId of ["fixture-ungranted-binding", grant.id]) {
        if (bindingId === grant.id)
          await changeOperatorWorkspaceAccountGrant(
            {
              workspaceId,
              connectionId: "fixture-operator-connection",
              actor,
              expectedRevision: grant.revision,
              state: "revoked",
            },
            {
              accounts: operatorAccounts,
              operatorGrants: operatorAccounts,
              workspaceAccess: access,
              operatorWorkspaceId,
            },
          );
        expect(
          (
            await productionAdapter.save({
              ...guardRequest,
              operationId: randomUUID(),
              selection: {
                ...guardRequest.selection,
                gatewayBindingId: bindingId,
              },
            })
          ).results,
        ).toEqual([{ repositoryId: operatorRepositoryId, status: "denied" }]);
        expect(writeSpy).toHaveBeenCalledTimes(1);
      }
      // An active binding cannot turn a foreign workspace or personal owner
      // into an operator account; these fixtures never receive operator grants.
      for (const owner of [
        { ownerWorkspaceId: foreignWorkspace },
        { ownerUserId: actor.userId },
      ]) {
        const suffix = owner.ownerWorkspaceId ? "foreign" : "personal";
        await db.providerAccountConnection.create({
          data: {
            id: `fixture-${suffix}-connection`,
            ...owner,
            gatewayAccountRef: `fixture-${suffix}-account`,
            profileRef: "fixture-responses",
            displayName: suffix,
            state: "active",
          },
        });
        await db.workspaceAccountBinding.create({
          data: {
            id: `fixture-${suffix}-binding`,
            workspaceId,
            connectionId: `fixture-${suffix}-connection`,
            state: "active",
            revision: 1,
            policyRevision: 1,
          },
        });
        expect(
          (
            await productionAdapter.save({
              ...guardRequest,
              operationId: randomUUID(),
              selection: {
                ...guardRequest.selection,
                gatewayBindingId: `fixture-${suffix}-binding`,
              },
            })
          ).results,
        ).toEqual([{ repositoryId: operatorRepositoryId, status: "denied" }]);
        expect(writeSpy).toHaveBeenCalledTimes(1);
      }
      const revokedGrant = await db.workspaceAccountBinding.findUniqueOrThrow({
        where: { id: grant.id },
      });
      await expect(
        changeOperatorWorkspaceAccountGrant(
          {
            workspaceId,
            connectionId: "fixture-operator-connection",
            actor,
            expectedRevision: revokedGrant.revision,
            state: "active",
          },
          {
            accounts: operatorAccounts,
            operatorGrants: operatorAccounts,
            workspaceAccess: access,
            operatorWorkspaceId,
          },
        ),
      ).rejects.toMatchObject({ code: "binding_unavailable" });
      // Controlled active+pending fixture independently checks the use guard;
      // the actual grant use case above refuses to manufacture this state.
      const pendingGrant = await db.workspaceAccountBinding.update({
        where: { id: grant.id },
        // SQL118 permits a versioned state change while retaining the fence.
        data: {
          state: "active",
          revision: { increment: 1 },
          policyRevision: { increment: 1 },
        },
      });
      expect(pendingGrant.state).toBe("active");
      expect(pendingGrant.pendingFenceOperationId).not.toBeNull();
      expect(
        (
          await productionAdapter.save({
            ...guardRequest,
            operationId: randomUUID(),
          })
        ).results,
      ).toEqual([{ repositoryId: operatorRepositoryId, status: "denied" }]);
      expect(writeSpy).toHaveBeenCalledTimes(1);
      // Auth decisions below require the actual live collaborator boundary,
      // so remove workspace-admin authority rather than injecting auth errors.
      await db.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: actor.userId } },
        data: { role: "member" },
      });
      const authRepository = await db.repositoryConnection.findUniqueOrThrow({
        where: { id: ids[1] },
        include: { installation: true },
      });
      if (!authRepository.installation || !authRepository.githubRepositoryId)
        throw new Error("fixture_repository_required");
      const authTarget = {
        ...authRepository,
        githubRepositoryId: authRepository.githubRepositoryId,
        installation: authRepository.installation,
      };
      const originalScrollForAuth = HTMLElement.prototype.scrollIntoView;
      HTMLElement.prototype.scrollIntoView = () => {};
      async function authUI(status: "denied" | "unknown") {
        const saves: GatewayBatchRequest[] = [],
          reads: GatewayBatchRequest[] = [];
        let refreshed = 0;
        const authInventory = [
          {
            repositoryId: ids[1],
            fullName: `fixture/${ids[1]}`,
            eligible: true,
            expectedVersion: null,
          },
        ];
        const authElement = (fresh = false) =>
          createElement(GatewayRepositoryBatchControls, {
            workspaceId,
            inventory: fresh
              ? authInventory.map((item) => ({ ...item, expectedVersion: 9 }))
              : authInventory,
            accounts,
            enabled: true,
            refresh: () => {
              refreshed++;
            },
            actions: {
              async save(request: GatewayBatchRequest) {
                saves.push(request);
                return productionAdapter.save(request);
              },
              async read(request: GatewayBatchRequest) {
                reads.push(request);
                return productionAdapter.read(request);
              },
            },
            children: createElement(GatewayRepositoryBatchTargetToggle, {
              repositoryId: ids[1],
            }),
          });
        const authView = render(authElement());
        try {
          fireEvent.click(
            screen.getByLabelText(
              `Select fixture/${ids[1]} for gateway configuration`,
            ),
          );
          for (const [label, option] of [
            ["Gateway account", "Fixture account · Fixture responses"],
            ["Gateway model", "fixture-model"],
          ] as const) {
            fireEvent.keyDown(screen.getByRole("combobox", { name: label }), {
              key: "Enter",
            });
            fireEvent.click(
              await screen.findByRole("option", { name: option }),
            );
          }
          fireEvent.click(
            screen.getByRole("button", { name: "Apply gateway configuration" }),
          );
          await waitFor(() => expect(refreshed).toBe(1));
          expect(screen.getByText(`fixture/${ids[1]}: ${status}`)).toBeTruthy();
          expect(writeSpy).toHaveBeenCalledTimes(1);
          expect(
            await findReviewConfiguration(target(ids[1]), { configurations }),
          ).toBeNull();
          expect(saves).toHaveLength(1);
          if (status === "denied") {
            expect(
              screen.queryByRole("button", { name: "Check saved operation" }),
            ).toBeNull();
            fireEvent.click(
              screen.getByRole("button", { name: "Finish viewing results" }),
            );
            expect(
              (
                screen.getByRole("button", {
                  name: "Apply gateway configuration",
                }) as HTMLButtonElement
              ).disabled,
            ).toBe(false);
          } else {
            authView.rerender(authElement(true));
            expect(screen.getByText("1 repositories selected")).toBeTruthy();
            expect(
              screen.getByText(`Operation: ${saves[0]!.operationId}`),
            ).toBeTruthy();
            expect(
              screen.queryByRole("button", { name: "Finish viewing results" }),
            ).toBeNull();
            expect(
              (
                screen.getByRole("button", {
                  name: "Apply gateway configuration",
                }) as HTMLButtonElement
              ).disabled,
            ).toBe(true);
            restoreBoundaryFacts();
            fireEvent.click(
              screen.getByRole("button", { name: "Check saved operation" }),
            );
            await waitFor(() => expect(reads).toHaveLength(1));
            await waitFor(() =>
              expect(
                (
                  screen.getByRole("button", {
                    name: "Check saved operation",
                  }) as HTMLButtonElement
                ).disabled,
              ).toBe(false),
            );
            expect(reads[0]).toEqual(saves[0]);
            expect(screen.getByText(`fixture/${ids[1]}: unknown`)).toBeTruthy();
            expect(
              screen.queryByRole("button", { name: "Finish viewing results" }),
            ).toBeNull();
            expect(saves).toHaveLength(1);
          }
        } finally {
          authView.unmount();
        }
      }
      try {
        // Keep both modern source identities and the existing legacy GitHub
        // session valid. GitLab must not borrow even valid stale GitHub fields.
        await db.userExternalIdentity.create({
          data: {
            userId: actor.userId,
            provider: "gitlab",
            externalUserId: "fixture-gitlab-user",
            login: "gitlab-synthetic",
          },
        });
        for (const sourceProvider of ["github", "gitlab"] as const) {
          restoreBoundaryFacts();
          boundary.getServerSession.mockResolvedValue({
            ...signedInSession,
            user: {
              ...signedInSession.user,
              sourceProvider,
              externalUserId:
                sourceProvider === "github"
                  ? actor.githubUserId
                  : "fixture-gitlab-user",
              sourceLogin:
                sourceProvider === "github"
                  ? actor.githubLogin
                  : "gitlab-synthetic",
            },
          });
          await expect(getDashboardSignedInActor()).resolves.toMatchObject({
            userId: actor.userId,
            sourceProvider,
            githubUserId:
              sourceProvider === "github" ? actor.githubUserId : null,
            githubLogin: sourceProvider === "github" ? actor.githubLogin : null,
          });
        }
        // Permission alone can positively prove access; retain the established
        // write+maintain role combination as well as missing-role admin/maintain.
        for (const data of [
          { permission: "admin", user: permissionFacts.user },
          { permission: "maintain", user: permissionFacts.user },
          {
            permission: "write",
            role_name: "maintain",
            user: permissionFacts.user,
          },
        ]) {
          restoreBoundaryFacts();
          boundary.request.mockResolvedValue({ data });
          await expect(
            assertDashboardRepositoryConfigMutationAllowed(
              workspaceId,
              authTarget,
            ),
          ).resolves.toMatchObject({
            userId: actor.userId,
            accessSource: {
              source: "repo_manager",
              capability: "direct_config",
            },
          });
          expect(writeSpy).toHaveBeenCalledTimes(1);
        }
        restoreBoundaryFacts();
        boundary.request.mockResolvedValue({
          data: { permission: "write", user: permissionFacts.user },
        });
        const readOnlyCache = vi.spyOn(db.repositoryPermissionCache, "upsert");
        try {
          // The same missing-role response permits repo-manager recovery from
          // its explicit write permission, without changing the durable cache.
          await expect(
            assertDashboardRepositoryRecoveryAllowed(workspaceId, authTarget),
          ).resolves.toMatchObject({
            accessSource: {
              source: "repo_manager",
              capability: "repo_manager",
            },
          });
          await expect(
            assertDashboardRepositoryConfigMutationAllowed(
              workspaceId,
              authTarget,
            ),
          ).rejects.toMatchObject({
            name: "Error",
            message: "repository_config_mutation_forbidden",
          });
          expect(readOnlyCache).not.toHaveBeenCalled();
          await authUI("unknown");
        } finally {
          readOnlyCache.mockRestore();
        }
        for (const [setFacts, message] of [
          [
            () => {
              vi.stubEnv("REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS", "0");
            },
            "dashboard_mutations_disabled",
          ],
          [
            () => {
              boundary.getServerSession.mockResolvedValue(null);
            },
            "dashboard_mutation_requires_sign_in",
          ],
          [
            () => {
              boundary.request.mockResolvedValue({
                data: {
                  ...permissionFacts,
                  permission: "read",
                  role_name: "read",
                },
              });
            },
            "repository_mutation_forbidden",
          ],
          [
            () => {
              boundary.request.mockResolvedValue({
                data: {
                  ...permissionFacts,
                  permission: "write",
                  role_name: "write",
                },
              });
            },
            "repository_config_mutation_forbidden",
          ],
        ] as const) {
          restoreBoundaryFacts();
          setFacts();
          await expect(
            assertDashboardRepositoryConfigMutationAllowed(
              workspaceId,
              authTarget,
            ),
          ).rejects.toMatchObject({
            name: "DashboardMutationRefusedError",
            message,
          });
          await authUI("denied");
        }
        // Successful session identity but successful local user absence is also
        // a sign-in refusal; use an external identity with no local mapping.
        restoreBoundaryFacts();
        boundary.getServerSession.mockResolvedValue({
          ...signedInSession,
          user: { githubUserId: "456", githubLogin: "absent" },
        });
        await expect(
          assertDashboardRepositoryConfigMutationAllowed(
            workspaceId,
            authTarget,
          ),
        ).rejects.toMatchObject({
          name: "DashboardMutationRefusedError",
          message: "dashboard_mutation_requires_sign_in",
        });
        await authUI("denied");
        // Truthiness previously let this malformed session reach a successful
        // unmapped local-user result and emit a definite sign-in refusal.
        restoreBoundaryFacts();
        boundary.getServerSession.mockResolvedValue({
          ...signedInSession,
          user: { githubUserId: "456", githubLogin: " " },
        });
        const malformedLookup = vi.spyOn(db.userExternalIdentity, "findUnique");
        try {
          await expect(
            assertDashboardRepositoryConfigMutationAllowed(
              workspaceId,
              authTarget,
            ),
          ).rejects.toMatchObject({
            name: "Error",
            message: "dashboard_mutation_requires_sign_in",
          });
          expect(malformedLookup).not.toHaveBeenCalled();
          await authUI("unknown");
          // Readback restores valid facts; only those recovery lookups may run.
          expect(
            malformedLookup.mock.calls.every(
              ([input]) =>
                input.where.provider_externalUserId?.externalUserId !== "456",
            ),
          ).toBe(true);
        } finally {
          malformedLookup.mockRestore();
        }
        for (const setFacts of [
          () => {
            boundary.authConfigured = false;
          },
          () => {
            boundary.getServerSession.mockRejectedValue(
              new Error("dashboard_mutation_requires_sign_in"),
            );
          },
          () => {
            boundary.getServerSession.mockResolvedValue({
              expires: signedInSession.expires,
              user: {},
            });
          },
          () => {
            boundary.getServerSession.mockResolvedValue({
              ...signedInSession,
              user: {
                ...signedInSession.user,
                sourceProvider: "gitlab",
                externalUserId: "456",
                sourceLogin: " ",
              },
            });
          },
          ...[401, 403, 404].map((status) => () => {
            boundary.request.mockRejectedValue(
              Object.assign(new Error("repository_config_mutation_forbidden"), {
                status,
              }),
            );
          }),
          () => {
            boundary.request.mockRejectedValue(
              new Error("repository_mutation_forbidden"),
            );
          },
          ...[
            {},
            { permission: "", user: permissionFacts.user },
            { permission: "read" },
            { permission: "unknown", user: permissionFacts.user },
          ].map((data) => () => {
            boundary.request.mockResolvedValue({ data });
          }),
        ]) {
          restoreBoundaryFacts();
          setFacts();
          await expect(
            assertDashboardRepositoryConfigMutationAllowed(
              workspaceId,
              authTarget,
            ),
          ).rejects.toMatchObject({ name: "Error" });
          await authUI("unknown");
        }
        restoreBoundaryFacts();
        const userLookup = vi
          .spyOn(db.userExternalIdentity, "findUnique")
          .mockRejectedValue(new Error("dashboard_mutation_requires_sign_in"));
        try {
          await authUI("unknown");
        } finally {
          userLookup.mockRestore();
        }
        restoreBoundaryFacts();
        boundary.request.mockResolvedValue({
          data: { ...permissionFacts, permission: "read", role_name: "read" },
        });
        const cacheWrite = vi
          .spyOn(db.repositoryPermissionCache, "upsert")
          .mockRejectedValue(new Error("repository_mutation_forbidden"));
        try {
          await authUI("unknown");
        } finally {
          cacheWrite.mockRestore();
        }
      } finally {
        HTMLElement.prototype.scrollIntoView = originalScrollForAuth;
        restoreBoundaryFacts();
        writeSpy.mockRestore();
      }
      await db.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: actor.userId } },
        data: { role: "admin" },
      });
      let inventory: readonly GatewayBatchInventoryItem[] = ids.map(
        (repositoryId) => ({
          repositoryId,
          fullName: `fixture/${repositoryId}`,
          eligible: true,
          expectedVersion: null,
        }),
      );
      const savedRequests: GatewayBatchRequest[] = [];
      const readRequests: GatewayBatchRequest[] = [];
      let loseResponse = false;
      let loseRead = false;
      let response: GatewayBatchResult | undefined;
      const actions = {
        async save(request: GatewayBatchRequest) {
          savedRequests.push(request);
          response = await adapter.save(request);
          if (loseResponse) throw new Error("fixture_response_lost");
          return response;
        },
        async read(request: GatewayBatchRequest) {
          readRequests.push(request);
          if (loseRead) throw new Error("fixture_read_lost");
          return adapter.read(request);
        },
      };
      const children = ids.map((repositoryId) =>
        createElement(GatewayRepositoryBatchTargetToggle, {
          key: repositoryId,
          repositoryId,
        }),
      );
      let currentAccounts = accounts;
      let enabled = true;
      let refreshes = 0;
      const element = () =>
        createElement(GatewayRepositoryBatchControls, {
          workspaceId,
          inventory,
          accounts: currentAccounts,
          enabled,
          actions,
          refresh: () => {
            refreshes++;
          },
          children,
        });
      const view = render(element());
      for (const id of ids)
        fireEvent.click(
          screen.getByLabelText(
            `Select fixture/${id} for gateway configuration`,
          ),
        );
      async function choose(label: string, option: string) {
        fireEvent.keyDown(screen.getByRole("combobox", { name: label }), {
          key: "Enter",
        });
        fireEvent.click(await screen.findByRole("option", { name: option }));
      }
      // Radix scrolls highlighted options; jsdom has no scrolling layout.
      const originalScroll = HTMLElement.prototype.scrollIntoView;
      HTMLElement.prototype.scrollIntoView = () => {};
      try {
        await choose("Gateway account", "Fixture account · Fixture responses");
        await choose("Gateway model", "fixture-model");
        const initialInventory = inventory;
        inventory = [];
        enabled = false;
        view.rerender(element());
        expect(screen.getByText("3 repositories selected")).toBeTruthy();
        expect(
          (
            screen.getByRole("button", {
              name: "Apply gateway configuration",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(true);
        expect(savedRequests).toHaveLength(0);
        inventory = initialInventory;
        enabled = true;
        view.rerender(element());
        for (const id of ids)
          expect(
            (
              screen.getByLabelText(
                `Select fixture/${id} for gateway configuration`,
              ) as HTMLInputElement
            ).checked,
          ).toBe(true);
        // Real typed refusal paths, with no configuration/receipt writes.
        await entitlements.upsertWorkspaceEntitlement({
          ...freeBetaEntitlement(workspaceId),
          status: "paused",
        });
        fireEvent.click(
          screen.getByRole("button", { name: "Apply gateway configuration" }),
        );
        await waitFor(() => expect(refreshes).toBe(1));
        for (const id of ids)
          expect(screen.getByText(`fixture/${id}: denied`)).toBeTruthy();
        expect(
          await db.reviewConfigurationVersion.count({
            where: { configuration: { repositoryId: { in: [...ids] } } },
          }),
        ).toBe(0);
        expect(
          screen.queryByRole("button", { name: "Check saved operation" }),
        ).toBeNull();
        fireEvent.click(
          screen.getByRole("button", { name: "Finish viewing results" }),
        );
        await entitlements.upsertWorkspaceEntitlement(
          freeBetaEntitlement(workspaceId),
        );
        for (const id of ids)
          for (
            let i = 0;
            i < freeBetaLimits.reviewConfigSavesPerWorkspacePerHour;
            i++
          )
            await ratePolicy.assertReviewConfigSaveAllowed({
              workspaceId,
              resourceId: id,
            });
        fireEvent.click(
          screen.getByRole("button", { name: "Apply gateway configuration" }),
        );
        await waitFor(() => expect(refreshes).toBe(2));
        for (const id of ids)
          expect(screen.getByText(`fixture/${id}: denied`)).toBeTruthy();
        expect(
          await findReviewConfiguration(target(ids[0]), { configurations }),
        ).toBeNull();
        fireEvent.click(
          screen.getByRole("button", { name: "Finish viewing results" }),
        );
        await db.rateLimitBucket.deleteMany({
          where: {
            key: {
              in: ids.map(
                (id) => `dashboard:review_config_save:${workspaceId}:${id}`,
              ),
            },
          },
        });
        const eligibilityRequest: GatewayBatchRequest = {
          workspaceId,
          operationId: randomUUID(),
          targets: [{ repositoryId: ids[0], expectedVersion: null }],
          selection: {
            kind: "codex",
            authMode: "codex_account_gateway",
            gatewayBindingId: "fixture-binding",
            gatewayProfileRef: "fixture-responses",
            model: "fixture-model",
            reasoningEffort: "high",
            agenticContext: true,
            fastMode: false,
            requiredHealthy: true,
          },
        };
        const factsPath = `/fixture/repositories/${ids[0]}`;
        const eligibleFacts = repositoryFacts.get(factsPath)!;
        // Entitlement can change after initial save authorization and catalogue
        // reads; the fresh per-target check must still refuse before mutation.
        pauseEntitlementAfterProfiles = true;
        expect(
          (
            await adapter.save({
              ...eligibilityRequest,
              operationId: randomUUID(),
            })
          ).results,
        ).toEqual([{ repositoryId: ids[0], status: "denied" }]);
        expect(
          await findReviewConfiguration(target(ids[0]), { configurations }),
        ).toBeNull();
        pauseEntitlementAfterProfiles = false;
        await entitlements.upsertWorkspaceEntitlement(
          freeBetaEntitlement(workspaceId),
        );
        for (const facts of [
          { ...eligibleFacts, archived: true },
          { ...eligibleFacts, disabled: true },
          { ...eligibleFacts, id: 999 },
        ]) {
          repositoryFacts.set(factsPath, facts);
          expect(
            (
              await adapter.save({
                ...eligibilityRequest,
                operationId: randomUUID(),
              })
            ).results,
          ).toEqual([{ repositoryId: ids[0], status: "denied" }]);
          expect(
            await findReviewConfiguration(target(ids[0]), { configurations }),
          ).toBeNull();
        }
        repositoryFacts.set(factsPath, {
          id: 10,
          full_name: `fixture/${ids[0]}`,
        });
        expect((await adapter.save(eligibilityRequest)).results).toEqual([
          { repositoryId: ids[0], status: "unknown" },
        ]);
        expect((await adapter.read(eligibilityRequest)).results).toEqual([
          { repositoryId: ids[0], status: "unknown" },
        ]);
        repositoryFacts.set(factsPath, eligibleFacts);
        catalogUnavailable = true;
        expect(
          (
            await adapter.save({
              ...eligibilityRequest,
              operationId: randomUUID(),
            })
          ).results,
        ).toEqual([{ repositoryId: ids[0], status: "unknown" }]);
        catalogUnavailable = false;
        expect(
          await findReviewConfiguration(target(ids[0]), { configurations }),
        ).toBeNull();
        savedRequests.length = 0;
        refreshes = 0;
        const changedProfile = await db.providerAccountConnection.update({
          where: { id: "fixture-connection" },
          data: {
            profileRef: "fixture-alternate",
            metadataRevision: { increment: 1 },
          },
        });
        currentAccounts = {
          status: "ok",
          value: {
            ...accounts.value,
            accounts: accounts.value.accounts.map((item) => ({
              ...item,
              profileId: changedProfile.profileRef!,
              profileLabel: "Alternate responses",
              mirrorRevision: changedProfile.metadataRevision,
            })),
          },
        };
        view.rerender(element());
        expect(screen.getByText("3 repositories selected")).toBeTruthy();
        expect(
          screen.getByText(
            "The chosen account or model is no longer eligible. Your repository selection is preserved.",
          ),
        ).toBeTruthy();
        expect(
          (
            screen.getByRole("button", {
              name: "Apply gateway configuration",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(true);
        expect(savedRequests).toHaveLength(0);
        await db.providerAccountConnection.update({
          where: { id: "fixture-connection" },
          data: {
            profileRef: "fixture-responses",
            metadataRevision: { increment: 1 },
          },
        });
        currentAccounts = accounts;
        view.rerender(element());
        // Concurrent individual-editor save + transfer happen after first paint.
        const concurrent = await saveReviewConfiguration(
          {
            target: target(ids[1]),
            config: { ...workspaceConfig, reviewLanguage: "German" },
            expectedVersion: null,
          },
          { configurations },
        );
        await db.repositoryConnection.update({
          where: { id: ids[2] },
          data: {
            workspaceId: foreignWorkspace,
            installationId: `${foreignWorkspace}-installation`,
          },
        });
        fireEvent.click(
          screen.getByRole("button", { name: "Apply gateway configuration" }),
        );
        await waitFor(() =>
          expect(
            screen.getByText(`fixture/${ids[0]}: applied (version 1)`),
          ).toBeTruthy(),
        );
        expect(screen.getByText(`fixture/${ids[1]}: conflict`)).toBeTruthy();
        expect(screen.getByText(`fixture/${ids[2]}: denied`)).toBeTruthy();
        expect(
          screen.queryByText("Applied to every selected repository."),
        ).toBeNull();
        const applied = await findReviewConfiguration(target(ids[0]), {
          configurations,
        });
        expect(applied?.config.providers).toEqual([
          savedRequests[0]!.selection,
        ]);
        expect(applied?.config.provider).toEqual(savedRequests[0]!.selection);
        expect(applied?.config.blockingPolicy).toEqual(
          workspaceConfig.blockingPolicy,
        );
        expect(applied?.config.limits).toEqual(workspaceConfig.limits);
        expect(applied?.config.reviewLanguage).toBe("French");
        expect(applied?.config.investigationRollout).toEqual(
          workspaceConfig.investigationRollout,
        );
        expect(
          await findReviewConfiguration(target(ids[1]), { configurations }),
        ).toEqual(concurrent);
        expect(
          await findReviewConfiguration(
            { ...target(ids[2]), workspaceId: foreignWorkspace },
            { configurations },
          ),
        ).toBeNull();
        const operationId = savedRequests[0]!.operationId;
        expect(
          (
            await adapter.read({
              ...savedRequests[0]!,
              operationId: randomUUID(),
            })
          ).results.every((item) => item.status === "unknown"),
        ).toBe(true);
        const scopedRequest = {
          ...savedRequests[0]!,
          operationId,
          targets: [savedRequests[0]!.targets[0]!],
        };
        expect((await adapter.read(scopedRequest)).results).toEqual([
          { repositoryId: ids[0], status: "applied", version: 1 },
        ]);
        const changedSelection = {
          ...scopedRequest,
          selection: { ...scopedRequest.selection, model: "changed-model" },
        };
        expect((await adapter.read(changedSelection)).results).toEqual([
          { repositoryId: ids[0], status: "conflict" },
        ]);
        expect((await adapter.save(changedSelection)).results).toEqual([
          { repositoryId: ids[0], status: "conflict" },
        ]);
        expect(
          (
            await adapter.read({
              ...scopedRequest,
              targets: [{ repositoryId: ids[0], expectedVersion: 1 }],
            })
          ).results,
        ).toEqual([{ repositoryId: ids[0], status: "conflict" }]);
        expect(
          (await findReviewConfiguration(target(ids[0]), { configurations }))
            ?.version,
        ).toBe(1);
        // Fresh versions and changed eligibility must preserve all selected IDs
        // AND their original version snapshots, rather than silently replacing CAS.
        inventory = inventory
          .filter((item) => item.repositoryId !== ids[2])
          .map((item) => ({ ...item, expectedVersion: 1 }));
        view.rerender(element());
        expect(screen.getByText("3 repositories selected")).toBeTruthy();
        for (const id of ids.slice(0, 2))
          expect(
            (
              screen.getByLabelText(
                `Select fixture/${id} for gateway configuration`,
              ) as HTMLInputElement
            ).checked,
          ).toBe(true);
        expect(
          screen.getByText(
            `Selected repository ${ids[2]} is no longer in the inventory.`,
          ),
        ).toBeTruthy();
        fireEvent.click(
          screen.getByRole("button", { name: "Finish viewing results" }),
        );
        fireEvent.click(
          screen.getByRole("button", {
            name: `Remove ${ids[2]} from selection`,
          }),
        );
        expect(screen.getByText("2 repositories selected")).toBeTruthy();
        for (const id of ids.slice(0, 2))
          fireEvent.click(
            screen.getByLabelText(
              `Select fixture/${id} for gateway configuration`,
            ),
          );
        fireEvent.click(
          screen.getByLabelText(
            `Select fixture/${ids[0]} for gateway configuration`,
          ),
        );
        // A second deliberate operation loses its save response and first read.
        // Real durable receipt is recovered on the next user-triggered read only.
        loseResponse = true;
        loseRead = true;
        fireEvent.click(
          screen.getByRole("button", { name: "Apply gateway configuration" }),
        );
        await waitFor(() => expect(refreshes).toBe(2));
        expect(response?.results).toEqual([
          { repositoryId: ids[0], status: "applied", version: 2 },
        ]);
        expect(savedRequests).toHaveLength(2);
        expect(savedRequests[1]!.targets[0]!.expectedVersion).toBe(1);
        const lostOperationId = savedRequests[1]!.operationId;
        expect(readRequests[0]!.operationId).toBe(lostOperationId);
        expect(readRequests[0]!.selection).toEqual(savedRequests[1]!.selection);
        expect(screen.getByText(`fixture/${ids[0]}: unknown`)).toBeTruthy();
        expect(
          (
            screen.getByRole("button", {
              name: "Apply gateway configuration",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(true);
        // Revocation while a save result is unknown cannot erase selection or
        // prevent an authorized read of an already-applied configuration receipt.
        await db.workspaceAccountBinding.update({
          where: { id: "fixture-binding" },
          data: {
            state: "revoked",
            revision: 2,
            policyRevision: 2,
            pendingFenceOperationId: "fixture-binding-revoke-intent",
            pendingFencePolicySubject: "fixture-binding",
            pendingFencePolicyRevision: 2,
          },
        });
        await entitlements.upsertWorkspaceEntitlement({
          ...freeBetaEntitlement(workspaceId),
          status: "paused",
        });
        catalogUnavailable = true;
        currentAccounts = {
          status: "ok",
          value: { ...accounts.value, accounts: [] },
        };
        const retainedInventory = inventory;
        inventory = [];
        enabled = false;
        view.rerender(element());
        expect(screen.getByText("1 repositories selected")).toBeTruthy();
        expect(
          screen.getByText(
            "The chosen account or model is no longer eligible. Your repository selection is preserved.",
          ),
        ).toBeTruthy();
        expect(screen.getByText(`${ids[0]}: unknown`)).toBeTruthy();
        expect(screen.getByText(`Operation: ${lostOperationId}`)).toBeTruthy();
        expect(
          screen.queryByRole("button", { name: "Finish viewing results" }),
        ).toBeNull();
        expect(
          (
            screen.getByRole("button", {
              name: "Apply gateway configuration",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(true);
        loseRead = false;
        fireEvent.click(
          screen.getByRole("button", { name: "Check saved operation" }),
        );
        await waitFor(() =>
          expect(
            screen.getByText(`${ids[0]}: applied (version 2)`),
          ).toBeTruthy(),
        );
        inventory = retainedInventory;
        enabled = true;
        view.rerender(element());
        expect(screen.getByText("1 repositories selected")).toBeTruthy();
        expect(
          screen.getByText(`fixture/${ids[0]}: applied (version 2)`),
        ).toBeTruthy();
        expect(readRequests[1]!.operationId).toBe(lostOperationId);
        expect(readRequests[1]!.targets).toEqual(savedRequests[1]!.targets);
        expect(readRequests[1]!.selection).toEqual(savedRequests[1]!.selection);
        expect(savedRequests).toHaveLength(2);
        expect(
          (await findReviewConfiguration(target(ids[0]), { configurations }))
            ?.version,
        ).toBe(2);
        // Clear retains the operator probe's version-1 receipt/history. A new
        // null-CAS operation must report its ACTUAL version 2 after response loss.
        view.unmount();
        catalogUnavailable = false;
        await entitlements.upsertWorkspaceEntitlement(
          freeBetaEntitlement(workspaceId),
        );
        await db.providerAccountConnection.create({
          data: {
            id: "fixture-history-connection",
            ownerWorkspaceId: workspaceId,
            gatewayAccountRef: "fixture-history-account",
            profileRef: "fixture-responses",
            displayName: "History account",
            state: "active",
          },
        });
        await db.workspaceAccountBinding.create({
          data: {
            id: "fixture-history-binding",
            workspaceId,
            connectionId: "fixture-history-connection",
            state: "active",
            revision: 1,
            policyRevision: 1,
          },
        });
        const historyAccounts: AccountsResult<AccountsPage> = {
          status: "ok",
          value: {
            ...accounts.value,
            accounts: [
              {
                ...accounts.value.accounts[0]!,
                connectionId: "fixture-history-connection",
                binding: {
                  id: "fixture-history-binding",
                  state: "active",
                  revision: 1,
                  fencePending: false,
                },
              },
            ],
          },
        };
        boundary.loadAccountsBootstrap.mockResolvedValue({
          context: "controlled-catalogue",
          page: historyAccounts,
        });
        expect(
          await findReviewConfiguration(target(operatorRepositoryId), {
            configurations,
          }),
        ).toBeNull();
        expect(
          await db.reviewConfigurationVersion.count({
            where: { configuration: { repositoryId: operatorRepositoryId } },
          }),
        ).toBe(1);
        const historyRequests: GatewayBatchRequest[] = [],
          historyReads: GatewayBatchRequest[] = [];
        let historyResult: GatewayBatchResult | undefined;
        let historyReadLost = true,
          historyRefreshes = 0;
        const historyView = render(
          createElement(GatewayRepositoryBatchControls, {
            workspaceId,
            accounts: historyAccounts,
            enabled: true,
            inventory: [
              {
                repositoryId: operatorRepositoryId,
                fullName: `fixture/${operatorRepositoryId}`,
                eligible: true,
                expectedVersion: null,
              },
            ],
            refresh: () => {
              historyRefreshes++;
            },
            actions: {
              async save(request: GatewayBatchRequest) {
                historyRequests.push(request);
                historyResult = await productionAdapter.save(request);
                throw new Error("fixture_response_lost");
              },
              async read(request: GatewayBatchRequest) {
                historyReads.push(request);
                if (historyReadLost) throw new Error("fixture_read_lost");
                return productionAdapter.read(request);
              },
            },
            children: createElement(GatewayRepositoryBatchTargetToggle, {
              repositoryId: operatorRepositoryId,
            }),
          }),
        );
        try {
          fireEvent.click(
            screen.getByLabelText(
              `Select fixture/${operatorRepositoryId} for gateway configuration`,
            ),
          );
          await choose(
            "Gateway account",
            "Fixture account · Fixture responses",
          );
          await choose("Gateway model", "fixture-model");
          fireEvent.click(
            screen.getByRole("button", { name: "Apply gateway configuration" }),
          );
          await waitFor(() => expect(historyRefreshes).toBe(1));
          expect(historyResult?.results).toEqual([
            {
              repositoryId: operatorRepositoryId,
              status: "applied",
              version: 2,
            },
          ]);
          expect(historyRequests).toHaveLength(1);
          const historyRequest = historyRequests[0]!;
          expect(historyRequest.targets).toEqual([
            { repositoryId: operatorRepositoryId, expectedVersion: null },
          ]);
          expect(
            screen.getByText(`Operation: ${historyRequest.operationId}`),
          ).toBeTruthy();
          expect(
            screen.getByText(`fixture/${operatorRepositoryId}: unknown`),
          ).toBeTruthy();
          expect(screen.getByText("1 repositories selected")).toBeTruthy();
          expect(
            screen.queryByRole("button", { name: "Finish viewing results" }),
          ).toBeNull();
          expect(
            (
              screen.getByRole("button", {
                name: "Apply gateway configuration",
              }) as HTMLButtonElement
            ).disabled,
          ).toBe(true);
          historyReadLost = false;
          fireEvent.click(
            screen.getByRole("button", { name: "Check saved operation" }),
          );
          await waitFor(() =>
            expect(
              screen.getByText(
                `fixture/${operatorRepositoryId}: applied (version 2)`,
              ),
            ).toBeTruthy(),
          );
          expect(historyReads).toEqual([historyRequest, historyRequest]);
          expect(historyRequests).toHaveLength(1);
          expect(
            (await productionAdapter.save(historyRequest)).results,
          ).toEqual([
            {
              repositoryId: operatorRepositoryId,
              status: "applied",
              version: 2,
            },
          ]);
          const changedVersion = {
            ...historyRequest,
            targets: [
              { repositoryId: operatorRepositoryId, expectedVersion: 1 },
            ],
          };
          expect(
            (await productionAdapter.read(changedVersion)).results,
          ).toEqual([
            { repositoryId: operatorRepositoryId, status: "conflict" },
          ]);
          expect(
            (await productionAdapter.save(changedVersion)).results,
          ).toEqual([
            { repositoryId: operatorRepositoryId, status: "conflict" },
          ]);
          expect(
            (
              await findReviewConfiguration(target(operatorRepositoryId), {
                configurations,
              })
            )?.version,
          ).toBe(2);
          expect(
            await db.reviewConfigurationVersion.count({
              where: { configuration: { repositoryId: operatorRepositoryId } },
            }),
          ).toBe(2);
          fireEvent.click(
            screen.getByRole("button", { name: "Finish viewing results" }),
          );
          expect(
            (
              screen.getByRole("button", {
                name: "Apply gateway configuration",
              }) as HTMLButtonElement
            ).disabled,
          ).toBe(false);

          // A familiar refusal thrown INSIDE the writer is uncertain until the
          // exact receipt proves the same selection and entire intended config.
          const originalWrite =
            PrismaReviewConfigurationRepository.prototype
              .saveNextVersionWithOperation;
          let enteredFailure: "before" | "after" | "different_config" =
            "before";
          const enteredSpy = vi
            .spyOn(
              PrismaReviewConfigurationRepository.prototype,
              "saveNextVersionWithOperation",
            )
            .mockImplementation(async function (
              this: PrismaReviewConfigurationRepository,
              input,
            ) {
              if (enteredFailure === "before") {
                // Exercise the new type from its REAL decision path after the
                // adapter entered the writer. Even definite local disablement
                // here cannot substitute for this operation's exact receipt.
                vi.stubEnv("REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS", "0");
                try {
                  await assertDashboardRepositoryConfigMutationAllowed(
                    workspaceId,
                    authTarget,
                  );
                } finally {
                  vi.stubEnv("REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS", "1");
                }
                throw new Error("fixture_expected_dashboard_refusal");
              }
              await originalWrite.call(
                this,
                enteredFailure === "different_config"
                  ? {
                      ...input,
                      config: { ...input.config, reviewLanguage: "German" },
                    }
                  : input,
              );
              throw new Error("repository_config_mutation_forbidden");
            });
          try {
            const enteredRequest = {
              ...historyRequest,
              operationId: randomUUID(),
              targets: [
                { repositoryId: operatorRepositoryId, expectedVersion: 2 },
              ],
            };
            expect(
              (await productionAdapter.save(enteredRequest)).results,
            ).toEqual([
              { repositoryId: operatorRepositoryId, status: "unknown" },
            ]);
            expect(
              (await productionAdapter.read(enteredRequest)).results,
            ).toEqual([
              { repositoryId: operatorRepositoryId, status: "unknown" },
            ]);
            expect(
              (
                await findReviewConfiguration(target(operatorRepositoryId), {
                  configurations,
                })
              )?.version,
            ).toBe(2);
            enteredFailure = "after";
            const exactEnteredRequest = {
              ...enteredRequest,
              operationId: randomUUID(),
            };
            expect(
              (await productionAdapter.save(exactEnteredRequest)).results,
            ).toEqual([
              {
                repositoryId: operatorRepositoryId,
                status: "applied",
                version: 3,
              },
            ]);
            expect(
              (await productionAdapter.read(exactEnteredRequest)).results,
            ).toEqual([
              {
                repositoryId: operatorRepositoryId,
                status: "applied",
                version: 3,
              },
            ]);
            enteredFailure = "different_config";
            expect(
              (
                await productionAdapter.save({
                  ...exactEnteredRequest,
                  operationId: randomUUID(),
                  targets: [
                    { repositoryId: operatorRepositoryId, expectedVersion: 3 },
                  ],
                })
              ).results,
            ).toEqual([
              { repositoryId: operatorRepositoryId, status: "conflict" },
            ]);
          } finally {
            enteredSpy.mockRestore();
          }
          // Later saves cannot change the result of the original version-2
          // receipt or cause exact retry to reactivate/append historical intent.
          expect(
            (await productionAdapter.read(historyRequest)).results,
          ).toEqual([
            {
              repositoryId: operatorRepositoryId,
              status: "applied",
              version: 2,
            },
          ]);
          expect(
            (await productionAdapter.save(historyRequest)).results,
          ).toEqual([
            {
              repositoryId: operatorRepositoryId,
              status: "applied",
              version: 2,
            },
          ]);
          expect(
            (
              await findReviewConfiguration(target(operatorRepositoryId), {
                configurations,
              })
            )?.version,
          ).toBe(4);
          // Between the prior lookup and entered uncertainty, one legitimate
          // clear+null-CAS write can persist this nonce under a different
          // original CAS. Recovery must surface the REAL P143 hash conflict.
          const casRequest: GatewayBatchRequest = {
            ...historyRequest,
            operationId: randomUUID(),
            targets: [
              { repositoryId: operatorRepositoryId, expectedVersion: 4 },
            ],
          };
          let durableVersion: number | undefined;
          const casLookups = vi.spyOn(
            PrismaReviewConfigurationRepository.prototype,
            "findOperation",
          );
          const casWriter = vi
            .spyOn(
              PrismaReviewConfigurationRepository.prototype,
              "saveNextVersionWithOperation",
            )
            .mockImplementation(async function (
              this: PrismaReviewConfigurationRepository,
              input,
            ) {
              await clearReviewConfiguration(input.target, {
                configurations: this,
              });
              const saved = await originalWrite.call(this, {
                ...input,
                expectedVersion: null,
              });
              durableVersion = saved.version;
              throw new Error("repository_config_mutation_forbidden");
            });
          try {
            expect((await productionAdapter.save(casRequest)).results).toEqual([
              { repositoryId: operatorRepositoryId, status: "conflict" },
            ]);
            expect(casWriter).toHaveBeenCalledTimes(1);
            expect(casWriter.mock.calls[0]![0].expectedVersion).toBe(4);
            expect(durableVersion).toBe(5);
            expect(casLookups).toHaveBeenCalledTimes(2);
            expect(casLookups.mock.calls.map(([input]) => input)).toEqual([
              {
                target: target(operatorRepositoryId),
                operationId: casRequest.operationId,
                expectedVersion: 4,
              },
              {
                target: target(operatorRepositoryId),
                operationId: casRequest.operationId,
                expectedVersion: 4,
              },
            ]);
            await expect(casLookups.mock.results[0]!.value).resolves.toBeNull();
            await expect(
              casLookups.mock.results[1]!.value,
            ).rejects.toMatchObject({
              name: "ReviewConfigurationWriteConflictError",
              code: "review_configuration_write_conflict",
            });
            expect((await productionAdapter.read(casRequest)).results).toEqual([
              { repositoryId: operatorRepositoryId, status: "conflict" },
            ]);
            expect((await productionAdapter.save(casRequest)).results).toEqual([
              { repositoryId: operatorRepositoryId, status: "conflict" },
            ]);
            const durableRequest: GatewayBatchRequest = {
              ...casRequest,
              targets: [
                { repositoryId: operatorRepositoryId, expectedVersion: null },
              ],
            };
            for (const result of [
              await productionAdapter.read(durableRequest),
              await productionAdapter.read(historyRequest),
            ]) {
              expect(result.results).toEqual([
                {
                  repositoryId: operatorRepositoryId,
                  status: "applied",
                  version:
                    result.operationId === casRequest.operationId ? 5 : 2,
                },
              ]);
            }
            expect(casWriter).toHaveBeenCalledTimes(1);
            expect(
              await findReviewConfiguration(target(operatorRepositoryId), {
                configurations,
              }),
            ).toMatchObject({
              version: 5,
              config: casWriter.mock.calls[0]![0].config,
            });
            expect(
              await db.reviewConfigurationVersion.count({
                where: {
                  configuration: { repositoryId: operatorRepositoryId },
                },
              }),
            ).toBe(5);
          } finally {
            casWriter.mockRestore();
            casLookups.mockRestore();
          }
        } finally {
          historyView.unmount();
        }
      } finally {
        HTMLElement.prototype.scrollIntoView = originalScroll;
      }
    } finally {
      cleanup();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      boundary.authConfigured = true;
      if (fixtureStarted)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      await db.$disconnect();
      // Primary drops this exact disposable DB/cluster after the retained result.
    }
  },
  60000,
);
