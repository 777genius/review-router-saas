import {
  Prisma,
  type PrismaClient,
  type ProviderAccountConnection as SourceRow,
  type PersonalAccountOperation as OperationRow,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import type {
  PersonalAccountOperationStore,
  PersonalOperationResult,
} from "../../application/ports/provider-account-repository-port";
import type { PersonalGatewayAccount } from "../../application/ports/provider-account-synchronization-port";
import {
  assertGatewayCounter,
  personalIntentDigest,
  personalOperationId,
  snapshotPersonalIntent,
  type PersonalAccountIntent,
} from "../../application/use-cases/personal-account-operations";
import {
  ProviderAccountError,
  assertExpectedRevision,
  assertOpaqueReference,
  assertExecutable,
} from "../../domain/provider-account";
import {
  mapBinding,
  mapConnection,
  rethrowProductStorageError,
} from "./connection-mapping";

type Tx = Prisma.TransactionClient;
const conflict = () => {
  throw new ProviderAccountError("operation_conflict");
};
const unavailable = () => {
  throw new ProviderAccountError("connection_unavailable");
};
const eligible = (role: string | undefined) =>
  role === "owner" || role === "admin";
const operationKey = (actorUserId: string, clientOperationId: string) => ({
  actorUserId_clientOperationId: { actorUserId, clientOperationId },
});
const memberKey = (workspaceId: string, userId: string) => ({
  workspaceId_userId: { workspaceId, userId },
});
function toIntent(row: OperationRow): PersonalAccountIntent {
  // SQL fixes action shapes; the policy snapshot validates and strips every
  // non-intent column. Gateway counters alone need bigint->safe-number mapping.
  return snapshotPersonalIntent({
    ...row,
    expectedGatewayRevision: Number(row.expectedGatewayRevision),
  } as PersonalAccountIntent);
}
function operationData(input: PersonalAccountIntent) {
  const intent = snapshotPersonalIntent(input);
  return {
    ...intent,
    id: personalOperationId(intent.actorUserId, intent.clientOperationId),
    normalizedIntentHash: personalIntentDigest(intent),
    expectedGatewayRevision:
      intent.action === "connect"
        ? null
        : BigInt(intent.expectedGatewayRevision),
  };
}

/** Internal composition only. No public personal write/use entry is enabled. */
export class PrismaPersonalAccountOperations implements PersonalAccountOperationStore {
  constructor(private readonly prisma: PrismaClient) {}
  async resolvePersonalWorkspace(actorUserId: string): Promise<string> {
    assertOpaqueReference(actorUserId);
    // Resolve/provision BEFORE any Source/Binding locks, including finalization.
    return this.prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "User" WHERE "id" = ${actorUserId} FOR UPDATE`;
      if (users.length !== 1) return unavailable();
      const existing = await tx.workspace.findUnique({
        where: { personalOwnerUserId: actorUserId },
      });
      if (existing) return existing.id;
      const workspace = await tx.workspace.create({
        data: {
          personalOwnerUserId: actorUserId,
          slug: `personal-${randomUUID()}`,
          name: "Personal accounts",
        },
      });
      await tx.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: actorUserId, role: "owner" },
      });
      return workspace.id;
    });
  }
  async findOwnedSource(actorUserId: string, sourceId: string) {
    assertOpaqueReference(actorUserId);
    assertOpaqueReference(sourceId);
    const row = await this.prisma.providerAccountConnection.findFirst({
      where: { id: sourceId, ownerUserId: actorUserId, ownerWorkspaceId: null },
    });
    if (!row) return unavailable();
    return mapConnection(row);
  }
  private async result(
    tx: Tx,
    row: OperationRow,
  ): Promise<PersonalOperationResult> {
    const intent = toIntent(row);
    const source = row.resultSourceId
      ? await tx.providerAccountConnection.findUnique({
          where: { id: row.resultSourceId },
        })
      : null;
    const binding = row.resultBindingId
      ? await tx.workspaceAccountBinding.findUnique({
          where: { id: row.resultBindingId },
        })
      : null;
    if (row.phase === "applied" && (!source || source.ownerUserId === null))
      return unavailable();
    const ownerId = source?.ownerUserId ?? row.actorUserId;
    const scope = await tx.workspace.findFirst({
      where: {
        id: row.personalWorkspaceId,
        personalOwnerUserId: ownerId ?? "",
      },
    });
    const member = row.targetWorkspaceId
      ? await tx.workspaceMember.findUnique({
          where: memberKey(row.targetWorkspaceId, row.actorUserId),
        })
      : null;
    if (
      !ownerId ||
      !scope ||
      (ownerId !== row.actorUserId && !eligible(member?.role))
    )
      return unavailable();
    return {
      id: row.id,
      intent,
      phase: row.phase as PersonalOperationResult["phase"],
      source: source ? mapConnection(source) : null,
      binding: binding ? mapBinding(binding) : null,
      available:
        !!source &&
        !!binding &&
        source.state === "active" &&
        source.pendingSourceOperationId === null &&
        source.authorizationEpochMirror !== null &&
        binding.state === "active" &&
        binding.pendingFenceOperationId === null &&
        (!row.targetWorkspaceId || eligible(member?.role)),
    };
  }
  private async existing(tx: Tx, intent: PersonalAccountIntent) {
    const row = await tx.personalAccountOperation.findUnique({
      where: operationKey(intent.actorUserId, intent.clientOperationId),
    });
    if (row && row.normalizedIntentHash !== personalIntentDigest(intent))
      return conflict();
    return row;
  }
  async readOperation(actorUserId: string, clientOperationId: string) {
    assertOpaqueReference(actorUserId);
    assertOpaqueReference(clientOperationId);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.personalAccountOperation.findUnique({
        where: operationKey(actorUserId, clientOperationId),
      });
      if (!row) throw new ProviderAccountError("not_found");
      return this.result(tx, row);
    });
  }
  async reserveConnect(request: PersonalAccountIntent & { action: "connect" }) {
    const intent = snapshotPersonalIntent(request) as typeof request;
    const personalWorkspaceId = await this.resolvePersonalWorkspace(
      intent.actorUserId,
    );
    try {
      return await this.prisma.$transaction(async (tx) => {
        const previous = await this.existing(tx, intent);
        if (previous) return this.result(tx, previous);
        if (personalWorkspaceId !== intent.personalWorkspaceId)
          return unavailable();
        const row = await tx.personalAccountOperation.upsert({
          where: operationKey(intent.actorUserId, intent.clientOperationId),
          update: {},
          create: { ...operationData(intent), phase: "reserved" },
        });
        if (row.normalizedIntentHash !== personalIntentDigest(intent))
          return conflict();
        return this.result(tx, row);
      });
    } catch (error) {
      // The failed reservation transaction has rolled back. A UNIQUE loser may
      // only read its original immutable intent, never retry credential ingress.
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      ) {
        return this.prisma.$transaction(async (tx) => {
          const previous = await this.existing(tx, intent);
          if (previous) return this.result(tx, previous);
          return rethrowProductStorageError(error);
        });
      }
      return rethrowProductStorageError(error);
    }
  }
  async claimConnect(actorUserId: string, clientOperationId: string) {
    const original = await this.readOperation(actorUserId, clientOperationId);
    if (original.intent.action !== "connect") return conflict();
    // Single autocommit UPDATE; its resolved count is not permission until COMMIT.
    const changed = await this.prisma.personalAccountOperation.updateMany({
      where: { id: original.id, phase: "reserved" },
      data: { phase: "submitted" },
    });
    return changed.count === 1;
  }
  async noteConnectPhase(
    actorUserId: string,
    clientOperationId: string,
    phase: "unknown" | "rejected",
  ) {
    const original = await this.readOperation(actorUserId, clientOperationId);
    if (original.intent.action !== "connect") return conflict();
    await this.prisma.personalAccountOperation.updateMany({
      where: { id: original.id, phase: { in: ["submitted", "unknown"] } },
      data: { phase },
    });
  }
  async finalizeConnect(
    actorUserId: string,
    clientOperationId: string,
    request: PersonalGatewayAccount,
  ) {
    const account = {
      accountRef: request.accountRef,
      profileId: request.profileId,
      displayName: request.displayName,
      state: request.state,
      metadataRevision: request.metadataRevision,
      authorizationEpoch: request.authorizationEpoch,
    };
    assertOpaqueReference(account.accountRef);
    assertGatewayCounter(account.authorizationEpoch);
    assertGatewayCounter(account.metadataRevision);
    const personalWorkspaceId =
      await this.resolvePersonalWorkspace(actorUserId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockPersonalAuthority(tx, actorUserId, personalWorkspaceId);
      const id = personalOperationId(actorUserId, clientOperationId);
      await tx.$queryRaw`SELECT "id" FROM "PersonalAccountOperation" WHERE "id" = ${id} FOR UPDATE`;
      const row = await tx.personalAccountOperation.findUnique({
        where: { id },
      });
      if (
        !row ||
        row.actorUserId !== actorUserId ||
        row.action !== "connect" ||
        row.personalWorkspaceId !== personalWorkspaceId
      )
        return unavailable();
      if (row.phase === "applied") return this.result(tx, row);
      if (
        !["submitted", "unknown"].includes(row.phase) ||
        account.state !== "active" ||
        account.profileId !== row.profileId ||
        account.displayName !== row.displayName
      )
        return unavailable();
      // The absent source is serialized by the original operation lock/reservation.
      const source = await tx.providerAccountConnection.create({
        data: {
          id: row.proposedSourceId!,
          ownerUserId: actorUserId,
          gatewayAccountRef: account.accountRef,
          gatewayOperationRef: row.id,
          profileRef: row.profileId,
          displayName: row.displayName!,
          state: "active",
          authorizationEpochMirror: BigInt(account.authorizationEpoch),
        },
      });
      const binding = await tx.workspaceAccountBinding.create({
        data: {
          workspaceId: personalWorkspaceId,
          connectionId: source.id,
          state: "active",
        },
      });
      const applied = await tx.personalAccountOperation.update({
        where: { id },
        data: {
          phase: "applied",
          resultSourceId: source.id,
          resultBindingId: binding.id,
        },
      });
      return this.result(tx, applied);
    });
  }
  private async lockPersonalAuthority(
    tx: Tx,
    ownerUserId: string,
    personalWorkspaceId: string,
    actorUserId = ownerUserId,
  ) {
    // Prehold FK authority locks too: receipt/binding inserts must not acquire
    // User/P locks for the first time after locking the Source.
    const users = await tx.$queryRaw<
      { id: string }[]
    >`SELECT "id" FROM "User" WHERE "id" IN (${ownerUserId}, ${actorUserId}) ORDER BY "id" FOR KEY SHARE`;
    const scopes = await tx.$queryRaw<
      { id: string }[]
    >`SELECT "id" FROM "Workspace" WHERE "id" = ${personalWorkspaceId} AND "personalOwnerUserId" = ${ownerUserId} FOR KEY SHARE`;
    if (
      users.length !== new Set([ownerUserId, actorUserId]).size ||
      scopes.length !== 1
    )
      return unavailable();
  }
  private async lockMember(tx: Tx, workspaceId: string, actorUserId: string) {
    const members = await tx.$queryRaw<
      { role: string }[]
    >`SELECT "role" FROM "WorkspaceMember" WHERE "workspaceId" = ${workspaceId} AND "userId" = ${actorUserId} FOR SHARE`;
    if (members.length !== 1 || !eligible(members[0]?.role))
      throw new ProviderAccountError("workspace_forbidden");
  }
  private async lockSource(
    tx: Tx,
    intent: PersonalAccountIntent & { action: "attach" | "revoke" },
    ownerUserId: string,
  ) {
    const locked = await tx.$queryRaw<
      SourceRow[]
    >`SELECT * FROM "ProviderAccountConnection" WHERE "id" = ${intent.sourceId} AND "ownerUserId" = ${ownerUserId} FOR UPDATE`;
    const source = locked[0];
    if (!source) return unavailable();
    const target = await tx.workspace.findUnique({
      where: { id: intent.targetWorkspaceId },
    });
    if (!target || target.personalOwnerUserId !== null) return unavailable();
    return source;
  }
  async attach(request: PersonalAccountIntent & { action: "attach" }) {
    const intent = snapshotPersonalIntent(request) as typeof request;
    const { actorUserId, personalWorkspaceId } = intent;
    if (
      (await this.resolvePersonalWorkspace(actorUserId)) !== personalWorkspaceId
    )
      return unavailable();
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockPersonalAuthority(tx, actorUserId, personalWorkspaceId);
        // Lock current donor membership BEFORE Source, never after it.
        await this.lockMember(tx, intent.targetWorkspaceId, actorUserId);
        const source = await this.lockSource(tx, intent, actorUserId);
        const existing = await this.existing(tx, intent);
        if (existing) return this.result(tx, existing);
        assertExecutable(mapConnection(source));
        if (
          source.metadataRevision !== intent.expectedSourceMetadataRevision ||
          source.authorizationEpochMirror === null
        )
          throw new ProviderAccountError("revision_conflict");
        const history = await tx.$queryRaw<
          { id: string }[]
        >`SELECT "id" FROM "WorkspaceAccountBinding" WHERE "workspaceId" = ${intent.targetWorkspaceId} AND "connectionId" = ${source.id} ORDER BY "id" FOR UPDATE`;
        if (intent.predecessorBindingId === null) {
          if (history.length) return conflict();
        } else {
          const predecessor = await tx.workspaceAccountBinding.findUnique({
            where: { id: intent.predecessorBindingId },
          });
          const issuance = await tx.personalAccountOperation.findFirst({
            where: {
              action: "attach",
              phase: "applied",
              sourceId: source.id,
              targetWorkspaceId: intent.targetWorkspaceId,
              resultBindingId: intent.predecessorBindingId,
            },
          });
          const successor = await tx.personalAccountOperation.findFirst({
            where: {
              action: "attach",
              phase: "applied",
              predecessorBindingId: intent.predecessorBindingId,
            },
          });
          if (
            !issuance ||
            successor ||
            !predecessor ||
            predecessor.connectionId !== source.id ||
            predecessor.workspaceId !== intent.targetWorkspaceId ||
            predecessor.state !== "revoked" ||
            predecessor.revision !== intent.expectedPredecessorRevision ||
            predecessor.pendingFenceOperationId !== null ||
            predecessor.fenceAckPolicyRevision !== predecessor.policyRevision
          )
            return conflict();
        }
        if (
          await tx.workspaceAccountBinding.findFirst({
            where: {
              workspaceId: intent.targetWorkspaceId,
              connectionId: source.id,
              state: "active",
            },
          })
        )
          return conflict();
        const binding = await tx.workspaceAccountBinding.create({
          data: {
            workspaceId: intent.targetWorkspaceId,
            connectionId: source.id,
            state: "active",
          },
        });
        const applied = await tx.personalAccountOperation.create({
          data: {
            ...operationData(intent),
            phase: "applied",
            resultSourceId: source.id,
            resultBindingId: binding.id,
          },
        });
        return this.result(tx, applied);
      });
    } catch (error) {
      return rethrowProductStorageError(error);
    }
  }
  async revoke(request: PersonalAccountIntent & { action: "revoke" }) {
    const intent = snapshotPersonalIntent(request) as typeof request;
    const ownerId = (
      await this.prisma.providerAccountConnection.findUnique({
        where: { id: intent.sourceId },
        select: { ownerUserId: true },
      })
    )?.ownerUserId;
    if (
      !ownerId ||
      (await this.resolvePersonalWorkspace(ownerId)) !==
        intent.personalWorkspaceId
    )
      return unavailable();
    return this.prisma.$transaction(async (tx) => {
      await this.lockPersonalAuthority(
        tx,
        ownerId,
        intent.personalWorkspaceId,
        intent.actorUserId,
      );
      if (ownerId !== intent.actorUserId)
        await this.lockMember(tx, intent.targetWorkspaceId, intent.actorUserId);
      const source = await this.lockSource(tx, intent, ownerId);
      const existing = await this.existing(tx, intent);
      if (existing) return this.result(tx, existing);
      if (source.metadataRevision !== intent.expectedSourceMetadataRevision)
        throw new ProviderAccountError("revision_conflict");
      await tx.$queryRaw`SELECT "id" FROM "WorkspaceAccountBinding" WHERE "id" = ${intent.bindingId} FOR UPDATE`;
      const binding = await tx.workspaceAccountBinding.findUnique({
        where: { id: intent.bindingId },
      });
      if (
        !binding ||
        binding.connectionId !== source.id ||
        binding.workspaceId !== intent.targetWorkspaceId ||
        binding.state !== "active" ||
        binding.revision !== intent.expectedBindingRevision
      )
        throw new ProviderAccountError("binding_unavailable");
      await this.retire(
        tx,
        binding,
        personalOperationId(intent.actorUserId, intent.clientOperationId),
      );
      const applied = await tx.personalAccountOperation.create({
        data: {
          ...operationData(intent),
          phase: "applied",
          resultSourceId: source.id,
          resultBindingId: binding.id,
        },
      });
      return this.result(tx, applied);
    });
  }
  private async retire(
    tx: Tx,
    binding: { id: string; revision: number; policyRevision: number },
    operationId: string,
  ) {
    assertExpectedRevision(binding.revision);
    assertExpectedRevision(binding.policyRevision);
    const changed = await tx.workspaceAccountBinding.updateMany({
      where: { id: binding.id, revision: binding.revision, state: "active" },
      data: {
        state: "revoked",
        revision: { increment: 1 },
        policyRevision: { increment: 1 },
        pendingFenceOperationId: operationId,
        pendingFencePolicySubject: binding.id,
        pendingFencePolicyRevision: binding.policyRevision + 1,
      },
    });
    if (changed.count !== 1)
      throw new ProviderAccountError("revision_conflict");
  }
  async changeEligibility(
    request: Parameters<PersonalAccountOperationStore["changeEligibility"]>[0],
  ) {
    const input = { ...request };
    for (const ref of [
      input.actorUserId,
      input.workspaceId,
      input.memberId,
      input.userId,
    ])
      assertOpaqueReference(ref);
    if (
      !["owner", "admin", "member"].includes(input.expectedRole) ||
      (input.nextRole !== null &&
        !["owner", "admin", "member"].includes(input.nextRole))
    )
      throw new ProviderAccountError("invalid_input");
    if (input.nextUserId !== undefined) {
      assertOpaqueReference(input.nextUserId);
      if (input.nextRole === null)
        throw new ProviderAccountError("invalid_input");
    }
    await this.prisma.$transaction(async (tx) => {
      // Reassignment prelocks the new stable User before any Source/Binding FK work.
      if (input.nextUserId !== undefined) {
        const users = await tx.$queryRaw<
          { id: string }[]
        >`SELECT "id" FROM "User" WHERE "id" = ${input.nextUserId} FOR KEY SHARE`;
        if (users.length !== 1) return unavailable();
      }
      const members = await tx.$queryRaw<
        { id: string; userId: string | null; role: string }[]
      >`SELECT "id", "userId", "role" FROM "WorkspaceMember" WHERE "workspaceId" = ${input.workspaceId} AND ("userId" = ${input.actorUserId} OR "id" = ${input.memberId}) ORDER BY "id" FOR UPDATE`;
      if (!eligible(members.find((m) => m.userId === input.actorUserId)?.role))
        throw new ProviderAccountError("workspace_forbidden");
      const target = members.find((m) => m.id === input.memberId);
      const workspace = await tx.workspace.findUnique({
        where: { id: input.workspaceId },
      });
      if (
        !workspace ||
        workspace.personalOwnerUserId !== null ||
        target?.userId !== input.userId ||
        target.role !== input.expectedRole
      )
        throw new ProviderAccountError("revision_conflict");
      if (
        !eligible(input.nextRole ?? undefined) ||
        (input.nextUserId !== undefined && input.nextUserId !== input.userId)
      ) {
        const sources = await tx.$queryRaw<
          { id: string }[]
        >`SELECT s."id" FROM "ProviderAccountConnection" s WHERE s."ownerUserId" = ${input.userId} AND EXISTS (SELECT 1 FROM "WorkspaceAccountBinding" b WHERE b."connectionId" = s."id" AND b."workspaceId" = ${input.workspaceId} AND b."state" = 'active') ORDER BY s."id" FOR UPDATE`;
        if (sources.length) {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "WorkspaceAccountBinding" WHERE "workspaceId" = ${input.workspaceId} AND "connectionId" IN (${Prisma.join(sources.map((s) => s.id))}) AND "state" = 'active' ORDER BY "id" FOR UPDATE`,
          );
          const bindings = await tx.workspaceAccountBinding.findMany({
            where: {
              workspaceId: input.workspaceId,
              connectionId: { in: sources.map((s) => s.id) },
              state: "active",
            },
            orderBy: { id: "asc" },
          });
          for (const binding of bindings)
            await this.retire(tx, binding, randomUUID());
        }
      }
      if (input.nextRole === null)
        await tx.workspaceMember.delete({ where: { id: target.id } });
      else
        await tx.workspaceMember.update({
          where: { id: target.id },
          data: {
            role: input.nextRole,
            ...(input.nextUserId !== undefined
              ? { userId: input.nextUserId }
              : {}),
          },
        });
    });
  }
}
