# ReviewRouter Self-Hosted Workflow Contract

This contract defines how customer workflows connect to a hosted or self-hosted
ReviewRouter control plane without changing domain behavior.

## Runner Boundary

The GitHub Action runner owns:

- repository checkout
- diff and context gateway execution
- provider invocation
- context attestation sealing
- review artifact construction

The control plane owns:

- run authorization
- durable review-request dispatch
- revision-aware evidence lookup
- lease and batch state
- publication lifecycle
- webhook ingestion
- audit and retention policy

## Control Plane URL

Reusable workflows pass the target control-plane URL through
`control_plane_url`. The legacy `api_url` input remains supported for existing
workflows and is still emitted by conservative generated workflows until all
published reusable refs are updated. When both are set, `control_plane_url`
wins.

Generated workflows set the URL from `REVIEW_ROUTER_PUBLIC_API_URL`.

Example self-hosted workflow call:

```yaml
jobs:
  review:
    permissions:
      contents: read
      pull-requests: read
      id-token: write
    uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@626739854b5c67d94b3f0118738c106b4a232c41
    with:
      control_plane_url: https://api.reviewrouter.example.com
      runtime_config_mode: oidc
      review_action_v2_mode: t0
      provider_instance_id: codex-main
      review_head_sha: ${{ github.event.pull_request.head.sha }}
```

For direct action usage, the preferred input is `control-plane-url`. The legacy
`api-url` input and `REVIEWROUTER_API_URL` environment variable still work.
`REVIEWROUTER_CONTROL_PLANE_URL` takes priority over `REVIEWROUTER_API_URL`
when the action is run through a wrapper.

## Events

New client-triggered Direct V2 installations use canonical workflow schema 3.
Schema 2 remains valid for existing and queued workflows, but keeps its original
60-minute fallback. Schema 3 preserves the same ingress and permission contract
while reserving 240 minutes for the complete T0 lifecycle. Both are valid only
for same-repository PRs where the action performs OIDC admission itself:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]
```

The generated schema-3 workflow also requires a non-bot same-repository head,
binds `pr_number` and `review_head_sha` to the pull-request event, grants only
`contents: read`, `pull-requests: read`, and `id-token: write`, and calls the
reusable workflow at the registered full 40-character Action SHA. It has no
`workflow_dispatch` or `pull_request_target` trigger. Draft review is controlled
by the generated workflow or reusable workflow `review_drafts` input.

When `REVIEW_ROUTER_REVIEW_V2_INTENT_ADMISSION_REQUIRED=1`, the repository must
use the canonical T0 workflow instead of direct `pull_request` execution:

```yaml
on:
  workflow_dispatch:
    inputs:
      review_request_id:
        required: false
        type: string
      pr_number:
        required: false
        type: string
      review_head_sha:
        required: false
        type: string
```

The control plane ingests the PR webhook, creates the durable
`ReviewRequestedIntent`, and dispatches this workflow with the request id, PR
number and expected head SHA. A direct `pull_request` workflow cannot be used in
this mode because it starts before the control plane has bound a durable review
intent to the GitHub run identity.

Direct V2 initialization is allowed only for a repository with no previous
legacy mutation lane. Upgrade migration v7 fences all existing repository
identities as `v1_open`; those repositories must use the drain/activate
cutover. For repositories onboarded after v7, legacy capability admission and
Direct V2 initialization race under one repository-scoped database lock. The
winner is durable and the other path fails closed.

Do not use `pull_request_target` for runner-side provider execution unless the
workflow never checks out untrusted PR code with secrets. GitHub documents that
`pull_request_target` runs with base repository token/secrets, so it is not the
default ReviewRouter execution trigger.

## OIDC Runtime Config

OIDC mode requires:

```yaml
permissions:
  id-token: write
```

The action requests a GitHub Actions OIDC token with the `reviewrouter`
audience, then the control plane validates:

- repository owner/name/id
- workflow path
- workflow SHA
- run id and attempt
- event name
- pull request number
- reusable workflow producer SHA for T0
- registered workflow schema version

If validation fails, the action must fail closed before provider work consumes
capacity.

## Revision Freshness

Each review authorization is bound to:

- PR number
- base SHA
- merge-base SHA
- head SHA
- review revision hash
- producer release id
- producer action commit SHA

When a new commit arrives, previous completed evidence may be reused only if the
context attestation/reuse policy proves compatibility. In-progress work for an
older revision must not publish as fresh findings for the new revision.

## Permission Profiles

- `review-only`: canonical schema-2 or schema-3 client-triggered PR workflows. No
  server-side dispatch.
- `managed-review`: server-side durable `workflow_dispatch` and cancellation.
- `provisioning`: ReviewRouter creates setup PRs and repo secrets.
- `org-ruleset`: provisioning plus organization ruleset management.

Use the narrowest profile that matches the workflow mode.
