# Raw activation catalog independent review

## Decision

- Verdict: **GO**
- BLOCKER: **0**
- HIGH: **0**
- Decision ID: `RR-PR251-RAW-CATALOG-GO-5FCA28E9-DB9DE379-20260902`
- Reviewed at: `2026-09-02T16:50:10.750Z`

## Capture identities

- Base commit: `aa74add1eeca3618ff3bbe141ef4fff2dd8d985c`
- Audited head: `5fca28e9a3adf42632640fba7926caebf0af6ea2`
- Audited tree: `b857e2c14f61da84e355b1cecb323e101bad54cc`
- Workflow run: `33656389299`
- Run attempt: `1`
- Job: `100336203703`
- Artifact ID: `9857015173`
- Artifact name: `activation-catalog-policy-5fca28e9a3adf42632640fba7926caebf0af6ea2-1`

## Raw captures

| Selection | Label | Bytes | Raw SHA-256 |
| --- | --- | ---: | --- |
| selected | `activation-catalog-policy-candidate-1.json` | `2677685` | `db9de379250974c233848f62f0ff048d6bc0a9fe15129a3391dc7862655f3f23` |
| corroborating | `activation-catalog-policy-candidate-2.json` | `2677685` | `95da734b82acf0ad008b696f33cacbe2ce9e00ef97b22e99b873abf4e5b023dd` |

Capture-set digest: `sha256:53abe3656d28ce61a8c1c8d9d2dc874e99c70a225698a28f30243d738062f72a`
Source PostgreSQL image: `postgres:16.13-bookworm@sha256:472efd9a66f2b2f1a5aeb18b28de74332e6ef88c2b93a1a5d812fb6db67a5f60`
Target PostgreSQL image: `postgres:17.5-bookworm@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4`
