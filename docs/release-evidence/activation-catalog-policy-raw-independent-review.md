# Raw activation catalog independent review

## Decision

- Verdict: **GO**
- BLOCKER: **0**
- HIGH: **0**
- Decision ID: `RR-PR236-RAW-CATALOG-GO-5CB98204-91A581DD-20260831`
- Reviewed at: `2026-08-31T14:02:32.000Z`

## Capture identities

- Base commit: `f73066c3634ceeab6fc88bcffdcccbe611071480`
- Audited head: `5cb982044dcb074d68f7dc908387380c521f8e4d`
- Audited tree: `563feac3db9c6a9af4edecd1114004469ba833d6`
- Workflow run: `33398188752`
- Run attempt: `1`
- Job: `99507725901`
- Artifact ID: `9760216198`
- Artifact name: `activation-catalog-policy-5cb982044dcb074d68f7dc908387380c521f8e4d-1`

## Raw captures

| Selection | Label | Bytes | Raw SHA-256 |
| --- | --- | ---: | --- |
| selected | `activation-catalog-policy-candidate-1.json` | `2675451` | `91a581ddede77fa94fe71a1592b0aa13dadc8ea57edbcb1cdc0fce867f45e54c` |
| corroborating | `activation-catalog-policy-candidate-2.json` | `2675451` | `1a37777a2367ed2f9867c4184a14b12cd2704e719838687c852def5168ad22b6` |

Capture-set digest: `sha256:552d368e43cc7c02ad997a0a6ede18a2357f73b54efacd9dd650053355210e9f`
Source PostgreSQL image: `postgres:16.13-bookworm@sha256:472efd9a66f2b2f1a5aeb18b28de74332e6ef88c2b93a1a5d812fb6db67a5f60`
Target PostgreSQL image: `postgres:17.5-bookworm@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4`
