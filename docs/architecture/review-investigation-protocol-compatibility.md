# Review Investigation protocol compatibility

The SaaS repository owns the canonical Review Action v2 contract source. The
public Action consumes only generated artifacts through the fenced protocol
handoff. Manual edits to generated schemas or Action copies are forbidden.

| Server | Action | Gateway | Result                                              |
| ------ | ------ | ------- | --------------------------------------------------- |
| legacy | legacy | v3      | legacy review unchanged                             |
| new    | legacy | v3      | capability absent, deterministic legacy fallback    |
| legacy | new    | v3/v4   | capability absent, fallback before mutation         |
| new    | new    | v3      | legacy/context-attested paths only                  |
| new    | new    | v4      | investigation allowed by flags and release registry |

Producer release, schema digest, canonicalizer digest, Action base commit,
gateway artifact digest, policy version, and coverage contract are independent
compatibility fences. A mismatch rejects reuse or effects; it must not silently
downgrade a clean-capable path.

Release order is dormant server capability, public Action support, registered
producer release, shadow cohort, findings effects, verified clean, then
cross-revision replay. Released tags and artifacts are immutable.

## Lifecycle observation compatibility

Lifecycle witness rollout is parser-first. The server accepts the legacy
projection only through the explicit legacy authorization boundary and accepts
`review_lifecycle_observation.v1` only when every target carries a valid marker
fingerprint and thread-state hash. Unknown versions, mixed legacy/v1 targets,
duplicate target identities, and incomplete witnesses fail closed.

For v1, the Action and SaaS share the golden
`review_lifecycle_thread_state.v1` canonicalization fixture. The witness covers
the complete paginated comment history of the target thread while deliberately
excluding `isResolved`; a permitted resolve is a mutation after authorization,
not evidence that the observed thread changed before publication.

GitHub lifecycle lookup has four domain outcomes: `current`, `changed`,
`missing`, and `unavailable`. Only `current`, `changed`, and `missing` are
conclusive facts. Transient or malformed GitHub responses are `unavailable` and
map to the existing retryable `capacity_limited` response; they must never be
reported as a stale revision.

The projection envelope must be validated without stripping its version or
per-target witness fields before persistence/publication. This preserves the
same evidence across request, claim, begin, retry, and lifecycle mutation gates.

## Command ledger compatibility

Hosted publication verifies the same repository- and PR-bound HMAC command
ledger used by the Action. A valid ledger is accepted independently of whether
the GitHub author is the App bot or `github-actions[bot]`; invalid,
unverifiable, or ambiguous ledgers fail closed. Key derivation uses the existing
repository-scoped Action ledger key contract and timing-safe signature checks.

Rotating Codex authorization is never updated by direct secret replacement.
Operators must use `scripts/reseed-codex-rotating-auth.sh` so queued work cannot
observe an older auth generation.
