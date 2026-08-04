# Review Investigation result semantics

- `findings`: one or more accepted findings exist. Unrelated incomplete coverage
  may still be reported as inconclusive; findings are not discarded.
- `verified_clean`: every required obligation is satisfied with current,
  complete, authenticated evidence and a fresh critic certificate.
- `inconclusive`: the system cannot prove complete coverage within an external,
  security, capacity, or bounded-resource constraint. It is not clean.

Operator and user-visible surfaces must keep these states distinct. Shadow
results never publish comments, checks, merge signals, or thread resolution.
Verified-clean publication has its own switch and cannot be inferred from zero
findings.
