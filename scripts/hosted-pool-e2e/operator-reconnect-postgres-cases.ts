import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../packages/platform/db/src/index";
import { CredentialEnvelopeVault } from "../../packages/features/hosted-account-pool/src/infrastructure/crypto/credential-envelope-vault";
import { PrismaHostedCodexSessionPersistence } from "../../packages/features/hosted-account-pool/src/infrastructure/prisma/prisma-hosted-codex-session-persistence";
import { PrismaHostedCodexMutationFence } from "../../packages/features/hosted-account-pool/src/infrastructure/prisma/prisma-hosted-codex-mutation-fence";
import { setOperatorHostedAccountState } from "../../apps/api/src/hosted-pool-operator-account-state";

// Registered by the public PG suite after its authorized disposable setup.
// Writes use the actual API role; the owner connection only arranges fixtures
// and independently observes durable results. No role/trigger bypasses.
export function registerOperatorReconnectPostgresTests(
  enabled: boolean,
  context: () => {
    owner: PrismaClient;
    api: PrismaClient;
    vault: CredentialEnvelopeVault;
    workspace: string;
    pool: string;
    accountId: string;
    subject: string;
  },
) {
  describe.skipIf(!enabled)(
    "operator reconnect with actual PostgreSQL API role",
    () => {
      function fixture() {
        const c = context();
        const persistence = new PrismaHostedCodexSessionPersistence(
          c.api,
          c.vault,
          "disposable-incarnation",
          "disposable-resource",
          Buffer.alloc(32, 29),
        );
        const fence = new PrismaHostedCodexMutationFence(c.api);
        const state = () =>
          c.owner.hostedCodexAccount.findUniqueOrThrow({
            where: { id: c.accountId },
          });
        const mutate = (
          action: "pause" | "resume",
          expectedHealthVersion: number,
        ) =>
          setOperatorHostedAccountState({
            prisma: c.api,
            workspaceId: c.workspace,
            accountId: c.accountId,
            operatorId: "disposable-operator",
            action,
            expectedHealthVersion,
          });
        const acquire = async () => {
          const lease = await fence.acquire({
            accountId: c.accountId,
            runId: c.accountId,
            attempt: 1,
            ttlMs: 30_000,
            restoredGenerationHash: "fixture",
          });
          if (lease.status !== "granted")
            throw new Error("disposable_reconnect_lease_denied");
          return lease.leaseId;
        };
        return { ...c, persistence, fence, state, mutate, acquire };
      }

      it("requires relogin after invalid pause, replaces once, and preserves both repository bindings", async () => {
        const f = fixture();
        const roles = await f.api.$queryRaw<
          Array<{ name: string }>
        >`SELECT current_user::text AS name`;
        expect(roles[0]?.name).toBe("reviewrouter_api");
        const bindings = await f.owner.hostedCodexRepositoryBinding.findMany({
          where: { poolId: f.pool },
          orderBy: { id: "asc" },
        });
        expect(bindings.length).toBeGreaterThanOrEqual(2);
        await f.owner.hostedCodexAccount.update({
          where: { id: f.accountId },
          data: {
            state: "restore_quarantined",
            healthVersion: { increment: 1 },
          },
        });
        const invalid = await f.state();
        const paused = await f.mutate("pause", Number(invalid.healthVersion));
        await expect(f.mutate("resume", paused.healthVersion)).rejects.toThrow(
          "requires_relogin",
        );
        const generation = Number(invalid.activeGeneration!);
        const versionsBefore = await f.owner.hostedCodexCredentialVersion.count(
          { where: { accountId: f.accountId } },
        );
        const leaseId = await f.acquire();
        const bytes = auth(f.subject, "relogin");
        const command = {
          accountId: f.accountId,
          workspaceId: f.workspace,
          poolId: f.pool,
          expectedGeneration: generation,
          expectedHealthVersion: paused.healthVersion,
          nextAuthJsonBytes: bytes,
          nextGenerationHash: hash(bytes),
          leaseId,
          idempotencyKey: "disposable-relogin",
        };
        try {
          const foreign = auth(`${f.subject}-foreign`, "relogin");
          try {
            await expect(
              f.persistence.reconnect({
                ...command,
                nextAuthJsonBytes: foreign,
                nextGenerationHash: hash(foreign),
              }),
            ).rejects.toThrow("identity_drift");
          } finally {
            foreign.fill(0);
          }
          expect(await f.persistence.reconnect(command)).toMatchObject({
            status: "accepted",
            generation: generation + 1,
          });
          expect(await f.persistence.reconnect(command)).toMatchObject({
            status: "idempotent_replay",
            generation: generation + 1,
          });
          const replaced = await f.state();
          expect(replaced.state).toBe("paused");
          expect(replaced.activeGeneration).toBe(BigInt(generation + 1));
          expect(
            await f.owner.hostedCodexCredentialVersion.count({
              where: { accountId: f.accountId },
            }),
          ).toBe(versionsBefore + 1);
          await f.mutate("resume", Number(replaced.healthVersion));
          const restored = await f.persistence.read(f.accountId);
          expect(restored?.generation).toBe(generation + 1);
          try {
            expect(restored?.authJsonBytes).toEqual(bytes);
          } finally {
            restored?.authJsonBytes.fill(0);
          }
          expect(
            await f.owner.hostedCodexRepositoryBinding.findMany({
              where: { poolId: f.pool },
              orderBy: { id: "asc" },
            }),
          ).toEqual(bindings);
        } finally {
          bytes.fill(0);
          await f.fence.release({
            leaseId,
            reason: "disposable-test-complete",
          });
        }
      });

      it("rolls back a refresh generation when pause commits after its snapshot", async () => {
        const f = fixture();
        const before = await f.state();
        expect(before.state).toBe("healthy");
        const count = await f.owner.hostedCodexCredentialVersion.count({
          where: { accountId: f.accountId },
        });
        const leaseId = await f.acquire();
        const bytes = auth(f.subject, "refresh");
        const encrypt = f.vault.encrypt.bind(f.vault);
        // The callback commits a real independent transaction at the exact race
        // boundary. Encryption and the losing write still use their real adapters.
        const spy = vi
          .spyOn(f.vault, "encrypt")
          .mockImplementationOnce(async (...args) => {
            const envelope = await encrypt(...args);
            await f.mutate("pause", Number(before.healthVersion));
            return envelope;
          });
        try {
          expect(
            await f.persistence.compareAndSwap({
              accountId: f.accountId,
              expectedGeneration: Number(before.activeGeneration!),
              nextAuthJsonBytes: bytes,
              nextGenerationHash: hash(bytes),
              leaseId,
              idempotencyKey: "disposable-refresh-pause-race",
            }),
          ).toMatchObject({ status: "stale_generation" });
          const after = await f.state();
          expect(after.state).toBe("paused");
          expect(after.activeGeneration).toBe(before.activeGeneration);
          expect(after.healthVersion).toBe(before.healthVersion + 1n);
          expect(
            await f.owner.hostedCodexCredentialVersion.count({
              where: { accountId: f.accountId },
            }),
          ).toBe(count);
          await f.mutate("resume", Number(after.healthVersion));
        } finally {
          spy.mockRestore();
          bytes.fill(0);
          await f.fence.release({
            leaseId,
            reason: "disposable-test-complete",
          });
        }
      });
    },
  );
}

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
function auth(subject: string, phase: string) {
  const claims = Buffer.from(
    JSON.stringify({
      iss: "https://auth.openai.com",
      sub: subject,
      "https://api.openai.com/auth": { chatgpt_account_id: subject },
    }),
  ).toString("base64url");
  return Buffer.from(
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "fake-access",
        refresh_token: "fake-refresh",
        id_token: `e30.${claims}.signature`,
      },
      last_refresh:
        phase === "relogin" ? "2026-09-06T01:00:00Z" : "2026-09-06T01:01:00Z",
    }),
  );
}
