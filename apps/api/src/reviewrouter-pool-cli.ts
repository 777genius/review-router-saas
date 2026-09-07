import { open } from "node:fs/promises";

const commands = {
  "pool status": [],
  "pool accounts import": ["label", "auth-file"],
  "pool accounts replace": [
    "account-id",
    "expected-generation",
    "expected-health-version",
    "auth-file",
  ],
  "pool accounts pause": ["account-id", "expected-health-version"],
  "pool accounts resume": ["account-id", "expected-health-version"],
  "pool repositories connect": ["repo", "all", "dry-run"],
} as const;
export function poolCliOptions(command: string): readonly string[] | null {
  const options = commands[command as keyof typeof commands];
  return options ? ["workspace", "profile", "api-url", ...options] : null;
}

/** Read at most limit+1 bytes even if the file grows after stat. No remote paths. */
export async function readPoolAuthFile(filename: string): Promise<Buffer> {
  const file = await open(filename, "r").catch(() => {
    throw new Error("hosted_pool_auth_file_invalid");
  });
  const bytes = Buffer.alloc(1024 * 1024 + 1);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 1024 * 1024)
      throw new Error("hosted_pool_auth_file_invalid");
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length === 0 || length > 1024 * 1024)
      throw new Error("hosted_pool_auth_file_invalid");
    return Buffer.from(bytes.subarray(0, length));
  } catch {
    throw new Error("hosted_pool_auth_file_invalid");
  } finally {
    bytes.fill(0);
    await file.close();
  }
}

export async function executePoolCli(input: {
  readonly command: string;
  readonly options: Readonly<Record<string, string | true>>;
  request(
    method: "GET" | "POST",
    pathname: string,
    body?: unknown,
  ): Promise<unknown>;
  readonly readAuthFile?: typeof readPoolAuthFile;
}) {
  const required = (name: string) => {
    const value = input.options[name];
    if (typeof value !== "string" || !value.trim())
      throw new Error(`reviewrouter_operator_option_required:${name}`);
    return value.trim();
  };
  const integer = (name: string) => {
    const text = required(name);
    const value = Number(text);
    if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(value))
      throw new Error("hosted_pool_version_invalid");
    return value;
  };
  const workspace = required("workspace");
  const base = "/api/operator/v1/hosted-pool";
  const status = () =>
    input.request("GET", `${base}?workspace=${encodeURIComponent(workspace)}`);
  if (input.command === "pool status") return status();
  if (input.command === "pool repositories connect") {
    const all = input.options.all === true;
    const repo = input.options.repo;
    if (
      (all && repo !== undefined) ||
      (!all && typeof repo !== "string") ||
      (input.options.all !== undefined && !all) ||
      (input.options["dry-run"] !== undefined &&
        input.options["dry-run"] !== true)
    )
      throw new Error("hosted_pool_repository_selection_required");
    const current = (await status()) as {
      repositories: readonly {
        fullName: string;
        eligible: boolean;
        bindingRevision: number | null;
      }[];
    };
    const selected = all
      ? current.repositories.filter((r) => r.eligible)
      : current.repositories.filter((r) => r.fullName === repo);
    if (!all && selected.length !== 1)
      throw new Error("hosted_pool_repository_unavailable");
    const results = [];
    // Bounded one-request-at-a-time orchestration; subsequent runs reread revisions.
    for (const repository of selected) {
      if (input.options["dry-run"] === true) {
        results.push({
          repository: repository.fullName,
          status: "dry_run",
          expectedRevision: repository.bindingRevision,
        });
        continue;
      }
      try {
        results.push({
          repository: repository.fullName,
          result: await input.request("POST", `${base}/connect`, {
            workspace,
            repository: repository.fullName,
            expectedRevision: repository.bindingRevision,
          }),
        });
      } catch (error) {
        const conflict =
          error instanceof Error && error.message === "hosted_pool_conflict";
        const permissions =
          error instanceof Error &&
          error.message === "hosted_pool_github_app_permissions_required";
        results.push({
          repository: repository.fullName,
          status: conflict ? "conflict" : "failed",
          code: conflict
            ? "hosted_pool_conflict"
            : permissions
              ? "hosted_pool_github_app_permissions_required"
              : "hosted_pool_connect_failed",
        });
      }
    }
    return {
      status: results.some(
        (r) => r.status === "failed" || r.status === "conflict",
      )
        ? "partial_failure"
        : "complete",
      results,
    };
  }
  const action = input.command.split(" ")[2]!;
  const body: Record<string, unknown> = { workspace };
  if (action === "import") body.label = required("label");
  else {
    body.accountId = required("account-id");
    body.expectedHealthVersion = integer("expected-health-version");
  }
  if (action === "replace")
    body.expectedGeneration = integer("expected-generation");
  let auth: Buffer | undefined;
  try {
    if (action === "import" || action === "replace") {
      auth = await (input.readAuthFile ?? readPoolAuthFile)(
        required("auth-file"),
      );
      body.authBase64 = auth.toString("base64");
    }
    try {
      return await input.request("POST", `${base}/accounts/${action}`, body);
    } catch {
      // Never retry enrollment or relogin blindly after an uncertain response.
      if (auth)
        return { status: "reconcile_required", observed: await status() };
      throw new Error("hosted_pool_account_mutation_failed");
    }
  } finally {
    auth?.fill(0);
    delete body.authBase64;
  }
}
