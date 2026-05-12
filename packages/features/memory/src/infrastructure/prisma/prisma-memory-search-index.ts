import type {
  MemoryIndexDocument,
  MemorySearchIndexInput,
  MemorySearchIndexPort,
  MemorySearchIndexResult,
} from "../../application/ports/memory-search-index-port";
import type { MemoryScope } from "../../domain/memory-scope-policy";
import type { MemoryPrismaClient } from "./prisma-memory-mappers";

type SearchCandidate = {
  readonly id: string;
  readonly scope: string;
  readonly repositoryId: string | null;
  readonly userId: string | null;
  readonly body: string;
  readonly tags: unknown;
  readonly updatedAt: Date;
  readonly lastUsedAt: Date | null;
};

export class PrismaMemorySearchIndex implements MemorySearchIndexPort {
  constructor(private readonly prisma: MemoryPrismaClient) {}

  async supports(): ReturnType<MemorySearchIndexPort["supports"]> {
    return { capabilities: ["lexical"] };
  }

  async search(
    input: MemorySearchIndexInput,
  ): Promise<readonly MemorySearchIndexResult[]> {
    const tokens = tokenizeSearchQuery(input.safeQuery);
    if (tokens.length === 0) return [];

    const candidates = await this.prisma.memoryItem.findMany({
      where: {
        workspaceId: input.workspaceId,
        status: "active",
        AND: [
          {
            OR: [
              { scope: "workspace", repositoryId: null, userId: null },
              {
                scope: "repository",
                repositoryId: input.repositoryId,
                userId: null,
              },
              ...(input.includeUserPrefs && input.userId
                ? [
                    {
                      scope: "user_prefs" as const,
                      repositoryId: null,
                      userId: input.userId,
                    },
                  ]
                : []),
            ],
          },
          {
            OR: tokens.map((token) => ({
              body: { contains: token, mode: "insensitive" as const },
            })),
          },
        ],
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: Math.max(input.limit * 4, input.limit),
    });

    return candidates
      .filter((candidate) => isAllowedCandidate(candidate, input))
      .map((candidate) => scoreCandidate(candidate, tokens))
      .filter((result) => result.scoreParts.lexicalScore > 0)
      .sort(compareSearchResults)
      .slice(0, input.limit);
  }

  async upsertDocument(input: MemoryIndexDocument): Promise<void> {
    void input;
    return undefined;
  }

  async deleteDocument(input: {
    readonly workspaceId: string;
    readonly memoryItemId: string;
  }): Promise<void> {
    void input;
    return undefined;
  }
}

function isAllowedCandidate(
  candidate: SearchCandidate,
  input: MemorySearchIndexInput,
): boolean {
  if (candidate.scope === "workspace") {
    return candidate.repositoryId === null && candidate.userId === null;
  }
  if (candidate.scope === "repository") {
    return (
      candidate.repositoryId === input.repositoryId && candidate.userId === null
    );
  }
  return (
    input.includeUserPrefs &&
    input.userId !== null &&
    candidate.repositoryId === null &&
    candidate.userId === input.userId
  );
}

function scoreCandidate(
  candidate: SearchCandidate,
  tokens: readonly string[],
): MemorySearchIndexResult {
  const searchable = `${candidate.body} ${toTagText(candidate.tags)}`.toLowerCase();
  const matchedTokens = tokens.filter((token) => searchable.includes(token));
  const lexicalScore = matchedTokens.length / tokens.length;
  const recencyScore = recencyScoreFor(candidate.lastUsedAt ?? candidate.updatedAt);
  const scopeScore = scopeScoreFor(candidate.scope);
  const riskPenalty = 0;
  const semanticScore = 0;
  return {
    memoryItemId: candidate.id,
    scope: candidate.scope as MemoryScope,
    score:
      lexicalScore * 10 +
      scopeScore +
      recencyScore +
      semanticScore -
      riskPenalty,
    scoreParts: {
      lexicalScore,
      semanticScore,
      recencyScore,
      scopeScore,
      riskPenalty,
    },
    explanationCode: "lexical_match",
  };
}

function tokenizeSearchQuery(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9а-яё_-]+/giu, " ")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
        .slice(0, 24),
    ),
  ];
}

function toTagText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.filter((item): item is string => typeof item === "string").join(" ");
}

function recencyScoreFor(value: Date): number {
  const ageDays = Math.max(0, (Date.now() - value.getTime()) / 86_400_000);
  return Math.max(0, 1 - ageDays / 365);
}

function scopeScoreFor(scope: string): number {
  if (scope === "repository") return 0.3;
  if (scope === "workspace") return 0.2;
  return 0.1;
}

function compareSearchResults(
  left: MemorySearchIndexResult,
  right: MemorySearchIndexResult,
): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.scoreParts.scopeScore !== right.scoreParts.scopeScore) {
    return right.scoreParts.scopeScore - left.scoreParts.scopeScore;
  }
  return left.memoryItemId.localeCompare(right.memoryItemId);
}
