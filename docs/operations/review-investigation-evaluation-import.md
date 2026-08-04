# Signed review-investigation evaluation import

This path converts one immutable `terminal_operational` telemetry sample into
one promotion-eligible `fully_evaluated` sample. It is intended for a trusted
external corpus/comparison service. It does not run a provider and must not
receive source code, prompts, raw findings, credentials, or evaluator private
keys.

## Trust boundary

The API requires both controls:

1. a dedicated evaluation-import bearer credential authorizes only this
   operation;
2. an Ed25519 signature from the configured evaluation key ring establishes
   the authority of the evaluation facts.

Operator authentication without a valid evaluation signature cannot upgrade
telemetry. The API accepts no public key in the request. Configure verification
keys at startup:

```text
REVIEW_ROUTER_INVESTIGATION_EVALUATION_PUBLIC_KEYS_JSON=[{"keyId":"evaluation-2026-08","publicKeySpkiBase64":"BASE64_SPKI_DER","notBefore":"2026-08-01T00:00:00.000Z","verifyUntil":null}]
REVIEW_ROUTER_INVESTIGATION_EVALUATION_IMPORT_CREDENTIAL_SHA256=64_LOWERCASE_HEX
```

Keep an old public key in the ring only through its approved verification
window. `verifyUntil` is checked against both the signed issue time and import
time, so a retired key cannot authorize a backdated import. Private keys belong
only to the external evaluator.

## Signed payload

The evaluator signs the UTF-8 bytes of canonical JSON for `payload`. Canonical
JSON recursively sorts object keys, preserves array order, uses JSON scalar
encoding, and contains no whitespace. The detached signature is unpadded
base64url and must decode to 64 bytes.

The strict V1 payload binds all of the following:

- terminal sample ID and persisted payload hash;
- investigation ID and certificate ID/hash;
- producer release, repository scope, revision, and stable review unit hashes;
- corpus version and hashed ground-truth set;
- evaluation-policy version;
- expected and detected defect counts plus detected-set hash;
- security-evaluation hash and violation count;
- legacy-result hash and exact comparison disposition;
- a canonical issue/expiry window of at most seven days.

Hashes represent sanitized immutable artifacts. Never substitute raw defect or
finding text.

## Import

Send the signed envelope to:

```text
POST /api/operator/v1/review-investigation-evaluations
Authorization: Bearer EVALUATION_IMPORT_CREDENTIAL
Content-Type: application/json
```

Example request shape:

```json
{
  "payload": {
    "attestationVersion": "review-investigation-evaluation.v1",
    "attestationId": "evaluation-unique-id",
    "issuedAt": "2026-08-03T11:55:00.000Z",
    "expiresAt": "2026-08-03T13:00:00.000Z",
    "subject": {
      "terminalSampleId": "terminal-CERTIFICATE_HASH",
      "terminalSamplePayloadHash": "64-lowercase-hex",
      "investigationId": "investigation-id",
      "certificateId": "certificate-id",
      "certificateHash": "64-lowercase-hex",
      "producerReleaseId": "producer-release-id",
      "repositoryScopeHash": "64-lowercase-hex",
      "reviewRevisionHash": "64-lowercase-hex",
      "stableReviewUnitHash": "64-lowercase-hex"
    },
    "corpus": {
      "version": "corpus-2026-08.v1",
      "groundTruthSetHash": "64-lowercase-hex"
    },
    "evaluationPolicyVersion": "evaluation-policy.v1",
    "facts": {
      "groundTruth": {
        "expectedDefectCount": 3,
        "detectedDefectCount": 3,
        "detectedDefectSetHash": "64-lowercase-hex"
      },
      "security": {
        "evaluationHash": "64-lowercase-hex",
        "violationCount": 0
      },
      "legacy": {
        "resultHash": "64-lowercase-hex",
        "comparison": "investigation_improved"
      }
    }
  },
  "signature": {
    "algorithm": "ed25519",
    "keyId": "evaluation-2026-08",
    "value": "UNPADDED_BASE64URL_SIGNATURE"
  }
}
```

A new import returns `201` and `status: imported`. An exact replay returns `200`
and `status: already_imported`. The serializable database transaction acquires
the same producer-release lock used by report generation, then persists the
signed audit record and derived sample together. It cannot commit between a
promotion snapshot read and report save. A different attestation for the same
terminal sample, an ID/hash collision, a partial write, or any binding mismatch
fails closed. One terminal sample therefore contributes at most one evaluated
sample to promotion.

The ordinary telemetry recorder accepts only `terminal_operational` samples.
Promotion also requires every `fully_evaluated` row to have a matching audit
attestation whose hash, derived-sample ID, and producer release agree. It
cryptographically reverifies the stored signature and configured key validity
window instead of trusting import-time validation alone. A typed object inserted
through an unsigned application path is rejected rather than silently counted.

The endpoint is not registered unless both the public-key ring and dedicated
import credential hash are configured. Its credential cannot authorize
promotion. Error bodies are fixed and never echo canonical payloads,
signatures, database details, or comparison data.
