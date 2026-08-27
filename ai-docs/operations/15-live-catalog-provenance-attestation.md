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

The assembler reads repository and numeric owner identity, current `main` protection/head, run, complete one-job inventory, artifact, commit/tree, and a recursively derived source closure through authenticated GitHub APIs. It verifies the downloaded archive's producer attestation before parsing the archive or signing a claim. The producer certificate must bind the exact numeric repository and owner identifiers, repository name, capture workflow, signer digest, main source ref/digest, GitHub-hosted runner, and selected run invocation. Predicate fields are not authority.

The assembler first canonicalizes the complete, untruncated recursive Git tree as source-inventory v1 and reconstructs every Git tree object through the claimed root SHA. Symlinks, submodules, unsafe or duplicate paths, unsupported modes/types, and inventory bounds fail closed. The installed `reviewrouter.live-catalog.source-selector.v2` policy derives source-closure v2 from that inventory. It covers both workflows, package/lock/workspace and governing manifests, the narrow install lifecycle, installer/rehearsal/packager/migration/bootstrap chain, capture contract and projection, Prisma configuration/schema, all current and legacy release migrations, and reliable static ESM, dynamic-import, TypeScript import-equals, `require`, `require.resolve`, `createRequire`, and `import.meta.resolve` forms, including TSX descendants. Undeclared packages, unresolved workspace subpaths, URL/absolute/unsupported specifiers, unknown dynamic resolution, tracked dotenv/npm hook configuration, or an unknown lifecycle/operator fail closed.

Immutable blobs are reserved as an aggregate by declared tree size before any request, and every reservation is released on success or failure. At most 512 files, 4 MiB per fetched blob, and 24 MiB retained plus in-flight raw bytes are allowed. Each fetch addresses the immutable Git blob SHA and verifies declared size and Git blob identity. Claim schema v5 binds the numeric repository/owner identity, tree SHA, and inventory digest/count/byte facts; source-closure v2 binds the installed selector, inventory digest, exact byte-sorted entries, modes, blob identities, sizes, and byte digests. Claims v1-v4 are rejected without fallback.

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
- `live-catalog-provenance.evidence/source-inventory.json`: canonical complete recursive Git tree inventory;
- `live-catalog-provenance.evidence/source-closure.json`: canonical retained source bytes and per-file facts;
- the authenticated artifact archive and successful capture evidence needed for offline field recomputation.

The workflow summary also records `live-catalog-claim-fingerprint=sha256:<hex>`. Preserve the entire artifact together. The fingerprint is not knowable until the protected-main attestor commit and authenticated numeric repository and owner identities are bound.

## Offline verification

Obtain the current protected-main SHA, numeric repository ID, and numeric repository-owner ID together from a separately authenticated operator or deployment context at verification time. Never copy these trust inputs from the claim, subject, attestation bundle, retained evidence, or an old attestor run. If protected `main` has advanced from A to B, a correctly signed claim from A must be rejected; name reuse, repository reincarnation, and owner transfer are also rejected.

```sh
node --import tsx scripts/verify-live-catalog-attestation.mjs \
  --repository 777genius/review-router-saas \
  --claim live-catalog-provenance.claim.json \
  --subject live-catalog-provenance.subject.json \
  --bundle live-catalog-provenance.bundle.json \
  --evidence live-catalog-provenance.evidence \
  --trusted-current-main-repository-id <current-numeric-repository-id> \
  --trusted-current-main-owner-id <current-numeric-owner-id> \
  --trusted-current-main <40-hex-current-protected-main-sha>
```

Alternatively, pass `--trusted-current-main-file <operator-controlled-file>` containing exactly the 40-hex SHA and an optional final newline. The file must come from the same separately authenticated current-main lookup, not from the attestation artifact.

The verifier accepts the separately trusted current-main SHA and numeric repository/owner identity before reading artifact policy data. It bounded-parses the canonical v5 claim and authenticates the final bundle over those exact claim bytes first, requiring its certificate identity to converge with both the claim and separate trust input. Only then does it parse source-inventory v1, reconstruct the Git tree root, rerun the installed selector v2, and exact-set compare inventory, closure, claim, and retained evidence. It validates retained bytes, both exact workflow sources, capture contract/projection, archive entries, and capture facts; finally it reconstructs the canonical claim and authenticates the producer archive and normalized producer certificate. The artifact cannot select a policy or older schema. Bundle replay, artifact replay, repository reincarnation/owner mismatch, root/inventory/closure tamper, missing certificate fields, and coordinated local edits fail closed.

## Historical regression tuple

The immutable v29 regression values are recorded only as a rejection test fixture at `scripts/fixtures/live-catalog-attestation/historical-v29.json`. They are not release authority and every run, job, and artifact identifier in that file is forbidden as dispatch input. The old PostgreSQL `DETAIL` line records a failed mismatch and cannot prove a successful capture.

## Failure handling

Stop and keep production on HOLD for any branch-protection or exact-head mismatch, main advance before signing or consumption, producer run/job/artifact tuple mismatch, sibling job, non-attempt-1 run, self-hosted label/group, archive/REST/subject/claim digest divergence, source-inventory/tree-root/source-closure mismatch, extra artifact entry, non-identical or malformed candidate, missing/duplicate/tampered successful capture evidence, wrong workflow/contract/projection source, attestation failure, environment refusal, provider quota, or infrastructure failure. Do not repeatedly retry an infrastructure-blocked attestation and do not fall back to checked-in unsigned evidence. A disposable protected-main live contract proving the real two-attestation certificate shape remains required after merge and before production reconsideration.
