# Memory Change Requests Architecture Plan

Status: draft implementation plan

Date: 2026-05-21

Related docs:

- [ADR-018: Balanced Memory Privacy Boundary](../decisions/018-balanced-memory-privacy-boundary.md)
- [ADR-020: Balanced Memory Storage and Search Strategy](../decisions/020-balanced-memory-storage-search-strategy.md)
- [ADR-021: Balanced Memory Confirmation Authority](../decisions/021-balanced-memory-authority.md)
- [ADR-026: Balanced Memory Transaction and Outbox Strategy](../decisions/026-balanced-memory-transaction-outbox.md)
- [Balanced Memory Architecture Plan](./38-balanced-memory-architecture-plan.md)

## Problem

Current Balanced Memory supports:

- direct save by explicit command: `/rr remember repo <text>`;
- pending create suggestions from natural language remember requests;
- exact-id delete/disable commands: `/rr forget mem_...`, `/rr disable-memory mem_...`;
- dashboard edit/delete/disable with server-side permission checks.

The missing UX is text-first update/delete:

```text
удали из памяти что мы используем Jest
обнови память: теперь тесты запускаем через Vitest, а не Jest
forget the old Prisma migration memory
replace the memory about browser layout checks with this: run Playwright screenshots first
```

These requests should not mutate memory immediately. They should create a
pending, auditable change request that a human can confirm or reject.

## Decision

Implement a separate `MemoryChangeRequest` aggregate instead of overloading
`MemorySuggestion`.

Recommended option chosen by product:

**Separate table and bounded lifecycle for update/delete requests** - 🎯 8
🛡️ 10 🧠 7, roughly 900-1300 LOC.

Why this is the right architecture:

- `MemorySuggestion` remains focused on create-new-memory proposals.
- `MemoryChangeRequest` owns update/delete proposal lifecycle.
- Existing direct `editMemoryItem`, `deleteMemoryItem` and `disableMemoryItem`
  semantics stay intact.
- Dashboard and action runtime can show a clearer UI: "new memory suggestion"
  vs "change existing memory".
- We avoid a large union type inside `MemorySuggestion` where half the fields are
  nullable depending on action kind.

## Goals

- Let users write update/delete requests in normal text.
- Never let an LLM or action runtime delete/update memory without explicit
  human confirmation.
- Reuse current memory authorization, safety, audit, quota and outbox patterns.
- Keep pending change requests out of runtime memory bundles.
- Preserve tenant boundaries: workspace, repository, user preference scope.
- Avoid raw prompt, model output, code, diffs, full conversation or raw comment
  storage.
- Make e2e validation possible through the existing local GitHub App path on one
  disposable repository.

## Non-Goals

- No autonomous semantic delete.
- No global user memory rollout in action runtime.
- No vector DB requirement for v1 of change requests.
- No broad rewrite of existing `MemorySuggestion`.
- No raw GitHub comment thread import.

## Current Gap

The parser already recognizes exact-id commands:

```text
/rr forget mem_123
/rr disable-memory mem_123
/rr remember mem_suggestion_123
```

The action API already accepts normalized commands:

```ts
type MemoryActionCommand =
  | { kind: "confirm_suggestion"; suggestionId: string }
  | { kind: "reject_suggestion"; suggestionId: string; reason?: string | null }
  | { kind: "disable_memory"; memoryItemId: string }
  | { kind: "forget_memory"; memoryItemId: string }
  | { kind: "list_memory"; view: "active" | "pending" };
```

But there is no first-class object for:

```ts
{
  kind: "update_existing_memory";
  targetMemoryItemId: string;
  proposedBody: string;
}
```

or:

```ts
{
  kind: "delete_existing_memory";
  targetMemoryItemId: string;
}
```

Natural language delete/update also cannot safely choose a target unless search
finds exactly one high-confidence match.

## Clean Architecture Shape

Layering stays the same as Balanced Memory:

```text
domain <- application <- interface
application -> ports <- infrastructure
```

### Domain

New domain objects:

- `MemoryChangeRequest`
- `MemoryChangeRequestSnapshot`
- `MemoryChangeRequestKind`
- `MemoryChangeRequestStatus`
- `MemoryChangeTargetResolution`
- `MemoryChangeIntent`

Domain responsibilities:

- state transitions: pending, applied, rejected, blocked, expired, superseded;
- target binding invariants;
- stale-target checks by expected body hash/version;
- tombstone-safe delete request behavior;
- no dependency on Prisma, Fastify, Next.js, GitHub SDK or search provider.

### Application

New use cases:

- `proposeMemoryChangeFromInteraction`
- `applyMemoryChangeRequest`
- `rejectMemoryChangeRequest`
- `expirePendingMemoryChangeRequests`
- `listMemoryChangeRequestsForDashboard`

Shared application services:

- `resolveMemoryChangeTarget`
- `planMemoryItemEdit`
- `planMemoryItemDelete`
- `enforceMemoryChangePolicy`

The edit/delete planning helpers are important for DRY. They should extract the
common validation and mutation planning from current `editMemoryItem` and
`deleteMemoryItem`, then both old direct use cases and new apply-change use case
can call the same code path.

### Ports

New ports:

