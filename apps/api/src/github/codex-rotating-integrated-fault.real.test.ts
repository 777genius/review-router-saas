import { Duplex } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  CodexRotatingVersionedWritebackDispatcher,
  registerActionControlPlaneRoutes,
  type CodexRotatingVersionedWritebackLedgerPort,
} from "@reviewrouter/features-action-control-plane";
import {
  allocateVersionedProviderSecretNamespace,
  createVersionedSecretWorkflowSourceAttestation,
  WorkflowSourceTrust,
} from "@reviewrouter/features-codex-oauth-rotating";
import { putGitHubSecretExactlyOnce } from "./one-shot-github-secret-put.js";

enum IntegratedFault {
  DelayedTransport = "delayed_transport",
  TimeoutAfterDispatch = "timeout_after_dispatch",
  DroppedResponse = "dropped_response",
  RestartAfterAuthorization = "restart_after_authorization",
  RestartAfterProviderConfirmation = "restart_after_provider_confirmation",
  WorkflowPublicationFailure = "workflow_publication_failure",
  ActivationFailure = "activation_failure",
  StaleEpoch = "stale_epoch",
  AccountSwitch = "account_switch",
}

enum FixtureState {
  Fresh = "fresh",
  Authorized = "authorized",
  ProviderConfirmed = "provider_confirmed",
  Activated = "activated",
  Tombstoned = "tombstoned",
  StaleEpoch = "stale_epoch",
  AccountSwitched = "account_switched",
}

const now = new Date("2026-08-10T00:00:00.000Z");
const namespace = allocateVersionedProviderSecretNamespace({
  scope: {
    repositoryId: "123456",
    providerInstanceId: "codex-rotating:123456",
  },
  epoch: 2n,
  randomBytes: () => Buffer.alloc(16, 9),
});
const writebackRequest = {
  protocolVersion: 1 as const,
  leaseId: "lease:integrated:1",
  providerInstanceId: "codex-rotating:123456",
  generation: 2,
  latestGenerationHash: "generation-hash-01234567890123456789",
  accountIdentityHash: "account-identity-01234567890123456789",
  accountIdentityAlgorithm: "provider_issuer_subject_account_v1" as const,
  encryptedValue: Buffer.from("ciphertext-fixture").toString("base64"),
  keyId: "key-fixture",
  idempotencyKey: "writeback:integrated:1",
};

