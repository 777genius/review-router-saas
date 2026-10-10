# Account Gateway integration stack

Owner decision: 2026-10-03. This branch is the integration base for the plan51/contract53 program.
The root PR targets main and stays draft until assembled qualification.
Component PRs target feat/account-gateway-integration or an explicit parent
component. Review each bounded diff; integrate accepted components through
GitHub PRs, retain their commits/issue refs, and run final assembled E2E on an
exact SHA before the root PR is ready. No deployment or legacy retirement is
implied by integration.

## Current and next components

- Plan corrections after Opus 5.5/xhigh critique, including all finding dispositions.
- RR C1 owner/use persistence: preserve existing PR 488 and its review history;
  qualify migration 117 catalog, reconcile this base, then retarget to this branch.
- RR C2 server gateway adapter/configuration/OIDC relay.
- RR C3 Accounts UI and Models/repository batch policy.
- D-min real Codex/MiMo CLI tools/final review/publication; then D-final lifecycle
  and measured enforced limits. UI may proceed in parallel with D-min.

## Service repositories

GitHub PR bases are repository-local. The reusable service and pinned native
fork keep their own component PRs, linked from the root PR rather than copied
into RR. Account Gateway SDK/kernel PRs 1-3 are already merged. Pending native
fork PR 2 is preserved; bounded bootstrap/lifecycle children use that reviewed
foundation. The root RR candidate pins only accepted service/SDK/engine SHAs.

## Rules

Default tier only; explicit gpt-6.1-sol/high/default writers and gpt-6.1-sol/xhigh/default independent
reviews. Separate hosted jobs/workspaces and non-overlapping ownership.
Target <=2000 changed LOC per component; preserve existing coherent larger PRs.
All ordinary commits: iliya <iliyazelenkog@gmail.com>, conventional messages,
Refs agent-teams-ai/account-gateway#1. Tests only disposable sandbox projects.
Unknown effects and cleanup evidence survive rollback; disable new admission
before reverting. Do not revive legacy grants/refresh writers automatically.

The normative contract is [architecture/53-account-gateway-implementation-contract.md](../architecture/53-account-gateway-implementation-contract.md);
architecture/51 defines the full program and architecture/50 the owner vision.
Opus dispositions are accepted at DOC PLAN level in 52; 53 is included with exact
bytes/digest in every packet. Documentation or terminal catalog status does not close a runtime gate.
W5/C1 catalog outputs are terminal awaiting qualification; B2 remains active elsewhere.
This docs worker does not open/commit/push: main verifies owner identities and
opens its child PR targeting feat/account-gateway-integration under root PR490.
Supplied base d06564b4 is not an observed HEAD when linked Git metadata is unavailable.
S operator grants follow D, E/F remain mandatory before G, H preserves personal sharing.
