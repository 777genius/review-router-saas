import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
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

const briefMarker = "REVIEWROUTER_INVESTIGATION_TURN_BRIEF_V1_BASE64URL:";
const scenarioMarker = "REVIEWROUTER_PAIRED_E2E_SCENARIO:";

void main();

async function main(): Promise<void> {
  const prompt = await readStdin();
  const brief = decodeBrief(prompt);
  const scenario = decodeScenario(prompt);
  const outputPath = requireArgumentValue("--output-last-message");
  const model = requireArgumentValue("--model");
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
  await writeFile(outputPath, JSON.stringify(output), "utf8");
  process.stdout.write(
    `${JSON.stringify({ type: "session_configured", model })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: Buffer.byteLength(prompt, "utf8"),
        cached_input_tokens: 0,
        output_tokens: Buffer.byteLength(JSON.stringify(output), "utf8"),
        reasoning_output_tokens: 0,
      },
    })}\n`,
  );
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
      operationReceiptIds = await readRequiredRelationFiles(
        client,
        requirement,
        scenario,
      );
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
  const result = await client.callTool({ name: tool, arguments: { ...args } });
  return parseToolPayload(result.content);
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

function requireArgumentValue(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`paired_fake_argument_missing:${flag}`);
  return value;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
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
