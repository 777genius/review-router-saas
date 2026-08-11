export function checkCodexSecretWriteBoundary(checkoutRoot?: string): {
  readonly status: "pass";
  readonly auditedAdapters: readonly string[];
};