```ts
export interface MemoryChangeRequestRepositoryPort {
  save(request: MemoryChangeRequest): Promise<void>;
  findById(input: {
    readonly workspaceId: string;
    readonly requestId: string;
  }): Promise<MemoryChangeRequestSnapshot | null>;
  findPendingByDedupeKey(input: {
    readonly workspaceId: string;
    readonly dedupeKey: string;
  }): Promise<MemoryChangeRequestSnapshot | null>;
  countPendingForWorkspace(input: {
    readonly workspaceId: string;
    readonly notExpiredAt?: Date;
  }): Promise<number>;
  listForDashboard(input: {
    readonly workspaceId: string;
    readonly repositoryId?: string | null;
    readonly scope?: MemoryScope;
    readonly statuses: readonly MemoryChangeRequestStatus[];
    readonly limit: number;
    readonly cursor?: MemoryDashboardRepositoryCursor;
    readonly notExpiredAt?: Date;
  }): Promise<readonly MemoryChangeRequestSnapshot[]>;
  listExpiredPending(input: {
    readonly workspaceId: string;
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }): Promise<readonly MemoryChangeRequestSnapshot[]>;
}
```

```ts
export interface MemoryChangeTargetResolverPort {
  resolve(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly userId: string | null;
    readonly scopeHint: MemoryScope | null;
    readonly safeQuery: string;
    readonly limit: number;
  }): Promise<readonly MemoryChangeTargetCandidate[]>;
}

export type MemoryChangeTargetCandidate = {
  readonly item: MemoryItemSnapshot;
  readonly score: number;
  readonly explanationCode:
    | "exact_id"
    | "lexical_match"
    | "semantic_match"
    | "fallback";
};
```

Why a resolver port instead of calling Prisma search directly:

- DIP: use cases depend on a capability, not storage/search implementation.
- OCP: later pgvector or hybrid search can be added without changing the use
  case.
- LSP: every resolver must return canonical active memory item snapshots, not
  raw index rows.
- ISP: the change use cases do not need the whole `MemorySearchIndexPort`.

### Infrastructure

New adapters:

- `PrismaMemoryChangeRequestRepository`
- `PrismaMemoryChangeTargetResolver`

`PrismaMemoryChangeTargetResolver` can initially use:

- exact id match if user wrote `mem_...`;
- lexical search through `PrismaMemorySearchIndex`;
- canonical reload through `MemoryItemRepositoryPort`;
- deterministic score thresholds.

No vector DB is required in v1.

### Interface

New interface pieces:

- parser for text update/delete intent;
- event normalizer output for `memoryChangeRequests`;
- action API route for change request submissions;
- action command extension for applying/rejecting requests;
- dashboard section for pending change requests.

## SOLID Mapping

SRP:

- `MemorySuggestion` only proposes new memory.
- `MemoryChangeRequest` only proposes changes to existing memory.
- Parser only identifies user intent.
- Resolver only returns candidate targets.
- Apply use case only confirms a previously created request.

OCP:

- Add new change request types through new aggregate/use cases.
- Keep existing save suggestion flow stable.
- Add resolver implementations without changing application policies.

LSP:

- Any `MemoryChangeTargetResolverPort` must enforce canonical item constraints:
  workspace match, active status, allowed scope shape, and no deleted items.
- Search adapters cannot return stale or cross-tenant hits as authoritative
  targets.

ISP:

- `MemoryChangeRequestRepositoryPort` is separate from
  `MemorySuggestionRepositoryPort`.
- Resolver port is narrower than full search/index ports.
- Dashboard list DTOs stay separate from mutation ports.

DIP:

- Use cases depend on ports.
- Prisma, GitHub, Fastify and dashboard actions compose adapters at the edge.

## Data Model

Migration sketch:

```sql
CREATE TYPE "MemoryChangeRequestKind" AS ENUM ('update', 'delete');
CREATE TYPE "MemoryChangeRequestStatus" AS ENUM (
  'pending',
  'applied',
  'rejected',
  'blocked',
  'expired',
  'superseded'
);

CREATE TABLE "MemoryChangeRequest" (
  "id" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "workspaceId" TEXT NOT NULL,
  "repositoryId" TEXT,
  "userId" TEXT,
  "scope" "MemoryScope" NOT NULL,
  "kind" "MemoryChangeRequestKind" NOT NULL,
  "status" "MemoryChangeRequestStatus" NOT NULL DEFAULT 'pending',

  "targetMemoryItemId" TEXT NOT NULL,
  "targetBodyHash" TEXT NOT NULL,
  "targetBodyVersion" INTEGER NOT NULL,
  "targetVersion" INTEGER NOT NULL,

  "proposedBody" TEXT,
  "proposedBodyHash" TEXT,
  "proposedBodyVersion" INTEGER NOT NULL DEFAULT 1,

  "reason" TEXT NOT NULL,
  "source" JSONB NOT NULL,
  "safetyReport" JSONB,
  "targetResolution" JSONB NOT NULL,

  "policyVersion" INTEGER NOT NULL DEFAULT 1,
  "safetyPolicyVersion" INTEGER NOT NULL DEFAULT 1,
  "createdByActor" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "dedupeKey" TEXT NOT NULL,

  "relatedChangeRequestId" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolvedBy" TEXT,
  "resolutionReason" TEXT,
  "appliedMemoryItemVersion" INTEGER,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT "MemoryChangeRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryChangeRequest_scope_shape_chk" CHECK (
    (
      "scope" = 'repository'
      AND "repositoryId" IS NOT NULL
      AND "userId" IS NULL
    )
    OR (
      "scope" = 'workspace'
      AND "repositoryId" IS NULL
      AND "userId" IS NULL
    )
    OR (
      "scope" = 'user_prefs'
      AND "repositoryId" IS NULL
      AND "userId" IS NOT NULL
    )
  ),
  CONSTRAINT "MemoryChangeRequest_kind_body_chk" CHECK (
    (
      "kind" = 'update'
      AND "proposedBody" IS NOT NULL
      AND char_length("proposedBody") BETWEEN 1 AND 1000
      AND "proposedBodyHash" IS NOT NULL
    )
    OR (
      "kind" = 'delete'
      AND "proposedBody" IS NULL
      AND "proposedBodyHash" IS NULL
    )
  ),
  CONSTRAINT "MemoryChangeRequest_terminal_resolution_chk" CHECK (
    (
      "status" = 'pending'
      AND "resolvedAt" IS NULL
      AND "resolvedBy" IS NULL
      AND "resolutionReason" IS NULL
    )
    OR (
      "status" <> 'pending'
      AND "resolvedAt" IS NOT NULL
      AND "resolvedBy" IS NOT NULL
      AND "resolutionReason" IS NOT NULL
    )
  )
);

CREATE INDEX "MemoryChangeRequest_workspaceId_status_expiresAt_idx"
  ON "MemoryChangeRequest"("workspaceId", "status", "expiresAt");

CREATE INDEX "MemoryChangeRequest_workspaceId_targetMemoryItemId_status_idx"
  ON "MemoryChangeRequest"("workspaceId", "targetMemoryItemId", "status");

CREATE UNIQUE INDEX "MemoryChangeRequest_pending_dedupe_uq"
  ON "MemoryChangeRequest" ("workspaceId", "dedupeKey")
  WHERE "status" = 'pending';
```

