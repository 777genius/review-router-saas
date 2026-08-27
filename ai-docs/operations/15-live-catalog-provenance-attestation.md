# Live catalog provenance attestation (stage 1)

## Status and boundary

This is the protected-main prerequisite for independently authenticated live-catalog provenance. Production is **HOLD**. This workflow does not authorize or perform a deploy, migration, release transition, tag change, Render change, production write, or PR #227 change. In particular, its output is not wired into `release-migration-transition`.

The trust root is GitHub's attestation signature from the exact checked-in `.github/workflows/attest-live-catalog-digest.yml` on protected `refs/heads/main`. A checked-in evidence document and a checked-in hash are not a substitute.

## Preconditions

- The attestor workflow is present on the current protected `main` head.
- The attestor dispatch itself is attempt 1 and is selected from `main`.
- The source CI run is the selected successful `workflow_dispatch`, attempt 1. Its authenticated head branch is recorded, while all source reads use its immutable head commit rather than a mutable branch ref.
- `Quality Gates` and `Dedicated Release Authority PG17 contract` are both successful GitHub-hosted jobs in that exact run.
- The activation-catalog artifact belongs to that run, is unexpired, has GitHub's archive digest, and contains only the two byte-identical candidate files.
- The `production-release` environment approval is granted for attestation only. It is not deployment approval.

The assembler reads repository, current `main` protection/head, run, jobs, artifact, commit/tree, job log, workflow source, and projection source through authenticated GitHub APIs. The source workflow and `fencedLiveV70V73CatalogDigestSql` bytes are fetched at the source commit. The current checkout is never used as a substitute for those source-commit bytes. The source run must itself be an attempt-1 `workflow_dispatch` on `main` in the exact repository, and its commit must be the current protected-main commit or an authenticated ancestor of the attestor's current protected-main commit.

## Dispatch

Use the Actions UI or dispatch the workflow with the four exact IDs:

```sh
gh workflow run attest-live-catalog-digest.yml \
  --ref main \
  -f source_run_id=33020660492 \
  -f quality_job_id=98349971837 \
  -f pg17_job_id=98349971721 \
  -f artifact_id=9626432342
```

Do not re-run a failed attestor attempt. Diagnose it and dispatch a new attempt-1 run after a coherent protected-main correction.

## Outputs

The stable artifact `live-catalog-provenance-<attestor-main-sha>` contains:

- `live-catalog-provenance.claim.json`: canonical signed subject bytes;
- `live-catalog-provenance.subject.json`: subject size, SHA-256, and claim fingerprint;
- `live-catalog-provenance.bundle.json`: Sigstore/GitHub attestation bundle copied to a stable name.
- `live-catalog-provenance.evidence/`: the authenticated artifact archive, full Quality log, and source-commit workflow/projection bytes needed for offline field recomputation.

The workflow summary also records `live-catalog-claim-fingerprint=sha256:<hex>`. Preserve all three files together. The fingerprint is not knowable until the protected-main attestor commit and authenticated repository ID are bound.

## Offline verification

Use the exact repository and attestor main digest printed by the successful run:

```sh
node scripts/verify-live-catalog-attestation.mjs \
  --repository 777genius/review-router-saas \
  --claim live-catalog-provenance.claim.json \
  --subject live-catalog-provenance.subject.json \
  --bundle live-catalog-provenance.bundle.json \
  --evidence live-catalog-provenance.evidence \
  --attestor-digest <40-hex-protected-main-sha>
```

The verifier first enforces canonical domain structure and recomputes the subject hash, claim fingerprint, observation binding, identical candidate tuple, and candidate-to-observed digest. It then runs `gh attestation verify` against the supplied bundle with the exact repository, exact signer workflow, `refs/heads/main`, exact attestor source digest, and `--deny-self-hosted-runners`. Any tuple edit requires a new valid protected-main signature; coordinated edits to the claim and its local subject metadata still fail signature verification.

## Historical regression tuple

The immutable v29 regression values are recorded only as a test fixture at `scripts/fixtures/live-catalog-attestation/historical-v29.json`. They are not release authority. The test recomputes the source tree, source workflow hash, correct `fencedLiveV70V73CatalogDigestSql` projection hash, exact 265-byte sanitized observation line hash, and candidate-to-observed binding.

## Failure handling

Stop and keep production on HOLD for any branch-protection mismatch, run/job/artifact tuple mismatch, non-attempt-1 run, self-hosted label/group, archive or source hash mismatch, extra artifact entry, non-identical candidate, missing/duplicate observation, wrong projection export, attestation failure, environment refusal, provider quota, or infrastructure failure. Do not repeatedly retry an infrastructure-blocked attestation and do not fall back to checked-in unsigned evidence.
