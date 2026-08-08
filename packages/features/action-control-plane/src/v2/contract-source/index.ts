export type ReviewActionV2NegotiationContractSource = {
  readonly contractSourceVersion: 1;
  readonly protocolVersion: "2";
  readonly schemaId: string;
  readonly operations: readonly [
    {
      readonly operationId: "review_run_authorize";
      readonly method: "POST";
      readonly path: "/api/action/v2/review-runs/authorize";
      readonly callerAuthority: "fresh_scm_oidc";
      readonly mutability: "authorization";
      readonly naturalIdempotencyPreimage: readonly [
        "oidc_replay_key_hash",
        "protocol_offer_hash",
      ];
      readonly semanticRetryClass: "same_request";
      readonly defaultTimeoutMs: 15_000;
      readonly bodyLimitBytes: 24_576;
      readonly maxOidcTokenBytes: 16_384;
      readonly maxProtocolOffers: 8;
      readonly maxRequestIdBytes: 128;
    },
  ];
  readonly retryClasses: readonly ["never", "same_request", "read_only"];
  readonly errors: readonly [
    {
      readonly typeName: "InvalidRequest";
      readonly errorCode: "invalid_request";
      readonly retryClass: "never";
      readonly httpStatus: 400;
    },
    {
      readonly typeName: "UnsupportedProtocol";
      readonly errorCode: "unsupported_protocol";
      readonly retryClass: "never";
      readonly httpStatus: 426;
      readonly fallbackProtocolVersion: "1";
    },
  ];
};

export const reviewActionV2NegotiationContract = {
  contractSourceVersion: 1,
  protocolVersion: "2",
  schemaId:
    "https://reviewrouter.site/schemas/action/v2/review-run-authorize-negotiation.json",
  operations: [
    {
      operationId: "review_run_authorize",
      method: "POST",
      path: "/api/action/v2/review-runs/authorize",
      callerAuthority: "fresh_scm_oidc",
      mutability: "authorization",
      naturalIdempotencyPreimage: [
        "oidc_replay_key_hash",
        "protocol_offer_hash",
      ],
      semanticRetryClass: "same_request",
      defaultTimeoutMs: 15_000,
      bodyLimitBytes: 24_576,
      maxOidcTokenBytes: 16_384,
      maxProtocolOffers: 8,
      maxRequestIdBytes: 128,
    },
  ],
  retryClasses: ["never", "same_request", "read_only"],
  errors: [
    {
      typeName: "InvalidRequest",
      errorCode: "invalid_request",
      retryClass: "never",
      httpStatus: 400,
    },
    {
      typeName: "UnsupportedProtocol",
      errorCode: "unsupported_protocol",
      retryClass: "never",
      httpStatus: 426,
      fallbackProtocolVersion: "1",
    },
  ],
} as const satisfies ReviewActionV2NegotiationContractSource;

const commonCommandErrors = [
  "invalid_request",
  "invalid_authentication",
  "forbidden",
  "capability_disabled",
  "not_found",
  "idempotency_conflict",
  "resource_gone",
  "stale_precondition",
  "limit_exceeded",
  "invariant_violation",
  "capacity_limited",
  "ambiguous_outcome",
] as const;

const commonReadErrors = [
  "invalid_request",
  "invalid_authentication",
  "forbidden",
  "capability_disabled",
  "not_found",
  "resource_gone",
  "stale_precondition",
  "limit_exceeded",
  "capacity_limited",
  "service_unavailable",
] as const;

const contextGatewayOpenErrors = [
  "invalid_request",
  "invalid_authentication",
  "forbidden",
  "capability_disabled",
  "not_found",
  "idempotency_conflict",
  "resource_gone",
  "stale_precondition",
  "limit_exceeded",
  "invariant_violation",
  "capacity_limited",
  "ambiguous_outcome",
] as const;

const contextAttestationCommitErrors = [
  "invalid_request",
  "invalid_authentication",
  "forbidden",
  "capability_disabled",
  "not_found",
  "idempotency_conflict",
  "resource_gone",
  "stale_precondition",
  "limit_exceeded",
  "invariant_violation",
  "ambiguous_outcome",
] as const;