Notes:

- Do not store the old target body in `MemoryChangeRequest`; load it from
  `MemoryItem` when rendering.
- `targetBodyHash`, `targetBodyVersion` and `targetVersion` bind the request to
  the exact item state that was reviewed by the user.
- If target memory changes before confirmation, apply must fail with
  `memory_change_target_stale`.
- For delete requests, store only the target id/hash/version plus safe metadata.
- For update requests, store the proposed new distilled body because that is the
  content being approved.
- `targetResolution` stores scores and counts, not raw search results.

Example `targetResolution`:

```json
{
  "resolverVersion": 1,
  "queryHash": "sha256:...",
  "candidateCount": 2,
  "selectedScore": 0.91,
  "runnerUpScore": 0.42,
  "selectionReason": "single_high_confidence_match"
}
```

## Domain Example

```ts
export type MemoryChangeRequestKind = "update" | "delete";
export type MemoryChangeRequestStatus =
  | "pending"
  | "applied"
  | "rejected"
  | "blocked"
  | "expired"
  | "superseded";

export type MemoryChangeRequestSnapshot = {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly repositoryId: string | null;
  readonly userId: string | null;
  readonly scope: MemoryScope;
  readonly kind: MemoryChangeRequestKind;
  readonly status: MemoryChangeRequestStatus;
  readonly targetMemoryItemId: string;
  readonly targetBodyHash: string;
  readonly targetBodyVersion: number;
  readonly targetVersion: number;
  readonly proposedBody: string | null;
  readonly proposedBodyHash: string | null;
  readonly reason: string;
  readonly source: MemorySource;
  readonly safetyReport: MemorySafetyReport | null;
  readonly targetResolution: MemoryChangeTargetResolution;
  readonly createdByActor: string;
  readonly expiresAt: Date;
  readonly dedupeKey: string;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly resolutionReason: string | null;
  readonly version: number;
};

export class MemoryChangeRequest {
  private constructor(private readonly value: MemoryChangeRequestSnapshot) {}

  static createPendingUpdate(input: CreateMemoryChangeUpdateInput) {
    assertValidMemoryScope(input);
    const proposedBody = normalizeMemoryBody(input.proposedBody);
    if (!proposedBody) throw memoryError("memory_input_invalid");
    return new MemoryChangeRequest({
      ...baseChangeRequest(input),
      kind: "update",
      status: "pending",
      proposedBody,
      proposedBodyHash: createMemoryBodyHash(proposedBody),
      safetyReport: input.safetyReport,
      resolvedAt: null,
      resolvedBy: null,
      resolutionReason: null,
    });
  }

  static createPendingDelete(input: CreateMemoryChangeDeleteInput) {
    assertValidMemoryScope(input);
    return new MemoryChangeRequest({
      ...baseChangeRequest(input),
      kind: "delete",
      status: "pending",
      proposedBody: null,
      proposedBodyHash: null,
      safetyReport: null,
      resolvedAt: null,
      resolvedBy: null,
      resolutionReason: null,
    });
  }

  apply(input: {
    readonly actor: MemoryActor;
    readonly now: Date;
    readonly appliedMemoryItemVersion: number;
  }): MemoryChangeRequest {
    this.assertPending(input.now);
    return new MemoryChangeRequest({
      ...this.value,
      status: "applied",
      resolvedAt: input.now,
      resolvedBy: memoryActorRef(input.actor),
      resolutionReason: "applied",
      appliedMemoryItemVersion: input.appliedMemoryItemVersion,
      updatedAt: input.now,
      version: this.value.version + 1,
    });
  }

  reject(input: {
    readonly actor: MemoryActor;
    readonly reason: string;
    readonly now: Date;
  }): MemoryChangeRequest {
    this.assertPending(input.now);
    return new MemoryChangeRequest({
      ...this.value,
      status: "rejected",
      resolvedAt: input.now,
      resolvedBy: memoryActorRef(input.actor),
      resolutionReason: input.reason.slice(0, 500),
      updatedAt: input.now,
      version: this.value.version + 1,
    });
  }

  private assertPending(now: Date): void {
    if (this.value.status !== "pending") {
      throw memoryError("memory_version_conflict");
    }
    if (this.value.expiresAt <= now) {
      throw memoryError("memory_version_conflict");
    }
  }
}
```

