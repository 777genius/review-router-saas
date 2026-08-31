# Raw activation catalog independent review

## Decision

- Verdict: **GO**
- BLOCKER: **0**
- HIGH: **0**
- Decision ID: `RR-PR236-RAW-CATALOG-GO-BE9958E3-140043EC-20260831`
- Reviewed at: `2026-08-31T22:13:00.000Z`

## Capture identities

- Base commit: `1963a5d3d7697c120c67eb864bb003c1a69f2a4d`
- Audited head: `be9958e3912d8d07fc965f0364fe8565d85d9894`
- Audited tree: `5e6612922c2368d7f0d3a948794aa90e9a3f44ba`
- Workflow run: `33444675220`
- Run attempt: `1`
- Job: `99660942529`
- Artifact ID: `9777622013`
- Artifact name: `activation-catalog-policy-be9958e3912d8d07fc965f0364fe8565d85d9894-1`

## Raw captures

| Selection | Label | Bytes | Raw SHA-256 |
| --- | --- | ---: | --- |
| selected | `activation-catalog-policy-candidate-1.json` | `2677685` | `140043ec47171493ff2e713eb0ec0a2afe18ae1133bb61b5178069533cbad6e9` |
| corroborating | `activation-catalog-policy-candidate-2.json` | `2677685` | `57c519a3f5ee2413ff61e1236ba49450160859e20f0ed0612fd1c3b67e283bf0` |

Capture-set digest: `sha256:7c697879d6acfdfeb9a77a2d1eb9f6d8bb9b468da14f9c62f4cd3337a4b8fdea`
Source PostgreSQL image: `postgres:16.13-bookworm@sha256:472efd9a66f2b2f1a5aeb18b28de74332e6ef88c2b93a1a5d812fb6db67a5f60`
Target PostgreSQL image: `postgres:17.5-bookworm@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4`
