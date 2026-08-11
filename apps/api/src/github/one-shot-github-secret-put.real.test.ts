import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { putGitHubSecretExactlyOnce } from "./one-shot-github-secret-put.js";

const wireProofEnabled =
  process.env.REVIEW_ROUTER_CODEX_ROTATING_WIRE_PROOF === "1";
const wireDescribe = wireProofEnabled ? describe : describe.skip;

enum WireFault {
  Success = "success",
  NonSuccess = "non_success",
  Redirect = "redirect",
  DelayedResponse = "delayed_response",
  Timeout = "timeout",
  ResponseDrop = "response_drop",
  ConnectionClose = "connection_close",
}

wireDescribe("runtime GitHub secret PUT wire proof", () => {
  it.each([
    WireFault.Success,
    WireFault.NonSuccess,
    WireFault.Redirect,
    WireFault.DelayedResponse,
    WireFault.Timeout,
    WireFault.ResponseDrop,
    WireFault.ConnectionClose,
  ])("dispatches exactly one request for %s", async (fault) => {
    let requests = 0;
    const observedMethods: Array<string | undefined> = [];
    const observedPaths: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      requests += 1;
      observedMethods.push(request.method);
      observedPaths.push(request.url);
      request.resume();
      if (fault === WireFault.ConnectionClose) {
        request.socket.destroy();
        return;
      }
      if (fault === WireFault.Redirect) {
        response.writeHead(307, { location: "/must-not-be-requested" });
        response.end();
        return;
      }
      if (fault === WireFault.NonSuccess) {
        response.writeHead(422, { "content-length": "0" });
        response.end();
        return;
      }
      if (fault === WireFault.ResponseDrop) {
        response.writeHead(201, { "content-length": "10" });
        response.flushHeaders();
        response.write("abc");
        setImmediate(() => response.destroy());
        return;
      }
      const delay =
        fault === WireFault.DelayedResponse
          ? 25
          : fault === WireFault.Timeout
            ? 250
            : 0;
      setTimeout(() => {
        if (!response.destroyed) {
          response.writeHead(204);
          response.end();
        }
      }, delay);
    });
    const baseUrl = await listen(server);
    const operation = putGitHubSecretExactlyOnce({
      baseUrl,
      owner: "owner",
      repo: "repository",
      secretName:
        "REVIEWROUTER_CODEX_AUTH_JSON_R1_P0000000000000000_E1_00000000000000000000000000000000",
      encryptedValue: "encrypted-fixture",
      keyId: "key-fixture",
      token: "wire-proof-token",
      timeoutMs: fault === WireFault.Timeout ? 30 : 500,
    });
    try {
      if (
        fault === WireFault.Timeout ||
        fault === WireFault.ResponseDrop ||
        fault === WireFault.ConnectionClose
      ) {
        await expect(operation).rejects.toBeDefined();
      } else {
        await expect(operation).resolves.toEqual({
          status:
            fault === WireFault.Redirect
              ? 307
              : fault === WireFault.NonSuccess
                ? 422
                : 204,
        });
      }
      expect(requests).toBe(1);
      expect(observedMethods).toEqual(["PUT"]);
      expect(observedPaths).toEqual([
        "/repos/owner/repository/actions/secrets/REVIEWROUTER_CODEX_AUTH_JSON_R1_P0000000000000000_E1_00000000000000000000000000000000",
      ]);
    } finally {
      server.closeAllConnections();
      await close(server);
    }
  });
});

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen_failed");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = once(server, "close");
  server.close();
  await closed;
}