## Text Intent Parser

Add a dedicated parser next to `memory-command-parser.ts`, not inside the use
case. The parser should be deterministic and conservative.

```ts
export type MemoryChangeIntent =
  | {
      readonly kind: "update";
      readonly scopeHint: MemoryScope | null;
      readonly targetQuery: string;
      readonly proposedBody: string;
      readonly rawCommand: string | null;
    }
  | {
      readonly kind: "delete";
      readonly scopeHint: MemoryScope | null;
      readonly targetQuery: string;
      readonly rawCommand: string | null;
    }
  | {
      readonly kind: "ignored";
      readonly reason:
        | "no_memory_change_intent"
        | "ambiguous_change_request"
        | "unsafe_raw_text";
    };
```

Supported text examples:

```text
удали из памяти что мы используем Jest
забудь память про старый Prisma migrate
remove memory about Jest
forget the memory that says we use Jest

обнови память: теперь тесты запускаем через Vitest, а не Jest
замени память про Jest на: Use Vitest for frontend tests.
update memory about browser checks to: Run Playwright screenshots before release.
```

Supported explicit commands:

```text
/rr propose-memory-delete mem_123
/rr propose-memory-update mem_123 Use Vitest for frontend tests.
/rr apply-memory-change mem_change_123
/rr reject-memory-change mem_change_123 stale
```

Why add explicit commands too:

- deterministic tests;
- fallback when semantic target resolution is ambiguous;
- safer support/debug path for maintainers.

## Target Resolution Policy

The resolver returns candidates. The application selects only if:

- top candidate is active;
- top candidate belongs to same workspace;
- top candidate scope is allowed for the current action session;
- top score is at least `0.85` for natural-language delete;
- top score is at least `0.80` for update;
- runner-up score is at least `0.20` lower than top score;
- candidate count is not zero;
- target body hash/version are captured at request creation.

If confidence is too low:

```ts
return {
  status: "rejected",
  reason: "memory_change_target_not_found",
};
```

If multiple close matches exist:

```ts
return {
  status: "rejected",
  reason: "memory_change_target_ambiguous",
};
```

The bot response can say:

```text
I found more than one matching memory. Use /rr memory in the dashboard or pass an exact id:
/rr propose-memory-delete mem_...
```

Do not create pending requests for ambiguous targets. Pending rows should mean
"there is a specific target ready for confirmation", not "we need a human to
guess which target".

## Use Case: Propose Change

```ts
export type ProposeMemoryChangeFromInteractionInput = {
  readonly envelope: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly userId: string | null;
    readonly actor: MemoryActor;
    readonly source: MemorySource;
    readonly intent: MemoryChangeIntent;
    readonly sourceTextHash: string | null;
  };
};

export async function proposeMemoryChangeFromInteraction(
  input: ProposeMemoryChangeFromInteractionInput,
  deps: MemoryChangeUseCaseDependencies,
): Promise<MemoryChangeMutationResult> {
  const now = deps.clock.now();

  const policy = await deps.memoryPolicyConfig.getPolicy({
    workspaceId: input.envelope.workspaceId,
    repositoryId: input.envelope.repositoryId,
  });

  if (!policy.memoryEnabled) {
    return { status: "rejected", reason: "memory_disabled" };
  }

  const candidates = await deps.memoryChangeTargetResolver.resolve({
    workspaceId: input.envelope.workspaceId,
    repositoryId: input.envelope.repositoryId,
    userId: input.envelope.userId,
    scopeHint: input.envelope.intent.scopeHint,
    safeQuery: input.envelope.intent.targetQuery,
    limit: 5,
  });

  const selected = selectMemoryChangeTarget(candidates, input.envelope.intent);
  if (selected.status !== "selected") return selected.rejection;

  const target = selected.item;
  const permission = await deps.memoryPermissions.canConfirmMemory({
    workspaceId: target.workspaceId,
    repositoryId: target.repositoryId,
    userId: target.userId,
    scope: target.scope,
    actor: input.envelope.actor,
  });
  if (!permission.allowed) {
    return {
      status: "rejected",
      reason: permission.reason,
      retryable: permission.retryable,
    };
  }

  const safety =
    input.envelope.intent.kind === "update"
      ? evaluateMemorySafety({
          body: input.envelope.intent.proposedBody,
          scope: target.scope,
          redactedSourceExcerpt: input.envelope.source.redactedExcerpt,
        })
      : null;

  if (safety?.severity === "blocked") {
    return {
      status: "rejected",
      reason: safety.blockedReason ?? "memory_safety_blocked",
    };
  }

  const request = MemoryChangeRequest.createPending({
    id: deps.memoryIds.newId("mem_change"),
    workspaceId: target.workspaceId,
    repositoryId: target.repositoryId,
    userId: target.userId,
    scope: target.scope,
    kind: input.envelope.intent.kind,
    target,
    proposedBody:
      input.envelope.intent.kind === "update"
        ? input.envelope.intent.proposedBody
        : null,
    safetyReport: safety,
    source: input.envelope.source,
    targetResolution: selected.resolution,
    actor: input.envelope.actor,
    expiresAt: new Date(
      now.getTime() + policy.suggestionTtlDays[target.scope] * 86_400_000,
    ),
    dedupeKey: changeRequestDedupeKey(input.envelope, target),
    now,
  });

  await deps.memoryTransaction.run(async (tx) => {
    await tx.memoryChangeRequests.save(request);
    await tx.memoryAudit.record({
      workspaceId: target.workspaceId,
      actor: memoryActorRef(input.envelope.actor),
      action: "memory.change_request.created",
      targetType: "memory_change_request",
      targetId: request.snapshot().id,
      metadata: {
        kind: request.snapshot().kind,
        scope: target.scope,
        targetMemoryItemId: target.id,
        targetBodyHash: target.bodyHash,
        proposedBodyHash: request.snapshot().proposedBodyHash,
      },
    });
  });

  return {
    status: "created",
    id: request.snapshot().id,
    version: request.snapshot().version,
    targetMemoryItemId: target.id,
    kind: request.snapshot().kind,
  };
}
```

