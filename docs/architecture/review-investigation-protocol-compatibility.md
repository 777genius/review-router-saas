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
