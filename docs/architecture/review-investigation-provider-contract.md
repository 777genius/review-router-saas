# Review Investigation provider contract

Provider adapters implement one semantic `ReviewAgentPort`; they do not own
coverage, retries, conclusions, certificates, or publication.

| Capability                               | Codex                | Claude Code          | Requirement                   |
| ---------------------------------------- | -------------------- | -------------------- | ----------------------------- |
| Stateless process per turn               | implemented          | implemented          | required                      |
| Context Gateway v4 only                  | implemented          | implemented          | required for clean            |
| Native shell/filesystem/network disabled | implemented          | implemented          | required                      |
| Strict turn JSON schema                  | implemented          | implemented          | required                      |
| Actual model attribution                 | implemented          | implemented          | required                      |
| Trusted token usage                      | parsed when supplied | parsed when supplied | mark unavailable otherwise    |
| Typed auth/capacity/startup failure      | implemented          | implemented          | no semantic tight-loop        |
| Cancellation and timeout                 | implemented          | implemented          | fencing remains authoritative |

Adding a provider requires passing the shared adapter contract suite. Unknown
native events fail closed; they are never mapped to success. Provider-native
sessions are disposable optimizations and cannot be the durable investigation
state.