## Use Case: Apply Change

The apply use case must re-check everything. The request is only a pending
proposal, not an authorization grant.

```ts
export async function applyMemoryChangeRequest(
  input: {
    readonly workspaceId: string;
    readonly requestId: string;
    readonly actor: MemoryActor;
    readonly expectedVersion?: number;
  },
  deps: MemoryChangeUseCaseDependencies,
): Promise<MemoryChangeMutationResult> {
  const request = await deps.memoryChangeRequests.findById({
    workspaceId: input.workspaceId,
    requestId: input.requestId,
  });
  if (!request) return { status: "noop", reason: "memory_change_not_found" };
  if (request.status !== "pending") {
    return { status: "noop", reason: request.status, id: request.id };
  }

  const target = await deps.memoryItems.findById({
    workspaceId: input.workspaceId,
    itemId: request.targetMemoryItemId,
  });
  if (!target || target.status !== "active") {
    return { status: "rejected", reason: "memory_change_target_unavailable" };
  }

  if (
    target.bodyHash !== request.targetBodyHash ||
    target.bodyVersion !== request.targetBodyVersion ||
    target.version !== request.targetVersion
  ) {
    return {
      status: "rejected",
      reason: "memory_change_target_stale",
      retryable: true,
    };
  }

  // Recheck policy, permission and safety at confirmation time.
  // Then apply update/delete and resolve the request in the same transaction.
}
```

Important DRY detail:

Do not copy the full body of `editMemoryItem` and `deleteMemoryItem`. Extract
shared internal planners:

```ts
export async function planMemoryItemEdit(input, deps): Promise<EditPlan>;
export async function planMemoryItemDelete(input, deps): Promise<DeletePlan>;
export async function commitMemoryItemEdit(plan, tx): Promise<void>;
export async function commitMemoryItemDelete(plan, tx): Promise<void>;
```

Then:

- `editMemoryItem` becomes `plan -> transaction -> commit`;
- `deleteMemoryItem` becomes `plan -> transaction -> commit`;
- `applyMemoryChangeRequest` becomes `load request -> plan -> transaction ->
commit item + save request`.

This avoids diverging audit/outbox behavior.

## API Contracts

Add one new candidate endpoint and extend the existing command endpoint.

### POST `/api/action/v1/memory-change-requests`

Input:

```ts
const memoryChangeRequestBodySchema = z.discriminatedUnion("kind", [
  z.object({
    protocolVersion: z.literal(1).default(1),
    kind: z.literal("update"),
    targetQuery: z.string().min(1).max(500),
    proposedBody: z.string().min(1).max(memoryBodyMaxCharacters),
    requestedScope: z.enum(["repository", "workspace"]).nullable().optional(),
    sourceTextHash: z.string().min(1).max(256).nullable().optional(),
    extractionVersion: z.number().int().min(1).max(100).default(1),
    source: safeMemorySourceSchema,
  }),
  z.object({
    protocolVersion: z.literal(1).default(1),
    kind: z.literal("delete"),
    targetQuery: z.string().min(1).max(500),
    requestedScope: z.enum(["repository", "workspace"]).nullable().optional(),
    sourceTextHash: z.string().min(1).max(256).nullable().optional(),
    extractionVersion: z.number().int().min(1).max(100).default(1),
    source: safeMemorySourceSchema,
  }),
]);
```

Same raw payload guard as candidate endpoint:

- reject `conversation`;
- reject `messages`;
- reject `prompt`;
- reject `modelResponse`;
- reject `rawComment`;
- reject `diff`;
- reject `patch`;
- reject `code`.

### POST `/api/action/v1/memory-commands`

Extend schema:

```ts
z.object({
  kind: z.literal("apply_memory_change"),
  requestId: z.string().regex(/^mem_change_[A-Za-z0-9_-]+$/),
}).strict();
```

```ts
z.object({
  kind: z.literal("reject_memory_change"),
  requestId: z.string().regex(/^mem_change_[A-Za-z0-9_-]+$/),
  reason: z.string().max(500).nullable().optional(),
}).strict();
```

Do not add direct `update_memory` or semantic `delete_memory` commands in the
action API. Direct mutation by text is the unsafe path this feature avoids.

## Action Runtime UX

The interaction workflow should post a bot reply after creating a change
request.

Delete example:

```text
Memory change request created.

Target:
"Use Jest for frontend tests."

Proposed action:
Delete this memory.

Confirm: /rr apply-memory-change mem_change_123
Reject: /rr reject-memory-change mem_change_123
```

Update example:

```text
Memory change request created.

Target:
"Use Jest for frontend tests."

Proposed replacement:
"Use Vitest for frontend tests."

Confirm: /rr apply-memory-change mem_change_456
Reject: /rr reject-memory-change mem_change_456
```

Ambiguous example:

```text
I found multiple matching memory items. Use an exact id or confirm from the dashboard.
```

