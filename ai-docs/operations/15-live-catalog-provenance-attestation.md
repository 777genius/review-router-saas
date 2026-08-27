# Live catalog provenance attestation (stage 1)

## Status and boundary

This is the protected-main prerequisite for independently authenticated live-catalog provenance. Production is **HOLD**. This workflow does not authorize or perform a deploy, migration, release transition, tag change, Render change, production write, or PR #227 change. In particular, its output is not wired into `release-migration-transition`.

The trust root is GitHub's attestation signature from the exact checked-in `.github/workflows/attest-live-catalog-digest.yml` on protected `refs/heads/main`. A checked-in evidence document and a checked-in hash are not a substitute.

## Preconditions

- The attestor workflow is present on the current protected `main` head.
- The attestor dispatch itself is attempt 1 and is selected from `main`.
- The source CI run is the selected successful `workflow_dispatch`, attempt 1. Its authenticated head branch is recorded, while all source reads use its immutable head commit rather than a mutable branch ref.
- `Full private PG16 to PG17 rehearsal` is the exact successful GitHub-hosted artifact-producing job in that run. Its successful capture output binds both disposable input identities, both normalized candidates, the live catalog digest, the migration receipt digest, and the canonical projection bytes.
- The activation-catalog artifact belongs to that run, is unexpired, has GitHub's archive digest, and contains only the two byte-identical candidate files plus the successful capture evidence file.
- The `production-release` environment approval is granted for attestation only. It is not deployment approval.

The assembler reads repository, current `main` protection/head, run, jobs, artifact, commit/tree, workflow source, and projection source through authenticated GitHub APIs. The source workflow and `fencedLiveV70V73CatalogDigestSql` bytes are fetched at the source commit. The current checkout is never used as a substitute for those source-commit bytes. The source run must itself be an attempt-1 `workflow_dispatch` on `main` in the exact repository, and its commit must be the current protected-main commit or an authenticated ancestor of the attestor's current protected-main commit.

## Dispatch

First dispatch `ci.yml` from the current protected `main` with `activation_catalog_policy_capture=true`. Wait for the run and its `Full private PG16 to PG17 rehearsal` job to complete successfully. Obtain fresh identifiers from that run, never from the historical fixture:

```sh
source_run_id=<successful-protected-main-ci-run-id>
gh run view "$source_run_id" --json databaseId,attempt,event,headBranch,headSha,status,conclusion,jobs
gh api "/repos/{owner}/{repo}/actions/runs/$source_run_id/artifacts"
```

Select the job database ID whose exact name is `Full private PG16 to PG17 rehearsal`, and the artifact ID whose exact name is `activation-catalog-policy-<head-sha>-1`. Confirm the run is attempt 1, `workflow_dispatch`, on `main`, successful, and at the current protected-main commit (or an authenticated ancestor accepted by the attestor). Then dispatch with those fresh values:

```sh
gh workflow run attest-live-catalog-digest.yml \
  --ref main \
  -f source_run_id="$source_run_id" \
  -f producer_job_id=<successful-producer-job-database-id> \
  -f artifact_id=<activation-catalog-artifact-id>
```

Do not re-run a failed attestor attempt. Diagnose it and dispatch a new attempt-1 run after a coherent protected-main correction.

## Outputs

The stable artifact `live-catalog-provenance-<attestor-main-sha>` contains:

- `live-catalog-provenance.claim.json`: canonical signed subject bytes;
- `live-catalog-provenance.subject.json`: subject size, SHA-256, and claim fingerprint;
- `live-catalog-provenance.bundle.json`: Sigstore/GitHub attestation bundle copied to a stable name.
- `live-catalog-provenance.evidence/`: the authenticated artifact archive, successful capture evidence, and source-commit workflow/projection bytes needed for offline field recomputation.

The workflow summary also records `live-catalog-claim-fingerprint=sha256:<hex>`. Preserve all three files together. The fingerprint is not knowable until the protected-main attestor commit and authenticated repository ID are bound.

## Offline verification

Use the exact repository and attestor main digest printed by the successful run:

```sh
node --import tsx scripts/verify-live-catalog-attestation.mjs \
  --repository 777genius/review-router-saas \
  --claim live-catalog-provenance.claim.json \
  --subject live-catalog-provenance.subject.json \
  --bundle live-catalog-provenance.bundle.json \
  --evidence live-catalog-provenance.evidence \
  --attestor-digest <40-hex-protected-main-sha>
```

The verifier first enforces canonical domain structure and recomputes the subject hash, claim fingerprint, successful observation binding, identical candidate tuple, and candidate-to-observed digest. It then runs `gh attestation verify` against the supplied bundle with the exact repository, exact signer workflow, `refs/heads/main`, exact attestor source digest, and `--deny-self-hosted-runners`, and requires gh to report the SHA-256 of the exact already-validated claim bytes. Any tuple edit requires a new valid protected-main signature; coordinated edits to the claim and its local subject metadata still fail signature verification.

## Historical regression tuple

The immutable v29 regression values are recorded only as a rejection test fixture at `scripts/fixtures/live-catalog-attestation/historical-v29.json`. They are not release authority and every run, job, and artifact identifier in that file is forbidden as dispatch input. The old PostgreSQL `DETAIL` line records a failed mismatch and cannot prove a successful capture.

## Failure handling

Stop and keep production on HOLD for any branch-protection mismatch, producer run/job/artifact tuple mismatch, non-attempt-1 run, self-hosted label/group, archive or source hash mismatch, extra artifact entry, non-identical or malformed candidate, missing/duplicate/tampered successful capture evidence, wrong projection export, attestation failure, environment refusal, provider quota, or infrastructure failure. Do not repeatedly retry an infrastructure-blocked attestation and do not fall back to checked-in unsigned evidence.
