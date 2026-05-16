import type { MemoryScope } from "../../domain/memory-scope-policy";

export type MemorySearchCapability =
  | "lexical"
  | "full_text"
  | "semantic_vector"
  | "hybrid";

export type MemorySearchIndexCapabilities = {
  readonly capabilities: readonly MemorySearchCapability[];
};

export type MemorySearchIndexInput = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly userId: string | null;
  readonly safeQuery: string;
  readonly limit: number;
  readonly includeUserPrefs: boolean;
};

export type MemorySearchIndexScoreParts = {
  readonly lexicalScore: number;
  readonly semanticScore: number;
  readonly recencyScore: number;
  readonly scopeScore: number;
  readonly riskPenalty: number;
};

export type MemorySearchIndexResult = {
  readonly memoryItemId: string;
  readonly score: number;
  readonly scope: MemoryScope;
  readonly scoreParts: MemorySearchIndexScoreParts;
  readonly explanationCode: "lexical_match" | "semantic_match" | "fallback";
};

export type MemoryIndexDocument = {
  readonly workspaceId: string;
  readonly memoryItemId: string;
  readonly repositoryId: string | null;
  readonly userId: string | null;
  readonly scope: MemoryScope;
  readonly body: string;
  readonly bodyHash: string;
  readonly bodyVersion: number;
  readonly tags: readonly string[];
  readonly updatedAt: Date;
};

export interface MemorySearchIndexPort {
  supports(): Promise<MemorySearchIndexCapabilities>;
  search(
    input: MemorySearchIndexInput,
  ): Promise<readonly MemorySearchIndexResult[]>;
  upsertDocument(input: MemoryIndexDocument): Promise<void>;
  deleteDocument(input: {
    readonly workspaceId: string;
    readonly memoryItemId: string;
  }): Promise<void>;
}