This response can include target body because it is already confirmed memory
visible to the authorized runtime. It must not include raw source excerpts,
prompt text, diff or model output.

## Dashboard UX

Add a third inbox group inside memory management:

- "New suggestions"
- "Change requests"
- "Confirmed memory"

For change requests show:

- action: update/delete;
- current target body loaded from canonical `MemoryItem`;
- proposed replacement for update;
- target status: current, stale, deleted, disabled;
- actor/source metadata;
- confirm/reject actions;
- stale warning if hash/version no longer match.

Do not let dashboard apply stale requests. Show:

```text
Target memory changed after this request was created. Reject this request and create a fresh one.
```

## Privacy Rules

- Store proposed update body, because it is the body being approved.
- Do not store target old body in the request row.
- Store target body hash/version for binding.
- Store safe source summary only.
- Audit/outbox metadata contains ids, scopes, hashes and versions only.
- Deleted target body/source must be tombstoned by the existing delete behavior.
- Pending change requests never enter runtime memory bundle.
- Support diagnostics expose counts only.

## Authorization Rules

At proposal time:

- reject if actor cannot manage target scope;
- repository scope requires selected, active repository;
- workspace scope requires workspace admin;
- user preferences require matching user id and should stay disabled in action
  runtime until runtime has authenticated user identity.

At apply time:

- recheck policy;
- recheck permission;
- recheck target active status;
- recheck target body hash/version;
- re-run safety for proposed update body;
- reject stale request instead of silently retargeting.

## Edge Cases

| Case                                           | Expected behavior                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| No target found                                | Reject with `memory_change_target_not_found`; bot suggests exact id/dashboard |
| Multiple close targets                         | Reject with `memory_change_target_ambiguous`; no pending row                  |
| Target deleted before apply                    | Reject with `memory_change_target_unavailable`                                |
| Target disabled before apply                   | Reject or require dashboard re-enable path; do not edit disabled by text      |
| Target body edited before apply                | Reject with `memory_change_target_stale`                                      |
| Proposed update duplicates another active item | Noop/reject `memory_duplicate`                                                |
| Proposed update contains secret/code/diff      | Reject `memory_safety_blocked`                                                |
| Request expired                                | Mark expired and return noop                                                  |
| Comment edited with same source id             | Supersede old pending change request from same source                         |
| Bot comment contains command quote             | Parser must ignore quoted/fenced/table/html-comment commands                  |
| Fork PR                                        | Keep current fork policy; no private workspace memory exposure                |
| Memory disabled                                | Direct cleanup by id can remain; text change request creation should reject   |
| Outbox indexing fails                          | Request applied state stays canonical; index retry via existing outbox        |
| Duplicate GitHub delivery                      | Dedupe by workspace/source/action/target/proposed hash                        |
| User says "forget everything"                  | Reject as unsafe/ambiguous, never bulk delete                                 |
| User names a secret                            | Safety blocks if secret-like text appears                                     |
| Old request references pruned target           | Reject unavailable; retention job may prune request later                     |

## Implementation Steps

1. Add domain types and tests.

   Files:
   - `packages/features/memory/src/domain/memory-change-request.ts`
   - `packages/features/memory/src/tests/memory-change-request.test.ts`

2. Add ports and dependency shape.

   Files:
   - `packages/features/memory/src/application/ports/memory-change-request-repository-port.ts`
   - `packages/features/memory/src/application/ports/memory-change-target-resolver-port.ts`
   - extend `memory-use-case-types.ts`
   - extend `memory-transaction-port.ts`

3. Add Prisma migration and mappers.

   Files:
   - `packages/platform/db/prisma/migrations/000019_memory_change_requests/migration.sql`
   - `packages/features/memory/src/infrastructure/prisma/prisma-memory-change-request-repository.ts`
   - extend `prisma-memory-mappers.ts`
   - extend `prisma-memory-transaction.ts`

4. Extract shared edit/delete planners.

   Files:
   - `packages/features/memory/src/application/use-cases/plan-memory-item-edit.ts`
   - `packages/features/memory/src/application/use-cases/plan-memory-item-delete.ts`
   - refactor `edit-memory-item.ts`
   - refactor `delete-memory-item.ts`

5. Add change request use cases.

   Files:
   - `propose-memory-change-from-interaction.ts`
   - `apply-memory-change-request.ts`
   - `reject-memory-change-request.ts`
   - `expire-pending-memory-change-requests.ts`
   - `list-memory-change-requests-for-dashboard.ts`

6. Add parser and normalizer support.

   Files:
   - `memory-change-command-parser.ts`
   - `memory-interaction-event-normalizer.ts`
   - `memory-interaction.test.ts`

7. Add action API contract.

   Files:
   - `apps/api/src/action-memory-routes.ts`
   - `apps/api/src/app.ts`
   - `apps/api/src/app.test.ts`
   - `packages/features/api-demo/src/domain/api-demo.ts`

8. Add workflow env wiring.

   Files:
   - `packages/features/workflow-provisioning/src/domain/workflow-template.ts`
   - workflow template tests

   New env:

   ```yaml
   REVIEW_ROUTER_MEMORY_CHANGE_REQUEST_ENDPOINT: "/api/action/v1/memory-change-requests"
   ```

9. Add action runtime support.

   The runtime must:
   - parse text update/delete intent;
   - call the new change request endpoint;
   - post confirm/reject commands;
   - send `apply_memory_change` and `reject_memory_change` commands.

10. Add dashboard UI.

    Files:
    - `apps/web/app/dashboard/memory-management-panel.tsx`
    - `apps/web/app/dashboard/actions.ts`
    - `apps/web/src/features/memory/application/memory-dashboard-view-model.ts`

