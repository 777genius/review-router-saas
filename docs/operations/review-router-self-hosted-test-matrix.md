# ReviewRouter Self-Hosted Test Matrix

Use sandbox repositories unless a user explicitly authorizes a real repository
for live validation.

## Unit Gates

| Area                 | Evidence                                                                                |
| -------------------- | --------------------------------------------------------------------------------------- |
| Permission profiles  | Manifest smoke validates `review-only`, `managed-review`, `provisioning`, `org-ruleset` |
| Readiness validation | Self-hosted checker accepts matching env/profile pairs and rejects mismatches           |
| Compose contract     | Docker Compose config preserves migrate gate, healthchecks, service commands, ports     |
| Workflow templates   | Generated workflow contains self-hosted API URL and OIDC permissions                    |
| Run authorization    | OIDC claims bind repository, workflow, run, revision, producer release                  |
| Evidence reuse       | Reuse denied without accepted context attestation                                       |
| Publishing           | Stale revision findings do not publish as fresh findings                                |
| Redaction            | Safe payload tests reject secrets, tokens, auth JSON and nonce material                 |

## Integration Gates

| Scenario                                                                 | Expected result                                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `review-only` App profile with direct PR workflow                        | Control plane authorizes OIDC runtime config, no workflow dispatch attempted      |
| `managed-review` App profile with durable intent                         | Worker submits `workflow_dispatch`, finds the run, can cancel the exact known run |
| `provisioning` App profile                                               | Dashboard setup PR and secret provisioning paths remain enabled                   |
| Self-hosted env with managed profile but provisioning flag enabled       | Readiness checker fails closed                                                    |
| Self-hosted env with review-only profile and dispatch-ready flag enabled | Readiness checker fails closed                                                    |
| Hosted env                                                               | Existing hosted readiness checks still pass                                       |

## E2E Gates

| Scenario                          | Required evidence                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| One-command self-hosted boot      | `docker compose` starts Postgres, migrate, web, api, worker; health endpoints pass                 |
| Fresh PR review                   | Action reaches self-hosted API URL, reviews PR, publishes via GitHub App                           |
| New commit during large PR review | Old completed batches are reused only when attested; moved/stale work does not publish as new      |
| Large PR bounded coverage         | Logs show planned batches, reviewed batches, skipped batches, and skip reason                      |
| Rerun                             | Rerun uses original GitHub run privileges and remains bound to the intended revision               |
| Provider capacity failure         | Control plane records safe failure without leaking provider credentials                            |
| Fork PR                           | Secret-backed provider execution is skipped unless a separate sandbox policy is explicitly enabled |

## Completion Evidence

A self-hosted release is not complete until the final report contains:

- commit SHAs for SaaS/control-plane and public action
- unit/integration command output
- self-hosted readiness output
- Docker/Compose health output or a documented environment blocker
- sandbox E2E run URL or local harness output
- real repository run URL only if explicitly authorized
- confirmation that logs do not contain provider credentials or raw source
