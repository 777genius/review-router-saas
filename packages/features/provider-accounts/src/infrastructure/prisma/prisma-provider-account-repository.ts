import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { WorkspaceBindingFenceRepositoryPort } from "../../application/ports/workspace-binding-fence-port";
import type {
  ProviderAccountAccountsQueryPort,
  OperatorAccountGrantRepositoryPort,
} from "../../application/ports/provider-account-repository-port";
import {
  ProviderAccountError,
  assertExecutable,
  assertExpectedRevision,
  assertWorkspaceOwner,
  assertWorkspaceUseOwner,
  assertOpaqueReference,
  snapshotBindingFence,
  type ScopedBindingFence,
  type BindingScope,
  type BindingState,
} from "../../domain/provider-account";
import {
  mapBinding,
  mapConnection,
  rethrowProductStorageError,
} from "./connection-mapping";

export class PrismaProviderAccountRepository
  implements
    ProviderAccountAccountsQueryPort,
    OperatorAccountGrantRepositoryPort,
    WorkspaceBindingFenceRepositoryPort
{
  private readonly prisma: PrismaClient;
  constructor(
    prisma: PrismaClient,
    private readonly operatorWorkspaceId?: string,
  ) {
    if (operatorWorkspaceId !== undefined)
      assertOpaqueReference(operatorWorkspaceId);
    this.prisma = prisma;
  }

  async denyOwnedConnectionForDisable(
    request: BindingScope & { readonly expectedMetadataRevision: number },
  ) {
    const input = {
      workspaceId: request.workspaceId,
      connectionId: request.connectionId,
      expectedMetadataRevision: request.expectedMetadataRevision,
    };
    assertOpaqueReference(input.workspaceId);
    assertOpaqueReference(input.connectionId);
    assertExpectedRevision(input.expectedMetadataRevision);
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Same lock as interactive CAS and mirror UPDATE: absence is serialized
          // against initial bind without changing the interactive revision contract.
          const locked = await tx.$queryRaw<readonly { id: string }[]>`
          SELECT "id" FROM "ProviderAccountConnection"
          WHERE "id" = ${input.connectionId} AND "ownerWorkspaceId" = ${input.workspaceId}
            AND "ownerUserId" IS NULL FOR UPDATE`;
          if (locked.length !== 1)
            throw new ProviderAccountError("connection_unavailable");
          const record = await tx.providerAccountConnection.findUniqueOrThrow({
            where: { id: input.connectionId },
          });
          const connection = mapConnection(record);
          assertWorkspaceOwner(connection, input.workspaceId);
          if (connection.metadataRevision !== input.expectedMetadataRevision)
            throw new ProviderAccountError("revision_conflict");
          const pair = {
            workspaceId: input.workspaceId,
            connectionId: input.connectionId,
          };
          let current = await tx.workspaceAccountBinding.findFirst({
            where: pair,
            orderBy: [{ state: "asc" }, { createdAt: "desc" }, { id: "desc" }],
          });
          if (current?.state === "revoked" && current.pendingFenceOperationId)
            return mapBinding(current); // Keep the exact outstanding requirement.
          if (!current) {
            assertExecutable(connection);
            // SQL requires initial active revision 1. It is never committed alone.
            current = await tx.workspaceAccountBinding.create({
              data: {
                ...pair,
                state: "active",
                revision: 1,
                policyRevision: 1,
              },
            });
          }
          assertExpectedRevision(current.revision);
          assertExpectedRevision(current.policyRevision);
          const changed = await tx.workspaceAccountBinding.updateMany({
            where: { id: current.id, revision: current.revision },
            data: {
              state: "revoked",
              revision: { increment: 1 },
              policyRevision: { increment: 1 },
              // A newer monotonic fence also covers any older required revision.
              pendingFenceOperationId: randomUUID(),
              pendingFencePolicySubject: current.id,
              pendingFencePolicyRevision: current.policyRevision + 1,
            },
          });
          if (changed.count !== 1)
            throw new ProviderAccountError("revision_conflict");
          return mapBinding(
            await tx.workspaceAccountBinding.findUniqueOrThrow({
              where: { id: current.id },
            }),
          );
        },
        { isolationLevel: "ReadCommitted" },
      );
    } catch (error) {
      return rethrowProductStorageError(error);
    }
  }

  async findOwnedConnectionByGatewayRef(request: {
    readonly workspaceId: string;
    readonly gatewayAccountRef: string;
  }) {
    const row = await this.prisma.providerAccountConnection.findFirst({
      where: {
        ownerWorkspaceId: request.workspaceId,
        ownerUserId: null,
        gatewayAccountRef: request.gatewayAccountRef,
      },
    });
    return row ? mapConnection(row) : null;
  }

  async findConnectionBinding(request: BindingScope) {
    const row = await this.prisma.workspaceAccountBinding.findFirst({
      where: {
        workspaceId: request.workspaceId,
        connectionId: request.connectionId,
        connection: { ownerUserId: null },
      },
      orderBy: [{ state: "asc" }, { createdAt: "desc" }, { id: "desc" }],
    });
    return row ? mapBinding(row) : null;
  }

  async findOwnedConnection(request: BindingScope) {
    const scope = {
      workspaceId: request.workspaceId,
      connectionId: request.connectionId,
    };
    const row = await this.prisma.providerAccountConnection.findFirst({
      where: {
        id: scope.connectionId,
        ownerWorkspaceId: scope.workspaceId,
        ownerUserId: null,
      },
    });
    return row ? mapConnection(row) : null;
  }
  async findBinding(
    request: {
      readonly workspaceId: string;
      readonly bindingId: string;
    },
    reader: Pick<PrismaClient, "workspaceAccountBinding"> = this.prisma,
  ) {
    const input = {
      workspaceId: request.workspaceId,
      bindingId: request.bindingId,
    };
    const row = await reader.workspaceAccountBinding.findUnique({
      where: {
        id_workspaceId: { id: input.bindingId, workspaceId: input.workspaceId },
      },
      include: { connection: true },
    });
    return row
      ? { binding: mapBinding(row), connection: mapConnection(row.connection) }
      : null;
  }
  async compareAndSetBinding(
    request: BindingScope & {
      readonly expectedRevision: number;
      readonly state: BindingState;
    },
  ) {
    return this.changeBinding(request);
  }

  async compareAndSetOperatorBinding(
    request: Parameters<
      OperatorAccountGrantRepositoryPort["compareAndSetOperatorBinding"]
    >[0],
  ) {
    if (!this.operatorWorkspaceId)
      throw new ProviderAccountError("workspace_forbidden");
    return this.changeBinding(request, { ...request.actor });
  }

  private async changeBinding(
    request: BindingScope & {
      readonly expectedRevision: number;
      readonly state: BindingState;
    },
    operatorActor?: {
      readonly userId?: string | undefined;
      readonly githubUserId: string;
    },
  ) {
    const input = {
      workspaceId: request.workspaceId,
      connectionId: request.connectionId,
      expectedRevision: request.expectedRevision,
      state: request.state,
    };
    assertOpaqueReference(input.workspaceId);
    assertOpaqueReference(input.connectionId);
    if (input.state !== "active" && input.state !== "revoked")
      throw new ProviderAccountError("invalid_input");
    assertExpectedRevision(input.expectedRevision, input.state === "active");
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          if (operatorActor) {
            if (operatorActor.userId !== undefined)
              assertOpaqueReference(operatorActor.userId);
            else if (!/^[0-9]+$/.test(operatorActor.githubUserId))
              throw new ProviderAccountError("invalid_input");
            const members = operatorActor.userId
              ? await tx.$queryRaw<readonly { id: string }[]>`
                  SELECT "id" FROM "WorkspaceMember"
                  WHERE "workspaceId" = ${this.operatorWorkspaceId!}
                    AND "userId" = ${operatorActor.userId}
                    AND "role" IN ('owner', 'admin') FOR SHARE`
              : await tx.$queryRaw<readonly { id: string }[]>`
                  SELECT m."id" FROM "WorkspaceMember" m JOIN "User" u ON u."id" = m."userId"
                  WHERE m."workspaceId" = ${this.operatorWorkspaceId!}
                    AND u."githubUserId" = ${BigInt(operatorActor.githubUserId)}
                    AND m."role" IN ('owner', 'admin') FOR SHARE OF m, u`;
            if (members.length !== 1)
              throw new ProviderAccountError("workspace_forbidden");
          }
          const ownerWorkspaceId = operatorActor
            ? this.operatorWorkspaceId!
            : input.workspaceId;
          const detachOperatorUse =
            !operatorActor &&
            input.state === "revoked" &&
            !!this.operatorWorkspaceId;
          // Lock the owned connection before inspecting status or the binding.
          // Synchronization UPDATEs use this same row lock. Initial bind/bind and
          // bind/revoke races are serialized without an absent-row lock gap.
          const locked = await tx.$queryRaw<readonly { id: string }[]>`
          SELECT "id" FROM "ProviderAccountConnection"
          WHERE "id" = ${input.connectionId}
            AND ("ownerWorkspaceId" = ${ownerWorkspaceId}
              OR (${detachOperatorUse} AND "ownerWorkspaceId" = ${this.operatorWorkspaceId ?? input.workspaceId}))
            AND "ownerUserId" IS NULL FOR UPDATE`;
          if (locked.length !== 1)
            throw new ProviderAccountError("connection_unavailable");
          const record = await tx.providerAccountConnection.findFirst({
            where: {
              id: input.connectionId,
              ownerUserId: null,
            },
          });
          const connection = record ? mapConnection(record) : null;
          if (operatorActor) assertWorkspaceOwner(connection, ownerWorkspaceId);
          else if (detachOperatorUse)
            assertWorkspaceUseOwner(
              connection,
              input.workspaceId,
              this.operatorWorkspaceId,
            );
          else assertWorkspaceOwner(connection, input.workspaceId);
          if (input.state === "active") assertExecutable(connection);
          const pair = {
            workspaceId: input.workspaceId,
            connectionId: input.connectionId,
          };
          const current = await tx.workspaceAccountBinding.findFirst({
            where: pair,
            orderBy: [{ state: "asc" }, { createdAt: "desc" }, { id: "desc" }],
          });
          // A recipient can revoke an existing operator grant, never manufacture one.
          if (
            !operatorActor &&
            connection.owner.kind === "workspace" &&
            connection.owner.workspaceId !== input.workspaceId &&
            !current
          )
            throw new ProviderAccountError("binding_unavailable");
          if (
            operatorActor &&
            input.state === "active" &&
            current?.pendingFenceOperationId
          )
            throw new ProviderAccountError("binding_unavailable");
          if (!current) {
            if (input.expectedRevision !== 0 || input.state !== "active") {
              throw new ProviderAccountError("revision_conflict");
            }
            return mapBinding(
              await tx.workspaceAccountBinding.create({
                data: {
                  ...pair,
                  state: "active",
                  revision: 1,
                  policyRevision: 1,
                },
              }),
            );
          }
          assertExpectedRevision(current.policyRevision);
          const changed = await tx.workspaceAccountBinding.updateMany({
            where: { id: current.id, revision: input.expectedRevision },
            data: {
              state: input.state,
              revision: { increment: 1 },
              policyRevision: { increment: 1 },
              // Higher monotonic intent retains the older outstanding requirement.
              // Grants preserve it; only its actual durable ACK can clear it.
              ...(input.state === "revoked"
                ? {
                    pendingFenceOperationId: randomUUID(),
                    pendingFencePolicySubject: current.id,
                    pendingFencePolicyRevision: current.policyRevision + 1,
                  }
                : {}),
            },
          });
          if (changed.count !== 1)
            throw new ProviderAccountError("revision_conflict");
          const updated = await tx.workspaceAccountBinding.findUniqueOrThrow({
            where: { id: current.id },
          });
          return mapBinding(updated);
        },
        { isolationLevel: "ReadCommitted" },
      );
    } catch (error) {
      return rethrowProductStorageError(error);
    }
  }

  async listOperatorGrantedBindings(request: {
    readonly workspaceId: string;
    readonly limit: number;
    readonly afterBindingId?: string;
  }) {
    const input = { ...request };
    assertOpaqueReference(input.workspaceId);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 25)
      throw new ProviderAccountError("invalid_input");
    if (input.afterBindingId !== undefined)
      assertOpaqueReference(input.afterBindingId);
    if (
      !this.operatorWorkspaceId ||
      input.workspaceId === this.operatorWorkspaceId
    )
      return [];
    const rows = await this.prisma.workspaceAccountBinding.findMany({
      where: {
        workspaceId: input.workspaceId,
        state: "active",
        pendingFenceOperationId: null,
        ...(input.afterBindingId ? { id: { gt: input.afterBindingId } } : {}),
        connection: {
          ownerWorkspaceId: this.operatorWorkspaceId,
          ownerUserId: null,
        },
      },
      orderBy: { id: "asc" },
      take: input.limit,
      include: { connection: true },
    });
    return rows.map((row) => ({
      binding: mapBinding(row),
      connection: mapConnection(row.connection),
    }));
  }

  async listPendingBindingFences(request: {
    readonly limit: number;
    readonly afterBindingId?: string;
  }) {
    const input = {
      limit: request.limit,
      ...(request.afterBindingId !== undefined
        ? { afterBindingId: request.afterBindingId }
        : {}),
    };
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new ProviderAccountError("invalid_input");
    if (input.afterBindingId !== undefined)
      assertOpaqueReference(input.afterBindingId);
    const rows = await this.prisma.workspaceAccountBinding.findMany({
      where: {
        pendingFenceOperationId: { not: null },
        ...(input.afterBindingId !== undefined
          ? { id: { gt: input.afterBindingId } }
          : {}),
      },
      orderBy: { id: "asc" },
      take: input.limit,
    });
    return rows.map(mapBinding);
  }

  async acknowledgeBindingFence(request: ScopedBindingFence): Promise<boolean> {
    const input = snapshotBindingFence(request);
    const changed = await this.prisma.workspaceAccountBinding.updateMany({
      where: {
        id: input.bindingId,
        workspaceId: input.workspaceId,
        pendingFenceOperationId: input.operationId,
        pendingFencePolicySubject: input.policySubject,
        pendingFencePolicyRevision: input.policyRevision,
      },
      data: {
        pendingFenceOperationId: null,
        pendingFencePolicySubject: null,
        pendingFencePolicyRevision: null,
        fenceAckOperationId: input.operationId,
        fenceAckPolicyRevision: input.policyRevision,
      },
    });
    return changed.count === 1;
  }
}
