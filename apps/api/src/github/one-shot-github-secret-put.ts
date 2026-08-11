import {
  Agent as HttpAgent,
  request as httpRequest,
  type ClientRequestArgs,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { CodexRotatingSecretPutPreDispatchError } from "@reviewrouter/features-action-control-plane";

export type OneShotGitHubSecretPutInput = Readonly<{
  baseUrl: string;
  owner: string;
  repo: string;
  secretName: string;
  encryptedValue: string;
  keyId: string;
  token: string;
  timeoutMs: number;
}>;

export type OneShotGitHubSecretPut = (
  input: OneShotGitHubSecretPutInput,
) => Promise<{ readonly status: number }>;

/**
 * The sole runtime HTTP effect for a versioned GitHub secret name.
 * Exactly one ClientRequest is constructed. There is no redirect branch, no
 * agent reuse and no retry path. The full response is consumed so a dropped
 * response is never mistaken for a complete provider acknowledgement.
 */
export async function putGitHubSecretExactlyOnce(
  input: OneShotGitHubSecretPutInput,
  testTransport?: Readonly<{
    createConnection(options: ClientRequestArgs): Duplex;
  }>,
): Promise<{ readonly status: number }> {
  let url: URL;
  let body: Buffer;
  try {
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
      throw new Error("timeout_invalid");
    }
    const baseUrl = new URL(input.baseUrl);
    if (
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash ||
      (baseUrl.protocol !== "https:" &&
        !(baseUrl.protocol === "http:" && isLoopback(baseUrl.hostname)))
    ) {
      throw new Error("base_url_invalid");
    }
    const path = [
      "repos",
      input.owner,
      input.repo,
      "actions",
      "secrets",
      input.secretName,
    ]
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    url = new URL(path, `${baseUrl.toString().replace(/\/+$/u, "")}/`);
    body = Buffer.from(
      JSON.stringify({
        encrypted_value: input.encryptedValue,
        key_id: input.keyId,
      }),
      "utf8",
    );
  } catch {
    throw new CodexRotatingSecretPutPreDispatchError();
  }
  const dispatch = url.protocol === "https:" ? httpsRequest : httpRequest;
  const testAgent = testTransport
    ? url.protocol === "https:"
      ? new HttpsAgent({ keepAlive: false })
      : new HttpAgent({ keepAlive: false })
    : null;
  if (testAgent && testTransport) {
    testAgent.createConnection =
      testTransport.createConnection as typeof testAgent.createConnection;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let requestBytesMayHaveLeft = false;
    const settle = (
      outcome:
        | Readonly<{ status: "resolved"; statusCode: number }>
        | Readonly<{ status: "rejected"; error: Error }>,
    ) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (outcome.status === "resolved") {
        resolve({ status: outcome.statusCode });
      } else {
        reject(outcome.error);
      }
    };
    let request: ReturnType<typeof httpRequest>;
    try {
      request = dispatch(
        url,
        {
          method: "PUT",
          agent: testAgent ?? false,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${input.token}`,
            "content-length": body.byteLength,
            "content-type": "application/json",
            "user-agent": "ReviewRouter-Codex-Rotating/1",
            "x-github-api-version": "2022-11-28",
          },
        },
        (response) => {
          response.once("aborted", () =>
            settle({
              status: "rejected",
              error: new Error("codex_rotating_secret_put_response_incomplete"),
            }),
          );
          response.once("error", () =>
            settle({
              status: "rejected",
              error: new Error("codex_rotating_secret_put_response_incomplete"),
            }),
          );
          response.on("data", () => undefined);
          response.once("end", () => {
            if (!response.complete || response.statusCode === undefined) {
              settle({
                status: "rejected",
                error: new Error(
                  "codex_rotating_secret_put_response_incomplete",
                ),
              });
              return;
            }
            settle({ status: "resolved", statusCode: response.statusCode });
          });
        },
      );
    } catch {
      reject(new CodexRotatingSecretPutPreDispatchError());
      return;
    }
    request.once("socket", (socket) => {
      if (url.protocol === "https:") {
        // A TCP connection alone cannot dispatch the HTTP request over TLS.
        // Until the handshake completes, DNS/connect/TLS failures are
        // definite pre-dispatch failures. From secureConnect onward, assume
        // request bytes may have left even if Node has not reported finish.
        if ("encrypted" in socket) {
          socket.once("secureConnect", () => {
            requestBytesMayHaveLeft = true;
          });
          return;
        }
      } else if ("connecting" in socket && socket.connecting) {
        // net.Socket queues ClientRequest writes while DNS/TCP connection is
        // pending. No request byte can leave before connect.
        socket.once("connect", () => {
          requestBytesMayHaveLeft = true;
        });
        return;
      }

      // Injected or already-connected sockets have no pending connection
      // lifecycle to observe, so preserve the fail-safe classification.
      requestBytesMayHaveLeft = true;
    });
    request.once("error", (cause) =>
      settle({
        status: "rejected",
        error: requestBytesMayHaveLeft
          ? new Error(
              timedOut
                ? "codex_rotating_secret_put_timeout"
                : "codex_rotating_secret_put_transport_unknown",
              { cause },
            )
          : new CodexRotatingSecretPutPreDispatchError(),
      }),
    );
    const timeout = setTimeout(() => {
      timedOut = true;
      request.destroy(new Error("codex_rotating_secret_put_timeout"));
    }, input.timeoutMs);
    try {
      request.end(body);
    } catch (cause) {
      settle({
        status: "rejected",
        error: requestBytesMayHaveLeft
          ? new Error("codex_rotating_secret_put_transport_unknown", { cause })
          : new CodexRotatingSecretPutPreDispatchError(),
      });
    }
  });
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}
