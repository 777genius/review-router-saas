export const legacyReviewRouterWorkflowPath =
  ".github/workflows/reviewrouter.yml";
export const managedCodexWorkflowPath =
  ".github/workflows/reviewrouter-codex.yml";
export const managedInteractionWorkflowPath =
  ".github/workflows/reviewrouter-interaction.yml";

export const managedReviewRouterWorkflowPaths = [
  legacyReviewRouterWorkflowPath,
  managedCodexWorkflowPath,
  managedInteractionWorkflowPath,
] as const;