export const reviewActionV2TransportContract = Object.freeze({
  contractSourceVersion: 1,
  protocolVersion: "2",
  schemaId: "https://reviewrouter.site/schemas/action/v2/review-action.json",
  envelope: Object.freeze({
    requestIdMaxBytes: 128,
    idempotencyKeyMaxBytes: 256,
    capabilityTokenMaxBytes: 32_768,
    errorDetailMaxItems: 8,
    errorDetailMaxBytes: 160,
  }),
  retryClasses: Object.freeze(["never", "same_request", "read_only"]),
  errors: Object.freeze([
    Object.freeze({
      typeName: "InvalidRequest",
      errorCode: "invalid_request",
      retryClass: "never",
      httpStatus: 400,
    }),
    Object.freeze({
      typeName: "InvalidAuthentication",
      errorCode: "invalid_authentication",
      retryClass: "never",
      httpStatus: 401,
    }),
    Object.freeze({
      typeName: "Forbidden",
      errorCode: "forbidden",
      retryClass: "never",
      httpStatus: 403,
    }),
    Object.freeze({
      typeName: "CapabilityDisabled",
      errorCode: "capability_disabled",
      retryClass: "never",
      httpStatus: 403,
    }),
    Object.freeze({
      typeName: "NotFound",
      errorCode: "not_found",
      retryClass: "never",
      httpStatus: 404,
    }),
    Object.freeze({
      typeName: "IdempotencyConflict",
      errorCode: "idempotency_conflict",
      retryClass: "never",
      httpStatus: 409,
    }),
    Object.freeze({
      typeName: "ResourceGone",
      errorCode: "resource_gone",
      retryClass: "never",
      httpStatus: 410,
    }),
    Object.freeze({
      typeName: "StalePrecondition",
      errorCode: "stale_precondition",
      retryClass: "never",
      httpStatus: 412,
    }),
    Object.freeze({
      typeName: "LimitExceeded",
      errorCode: "limit_exceeded",
      retryClass: "never",
      httpStatus: 413,
    }),
    Object.freeze({
      typeName: "InvariantViolation",
      errorCode: "invariant_violation",
      retryClass: "never",
      httpStatus: 422,
    }),
    Object.freeze({
      typeName: "UnsupportedProtocol",
      errorCode: "unsupported_protocol",
      retryClass: "never",
      httpStatus: 426,
    }),
    Object.freeze({
      typeName: "CapacityLimited",
      errorCode: "capacity_limited",
      retryClass: "same_request",
      httpStatus: 429,
    }),
    Object.freeze({
      typeName: "AmbiguousOutcome",
      errorCode: "ambiguous_outcome",
      retryClass: "same_request",
      httpStatus: 500,
    }),
    Object.freeze({
      typeName: "ServiceUnavailable",
      errorCode: "service_unavailable",
      retryClass: "read_only",
      httpStatus: 503,
    }),
  ]),
  operations: Object.freeze([
    Object.freeze({
      operationId: "review_run_authorize",
      method: "POST",
      path: "/api/action/v2/review-runs/authorize",
      requestFraming: "json",
      responseFraming: "json",
      transportAudience: "review_run_authorization",
      defaultTimeoutMs: 15_000,
      bodyLimitBytes: 24_576,
      successStatuses: Object.freeze([200, 201]),
      errorCodes: Object.freeze([
        "invalid_request",
        "forbidden",
        "not_found",
        "idempotency_conflict",
        "resource_gone",
        "limit_exceeded",
        "invariant_violation",
        "unsupported_protocol",
        "capacity_limited",
        "ambiguous_outcome",
      ]),
    }),
    Object.freeze({
      operationId: "review_run_renew",
      method: "POST",
      path: "/api/action/v2/review-runs/renew",
      requestFraming: "json",
      responseFraming: "json",
      transportAudience: "review_run_authorization_renewal",
      defaultTimeoutMs: 15_000,
      bodyLimitBytes: 24_576,
      successStatuses: Object.freeze([200]),
      errorCodes: Object.freeze(commonCommandErrors),
    }),
    ...Object.freeze(
      (
        [
          [
            "review_execution_restore",
            "/api/action/v2/review-executions/restore",
            5_000,
            32_768,
            [200],
            commonReadErrors,
          ],
          [
            "review_execution_start",
            "/api/action/v2/review-executions/start",
            10_000,
            262_144,
            [200, 201],
            commonCommandErrors,
          ],
          [
            "review_execution_supersede",
            "/api/action/v2/review-executions/supersede",
            10_000,
            32_768,
            [200],
            commonCommandErrors,
          ],
          [
            "review_execution_observation_attach",
            "/api/action/v2/review-executions/observations/attach",
            10_000,
            65_536,
            [200, 201],
            commonCommandErrors,
          ],
          [
            "review_execution_observation_adopt",
            "/api/action/v2/review-executions/observations/adopt",
            10_000,
            262_144,
            [200, 201],
            commonCommandErrors,
          ],
          [
            "review_execution_finalize",
            "/api/action/v2/review-executions/finalize",
            10_000,
            524_288,
            [200, 201],
            commonCommandErrors,
          ],
          [
            "review_investigation_open",
            "/api/action/v2/review-investigations/open",
            10_000,
            524_288,
            [200, 201],
            commonCommandErrors,
          ],
          [
            "review_investigation_open_v2",
            "/api/action/v2/review-investigations/open-v2",
            10_000,
            524_288,
            [200, 201],
            commonCommandErrors,
          ],
          [
            "review_investigation_restore",
            "/api/action/v2/review-investigations/restore",
            5_000,
            32_768,
            [200],
            commonReadErrors,
          ],
          [
            "review_investigation_turn_plan",
            "/api/action/v2/review-investigations/turns/plan",
            10_000,
            65_536,
            [200, 201, 202],
            commonCommandErrors,
          ],
          [
            "review_investigation_lease_acquire",
            "/api/action/v2/review-investigations/leases/acquire",
            10_000,
            262_144,
            [200, 201],
            commonCommandErrors,
          ],
          [
            "review_investigation_lease_renew",
            "/api/action/v2/review-investigations/leases/renew",
            10_000,
            32_768,
            [200],
            commonCommandErrors,
          ],
          [
            "review_investigation_lease_release",
            "/api/action/v2/review-investigations/leases/release",
            10_000,
            32_768,
            [200],
            commonCommandErrors,
          ],
          [
            "review_investigation_turn_commit",
            "/api/action/v2/review-investigations/turns/commit",
            15_000,
            2_097_152,
            [200, 201, 202],
            commonCommandErrors,
          ],
          [
            "review_investigation_turn_abort",
            "/api/action/v2/review-investigations/turns/abort",
            10_000,
            65_536,
            [200, 202],
            commonCommandErrors,
          ],
          [
            "review_investigation_replay_prepare",
            "/api/action/v2/review-investigations/replay/prepare",
            10_000,
            262_144,
            [200],
            commonReadErrors,
          ],
          [
            "review_investigation_replay",
            "/api/action/v2/review-investigations/replay",
            15_000,
            524_288,
            [200, 201],
            commonCommandErrors,
          ],
          [
            "review_investigation_replay_v2",
            "/api/action/v2/review-investigations/replay-v2",
            15_000,
            524_288,
            [200, 201],
            commonCommandErrors,
          ],
          [
            "review_investigation_conclude",
            "/api/action/v2/review-investigations/conclude",
            10_000,
            65_536,
            [200, 201],
            commonCommandErrors,
          ],
          [
            "review_invocation_lease_acquire",
            "/api/action/v2/review-invocation-leases/acquire",
            10_000,
            262_144,
            [200, 201],
            commonCommandErrors,
          ],
          [
            "review_invocation_lease_renew",
            "/api/action/v2/review-invocation-leases/renew",
            10_000,
            32_768,
            [200],
            commonCommandErrors,
          ],
          [
            "review_invocation_lease_release",
            "/api/action/v2/review-invocation-leases/release",
            10_000,
            32_768,
            [200],
            commonCommandErrors,
          ],
          [
            "review_context_gateway_open",
            "/api/action/v2/review-context/gateway/open",
            10_000,
            65_536,
            [200, 201],
            contextGatewayOpenErrors,
          ],
          [
            "review_context_gateway_seal",
            "/api/action/v2/review-context/gateway/seal",
            15_000,
            4_194_304,
            [200, 201],
            contextAttestationCommitErrors,
          ],
          [
            "review_investigation_context_gateway_open",
            "/api/action/v2/review-investigations/context-gateway/open",
            10_000,
            65_536,
            [200, 201],
            contextGatewayOpenErrors,
          ],
          [
            "review_investigation_context_gateway_seal",
            "/api/action/v2/review-investigations/context-gateway/seal",
            15_000,
            4_194_304,
            [200, 201],
            contextAttestationCommitErrors,
          ],
          [
            "review_evidence_lookup",
            "/api/action/v2/review-evidence/lookup",
            5_000,
            262_144,
            [200],
            commonReadErrors,
          ],
          [
            "review_context_receipt_replay_commit",
            "/api/action/v2/review-context/receipt-replay/commit",
            15_000,
            4_194_304,
            [200, 201],
            contextAttestationCommitErrors,
          ],
          [
            "review_context_replay_commit",
            "/api/action/v2/review-context/replay/commit",
            15_000,
            4_194_304,
            [200, 201],
            contextAttestationCommitErrors,
          ],
          [
            "review_evidence_commit",
            "/api/action/v2/review-evidence/commit",
            10_000,
            2_097_152,
            [200, 201],
            commonCommandErrors,
          ],
          [
            "review_snapshot_restore",
            "/api/action/v2/review-snapshots/restore",
            5_000,
            32_768,
            [200],
            commonReadErrors,
          ],
          [
            "review_publication_request",
            "/api/action/v2/review-publication/request",
            10_000,
            524_288,
            [200, 201, 202],
            commonCommandErrors,
          ],
          [
            "review_publication_status",
            "/api/action/v2/review-publication/status",
            5_000,
            32_768,
            [200, 202],
            commonReadErrors,
          ],
        ] as const
      ).map(
        ([
          operationId,
          path,
          defaultTimeoutMs,
          bodyLimitBytes,
          successStatuses,
          errorCodes,
        ]) =>
          Object.freeze({
            operationId,
            method: "POST",
            path,
            requestFraming: "json",
            responseFraming: "json",
            transportAudience: "review_action_v2",
            defaultTimeoutMs,
            bodyLimitBytes,
            successStatuses: Object.freeze(successStatuses),
            errorCodes: Object.freeze(errorCodes),
          }),
      ),
    ),
  ]),
});
