import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { putGitHubSecretExactlyOnce } from "./one-shot-github-secret-put.js";

enum ProtocolFault {
  Success = "success",
  NonSuccess = "non_success",
  Redirect = "redirect",
  DelayedResponse = "delayed_response",
  Timeout = "timeout",
  ResponseDrop = "response_drop",
  ConnectionClose = "connection_close",
}

enum PreDispatchTransportFault {
  Dns = "dns",
  ConnectRefused = "connect_refused",
  TlsHandshake = "tls_handshake",
}

describe("one-shot GitHub PUT HTTP protocol", () => {
  it.each([
    { baseUrl: "not-a-url", timeoutMs: 250, token: "token" },
    { baseUrl: "http://example.com", timeoutMs: 250, token: "token" },
    { baseUrl: "http://127.0.0.1", timeoutMs: 0, token: "token" },
    {
      baseUrl: "http://127.0.0.1",
      timeoutMs: 250,
      token: "invalid\nheader",
    },
  ])(
    "types deterministic pre-dispatch failures for %#",
    async ({ baseUrl, timeoutMs, token }) => {
      let transportConstructed = false;
      await expect(
        putGitHubSecretExactlyOnce(
          {
            baseUrl,
            owner: "owner",
            repo: "repository",
            secretName: "SECRET",
            encryptedValue: "encrypted-fixture",
            keyId: "key-fixture",
            token,
            timeoutMs,
          },
          {
            createConnection: () => {
              transportConstructed = true;
              throw new Error("transport_must_not_be_constructed");
            },
          },
        ),
      ).rejects.toMatchObject({ outcome: "pre_dispatch_failure" });
      expect(transportConstructed).toBe(false);
    },
  );

  it.each(Object.values(PreDispatchTransportFault))(
    "types %s failure before a possible request-byte flush as pre-dispatch",
    async (fault) => {
      const wire = new PreDispatchFailureWire(fault);
      const operation = putGitHubSecretExactlyOnce(
        {
          baseUrl:
            fault === PreDispatchTransportFault.TlsHandshake
              ? "https://127.0.0.1"
              : "http://127.0.0.1",
          owner: "owner",
          repo: "repository",
          secretName: "SECRET",
          encryptedValue: "encrypted-fixture",
          keyId: "key-fixture",
          token: "protocol-fixture-token",
          timeoutMs: 250,
        },
        { createConnection: () => wire },
      );

      await expect(operation).rejects.toMatchObject({
        outcome: "pre_dispatch_failure",
      });
      expect(wire.requestBytesFlushed).toBe(false);
    },
  );

  it.each(Object.values(ProtocolFault))(
    "serializes exactly one PUT and does not replay for %s",
    async (fault) => {
      const wire = new ProtocolWire(fault);
      const operation = putGitHubSecretExactlyOnce(
        {
          baseUrl: "http://127.0.0.1",
          owner: "owner",
          repo: "repository",
          secretName:
            "REVIEWROUTER_CODEX_AUTH_JSON_R1_P0000000000000000_E1_00000000000000000000000000000000",
          encryptedValue: "encrypted-fixture",
          keyId: "key-fixture",
          token: "protocol-fixture-token",
          timeoutMs: fault === ProtocolFault.Timeout ? 15 : 250,
        },
        { createConnection: () => wire },
      );

      if (
        fault === ProtocolFault.Timeout ||
        fault === ProtocolFault.ResponseDrop ||
        fault === ProtocolFault.ConnectionClose
      ) {
        await expect(operation).rejects.not.toMatchObject({
          outcome: "pre_dispatch_failure",
        });
      } else {
        await expect(operation).resolves.toEqual({
          status:
            fault === ProtocolFault.Redirect
              ? 307
              : fault === ProtocolFault.NonSuccess
                ? 422
                : 204,
        });
      }

      expect(wire.requestLines()).toEqual([
        "PUT /repos/owner/repository/actions/secrets/REVIEWROUTER_CODEX_AUTH_JSON_R1_P0000000000000000_E1_00000000000000000000000000000000 HTTP/1.1",
      ]);
      expect(wire.requestHeaders()).toContain(
        "user-agent: ReviewRouter-Codex-Rotating/1",
      );
    },
  );
});

class PreDispatchFailureWire extends Duplex {
  connecting = true;
  readonly encrypted: boolean;
  requestBytesFlushed = false;

  constructor(private readonly fault: PreDispatchTransportFault) {
    super();
    this.encrypted = fault === PreDispatchTransportFault.TlsHandshake;
    queueMicrotask(() => {
      if (fault === PreDispatchTransportFault.TlsHandshake) {
        this.connecting = false;
        this.emit("connect");
      }
      const error = new Error(`${fault}_failure`) as NodeJS.ErrnoException;
      error.code =
        fault === PreDispatchTransportFault.Dns
          ? "ENOTFOUND"
          : fault === PreDispatchTransportFault.ConnectRefused
            ? "ECONNREFUSED"
            : "EPROTO";
      this.destroy(error);
    });
  }

  override _read(): void {}

  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    _callback: (error?: Error | null) => void,
  ): void {
    // A real connecting net.Socket retains these bytes in user space. Leave
    // the write pending to model that no HTTP request byte reached the wire.
    void _chunk;
    void _encoding;
    void _callback;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }
}

class ProtocolWire extends Duplex {
  private written = Buffer.alloc(0);
  private responseDispatched = false;

  constructor(private readonly fault: ProtocolFault) {
    super();
  }

  requestLines(): readonly string[] {
    return this.written
      .toString("latin1")
      .split("\r\n")
      .filter((line) => line.startsWith("PUT "));
  }

  requestHeaders(): string {
    return this.written.toString("latin1").split("\r\n\r\n", 1)[0] ?? "";
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
    this.dispatchResponseWhenRequestComplete();
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  private dispatchResponseWhenRequestComplete(): void {
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

    if (this.fault === ProtocolFault.Timeout) return;
    if (this.fault === ProtocolFault.ConnectionClose) {
      queueMicrotask(() => this.destroy(new Error("connection_closed")));
      return;
    }
    const respond = () => {
      if (this.fault === ProtocolFault.ResponseDrop) {
        this.push(
          "HTTP/1.1 201 Created\r\nContent-Length: 10\r\nConnection: close\r\n\r\nabc",
        );
        setImmediate(() => this.push(null));
        return;
      }
      const status =
        this.fault === ProtocolFault.Redirect
          ? "307 Temporary Redirect"
          : this.fault === ProtocolFault.NonSuccess
            ? "422 Unprocessable Entity"
            : "204 No Content";
      const location =
        this.fault === ProtocolFault.Redirect
          ? "Location: http://127.0.0.1/must-not-be-requested\r\n"
          : "";
      this.push(
        `HTTP/1.1 ${status}\r\n${location}Content-Length: 0\r\nConnection: close\r\n\r\n`,
      );
      this.push(null);
    };
    if (this.fault === ProtocolFault.DelayedResponse) {
      setTimeout(respond, 10);
    } else {
      queueMicrotask(respond);
    }
  }
}
