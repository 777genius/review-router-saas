# ADR-027: Branch-Aware Review Action v2 Contract Handoff

Status: Accepted

## Context

The SaaS control plane and public ReviewRouter Action have independent Git
histories. A generated protocol copied through the existing wrapper sync could be
written directly to public `main`, paired with the wrong runtime bundle, or later
registered from a floating ref. None of those states proves an immutable producer
release.

## Decision

Use a dedicated two-stage handoff. The existing wrapper sync remains unchanged.

1. SaaS exports committed canonical protocol output to an explicit public Action
   feature branch fenced by its exact current HEAD.
2. The public Action rebuilds and commits `dist/index.js` together with the
   generated source and handoff manifest.
3. A release manifest is emitted outside the public Action repository from that
   clean final commit.
4. Registration consumes only a release manifest that passes the cross-repository
   checker.

All commit identities are lowercase 40-character SHAs. Branch or tag refs are not
accepted as commit identities.

## Artifacts

The source is `packages/protocol-review-action-v2/src/generated/`. Its generated
`manifest.json` owns protocol, schema, and golden-fixture identity. The exporter
hashes every committed generated file and copies only those files to:

```text
src/control-plane/generated/review-action-v2/
```

The same directory receives canonical `handoff-manifest.json` with:

```text
contractExportVersion
saasSourceCommit
protocolVersion
schemaDigest
canonicalizerDigest
goldenFixtureDigest
generatedFileDigests
expectedPublicActionBaseCommit
```

If the protocol generator publishes `canonicalizerDigest`, that value is used. For
the negotiation-only bridge manifest, the exporter derives it from the sorted map
of committed generated TypeScript/JavaScript file digests. This compatibility rule
is deterministic and disappears naturally once the full generator owns the field.

The final release manifest adds:

```text
releaseManifestVersion
distributionKind = PublicReusable
actionCommitSha/runtimeCommitSha
handoffManifestDigest
runtimeEntrypointPath/runtimeEntrypointDigest
```

For `PublicReusable`, action and runtime commits are the same public repository
commit. The release manifest is not committed into that commit, which avoids a
self-referential digest. It is a write-once CI/release artifact.

## Safety Invariants

- Export to `main` is rejected.
- Target branch and expected target HEAD are mandatory and must match the checked
  out public Action worktree.
- Optional expected SaaS HEAD fences the source side.
- Export reads bytes from the committed SaaS Git tree and refuses dirty source
  output.
- The target may be empty or fully owned by a prior valid handoff. Unmanaged files,
  symlinks, and handwritten runtime code are never overwritten.
- Target replacement is staged and renamed atomically.
- Release generation requires a clean public Action worktree and reads generated
  source plus the bundle from the final commit.
- The expected public base must be an ancestor of the final Action commit.
- Release output must be outside the public Action repository and cannot overwrite
  different bytes.
- The checker reconstructs both manifests from Git objects in both repositories.

## Consequences

Contract promotion now requires an explicit public feature branch and one final
bundle commit. This adds a release step but removes mutable-ref and mismatched-bundle
ambiguity. Wrapper runtime sync and v1 rollback behavior are unchanged.

No generated protocol, Action runtime, outbox, or persistence behavior is owned by
this boundary. The scripts only validate, transfer, hash, and attest artifacts.
