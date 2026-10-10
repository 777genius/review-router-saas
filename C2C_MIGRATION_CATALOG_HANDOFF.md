# Migration120 catalog handoff

Status: catalog patch complete; 7 owned files changed, 73 additions / 19 deletions.
Supplied base: RR daf0141b / accepted integration454 tree.
Observed Git base: unavailable; linked Git metadata target missing. One preflight, no repairs.
Exact content base: artifacts/preimages/ and preimages.sha256.json (8 owned preimages).
Contract53 SHA256: 66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0.
SQL120 SHA256: 6ced2dc41f736a2c6e42d6edafc4e9f753622fa157baff09ea962da9d81bd369.
Required integration directory: 000120_review_run_runtime_snapshot.
Observed actual checkout: 118 SQL files through SQL119; copied integration checkout: 119 through SQL120.
Counts follow actual inventory, contrary to the supplied 119-before/120-after count.
Integration must add immutable SQL120 atomically with this patch. Production SQL/schema untouched.
Managed92 and historical96 counts, identities, hashes and frozen contracts preserved.
Checkout extension pins exact SQL120 checksum and complete predecessor manifest.
Existing catalog, historical exclusion/count/drift, rehearsal exclusion, transaction receipt,
and gateway PG latest expectations updated. No new unit tests.
Bug making the adjusted tail contract red before repair: SQL120 was unrecognized/rejected.
Missing SQL119 and altered SQL120 remain rejected; historical execution excludes SQL120.
Rehearsal implementation unchanged: its named inventory filter covers 000060..000099,
and actual historical execution already consumes the updated historical96 reader.
PASS: Node syntax checks; actual production catalog readers in a disposable copied checkout;
exact managed92/historical96 hashes; SQL120 drift and missing119 rejection; old checkout admission.
NOT_RUN: existing Vitest, TypeScript and PostgreSQL checks; cached runners unavailable, no installs.
Patch dry run: PASS: exact captured preimages.
Artifacts: /srv/worker-state/jobs/review-router/account-gateway-v1/jobs/review-router-account-gateway-v1-c2c-migration-catalog/tmp/agent/artifacts.
Exact patch: migration120-catalog.patch; base/pre/post hashes: patch-manifest.json; smoke: catalog-smoke.json.
Patch SHA256: 2d2b88aedc7240e08d51e10698b1f5687cc07f5fcf0e0875155bfd0ffbbdf727.
All 118 source SQL preimage hashes remain unchanged; immutable input unchanged.
No credentials, provider/paid calls, production/admin/workflow/CI/deploy/release actions, commits or pushes.
Controller commit author: iliya <iliyazelenkog@gmail.com>; trailer: Refs #490.
No source approval or E2E/product qualification claim. Full Dfinal/S/E/F/G remain; H deferred.

Primary integration: handoff renamed to the explicitly owned path. The transaction
receipt test is the nearest existing catalog-to-builder boundary; scope reconciled.
Existing focused Vitest checks passed164/164, zero skips in the isolated host fixture.
Actual SQL120 migration passed on fresh PG17.10; final source review/CI remain pending.
