# Context Gateway v4 security contract

Context Gateway v4 is the only clean-capable repository access profile for
Review Investigations. It runs on the customer runner and reads immutable Git
objects at the authorized base, merge-base, and head revisions.

## Allowed operations

- exact-revision file read;
- bounded directory listing;
- bounded text search;
- canonical changed-path inventory;
- typed Git facts required by an obligation.

Every request is bound to the session, operation key, revision, tool policy,
gateway binary, and sequence. Paginated results are incomplete until every page
is authenticated and the terminal cursor is observed.

## Fail-closed rules

- no shell, browser, network, plugin, arbitrary filesystem, or unrelated MCP;
- no worktree/index/config trust for evidence reads;
- traversal, symlink escape, replacement objects, malformed cursors, reordered
  pages, truncation, policy drift, or binary drift cannot satisfy an obligation;
- binary, LFS, gitlink, generated, deleted, rename, shallow, and partial-clone
  cases produce typed evidence or an explicit inconclusive boundary;
- recoverable operation rejection may be followed by a valid operation, but the
  rejection remains in the authenticated transcript;
- model output cannot issue an attestation, receipt, replay proof, or certificate.

## Replay

Private replay material contains bounded raw operation inputs and is stored only
in the runner-local `0600` file. The control plane receives canonical hashes,
receipt IDs, signed capabilities, and typed results. Cross-revision replay
requires the same complete coverage contract and a fresh target critic.

## Secret boundary

Never persist or log repository content, prompts, search queries, gateway
session secrets, provider credentials, cookies, auth payloads, or raw model
output. Logs and telemetry use identifiers, digests, counts, sizes, durations,
and typed failure codes only.
