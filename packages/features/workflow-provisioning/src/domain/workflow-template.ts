export type ReviewRouterWorkflowOptions = {
  readonly actionRef: string;
  readonly apiUrl: string;
  readonly runtimeConfigMode: "oidc" | "static";
  readonly staticRuntimeEnv?: Readonly<Record<string, string>>;
};

export const defaultWorkflowPath = ".github/workflows/reviewrouter.yml";
export const defaultSetupBranch = "reviewrouter/setup";

export function renderReviewRouterWorkflow(
  options: ReviewRouterWorkflowOptions,
): string {
  const staticRuntimeEnv = Object.entries(options.staticRuntimeEnv ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `          ${key}: ${JSON.stringify(value)}`)
    .join("\n");
  const staticRuntimeEnvBlock = staticRuntimeEnv ? `\n${staticRuntimeEnv}` : "";
  const oidcStep =
    options.runtimeConfigMode === "oidc"
      ? `
      - name: Fetch ReviewRouter runtime config
        if: github.event.pull_request.head.repo.full_name == github.repository
        shell: bash
        env:
          REVIEWROUTER_API_URL: ${options.apiUrl}
          REVIEWROUTER_OIDC_AUDIENCE: reviewrouter
        run: |
          set -euo pipefail
          if [ -z "\${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ] || [ -z "\${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
            echo "ReviewRouter OIDC is unavailable. Check id-token: write permission."
            exit 1
          fi
          echo "ReviewRouter runtime config will be fetched by the action using GitHub OIDC."
`
      : "";

  return `name: ReviewRouter

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write
  issues: write
  id-token: write

jobs:
  review:
    name: review
    runs-on: ubuntu-latest
    if: github.event.pull_request.draft == false
    steps:
      - name: Checkout pull request code
        uses: actions/checkout@v6
        with:
          persist-credentials: false

      - name: Skip fork pull requests
        if: github.event.pull_request.head.repo.full_name != github.repository
        shell: bash
        run: |
          echo "ReviewRouter skipped this fork pull request because secret-backed provider execution is disabled by default."
${oidcStep}      - name: Run ReviewRouter
        if: github.event.pull_request.head.repo.full_name == github.repository
        uses: ${options.actionRef}
        env:
          REVIEWROUTER_API_URL: ${options.apiUrl}
          REVIEWROUTER_RUNTIME_CONFIG_MODE: ${options.runtimeConfigMode}
          REVIEWROUTER_STATIC_CONFIG_FALLBACK: "true"${staticRuntimeEnvBlock}
`;
}
