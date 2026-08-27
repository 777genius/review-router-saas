# GitHub attestation verification fixture

`gh-verification-result.json` preserves the object and exact-key structure
observed from `gh attestation verify --format json` with GitHub CLI 2.96.0 on
2026-08-27. Repository, workflow, run, digest, statement payload, signature and
DER certificate bytes were replaced with deterministic test values. The
retained certificate fields, timestamps and Sigstore bundle fields are public
verification material; the fixture contains no token, private key or secret.

Tests use this fixture at both producer-archive and final-claim normalization
boundaries and mutate exact keys and certificate identities to prove malformed
2.96-shaped output fails closed.
