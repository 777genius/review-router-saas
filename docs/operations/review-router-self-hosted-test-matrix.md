# ReviewRouter Self-Hosted Test Matrix

Use sandbox repositories unless a user explicitly authorizes a real repository
for live validation.

## Unit Gates

| Area                 | Evidence                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| Permission profiles  | Manifest smoke validates `review-only`, `managed-review`, `provisioning`, `org-ruleset`            |
| Readiness validation | Checker requires direct-init/client-triggered opt-ins, compatible intent flags, keys, attestations |
| Migration URL        | Prisma `schema` query is removed for `psql` while libpq query parameters are preserved             |
| Compose contract     | Runtime includes `psql`; Prisma and Review v2 migrations gate all app services                     |
| Workflow templates   | Generated workflow contains self-hosted API URL and OIDC permissions                               |
| Legacy authority     | Upgrade backfill fences existing identities as V1; new legacy/direct races have one durable winner |
| Run authorization    | OIDC claims bind repository, workflow, run, revision, producer release                             |
| Evidence reuse       | Reuse denied without accepted context attestation                                                  |
| Publishing           | Stale revision findings do not publish as fresh findings                                           |
| Redaction            | Safe payload tests reject secrets, tokens, auth JSON and nonce material                            |

## Integration Gates

| Scenario                                                           | Expected result                                                                   |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `review-only` App profile with direct PR workflow                  | Control plane authorizes OIDC runtime config, no workflow dispatch attempted      |
| `managed-review` App profile with durable intent                   | Non-self-hosted dispatch mode owns `workflow_dispatch` and exact-run cancellation |
| `provisioning` App profile                                         | Dashboard setup PR and secret provisioning paths remain enabled                   |
| Self-hosted env with managed profile but provisioning flag enabled | Readiness checker fails closed                                                    |
| Self-hosted env with review-only profile                           | Client-triggered T0 passes without server dispatch permission                     |
| Self-hosted env without either explicit T0 opt-in                  | Readiness checker fails closed before Compose starts                              |
| Client-triggered env with admission, ingress, or dispatch enabled  | Readiness checker rejects the incompatible combination                            |
| Self-hosted env with malformed key/config JSON                     | Readiness checker fails without printing configured material                      |
| Hosted env                                                         | Existing hosted readiness checks still pass                                       |
| Existing repository after v7                                       | Direct initialization is blocked by the conservative `v1_open` authority fence    |
| New repository legacy/direct race                                  | Exactly one authority mode wins under the shared repository lock                  |

## E2E Gates

| Scenario                          | Required evidence                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| One-command self-hosted boot      | Compose runs Prisma plus Review v2 backfill, then starts healthy web, api, and worker services     |
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

The reproducible local Compose and review harness evidence is produced by:

```bash
pnpm self-hosted:e2e
```

### 2026-07-30 Direct V2 sandbox proof

- Sandbox repository:
  `777genius/rr-selfhost-direct-v2-e2e-20260730t120036z`
- Immutable action release:
  `626739854b5c67d94b3f0118738c106b4a232c41`
- [GitHub Actions run 30543839246](https://github.com/777genius/rr-selfhost-direct-v2-e2e-20260730t120036z/actions/runs/30543839246)
  used a review-only GitHub App without `Actions: write`.
- Attempt 1 completed a fresh `gpt-5.5` review and published the terminal
  ReviewRouter status through the App.
- Attempt 2 proved deployment default propagation with `gpt-5.6-sol`. All
  provider responses had incomplete transcripts, so required coverage failed
  closed and the workflow did not claim a complete review.
- Attempt 3 restored the stable model and logged
  `Review evidence lookup: status=hit`. It attached the prior observation
  without invoking Codex or creating a new provider observation.
