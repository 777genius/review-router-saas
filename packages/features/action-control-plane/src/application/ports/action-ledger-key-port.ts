export type ActionLedgerKeyInput = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly githubRepositoryId: string;
  readonly repositoryFullName: string;
};

export interface ActionLedgerKeyPort {
  deriveLedgerKey(input: ActionLedgerKeyInput): string | null;
}
