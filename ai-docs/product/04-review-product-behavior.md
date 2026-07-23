# Review Product Behavior

## Review Quality Direction

ReviewRouter should prioritize actionable, high-confidence comments over volume.

Defaults:

- low max inline comments
- major/critical findings only by default
- clear severity labels
- no token/cost display for Codex OAuth subscription mode if usage is unavailable or misleading
- summary should explain skipped files/large diffs
- no duplicate comments on reruns

## Pull Request Summary

ReviewRouter Action should optionally update PR description or add a summary comment without overwriting the author's original description.

Desired sections:

```text
## Summary
- concise bullets of what changed

## Tests
- detected or reported tests

## ReviewRouter Walkthrough
- files selected for processing
- per-file change explanation
```

## Inline Comment Format

Preferred style:

````text
_🔴 Critical_ | _⚡ Quick win_

**Title.**

Explanation with concrete impact and relevant context.

<details>
<summary>Suggested fix</summary>

```diff
...
````

</details>

<sub>If this is intentionally accepted, a maintainer can reply `/rr skip`.</sub>

````

Do not include fragile or misleading reaction-based instructions.

## Human Overrides

Use deterministic command-based override:

```text
/rr skip [optional reason]
````

Rules:

- maintainer/admin can skip
- PR author skip is disabled by default unless configured
- skip state is signed in a bot-owned PR ledger comment
- skipped findings should stop blocking CI
- AI discussion can explain/argue but should not deterministically skip unless explicit supported command is used

## AI Discussion

## Revision Changes During Review

New commits do not publish stale findings. Completed provider observations may
resume only when their exact invocation/revision remains valid; otherwise required
work reruns. The current review always reloads human interaction and reports
honest complete/partial coverage. A partial run never says `All Clear` and never
advances the incremental snapshot.
Future/optional:

- if user replies with normal text to a review comment, ReviewRouter can answer with explanation
- if the model agrees finding may be false positive, it should suggest maintainer run `/rr skip`
- it should not silently skip based only on natural language in v1

Reason:

- natural-language skip has prompt injection and intent ambiguity risks
- deterministic command is auditable
