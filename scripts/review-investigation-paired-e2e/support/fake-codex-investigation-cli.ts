import { createHash } from "node:crypto";
import readline from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type TurnBrief = Readonly<{
  purpose: "discovery" | "critic";
  obligations: readonly Readonly<{
    obligationId: string;
    kind: string;
    canonicalRequirement: string;
  }>[];
}>;

type Scenario = "success" | "high_risk_proposal" | "incomplete_path_chain";

type ClosureClaim = Readonly<{
  obligationId: string;
  operationReceiptIds: readonly string[];
}>;

type JsonRpcRequest = Readonly<{
  id?: number;
  method: string;
  params?: Readonly<Record<string, unknown>>;
}>;

const briefMarker = "REVIEWROUTER_INVESTIGATION_TURN_BRIEF_V1_BASE64URL:";
const scenarioMarker = "REVIEWROUTER_PAIRED_E2E_SCENARIO:";
const codexVersion = requireCodexVersion(
  process.env.REVIEW_ROUTER_PAIRED_CODEX_APP_SERVER_VERSION,
);
const threadId = "reviewrouter-paired-e2e-thread";
const turnId = "reviewrouter-paired-e2e-turn";
let protocolCwd = process.cwd();
let requestedModel = "gpt-paired-e2e";
let outputQueue = Promise.resolve();
let itemSequence = 0;

void main();

async function main(): Promise<void> {
  if (process.argv.includes("--version")) {
    process.stdout.write(`codex-cli ${codexVersion}\n`);
    return;
  }
  if (!process.argv.includes("app-server")) {
    throw new Error("paired_fake_app_server_required");
  }
  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  input.on("line", (line) => {
    void handleRequest(JSON.parse(line) as JsonRpcRequest).catch(fail);
  });
}

async function handleRequest(message: JsonRpcRequest): Promise<void> {
  switch (message.method) {
    case "initialize":
      await respond(message, {
        userAgent: `Codex Desktop/${codexVersion} reviewrouter-paired-e2e`,
        codexHome: process.cwd(),
        platformFamily: "unix",
        platformOs: process.platform,
      });
      await notify("remoteControl/status/changed", { status: "disabled" });
      return;
    case "initialized":
      return;
    case "thread/start": {
      const params = requireRecord(message.params, "thread_start_params");
      requestedModel = stringField(params, "model");
      protocolCwd = stringField(params, "cwd");
      const thread = threadRecord();
      await respond(message, {
        thread,
        model: requestedModel,
        modelProvider: "openai",
        serviceTier: null,
        cwd: protocolCwd,
        instructionSources: [],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "readOnly", networkAccess: false },
        reasoningEffort: "xhigh",
      });
      await notify("thread/started", { thread });
      return;
    }
    case "turn/start": {
      const prompt = turnPrompt(
        requireRecord(message.params, "turn_start_params"),
      );
      await respond(message, { turn: turnRecord("inProgress") });
      await notify("turn/started", {
        threadId,
        turn: turnRecord("inProgress"),
      });
      void executeTurn(prompt).catch(fail);
      return;
    }
    case "turn/interrupt":
      await respond(message, {});
      return;
    default:
      throw new Error(`paired_fake_request_unsupported:${message.method}`);
  }
}

