import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { InvestigationShadowEvidencePersistenceStatus } from "../application/ports/investigation-shadow-evidence-ports";
import {
  investigationShadowEvidenceMaxPruneLimit,
  investigationShadowEvidenceMaxQueryLimit,
} from "../domain/investigation-shadow-evidence";
import { PrismaInvestigationShadowEvidenceStore } from "../infrastructure/prisma/prisma-investigation-shadow-evidence-store";
import { shadowEvidence } from "./investigation-shadow-evidence-fixtures";

describe("Prisma investigation shadow evidence store", () => {
  it("persists only through the dedicated shadow table", async () => {
    const create = vi.fn(async ({ data }: { data: unknown }) => data);
    const normalObservationCreate = vi.fn();
    const store = new PrismaInvestigationShadowEvidenceStore({
      reviewInvestigationShadowEvidence: { create },
      reviewEvidenceObservation: { create: normalObservationCreate },
    } as unknown as PrismaClient);

    await expect(store.persist(shadowEvidence())).resolves.toMatchObject({
      status: InvestigationShadowEvidencePersistenceStatus.Persisted,
      evidence: { authority: "non_authoritative" },
    });
    expect(create).toHaveBeenCalledOnce();
    expect(normalObservationCreate).not.toHaveBeenCalled();
  });

  it("uses a bounded skip-locked deletion query", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        { shadowEvidenceId: "investigation-shadow-fixture" },
      ]);
    const store = new PrismaInvestigationShadowEvidenceStore({
      $queryRaw: queryRaw,
    } as unknown as PrismaClient);

    await expect(
      store.prune({ retainUntilOrBeforeMs: Date.UTC(2026, 8, 3), limit: 25 }),
    ).resolves.toBe(1);
    const query = queryRaw.mock.calls[0]![0] as {
      readonly sql: string;
      readonly values: readonly unknown[];
    };
    expect(query.sql).toContain('FROM "ReviewInvestigationShadowEvidence"');
    expect(query.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(query.sql).not.toContain('"ReviewEvidenceObservation"');
    expect(query.values).toContain(25);
  });

  it("rejects unbounded query and prune requests before touching Prisma", async () => {
    const findMany = vi.fn();
    const queryRaw = vi.fn();
    const store = new PrismaInvestigationShadowEvidenceStore({
      $queryRaw: queryRaw,
      reviewInvestigationShadowEvidence: { findMany },
    } as unknown as PrismaClient);
    const fixture = shadowEvidence();

    await expect(
      store.findByScopeRevision({
        scope: fixture.scope,
        reviewRevisionHash: fixture.revision.reviewRevisionHash,
        limit: investigationShadowEvidenceMaxQueryLimit + 1,
      }),
    ).rejects.toThrow("investigation_shadow_query_limit_invalid");
    await expect(
      store.prune({
        retainUntilOrBeforeMs: Date.UTC(2026, 8, 3),
        limit: investigationShadowEvidenceMaxPruneLimit + 1,
      }),
    ).rejects.toThrow("investigation_shadow_prune_limit_invalid");
    expect(findMany).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
