import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { dirname, join } from "node:path";
import { createServer } from "node:tls";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const tokenCanary = "provider-token-must-not-leak";
const payloadCanary = "plaintext-auth-payload-must-not-leak";
const encryptedCanary = Buffer.from("encrypted-provider-payload").toString(
  "base64",
);
const namespace =
  "REVIEWROUTER_CODEX_AUTH_JSON_R123456_Pb3d5f6be619a10be_E1_0123456789abcdef0123456789abcdef";
const claimCanary = "codex_claim_11111111-1111-4111-8111-111111111111";
const servers: Array<ReturnType<typeof createServer>> = [];
const httpServers: Array<ReturnType<typeof createHttpServer>> = [];

afterEach(async () => {
  await Promise.all(
    [...servers.splice(0), ...httpServers.splice(0)].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe("rotating installer continuation curl boundary", () => {
  it.each([307, 308])(
    "does not follow an HTTP %s or ambient curl URL with a claim body",
    async (redirectStatus) => {
      let trustedRequests = 0;
      let crossOriginRequests = 0;
      const trustedBodies: string[] = [];
      const crossOrigin = createHttpServer((request, response) => {
        crossOriginRequests += 1;
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"prepared"}');
      });
      httpServers.push(crossOrigin);
      await listenOnLoopback(crossOrigin);
      const crossOriginAddress = crossOrigin.address();
      if (!crossOriginAddress || typeof crossOriginAddress === "string") {
        throw new Error("cross-origin test server did not bind a TCP port");
      }
      const crossOriginUrl = `http://127.0.0.1:${crossOriginAddress.port}`;

      const trustedOrigin = createHttpServer((request, response) => {
        trustedRequests += 1;
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          trustedBodies.push(body);
          response.writeHead(redirectStatus, {
            location: `${crossOriginUrl}/redirect-target`,
          });
          response.end();
        });
      });
      httpServers.push(trustedOrigin);
      await listenOnLoopback(trustedOrigin);
      const trustedAddress = trustedOrigin.address();
      if (!trustedAddress || typeof trustedAddress === "string") {
        throw new Error("trusted test server did not bind a TCP port");
      }
      const trustedUrl = `http://127.0.0.1:${trustedAddress.port}`;

      const root = mkdtempSync(join(tmpdir(), "rr-ledger-redirect-"));
      const journal = join(root, "journal.json");
      writeFileSync(journal, JSON.stringify({ claimId: claimCanary }), {
        mode: 0o600,
      });
      writeFileSync(
        join(root, ".curlrc"),
        [
          "verbose",
          'trace-ascii = "-"',
          `url = "${crossOriginUrl}/ambient-curlrc-transfer"`,
          "",
        ].join("\n"),
      );
      const script = join(process.cwd(), "scripts/seed-codex-rotating-auth.sh");
      const child = spawn(
        "/bin/bash",
        [
          "-c",
          'source "$1"; SETUP_URL="$2/manifest"; SETUP_PREPARE_URL="$2/prepare"; SETUP_DISPATCH_URL="$2/dispatch"; SETUP_DISPATCH_OUTCOME_URL="$2/confirm"; SETUP_STATUS_URL="$2/status"; resolve_versioned_ledger_urls; PAYLOAD_RETRY_STATE="$3"; setup_claim_status',
          "ledger-redirect",
          script,
          trustedUrl,
          journal,
        ],
        {
          env: {
            ...process.env,
            HOME: root,
            CURL_HOME: root,
            REVIEW_ROUTER_SEED_LIBRARY_ONLY: "1",
            HTTP_PROXY: "",
            HTTPS_PROXY: "",
            ALL_PROXY: "",
            NO_PROXY: "127.0.0.1",
            http_proxy: "",
            https_proxy: "",
            all_proxy: "",
            no_proxy: "127.0.0.1",
          },
        },
      );
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });

      expect(code).not.toBe(0);
      expect(trustedRequests).toBe(1);
      expect(trustedBodies).toEqual([JSON.stringify({ claimId: claimCanary })]);
      expect(crossOriginRequests).toBe(0);
      expect(output).not.toContain(claimCanary);
      expect(output).not.toContain("ambient-curlrc-transfer");
    },
  );
});

