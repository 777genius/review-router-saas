# Live catalog provenance attestation (stage 1)

## Status and boundary

This is the protected-main prerequisite for independently authenticated live-catalog provenance. Production is **HOLD**. This workflow does not authorize or perform a deploy, migration, release transition, tag change, Render change, production write, or PR #227 change. In particular, its output is not wired into `release-migration-transition`.

The trust root is the two-stage GitHub attestation chain from the exact checked-in `.github/workflows/capture-live-catalog.yml` and `.github/workflows/attest-live-catalog-digest.yml` on protected `refs/heads/main`. A checked-in evidence document and a checked-in hash are not a substitute.

## Preconditions

- The attestor workflow is present on the current protected `main` head.
- The attestor dispatch itself is attempt 1 and is selected from `main`.
- The source capture run is the selected successful `workflow_dispatch`, attempt 1, of `capture-live-catalog.yml`.
- The source capture commit, attestor `GITHUB_SHA`, and current protected `main` head are exactly equal. An ancestor is never accepted. The attestor rechecks protected `main` immediately before final signing.
- `Capture live catalog producer` is the only job in that run and is GitHub-hosted. Its successful capture output binds both disposable input identities, both normalized candidates, the live catalog digest, the migration receipt digest, and the canonical projection bytes.
- The activation-catalog artifact belongs to that run, is unexpired, has GitHub's archive digest, and contains only the two byte-identical candidate files plus the successful capture evidence file.
- The `production-release` environment approval is granted for attestation only. It is not deployment approval.

The assembler reads repository, current `main` protection/head, run, complete one-job inventory, artifact, commit/tree, and a recursively derived source closure through authenticated GitHub APIs. It verifies the downloaded archive's producer attestation before parsing the archive or signing a claim. The producer certificate must bind the exact repository, capture workflow, signer digest, main source ref/digest, GitHub-hosted runner, and selected run invocation. Predicate fields are not authority.

The source closure is fetched independently at the exact source commit. It binds path, Git blob SHA, byte SHA-256, size, and one canonical aggregate for the workflow, package/lock/workspace metadata, installer, rehearsal, packager, candidate parser, capture contract, migration/bootstrap/activation entry points, projection, transitive local imports, Prisma schema, and every consumed Prisma migration. Unresolved or dynamic local imports fail closed.

## Dispatch

First dispatch `capture-live-catalog.yml` from the current protected `main`. Wait for its sole `Capture live catalog producer` job to complete successfully. Obtain fresh identifiers from that run, never from the historical fixture:

```sh
source_run_id=<successful-protected-main-ci-run-id>
gh run view "$source_run_id" --json databaseId,attempt,event,headBranch,headSha,status,conclusion,jobs
gh api "/repos/{owner}/{repo}/actions/runs/$source_run_id/artifacts"
```

Select the sole job database ID, whose exact name is `Capture live catalog producer`, and the artifact ID whose exact name is `activation-catalog-policy-<head-sha>-1`. Confirm the run is attempt 1, `workflow_dispatch`, on `main`, successful, and exactly at the current protected-main commit. Then dispatch the attestor immediately with those fresh values:

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
- `live-catalog-provenance.bundle.json`: final Sigstore/GitHub attestation bundle copied to a stable name;
- `live-catalog-provenance.evidence/producer.bundle.json`: retained producer artifact-attestation bundle;
- `live-catalog-provenance.evidence/source-closure.json`: canonical retained source bytes and per-file facts;
- the authenticated artifact archive and successful capture evidence needed for offline field recomputation.

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

The verifier first authenticates the retained producer bundle against the exact archive bytes and normalized producer certificate. It then reconstructs the REST/producer/archive/claim digest convergence, the three exact archive entries, capture facts, contract/projection facts, complete retained source closure, and canonical schema-v3 claim. Only after that reconstruction does it verify the final bundle against the exact claim bytes, repository, signer workflow/digest, main source ref/digest, selected attestor run, and GitHub-hosted runner policy. Bundle replay, artifact replay, missing certificate fields, and coordinated local edits fail closed.

## Historical regression tuple

The immutable v29 regression values are recorded only as a rejection test fixture at `scripts/fixtures/live-catalog-attestation/historical-v29.json`. They are not release authority and every run, job, and artifact identifier in that file is forbidden as dispatch input. The old PostgreSQL `DETAIL` line records a failed mismatch and cannot prove a successful capture.

## Failure handling

Stop and keep production on HOLD for any branch-protection or exact-head mismatch, main advance before signing or consumption, producer run/job/artifact tuple mismatch, sibling job, non-attempt-1 run, self-hosted label/group, archive/REST/subject/claim digest divergence, source-closure mismatch, extra artifact entry, non-identical or malformed candidate, missing/duplicate/tampered successful capture evidence, wrong contract/projection export, attestation failure, environment refusal, provider quota, or infrastructure failure. Do not repeatedly retry an infrastructure-blocked attestation and do not fall back to checked-in unsigned evidence. A disposable protected-main live contract proving the real two-attestation certificate shape remains required after merge and before production reconsideration.
