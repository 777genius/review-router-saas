# Private Account Gateway SDK artifact

Internal private SDK0.1.0 from accepted Gateway source
`e8c9216ff51647b6712471f45990e1c0477ce4e7` (Gateway PR23 merge).
Its tree `81618fff86dfaaddee9d010e2262243fe524feac` matches the independently
reviewed and CI-qualified head `e3c5b20656880b449e8126d25776dbe491a0df19`.
This artifact is not an npm publication or a release. The prepared 14-entry,
14738-byte public package includes protected OAuth Begin contracts and the
server-only consumer-control factory through the existing `/http` export.
The existing pinned build produces packaged dist and declarations;
provenance.json records public source/build input/package file hashes,
source qualification runs and tarball integrity. Rebuild with the library's existing
`node scripts/build.mjs` and `npm pack --ignore-scripts` in an isolated workspace.

RR backend consumes `/contracts` and server-only `/http`. Neither upstream key
nor private execution/run-control bearer is part of this artifact or frontend API.
A future published package can replace this file dependency without changing ports.

OAuth enrollment is opt-in for the exact `openai-codex-oauth-responses-v1`
profile. Trusted native callback forwarding to the fixed
`http://localhost:1455/auth/callback` is a prerequisite owned elsewhere.
This repin does not qualify a live OAuth provider or introduce a public callback.