11. Add maintenance.

    Files:
    - `apps/worker/src/memory-maintenance.ts`
    - `apps/worker/src/worker.ts`
    - worker tests

12. Update docs and runbooks.

    Files:
    - `ai-docs/operations/02-runbooks.md`
    - `ai-docs/security/balanced-memory-beta-security-matrix.md`
    - this plan after implementation with evidence links.

## Tests

Unit tests:

- domain transitions for pending/apply/reject/expire/supersede;
- create update request rejects empty/unsafe proposed body;
- create delete request rejects missing target binding;
- target selector rejects no match;
- target selector rejects ambiguous close scores;
- target selector accepts one high-confidence match;
- stale target hash/version rejection;
- duplicate proposed update rejection;
- permission denial for member/PR author;
- workspace admin vs repository maintainer boundary.

Application tests:

- `proposeMemoryChangeFromInteraction` creates pending update request;
- `proposeMemoryChangeFromInteraction` creates pending delete request;
- `applyMemoryChangeRequest` edits item and resolves request in one transaction;
- `applyMemoryChangeRequest` deletes item and resolves request in one transaction;
- audit/outbox contain only ids/hash/version metadata;
- pending requests do not appear in `buildActionMemoryBundle`;
- expired request cannot apply;
- edited source comment supersedes previous pending request.

API tests:

- `POST /api/action/v1/memory-change-requests` rejects raw payload keys;
- update request endpoint returns `mem_change_...`;
- delete request endpoint returns `mem_change_...`;
- command endpoint applies update request;
- command endpoint applies delete request;
- command endpoint rejects request;
- unauthenticated request fails;
- non-interaction workflow session fails;
- cross-workspace id fails.

Dashboard tests:

- pending change request renders current target body and proposed replacement;
- stale request warning renders;
- confirm uses `expectedVersion`;
- reject works;
- deleted/disabled target is not shown as applyable.

DB e2e:

Extend `pnpm spike:memory:e2e` so a fresh temporary Postgres DB proves:

1. direct save creates target memory;
2. text update creates `MemoryChangeRequest`;
3. apply update changes target body and queues reindex;
4. text delete creates `MemoryChangeRequest`;
5. apply delete tombstones target and queues index delete;
6. stale update request is rejected after target edit;
7. ambiguous target text creates no pending request;
8. audit/outbox/usage telemetry contain no body/source/prompt/diff.

## Local GitHub App E2E Plan

Goal: prove the feature through a real GitHub comment workflow using one
existing disposable repository before any hosted deploy.

Use the existing real GitHub smoke as the baseline:

```bash
REVIEW_ROUTER_GITHUB_MEMORY_E2E=1 \
  REVIEW_ROUTER_GITHUB_MEMORY_E2E_PR=<open-disposable-pr-number> \
  pnpm spike:github-memory:e2e
```

For this feature, add a new script:

```bash
REVIEW_ROUTER_GITHUB_MEMORY_CHANGE_E2E=1 \
  REVIEW_ROUTER_GITHUB_MEMORY_CHANGE_E2E_REPO=777genius/review-router-saas-e2e \
  REVIEW_ROUTER_GITHUB_MEMORY_CHANGE_E2E_PR=<open-disposable-pr-number> \
  pnpm spike:github-memory-change:e2e
```

### Preflight

1. Use one disposable test repository, preferably the existing
   `777genius/review-router-saas-e2e`.
2. Verify `gh auth status`.
3. Verify the local GitHub App profile is applied:

   ```bash
   pnpm github-app:use-profile -- --profile <local-profile-path> --include-urls
   pnpm github-app:check
   ```

4. Start local API/web/worker against a local DB.
5. Expose local API to GitHub Actions through the same tunnel URL used in the
   local GitHub App profile.
6. Ensure `.github/workflows/reviewrouter-interaction.yml` on the test repo
   points to the branch/ref containing the new action runtime.
7. Ensure the interaction workflow has:

   ```yaml
   REVIEW_ROUTER_MEMORY_ENABLED: "true"
   REVIEW_ROUTER_MEMORY_PROTOCOL_VERSION: "1"
   REVIEW_ROUTER_MEMORY_BUNDLE_ENDPOINT: "/api/action/v1/memory"
   REVIEW_ROUTER_MEMORY_CANDIDATE_ENDPOINT: "/api/action/v1/memory-candidates"
   REVIEW_ROUTER_MEMORY_COMMAND_ENDPOINT: "/api/action/v1/memory-commands"
   REVIEW_ROUTER_MEMORY_CHANGE_REQUEST_ENDPOINT: "/api/action/v1/memory-change-requests"
   ```

### E2E Flow

The new smoke script should post comments and wait for the interaction workflow
run after each comment.

1. Create baseline memory:

   ```text
   /rr remember repo rr-change-smoke-<timestamp> Use Jest for frontend tests.
   ```

   Expected:
   - workflow run succeeds;
   - bot reply exposes `mem_...`;
   - direct memory item exists.

2. Request update by natural text:

   ```text
   обнови память про rr-change-smoke-<timestamp>: теперь Use Vitest for frontend tests.
   ```

   Expected:
   - workflow run succeeds;
   - bot reply exposes `mem_change_...`;
   - bot reply shows target and proposed replacement;
   - memory item is not changed yet.

3. Confirm update:

   ```text
   /rr apply-memory-change mem_change_...
   ```

   Expected:
   - workflow run succeeds;
   - bot reply says applied;
   - later memory bundle contains Vitest text and not Jest text.

