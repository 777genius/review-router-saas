# Activation Catalog Policy v28 Independent Security/Release Re-review

## Verdict: GO

**Decision ID:** `codex:activation-policy-v28:14774ef58ad8:ba51051d9407:go`

The v28 candidate remediates the v27 NO-GO. In both preactivation and activated policy, `reviewrouter_api`, `reviewrouter_web`, and `reviewrouter_worker` have only non-grantable `table:read` (`SELECT`) on `public."HostedCodexRuntimeGate"`; there is no table- or column-level `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, or `TRIGGER` authority for those roles. No blocker remains in the reviewed activation catalog.

## Exact review inputs and capture lineage

- Exact source/HEAD: `14774ef58ad81ac72890f96590102ac6d3dba328` (`fix(hosted-pool): protect runtime authority gate`), tree `6f850d4b53b3e39974f4d64a4cb88482402e5775`, parent/prior NO-GO source `c9cd9125f27a55dc81275575de8d90d2284e0827`. The trusted v26 source `83e55ce8772e54757b97e0214721af56af18ae0b` and the v27 source are both ancestors. The tracked worktree was clean before this report was created.
- GitHub Actions workflow: `CI`, `.github/workflows/ci.yml`, job `private-pg16-to-pg17-rehearsal`, run `32864736733`, attempt `1`, artifact `9569674329`. The capture workflow at the exact source is unchanged from trusted v26, checks out the run SHA with credentials disabled, runs the same capture command twice with disposable identities `rr-disposable-32864736733-1-a` and `rr-disposable-32864736733-1-b`, requires `cmp`, prints both SHA-256 values, and uploads `activation-catalog-policy-14774ef58ad81ac72890f96590102ac6d3dba328-1` with fail-on-missing behavior. Checkout, Node setup, and artifact upload actions are pinned by full commit SHA.
- Pinned source image: `postgres:16.13-bookworm@sha256:472efd9a66f2b2f1a5aeb18b28de74332e6ef88c2b93a1a5d812fb6db67a5f60`.
- Pinned target image: `postgres:17.5-bookworm@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4`.
- Candidate 1: `/var/tmp/rrpr227v27-controller/review-input-v28/activation-catalog-policy-candidate-1.json` — exactly `2,506,590` bytes, SHA-256 `ba51051d9407b4ca7b6b9c6ce74210f9ef70556e5df23512c4364024ef0800a9`.
- Candidate 2: `/var/tmp/rrpr227v27-controller/review-input-v28/activation-catalog-policy-candidate-2.json` — exactly `2,506,590` bytes, SHA-256 `ba51051d9407b4ca7b6b9c6ce74210f9ef70556e5df23512c4364024ef0800a9`.
- The two candidates are byte-identical (`cmp` success). Their byte counts and digests exactly match the expected capture record.

## Canonical digests

Canonicalization recursively sorts object keys and preserves array order, matching the repository's `canonicalJson` implementation. The artifact digest below uses kind `reviewrouter-activation-catalog-policy-artifact`, version `1`, and the candidate's exact two policies.

- Preactivation policy: `sha256:95591a9df4dd88afe9a9a10118bf11b7e5ec4694748f8262de124d5f7ba7fd59`.
- Activated policy: `sha256:6c8f40abc68b063b835289d3d42f7ee07d9769baf269c5b05fb85db72c8cb3a0`.
- Canonical promoted artifact: `sha256:bb528f22b531f212641ecebdb5ea8d0b851f0291a8c830d5bb41c88b348ccb57`.
- Raw two-capture candidate digest: `sha256:ba51051d9407b4ca7b6b9c6ce74210f9ef70556e5df23512c4364024ef0800a9`.

Comparison roots:

- Trusted v26 raw candidate: `2,490,382` bytes, SHA-256 `f2eeaf4ed03dbb72c7b551a483201aa6086788c3ee3d3b8118ded067ae5f3d1f`; canonical preactivation `sha256:b95cc2c1fdd94b64056f6d8cd9316d361dce87a8a6a8064c8db51db65a886e68`, activated `sha256:118834866426337911d13e47f2752f2f982c1393792668036e359b0062117c6f`, artifact `sha256:95a5b1adcb36e6917fa9113a17e7392772d344e4c9dfbef3d206e57e959f01d3`.
- Prior v27 NO-GO raw candidate: `2,509,191` bytes, SHA-256 `b01178c17044d9ac68aaf29dafae39692555aa881abf8e67b7d7ef5e8143edee`; canonical preactivation `sha256:95591a9df4dd88afe9a9a10118bf11b7e5ec4694748f8262de124d5f7ba7fd59`, activated `sha256:44e79ee088bed6fb14823ca2590b7a4f5ccbef2d94f680d2e6f61ee88fc66f4f`, artifact `sha256:868bf2c2f02cf62ea68afb4701b286e723b925490823d4f1916eb3aad8189529`.

## Exact inventory and normalized deltas

| Catalog | Phase | Roles | Memberships | Reachability | RLS inventory | Extensions | Grants | Effective principals | Effective permission leaves |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| trusted v26 | preactivation | 10 | 5 | 8 | 121 | 2 | 2,922 | 10 | 4,578 |
| trusted v26 | activated | 10 | 5 | 8 | 121 | 2 | 3,906 | 10 | 5,562 |
| prior NO-GO v27 | preactivation | 10 | 5 | 8 | 122 | 2 | 2,944 | 10 | 4,616 |
| prior NO-GO v27 | activated | 10 | 5 | 8 | 122 | 2 | 3,937 | 10 | 5,609 |
| candidate v28 | preactivation | 10 | 5 | 8 | 122 | 2 | 2,944 | 10 | 4,616 |
| candidate v28 | activated | 10 | 5 | 8 | 122 | 2 | 3,928 | 10 | 5,600 |

Exact trusted-v26-to-v28 delta, identically in both phases:

- Roles `-0/+0`; memberships `-0/+0`; reachability `-0/+0`; extensions `-0/+0`.
- RLS inventory `-0/+1`: only `public."HostedCodexRuntimeGate"`, owned by `reviewrouter_release_schema_owner`, with RLS disabled, not forced, and no policies.
- Grants `-0/+22`, all scoped to objects created by migration `000081_hosted_codex_runtime_gate` and its source ACL convergence: 2 non-grantable PUBLIC type-usage records for the table row type and status enum; 3 non-grantable runtime table-read records (API/web/worker) established by convergence; 6 owner-object records (gate table, authority index, primary-key index, guard routine, row type, enum type); 9 owner privilege records (guard execution plus the owner's eight table privileges); and 2 owner type-usage records.
- Effective permission leaves `-0/+38`: PUBLIC type usage becomes effective for all 10 inventoried principals (`+20`), API/web/worker each gain only gate read (`+3`), and the schema owner gains the remaining owner/object/routine/table capabilities (`+15`).

Migration `000080_hosted_codex_attempt_generation` is normalized-catalog neutral: it adds a column and foreign key to an existing table and replaces an existing guard function/trigger without changing any role, membership, reachability, RLS entry, extension, grant, or effective ACL. Migration `000081` explains the one new relation inventory entry and every new securable gate object; PostgreSQL owner/default-type ACLs plus the exact-source ACL convergence explain all 22 gate-related grant records. Convergence overrides the generic application-table grant for the gate, revokes API/web/worker `INSERT`, `UPDATE`, and `DELETE`, grants `SELECT`, globally revokes `TRUNCATE`, `REFERENCES`, and `TRIGGER`, and verifies table and column facts fail closed.

Exact prior-NO-GO-v27-to-v28 delta:

- Preactivation is canonical-byte identical: no normalized delta in any category.
- Activated roles, memberships, reachability, RLS inventory, extensions, and all unrelated grants are identical.
- Activated grants are exactly `-9/+0`, and effective permission leaves are exactly `-9/+0`: `table:insert`, `table:update`, and `table:delete` are removed from each of `reviewrouter_api`, `reviewrouter_web`, and `reviewrouter_worker` on `public."HostedCodexRuntimeGate"`. No other record changes.

## Security conclusions

- In each phase, API/web/worker have exactly one gate relation permission, `table:read`. Their additional gate-related entries are only type usage for the table row type and status enum. No gate column grant exists at all, and neither direct grants nor effective permissions contain application-role `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, or `TRIGGER`.
- `reviewrouter_codex_effect_authority` has no gate relation, column, routine, sequence, ownership, or mutation permission; it receives only the same non-grantable PUBLIC type usage. PUBLIC itself has only those two non-grantable type-usage records and no gate table or routine authority.
- The only inventoried principal with gate mutation authority is the dedicated `reviewrouter_release_schema_owner`. It is `NOLOGIN`, non-superuser, non-`CREATEROLE`, non-`BYPASSRLS`, has no membership or reachability edge, and is unreachable from API/web/worker/provider-effect/release-migration/bootstrap roles. The separately supplied least-privilege operator database connection is the intended transition boundary. The gate trigger forbids deletion and requires monotonic `revision`, `authzEpoch`, and `changedAt` for every update.
- Roles retain the trusted non-superuser/non-`CREATEROLE`/non-`BYPASSRLS` attributes. Membership and reachability graphs are unchanged from trusted v26. There is no unrelated RLS, extension, ownership, grantable-ACL, PUBLIC, or provider-effect drift and no privilege escalation.
- Independent mechanical assertions over both candidate files, trusted v26, and prior v27 passed. Source syntax checks for capture, promotion, and release-migration scripts also passed. No tracked source, deployment, repository, or external system was mutated by this review.

## Blockers

None.

## Residual risks

- This decision is bound to the exact source commit, workflow, run/attempt, artifact, image pins, candidate length, candidate SHA-256, and canonical digests above. Any change invalidates the GO and requires a new independent review.
- The catalog proves disposable-database ACL shape and reproducibility; it does not itself prove live-production database state, operator credential custody, deployment configuration, or a production rollout.
- The dedicated operator/owner boundary remains security-critical and must not be replaced by an application runtime credential or a role-reachability shortcut.

## Authorization

**GO only for exact-byte mechanical promotion/publication of the `2,506,590`-byte activation catalog v28 candidate whose SHA-256 is `ba51051d9407b4ca7b6b9c6ce74210f9ef70556e5df23512c4364024ef0800a9`. This is mechanical-promotion-only authorization. It explicitly is not deployment authorization and does not authorize merge, push, tagging, runtime activation, production database mutation, or substitution/regeneration of any reviewed byte.**