describe("integrated API to provider to workflow activation faults", () => {
  it.each(Object.values(IntegratedFault))(
    "fails closed for %s",
    async (fault) => {
      const providerWire = new IntegratedProviderWire(fault);
      const ledger = new IntegratedLedger(
        fault === IntegratedFault.StaleEpoch
          ? FixtureState.StaleEpoch
          : fault === IntegratedFault.AccountSwitch
            ? FixtureState.AccountSwitched
            : FixtureState.Fresh,
        fault === IntegratedFault.ActivationFailure,
      );
      const provider = {
        async assertCanWriteRepositorySecret() {
          return { status: "ready" as const };
        },
        async putEncryptedRepositorySecret(input: {
          encryptedValue: string;
          keyId: string;
        }) {
          const response = await putGitHubSecretExactlyOnce(
            {
              baseUrl: "http://127.0.0.1",
              owner: "owner",
              repo: "repository",
              secretName: namespace.name,
              encryptedValue: input.encryptedValue,
              keyId: input.keyId,
              token: "fixture-token",
              timeoutMs:
                fault === IntegratedFault.TimeoutAfterDispatch ? 30 : 500,
            },
            { createConnection: () => providerWire },
          );
          if (response.status !== 201 && response.status !== 204) {
            throw new Error("provider_non_success");
          }
          return {
            status: "accepted" as const,
            statusCode: response.status as 201 | 204,
          };
        },
      };
      const workflows = {
        async publishAndVerifyVersionedWorkflow() {
          if (fault === IntegratedFault.WorkflowPublicationFailure) {
            throw new Error("workflow_publication_failed");
          }
          return createVersionedSecretWorkflowSourceAttestation({
            repositoryId: "123456",
            workflowPath: ".github/workflows/reviewrouter-codex.yml",
            workflowSourceCommitSha: "a".repeat(40),
            workflowSourceBlobSha: "b".repeat(40),
            workflowSourceSha256: "c".repeat(64),
            workflowSemanticSha256: "d".repeat(64),
            sourceTrust: WorkflowSourceTrust.TrustedDefaultBranchRevision,
            secretNamespace: namespace,
          });
        },
      };

      if (fault === IntegratedFault.RestartAfterAuthorization) {
        await ledger.prepareVersionedWriteback({
          request: writebackRequest,
          encryptedPayloadDigest: "digest-fixture",
          now,
        });
      }
      if (fault === IntegratedFault.RestartAfterProviderConfirmation) {
        const prepared = await ledger.prepareVersionedWriteback({
          request: writebackRequest,
          encryptedPayloadDigest: "digest-fixture",
          now,
        });
        if (prepared.status !== "ready") throw new Error("fixture_not_ready");
        await provider.putEncryptedRepositorySecret({
          encryptedValue: writebackRequest.encryptedValue,
          keyId: writebackRequest.keyId,
        });
        await ledger.confirmVersionedProviderWrite({
          intentId: prepared.intentId,
          attemptId: prepared.attemptId,
          executorOwner: prepared.executorOwner,
          statusCode: 204,
          now,
        });
      }

      const dispatcher = new CodexRotatingVersionedWritebackDispatcher(
        ledger,
        provider,
        workflows,
        { now: () => now },
      );
      const api = Fastify({ logger: false });
      await registerActionControlPlaneRoutes(api, {
        codexRotatingVersionedWriteback: dispatcher,
        codexRotatingWritebackHmacKey: "fixture-hmac-key",
        clock: { now: () => now },
      } as unknown as Parameters<typeof registerActionControlPlaneRoutes>[1]);
      try {
        const response = await api.inject({
          method: "POST",
          url: "/api/action/v1/codex-oauth/writeback",
          payload: writebackRequest,
        });
        expect(response.statusCode).toBe(200);
        const expectedAccepted = fault === IntegratedFault.DelayedTransport;
        expect(response.json()).toMatchObject({
          status: expectedAccepted ? "accepted" : "writeback_recovery_required",
        });
        expect(providerWire.requestCount()).toBe(
          fault === IntegratedFault.StaleEpoch ||
            fault === IntegratedFault.AccountSwitch ||
            fault === IntegratedFault.RestartAfterAuthorization
            ? 0
            : 1,
        );
        expect(ledger.state).toBe(
          expectedAccepted ? FixtureState.Activated : FixtureState.Tombstoned,
        );
        if (!expectedAccepted) {
          const requestCountAfterTerminalOutcome = providerWire.requestCount();
          const replay = await api.inject({
            method: "POST",
            url: "/api/action/v1/codex-oauth/writeback",
            payload: writebackRequest,
          });
          expect(replay.statusCode).toBe(200);
          expect(replay.json()).toMatchObject({
            status: "writeback_recovery_required",
          });
          expect(providerWire.requestCount()).toBe(
            requestCountAfterTerminalOutcome,
          );
          expect(ledger.state).toBe(FixtureState.Tombstoned);
        }
      } finally {
        await api.close();
      }
    },
  );
});

class IntegratedLedger implements CodexRotatingVersionedWritebackLedgerPort {
  constructor(
    public state: FixtureState,
    private readonly failActivation: boolean,
  ) {}