const describeWire =
  process.env.REVIEW_ROUTER_CODEX_ROTATING_WIRE_PROOF === "1"
    ? describe
    : describe.skip;

describeWire("rotating installer one-shot curl provider adapter", () => {
  it.each([
    ["drops the response after application", "drop"],
    ["delays the response", "delay"],
    ["closes the connection", "close"],
    ["returns a non-success status", "failure"],
  ] as const)(
    "issues exactly one PUT when the provider %s",
    async (_, mode) => {
      const root = mkdtempSync(join(tmpdir(), "rr-one-shot-curl-"));
      const unusualTmpdir = `${root}/space ' quote " slash \\ unicode-é\nurl = "https://api.github.com/unexpected-transfer`;
      mkdirSync(unusualTmpdir, { recursive: true });
      const cert = join(root, "api.github.com.crt");
      const key = join(root, "api.github.com.key");
      execFileSync(
        "/usr/bin/openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=api.github.com",
          "-addext",
          "subjectAltName=DNS:api.github.com",
          "-keyout",
          key,
          "-out",
          cert,
        ],
        { stdio: "ignore" },
      );
      writeFileSync(
        join(root, ".curlrc"),
        [
          "verbose",
          'trace-ascii = "-"',
          'url = "https://api.github.com/ambient-curlrc-transfer"',
          "",
        ].join("\n"),
      );

      let putCount = 0;
      let transferCount = 0;
      let requestLine = "";
      let hostIsPinned = false;
      let authorizationPresent = false;
      let authorizationIsExact = false;
      let providerBodyIsExact = false;
      const provider = createServer(
        {
          cert: readFileSync(cert),
          key: readFileSync(key),
        },
        (tls) => {
          let request = Buffer.alloc(0);
          // Latch once per connection. Keeping this local prevents multiple
          // data events from double-counting one request while still making a
          // second connection (a retry) observable in putCount.
          let requestLatched = false;
          tls.on("data", (chunk) => {
            if (requestLatched) return;
            request = Buffer.concat([request, chunk]);
            const headerEnd = request.indexOf("\r\n\r\n");
            if (headerEnd < 0) return;
            const header = request.subarray(0, headerEnd).toString("utf8");
            const length = Number(
              /content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0,
            );
            if (request.length < headerEnd + 4 + length) return;
            requestLatched = true;
            transferCount += 1;
            requestLine = header.split("\r\n", 1)[0] ?? "";
            hostIsPinned = /^host:\s*api\.github\.com\s*$/imu.test(header);
            authorizationPresent = /^authorization:\s*Bearer\s+\S+\s*$/imu.test(
              header,
            );
            authorizationIsExact = new RegExp(
              `^authorization:\\s*Bearer\\s+${tokenCanary}\\s*$`,
              "imu",
            ).test(header);
            try {
              const body = JSON.parse(
                request
                  .subarray(headerEnd + 4, headerEnd + 4 + length)
                  .toString("utf8"),
              );
              providerBodyIsExact =
                body.key_id === "key-1" &&
                body.encrypted_value === encryptedCanary &&
                Object.keys(body).length === 2;
            } catch {
              providerBodyIsExact = false;
            }
            if (requestLine.startsWith("PUT ")) putCount += 1;
            if (mode === "drop") {
              // Graceful EOF after the provider applied the complete body but
              // before it emitted an HTTP status line.
              tls.end();
            } else if (mode === "close") {
              // Abrupt transport loss is a separate ambiguous outcome.
              tls.destroy();
            } else {
              const respond = () => {
                const status =
                  mode === "failure" ? "302 Found" : "204 No Content";
                const redirect =
                  mode === "failure"
                    ? "Location: https://redirect.invalid/secret\r\n"
                    : "";
                tls.end(
                  `HTTP/1.1 ${status}\r\n${redirect}Content-Length: 0\r\nConnection: close\r\n\r\n`,
                );
              };
              // This fires after curl's test-only one-second deadline, proving
              // a timeout after the provider has fully applied the request.
              if (mode === "delay") setTimeout(respond, 2_000);
              else respond();
            }
          });
        },
      );
      servers.push(provider);
      const providerSocket = join(root, "provider.sock");
      await new Promise<void>((resolve, reject) => {
        provider.once("error", reject);
        provider.listen(providerSocket, () => {
          provider.off("error", reject);
          resolve();
        });
      });

      const bin = join(root, "bin");
      execFileSync("/bin/mkdir", ["-p", bin]);
      const curlArgumentsLog = join(root, "curl-arguments.bin");
      const curl = join(bin, "curl");
      writeFileSync(
        curl,
        `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > '${curlArgumentsLog}'\nexec /usr/bin/curl "$@"\n`,
      );
      chmodSync(curl, 0o755);
      const ghLog = join(root, "gh.log");
      const gh = join(bin, "gh");
      writeFileSync(
        gh,
        `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${ghLog}'\nif [ "$1" = api ]; then printf '{"key_id":"key-1","key":"QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE="}\\n'; exit 0; fi\nif [ "$1" = secret ]; then cat >/dev/null; printf '${encryptedCanary}\\n'; exit 0; fi\nif [ "$1" = auth ] && [ "$2" = token ]; then printf '${tokenCanary}\\n'; exit 0; fi\nexit 1\n`,
      );
      chmodSync(gh, 0o755);
      const payload = join(root, "payload.json");
      writeFileSync(payload, payloadCanary, { mode: 0o600 });
      const script = join(process.cwd(), "scripts/seed-codex-rotating-auth.sh");
      const command = `source "$1"; TARGET_REPO=owner/repo; SECRET_NAME="$2"; AUTH_COMPACT_FILE="$3"; write_github_secret`;
      const childArguments = [
        "-c",
        command,
        "adapter",
        script,
        namespace,
        payload,
      ];
      const result = await new Promise<{ code: number | null; output: string }>(
        (resolve) => {
          const child = spawn("/bin/bash", childArguments, {
            env: {
              ...process.env,
              PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
              HOME: root,
              CURL_HOME: root,
              TMPDIR: unusualTmpdir,
              REVIEW_ROUTER_SEED_LIBRARY_ONLY: "1",
              REVIEW_ROUTER_CODEX_ROTATING_CURL_TEST_UNIX_SOCKET:
                providerSocket,
              REVIEW_ROUTER_CODEX_ROTATING_CURL_TEST_MAX_TIME: "1",
              HTTP_PROXY: "",
              HTTPS_PROXY: "",
              ALL_PROXY: "",
              NO_PROXY: "api.github.com",
              http_proxy: "",
              https_proxy: "",
              all_proxy: "",
              no_proxy: "api.github.com",
              CURL_CA_BUNDLE: cert,
            },
          });
          let output = "";
          child.stdout.on("data", (value) => (output += value));
          child.stderr.on("data", (value) => (output += value));
          child.on("close", (code) => resolve({ code, output }));
        },
      );

      expect(putCount, result.output).toBe(1);
      expect(transferCount).toBe(1);
      expect(requestLine).toBe(
        `PUT /repos/owner/repo/actions/secrets/${namespace} HTTP/1.1`,
      );
      expect(hostIsPinned).toBe(true);
      expect(authorizationPresent).toBe(true);
      expect(authorizationIsExact).toBe(true);
      expect(providerBodyIsExact).toBe(true);
      expect(result.code).not.toBe(0);
      const curlArguments = readFileSync(curlArgumentsLog)
        .toString("utf8")
        .split("\0")
        .filter((argument) => argument.length > 0);
      const providerBodyArguments = curlArguments.filter((argument) =>
        argument.startsWith("@"),
      );
      expect(providerBodyArguments).toHaveLength(1);
      expect(providerBodyArguments[0]).toMatch(
        new RegExp(`^@${escapeRegExp(unusualTmpdir)}/`),
      );
      const logs = `${result.output}\n${readFileSync(ghLog, "utf8")}`;
      expect(logs).not.toMatch(/curl:\s*Warning|unknown option/i);
      expect(JSON.stringify(childArguments)).not.toContain(tokenCanary);
      expect(JSON.stringify(childArguments)).not.toContain(payloadCanary);
      expect(JSON.stringify(childArguments)).not.toContain(encryptedCanary);
      expect(logs).not.toContain(tokenCanary);
      expect(logs).not.toContain(payloadCanary);
      expect(logs).not.toContain(encryptedCanary);
    },
  );
});

function listenOnLoopback(
  server: ReturnType<typeof createHttpServer>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
