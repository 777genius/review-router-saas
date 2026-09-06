# Raw activation catalog independent review

## Decision

- Verdict: **GO**
- BLOCKER: **0**
- HIGH: **0**
- Decision ID: `RR-CONNECT-RAW-GO-8D23292B-20260906-R1`
- Reviewed at: `2026-09-06T16:53:12.199Z`

## Capture identities

- Base commit: `0ff2a4625e3432f7030f9fb2a014af5cdbdf1265`
- Audited head: `8d23292b8a046a967350b15aa6f828ce0cbae9a3`
- Audited tree: `d29794aa1e8e8dc1e2b1010d99a48f791f1f266d`
- Workflow run: `34045624741`
- Run attempt: `2`
- Job: `101522171249`
- Artifact ID: `9993260794`
- Artifact name: `activation-catalog-policy-8d23292b8a046a967350b15aa6f828ce0cbae9a3-2`

## Raw captures

| Selection | Label | Bytes | Raw SHA-256 |
| --- | --- | --- | --- |
| selected | `activation-catalog-policy-candidate-1.json` | `2681152` | `049f6fa99bbcfac377964742e0a513d1e031609176b88df9a27c44a00c6308a8` |
| corroborating | `activation-catalog-policy-candidate-2.json` | `2681152` | `7396196490552f450132e7af81ee765af7cf7a69007b75386c8348a0dbb348f0` |

Capture-set digest: `sha256:58f09551b3b14998ece6185c168aaa9a64c4bf03e2a32db1132a4b0d6e431cac`
Source PostgreSQL image: `postgres:16.13-bookworm@sha256:472efd9a66f2b2f1a5aeb18b28de74332e6ef88c2b93a1a5d812fb6db67a5f60`
Target PostgreSQL image: `postgres:17.5-bookworm@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4`

I independently hashed the 223086-byte archive: `1dc9915257d9c34b359686e3f0e28ab9d375e41f822d6f9a927eb1f8e3e44fa9`, matching artifact metadata. Its only two members match the supplied raw files byte-for-byte. Supplied run, job and artifact metadata bind the audited commit to attempt 2; capture step 8 and upload step 9 succeeded. Overall CI concluded failure, with Quality Gates failed; full cutover and release-gate evidence steps were skipped. The reported first-attempt psql exit 3 and stale web-test extraction diagnosis are user-supplied context, not independently established by these metadata files. This GO covers the bounded raw/custody review only.

An independent recursive comparison found exactly four pair differences: disposable identities `rr-disposable-34045624741-2-a` / `rr-disposable-34045624741-2-b`; configured identities `target.internal:32769/review_router` / `target.internal:32772/review_router`; system identifiers `7682464498732359718` / `7682464611413127207`; and custody evidence hashes `sha256:df2813eca6543afacc49659da469c5229211822b9c8afb1bcc118b7883723aad` / `sha256:02ebfa37bd208fe4ec74f1001b1a060e12e3bbf895a13ea76841830cfd42d901`. Both self-hashes pass the actual pair validator. Every other value is invariant, including both complete policies, projection, postmanifest and recovery witness. The all-`c` recovery witness is a disposable fixture, not production recovery evidence.

The audited Git custody and capture-surface validators passed with exact checkout/tree enforcement. Both the baseline and accepted capture source `0d8ad35d70a749cbdf4f525769b37e448e729c69` are ancestors of the audited head. Comparing the complete declared capture surface against that accepted source yields only three added importer lines in `pnpm-lock.yaml`: the API workspace link to `@reviewrouter/platform-locks`. All migration SQL, migration projection/transition sources, production normalization, capture harness and validators are unchanged. SQL96 remains `d1b49b764f406004227f3af9e23e3a4b36268b73d76f8e7b19828d508d8c8826`; the inventory contains 96 migrations.

The importer matches the API manifest and links an unchanged existing workspace package; it changes no resolved external package version or lifecycle hook. That package performs lease DML on DistributedLock through its supplied Prisma client when invoked. The importer itself grants no database privilege and changes no SQL, role, guard, trigger or capture execution. Connected application changes outside the declared capture surface are not certified by this bounded review.

I verified the previous archive and both raw hashes against R3, and the committed report's exact binding to its genuine completed runtime summary in `f8f263c5acd9b75749e5e42910418c72e1c75014`. That evidence commit is not an ancestor of this captured head; semantic reuse rests on equality to the accepted captured source. Both new complete policy objects equal both previous policies, with no omitted fields. This supports reuse of R3's SQL96 guard-preservation, effective-permission and phase-ACL analysis without repeating the historical audit.

Both new captures passed the actual production normalization validator for both phases. Canonical digests recompute to preactivation `sha256:a0a2d7bfbf361012c06c2435f111fd677ae2a07bf9bca2ce60dc5e00067da4c5`, activated `sha256:6da321706c77cdaf15344d32209ffc5b936dae3630522a6e078c7f1336bf2e2a`, and artifact `sha256:abda62f9316c446711a3b6c350c7eeb89660c50837dbcdaed97d41bbd44fb590`. The actual pure renderer produces 2680528 bytes with SHA-256 `d6ff4e160988fa4f08c26c7450245de9ad49601a1c6673a29693f9d63edbb52e`.

The invariant projection digest is `sha256:23f865f463e6c7fc249f73ed5af13d62af11f528066e9637d7bc3c0c6d973b94`, observed catalog digest `sha256:4413b55476ac02968f5d6f05ca698549e2904dd98591bc706fc5c0b21fbbd2f8`, and postmanifest `sha256:5faad7059a2f57055086dd1571e87706c261a486e8952334401f1d91cc41c97b`. I constructed the new evidence from actual attempt-2 metadata, verified raw bytes, workflow image pins and this decision. The actual evidence and externally bound capture-pair validators accepted it. Capture-set hashing excludes exactly kind, version and captureSetSha256; reviewedAt is a separate report field.

Validation used native Node and read-only source/archive inspection, without installs, network, database, deployment or additional workers. The actual markdown validator accepted this report. Both worktrees remained clean and outer HEAD remained the requested baseline. I did not edit trust roots, execute promotion or manufacture a new runtime receipt; its final binding remains the runtime's responsibility.