  async prepareVersionedWriteback(
    input: Parameters<
      CodexRotatingVersionedWritebackLedgerPort["prepareVersionedWriteback"]
    >[0],
  ) {
    void input;
    if (this.state !== FixtureState.Fresh) {
      if (
        this.state === FixtureState.Authorized ||
        this.state === FixtureState.ProviderConfirmed
      ) {
        this.state = FixtureState.Tombstoned;
      } else if (
        this.state === FixtureState.StaleEpoch ||
        this.state === FixtureState.AccountSwitched
      ) {
        this.state = FixtureState.Tombstoned;
      }
      return { status: "writeback_recovery_required" as const };
    }
    this.state = FixtureState.Authorized;
    return {
      status: "ready" as const,
      intentId: "intent-1",
      attemptId: "attempt-1",
      executorOwner: "executor-1",
      retirementIdentity: {
        providerInstanceId: writebackRequest.providerInstanceId,
        mutationOwner: "runtime" as const,
        mutationOwnerId: writebackRequest.leaseId,
        mutationEpoch: 1n,
        namespaceId: namespace.namespaceId,
        generation: writebackRequest.generation,
        latestGenerationHash: writebackRequest.latestGenerationHash,
        accountIdentityHash: writebackRequest.accountIdentityHash,
      },
      namespace,
      repository: {
        workspaceId: "workspace-1",
        repositoryId: "repository-1",
        githubInstallationId: "789",
        githubRepositoryId: "123456",
        fullName: "owner/repository",
        owner: "owner",
        selected: true,
        installationStatus: "active" as const,
      },
      writeTarget: {
        expectedProviderInstanceId: "codex-rotating:123456",
        githubInstallationId: "789",
        githubRepositoryId: "123456",
        repositoryFullName: "owner/repository",
        owner: "owner",
        repo: "repository",
        secretName: namespace.name,
      },
    };
  }

  async confirmVersionedProviderWrite(
    input: Parameters<
      CodexRotatingVersionedWritebackLedgerPort["confirmVersionedProviderWrite"]
    >[0],
  ): Promise<void> {
    void input;
    if (this.state !== FixtureState.Authorized) throw new Error("bad_state");
    this.state = FixtureState.ProviderConfirmed;
  }

  async retirePreDispatchVersionedWriteback(
    input: Parameters<
      CodexRotatingVersionedWritebackLedgerPort["retirePreDispatchVersionedWriteback"]
    >[0],
  ): Promise<void> {
    void input;
    if (this.state === FixtureState.Tombstoned) return;
    if (this.state !== FixtureState.Authorized) throw new Error("bad_state");
    this.state = FixtureState.Tombstoned;
  }

  async retireAmbiguousVersionedWriteback(
    input: Parameters<
      CodexRotatingVersionedWritebackLedgerPort["retireAmbiguousVersionedWriteback"]
    >[0],
  ): Promise<void> {
    void input;
    this.state = FixtureState.Tombstoned;
  }

  async activateVersionedWriteback(
    input: Parameters<
      CodexRotatingVersionedWritebackLedgerPort["activateVersionedWriteback"]
    >[0],
  ): Promise<{ readonly generation: number }> {
    void input;
    if (this.failActivation) throw new Error("activation_failed");
    if (this.state !== FixtureState.ProviderConfirmed)
      throw new Error("bad_state");
    this.state = FixtureState.Activated;
    return { generation: 2 };
  }
}

class IntegratedProviderWire extends Duplex {
  private written = Buffer.alloc(0);
  private responseDispatched = false;

  constructor(private readonly fault: IntegratedFault) {
    super();
  }

  requestCount(): number {
    return this.written
      .toString("latin1")
      .split("\r\n")
      .filter((line) => line.startsWith("PUT ")).length;
  }

  override _read(): void {}

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.written = Buffer.concat([
      this.written,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding),
    ]);
    callback();
    this.respondWhenComplete();
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  private respondWhenComplete(): void {
    if (this.responseDispatched) return;
    const source = this.written.toString("latin1");
    const headerEnd = source.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const contentLength = Number(
      /^content-length:\s*(\d+)$/imu.exec(source.slice(0, headerEnd))?.[1] ??
        "0",
    );
    if (this.written.byteLength < headerEnd + 4 + contentLength) return;
    this.responseDispatched = true;
    if (this.fault === IntegratedFault.TimeoutAfterDispatch) return;

    const respond = () => {
      if (this.fault === IntegratedFault.DroppedResponse) {
        this.push(
          "HTTP/1.1 201 Created\r\nContent-Length: 20\r\nConnection: close\r\n\r\npartial",
        );
        setImmediate(() => this.push(null));
        return;
      }
      this.push(
        "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      this.push(null);
    };
    if (this.fault === IntegratedFault.DelayedTransport) {
      setTimeout(respond, 25);
    } else {
      queueMicrotask(respond);
    }
  }
}
