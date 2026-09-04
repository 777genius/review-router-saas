# Raw activation catalog independent review

## Decision

- Verdict: **GO**
- BLOCKER: **0**
- HIGH: **0**
- Decision ID: `RR-PR259-RAW-GO-FB81C02D-248C90A6-20260904-R2`
- Reviewed at: `2026-09-04T16:05:58.180Z`

## Capture identities

- Base commit: `b086fc56d4040e056d958d2ee5d83f3ab3c123e9`
- Audited head: `fb81c02d23f1a0110695070949bbb59d32936c1f`
- Audited tree: `214129466ca77a0e5a3cfb955928d4fce3ec6b61`
- Workflow run: `33890593187`
- Run attempt: `1`
- Job: `101081018756`
- Artifact ID: `9943755695`
- Artifact name: `activation-catalog-policy-fb81c02d23f1a0110695070949bbb59d32936c1f-1`

## Raw captures

| Selection | Label | Bytes | Raw SHA-256 |
| --- | --- | ---: | --- |
| selected | `activation-catalog-policy-candidate-1.json` | `2677685` | `248c90a630f14af561d54eb8b008210ced08cbc0c2d6c1d8a9a5258fbba91ea0` |
| corroborating | `activation-catalog-policy-candidate-2.json` | `2677685` | `e498cc7452e39fabfcabbdbb54052e09d4cdaec4ace57871232bf2b06a762e04` |

Capture-set digest: `sha256:15bcedf548ec76ad46e45601effa425e10271c6d31e829a255ffe1092155a91d`
Source PostgreSQL image: `postgres:16.13-bookworm@sha256:472efd9a66f2b2f1a5aeb18b28de74332e6ef88c2b93a1a5d812fb6db67a5f60`
Target PostgreSQL image: `postgres:17.5-bookworm@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4`