async function executeTurn(prompt: string): Promise<void> {
  const brief = decodeBrief(prompt);
  const scenario = decodeScenario(prompt);
  const closureClaims: ClosureClaim[] = [];

  if (brief.purpose === "discovery") {
    const transport = new StdioClientTransport({
      command: parseReviewRouterConfig("command") as string,
      args: parseReviewRouterConfig("args") as string[],
      cwd: parseReviewRouterConfig("cwd") as string,
      env: stringEnvironment(process.env),
      stderr: "pipe",
    });
    const client = new Client(
      { name: "reviewrouter-paired-e2e-codex", version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
      for (const obligation of brief.obligations) {
        closureClaims.push(
          await investigateObligation(client, obligation, scenario),
        );
      }
    } finally {
      await client.close();
    }
  }

  const output = {
    outputVersion: 2,
    findings: [],
    obligationProposals:
      brief.purpose === "discovery"
        ? proposalForMissingCaller(brief, scenario)
        : [],
    closureClaims,
    operationBackedDiscoveryClaims: [],
    unresolvableClaims: [],
    criticDecision: brief.purpose === "critic" ? "accept" : null,
  };
  const finalText = JSON.stringify(output);
  const item = {
    type: "agentMessage",
    id: "final-answer",
    text: finalText,
    phase: "final_answer",
    memoryCitation: null,
  };
  await notify("item/started", { threadId, turnId, startedAtMs: 1, item });
  await notify("item/completed", {
    threadId,
    turnId,
    completedAtMs: 2,
    item,
  });
  const usage = tokenUsage(
    Buffer.byteLength(prompt, "utf8"),
    Buffer.byteLength(finalText, "utf8"),
    5,
  );
  await notify("rawResponse/completed", {
    threadId,
    turnId,
    responseId: "response-1",
    usage,
  });
  await notify("thread/tokenUsage/updated", {
    threadId,
    turnId,
    tokenUsage: { total: usage, last: usage, modelContextWindow: 200_000 },
  });
  await notify("turn/completed", {
    threadId,
    turn: turnRecord("completed"),
  });
}

function proposalForMissingCaller(brief: TurnBrief, scenario: Scenario) {
  if (scenario !== "high_risk_proposal") return [];
  const path = "src/caller-a.ts";
  if (
    brief.obligations.some((obligation) => {
      const requirement = JSON.parse(obligation.canonicalRequirement) as Record<
        string,
        unknown
      >;
      return requirement.path === path;
    })
  ) {
    return [];
  }
  const pathHash = sha256(path);
  return [
    Object.freeze({
      kind: "direct_caller",
      canonicalSubject: JSON.stringify({
        kind: "file_read",
        pathHash,
        revision: "head",
        subjectVersion: 1,
      }),
      canonicalRequirement: JSON.stringify({
        kind: "complete_file",
        path,
        pathHash,
        requirementVersion: 1,
        revision: "head",
      }),
      riskPriority: 1,
    }),
  ];
}

async function investigateObligation(
  client: Client,
  obligation: TurnBrief["obligations"][number],
  scenario: Scenario,
): Promise<ClosureClaim> {
  const requirement = JSON.parse(obligation.canonicalRequirement) as Record<
    string,
    unknown
  >;
  let operationReceiptIds: readonly string[];
  switch (requirement.kind) {
    case "complete_inventory":
      operationReceiptIds = await collectPaginatedReceipts(
        client,
        "review_canonical_inventory",
        { pageSize: 500 },
      );
      break;
    case "complete_changed_file":
    case "complete_file":
      operationReceiptIds = [
        await callReceipt(client, "review_read_file", {
          path: stringField(requirement, "path"),
          revision: stringField(requirement, "revision"),
          startByte: 0,
          maxBytes: 2 * 1024 * 1024,
        }),
      ];
      break;
    case "complete_page_chain":
      operationReceiptIds = await collectPaginatedReceipts(
        client,
        "review_search_text",
        {
          query: stringField(requirement, "query"),
          paths: ["."],
          revision: "head",
          caseSensitive: true,
          pageSize: 500,
        },
      );
      break;
    case "complete_relation_context":
      operationReceiptIds = Object.freeze([
        ...(await collectPaginatedReceipts(client, "review_search_text", {
          query: stringField(requirement, "query"),
          paths: ["."],
          revision: "head",
          caseSensitive: true,
          pageSize: 500,
        })),
        ...(await readRequiredRelationFiles(client, requirement, scenario)),
      ]);
      break;
    default:
      throw new Error(
        `paired_fake_requirement_unsupported:${requirement.kind}`,
      );
  }
  return Object.freeze({
    obligationId: obligation.obligationId,
    operationReceiptIds: Object.freeze([...operationReceiptIds]),
  });
}

async function readRequiredRelationFiles(
  client: Client,
  requirement: Record<string, unknown>,
  scenario: Scenario,
): Promise<readonly string[]> {
  const requiredHashes = stringArrayField(requirement, "requiredPathHashes");
  const paths = await collectDirectoryEntries(client);
  const pathByHash = new Map(paths.map((entry) => [sha256(entry), entry]));
  const requiredPaths = requiredHashes.map((hash) => {
    const candidate = pathByHash.get(hash);
    if (!candidate) throw new Error("paired_fake_required_path_unavailable");
    return candidate;
  });
  const selected =
    scenario === "incomplete_path_chain" && requiredPaths.length > 0
      ? requiredPaths.slice(0, -1)
      : requiredPaths;
  return Promise.all(
    selected.map((filePath) =>
      callReceipt(client, "review_read_file", {
        path: filePath,
        revision: "head",
        startByte: 0,
        maxBytes: 2 * 1024 * 1024,
      }),
    ),
  );
}

async function collectDirectoryEntries(client: Client): Promise<string[]> {
  const entries: string[] = [];
  let cursor: string | undefined;
  do {
    const payload = await callTool(client, "review_list_directory", {
      path: ".",
      revision: "head",
      maxDepth: 32,
      includeHidden: true,
      pageSize: 2_000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    entries.push(...stringArrayField(payload, "entries"));
    cursor = nullableStringField(payload, "nextCursor") ?? undefined;
  } while (cursor !== undefined);
  return entries;
}

async function collectPaginatedReceipts(
  client: Client,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<readonly string[]> {
  const receipts: string[] = [];
  let cursor: string | undefined;
  do {
    const payload = await callTool(client, tool, {
      ...args,
      ...(cursor === undefined ? {} : { cursor }),
    });
    receipts.push(stringField(payload, "operationReceiptId"));
    cursor = nullableStringField(payload, "nextCursor") ?? undefined;
  } while (cursor !== undefined);
  return Object.freeze(receipts);
}

async function callReceipt(
  client: Client,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<string> {
  return stringField(await callTool(client, tool, args), "operationReceiptId");
}

async function callTool(
  client: Client,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const id = `mcp-${++itemSequence}`;
  await notify("item/started", {
    threadId,
    turnId,
    startedAtMs: 1,
    item: mcpItem(id, tool, args, "inProgress", null),
  });
  const result = await client.callTool({ name: tool, arguments: { ...args } });
  await notify("item/completed", {
    threadId,
    turnId,
    completedAtMs: 2,
    item: mcpItem(id, tool, args, "completed", { content: result.content }),
  });
  return parseToolPayload(result.content);
}

function mcpItem(
  id: string,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  status: "inProgress" | "completed",
  result: Readonly<Record<string, unknown>> | null,
) {
  return {
    type: "mcpToolCall",
    id,
    server: "reviewrouter",
    tool,
    arguments: args,
    status,
    result,
    error: null,
    pluginId: null,
    appContext: null,
  };
}

function parseToolPayload(content: unknown): Record<string, unknown> {
  if (!Array.isArray(content) || content.length !== 1) {
    throw new Error("paired_fake_tool_content_invalid");
  }
  const item = content[0] as Record<string, unknown>;
  if (item.type !== "text" || typeof item.text !== "string") {
    throw new Error("paired_fake_tool_text_invalid");
  }
  const parsed = JSON.parse(item.text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("paired_fake_tool_payload_invalid");
  }
  return parsed as Record<string, unknown>;
}

function decodeBrief(prompt: string): TurnBrief {
  const encoded = prompt
    .split(/\r?\n/u)
    .find((line) => line.startsWith(briefMarker))
    ?.slice(briefMarker.length);
  if (!encoded) throw new Error("paired_fake_turn_brief_missing");
  return JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as TurnBrief;
}

function decodeScenario(prompt: string): Scenario {
  const value = prompt
    .split(/\r?\n/u)
    .find((line) => line.startsWith(scenarioMarker))
    ?.slice(scenarioMarker.length);
  if (
    value === "success" ||
    value === "high_risk_proposal" ||
    value === "incomplete_path_chain"
  ) {
    return value;
  }
  throw new Error("paired_fake_scenario_missing");
}

function parseReviewRouterConfig(field: "command" | "args" | "cwd"): unknown {
  const prefix = `mcp_servers.reviewrouter.${field}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  if (!value) throw new Error(`paired_fake_gateway_${field}_missing`);
  return JSON.parse(value.slice(prefix.length));
}

function tokenUsage(
  inputTokens: number,
  outputTokens: number,
  reasoningOutputTokens: number,
) {
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens,
  };
}

function threadRecord() {
  return {
    id: threadId,
    ephemeral: true,
    modelProvider: "openai",
    path: null,
    cwd: protocolCwd,
    cliVersion: codexVersion,
    turns: [],
  };
}

function turnRecord(status: "inProgress" | "completed") {
  return { id: turnId, status, error: null, items: [] };
}

function turnPrompt(params: Readonly<Record<string, unknown>>): string {
  const input = params.input;
  if (!Array.isArray(input) || input.length !== 1) {
    throw new Error("paired_fake_turn_input_invalid");
  }
  return stringField(requireRecord(input[0], "turn_input"), "text");
}

function respond(
  request: JsonRpcRequest,
  result: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (!Number.isSafeInteger(request.id)) {
    throw new Error("paired_fake_request_id_invalid");
  }
  return send({ id: request.id, result });
}

function notify(
  method: string,
  params: Readonly<Record<string, unknown>>,
): Promise<void> {
  return send({ method, params, emittedAtMs: 1 });
}

function send(value: Readonly<Record<string, unknown>>): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  outputQueue = outputQueue.then(
    () =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(line, "utf8", (error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  );
  return outputQueue;
}

function fail(error: unknown): void {
  process.stderr.write(
    `${error instanceof Error ? error.message : "paired_fake_failure"}\n`,
  );
  process.exitCode = 1;
  process.stdin.destroy();
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`paired_fake_${field}_invalid`);
  }
  return value as Record<string, unknown>;
}

function stringEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function requireCodexVersion(value: string | undefined): string {
  if (!value || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(value)) {
    throw new Error("paired_fake_codex_version_invalid");
  }
  return value;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string") {
    throw new Error(`paired_fake_${field}_invalid`);
  }
  return result;
}

function nullableStringField(
  value: Record<string, unknown>,
  field: string,
): string | null {
  const result = value[field];
  if (result !== null && result !== undefined && typeof result !== "string") {
    throw new Error(`paired_fake_${field}_invalid`);
  }
  return typeof result === "string" ? result : null;
}

function stringArrayField(
  value: Record<string, unknown>,
  field: string,
): string[] {
  const result = value[field];
  if (
    !Array.isArray(result) ||
    result.some((item) => typeof item !== "string")
  ) {
    throw new Error(`paired_fake_${field}_invalid`);
  }
  return [...(result as string[])];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