4. Request delete by natural text:

   ```text
   удали из памяти rr-change-smoke-<timestamp> Vitest
   ```

   Expected:
   - workflow run succeeds;
   - bot reply exposes a new `mem_change_...`;
   - memory item still appears until confirmation.

5. Confirm delete:

   ```text
   /rr apply-memory-change mem_change_...
   ```

   Expected:
   - workflow run succeeds;
   - bot reply says deleted/applied;
   - later memory bundle no longer contains marker;
   - DB row is tombstoned and index delete event is queued.

6. Ambiguous text guard:

   Create two memories with same marker family, then post:

   ```text
   удали память про rr-change-smoke
   ```

   Expected:
   - no `mem_change_...` is created;
   - bot asks for exact id/dashboard confirmation.

7. Bot loop guard:

   Wait after the latest bot reply.

   Expected:
   - no new interaction run triggered by the bot's own comment.

### Local GitHub App Caveats

- This is not default CI. It requires GitHub App secrets, `gh`, an installed app,
  an open test PR and a reachable public API URL.
- Do not create a new GitHub repository unless isolation is required.
- Record PR URL, run URLs, marker, created memory id and change request ids in
  the final evidence block.
- Clean up by applying delete to the final memory or deleting the disposable PR.

## Commands to Run Before Real GitHub Smoke

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm lint
pnpm architecture:check
pnpm spike:memory:e2e
git diff --check
```

Then local GitHub App smoke:

```bash
REVIEW_ROUTER_GITHUB_MEMORY_CHANGE_E2E=1 \
  REVIEW_ROUTER_GITHUB_MEMORY_CHANGE_E2E_REPO=777genius/review-router-saas-e2e \
  REVIEW_ROUTER_GITHUB_MEMORY_CHANGE_E2E_PR=<open-disposable-pr-number> \
  pnpm spike:github-memory-change:e2e
```

## Risk Matrix

| Risk                           |  🎯 |  🛡️ |  🧠 | Mitigation                                                              |
| ------------------------------ | --: | --: | --: | ----------------------------------------------------------------------- |
| Wrong semantic target selected |   7 |   5 |   8 | High threshold, runner-up gap, reject ambiguous, exact-id fallback      |
| Human confirms stale request   |   8 |   8 |   5 | Bind target hash/version, reject stale on apply                         |
| Model deletes by itself        |   9 |  10 |   4 | Only creates pending request, apply requires command and permission     |
| Raw prompt/comment leak        |   8 |   8 |   6 | Raw payload guard, safe source summaries, audit/outbox hash-only        |
| Duplicate GitHub deliveries    |   8 |   8 |   5 | Dedupe key by source/action/target/proposed hash                        |
| Divergent edit/delete behavior |   7 |   7 |   7 | Extract shared edit/delete planners                                     |
| Dashboard and action disagree  |   7 |   7 |   6 | Both use same application use cases                                     |
| Disabled memory mode confusion |   6 |   8 |   6 | Keep direct cleanup, reject text-created change requests while disabled |

## Lowest-Confidence Areas

1. **Action runtime ownership** - 🎯 7 🛡️ 7 🧠 7

   The SaaS package clearly exposes endpoints, but the GitHub Action runtime
   must also be updated and built into `dist/index.js`. Before implementation,
   inspect the action runtime code path that currently parses memory responses
   and posts bot comments.

2. **Local GitHub App tunnel setup** - 🎯 7 🛡️ 8 🧠 5

   The repo has GitHub App profile helpers and real smoke scripts, but the exact
   local tunnel command is environment-specific. Use the existing local profile
   and do not hard-code tunnel tooling in product code.

3. **Target resolution thresholds** - 🎯 6 🛡️ 7 🧠 8

   Initial lexical matching may be enough for marker-heavy smoke tests but weak
   for natural user phrasing. Start conservative and collect examples before
   lowering thresholds.

4. **Policy when memory is disabled** - 🎯 7 🛡️ 8 🧠 5

   Existing design allows cleanup while disabled. Text-created change requests
   are new rows, so keep them disabled at first and rely on exact-id direct
   cleanup.

## Open Questions

1. Should `MemoryChangeRequest` have its own quota, or reuse pending suggestion
   quota?

   Recommendation: separate quota with a smaller default, because change
   requests are more sensitive.

2. Should natural text delete support workspace scope?

   Recommendation: yes only for workspace admins; repository scope remains the
   default in action runtime.

3. Should dashboard show ambiguous candidate list?

   Recommendation: dashboard can show candidates, GitHub bot should not create a
   pending request for ambiguity.

4. Should `apply-memory-change` support expected version from comment?

   Recommendation: no. The request already stores target version and request
   version; comments are too clunky for version tokens.

## Success Criteria

- Users can request update/delete in normal text.
- System creates `mem_change_...` pending request instead of mutating memory.
- Confirm command applies the exact reviewed change.
- Reject command resolves without changing memory.
- Stale, ambiguous and unsafe requests fail closed.
- Runtime bundle never includes pending change request content.
- Audit/outbox/support diagnostics do not leak bodies, raw comments, prompts,
  diffs or model output.
- Fresh DB e2e passes.
- One-repo local GitHub App smoke passes and records evidence.

📌 Summary:

Build `MemoryChangeRequest` as a separate aggregate. Let text create pending
update/delete requests only when target resolution is high-confidence. Require
`/rr apply-memory-change mem_change_...` before mutation. Reuse current edit and
delete semantics through shared planners so direct dashboard/action mutations and
change-request confirmations cannot drift.
