/** Coordinator-only staging check: exactly one Modal allocation, never retried. */
import { createHash } from "node:crypto";
import { parseLaunchAdmissionReceipt } from "../packages/core/src/contract/launch-response.ts";
import type { AgentEvent, ToolCall } from "../packages/core/src/provider.ts";
import { validateReadableVariables } from "../packages/core/src/readable-variables.ts";
import type { SandboxUsage } from "../packages/core/src/sandbox-usage.ts";
import { shellQuote } from "../packages/core/src/shell-quote.ts";
import type { TemplateDefinition } from "../packages/core/src/templates.ts";
import { readDefaultPins, verifyDefaultReceipts } from "./default-skill-smoke.ts";
import { parseExplicitPinnedAdmission } from "./modal-pinned-smoke-receipt.ts";
import { createRuntimeUsageCheck } from "./runtime-usage-smoke.ts";

if (process.env.ARMADA_RUNTIME_SMOKE !== "one_real_modal_launch")
  throw Error("Set ARMADA_RUNTIME_SMOKE=one_real_modal_launch explicitly.");
const origin = new URL(process.env.ARMADA_URL ?? "");
if (origin.protocol !== "https:" || origin.href !== `${origin.origin}/`)
  throw Error("ARMADA_URL must be an HTTPS origin.");
const token = process.env.ARMADA_TOKEN;
const golden = process.env.ARMADA_RUNTIME_GOLDEN;
const org = process.env.ARMADA_RUNTIME_ORG;
const credentialId = process.env.ARMADA_RUNTIME_CREDENTIAL_ID;
if (!token || !golden || !org || !credentialId) throw Error("Missing coordinator staging inputs.");

interface TemplateManifest {
  templateId?: string;
  requestKey?: string;
  revision?: number;
  revisionId?: string;
  golden?: { id?: string; orgId?: string; provider?: string };
  account?: { id?: string; version?: number };
  definition?: TemplateDefinition;
  variables?: unknown;
  skillReceipts?: unknown;
  resolvedSkills?: unknown;
}

interface Reply {
  id?: string;
  state?: string;
  manifest?: TemplateManifest;
  envelope?: unknown;
  golden?: { id?: string; orgId?: string; provider?: string };
  provider?: import("../packages/core/src/sandbox-provider.ts").SandboxProviderId;
  runtimeTransport?: "dialout";
  githubReady?: boolean;
  mcpReady?: boolean;
  status?: string;
  statusMessage?: string | null;
  settled?: boolean;
  conversationIds?: string[];
  prompt?: { promptId?: string; state?: string } | null;
  revision?: string;
  configured?: boolean;
  credentialRequests?: number;
  goldens?: { id: string; name: string; provider: string; orgId: string }[];
  modalRuntime?: {
    enabled?: boolean;
    followupVersion?: number;
    idleLaunchVersion?: number;
    emptyResumeVersion?: number;
    idleTemplateVersion?: number;
    resumeVersion?: number;
    mcpVersion?: number;
    skillsVersion?: number;
    variablesVersion?: number;
    usageVersion?: number;
    claudeVersion?: number;
    opencodeVersion?: number;
    opencodeShellProofVersion?: number;
    opencodeMcpProofVersion?: number;
  };
  mcpToolInventory?: { connectionId: string; tools: string[] }[];
  usage?: SandboxUsage;
  skills?: unknown;
  sandbox?: {
    id?: string;
    status?: string;
    conversationIds?: string[];
    goldenId?: string;
    skills?: unknown;
    provider?: string;
    runtimeTransport?: string;
    externalRef?: string;
    templateManifest?: TemplateManifest;
  };
  runtime?: { kind?: string; epoch?: string };
  promptId?: string;
  conversationId?: string;
  requestId?: string;
  resumed?: boolean;
  sourceCheckpoint?: { epoch?: string; watermark?: number; empty?: boolean };
  checkpoint?: { state?: string; watermark?: number; acknowledgedSequence?: number };
  source?: string;
  cursor?: string | null;
  hasMore?: boolean;
  events?: AgentEvent[];
  runtimeFailure?: unknown;
  sandboxes?: {
    id: string;
    status: string;
    provider?: string;
    harness?: string;
    externalRef?: string;
    stoppedAt?: string | null;
  }[];
}
const launchBudgetMs = 600_000;
const launchProvider = "modal";
async function api<T = Reply>(path: string, body: object, timeoutMs = launchBudgetMs): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(`/api/v1/${path}`, origin), {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw Error(`Staging ${path} transport outcome unknown; inspect existing allocations before retrying.`);
  }
  if (!response.ok) throw Error(`Staging ${path} refused (${response.status}); no allocation retry.`);
  try {
    return (await response.json()) as T;
  } catch {
    throw Error(`Staging ${path} returned an invalid receipt; no allocation retry.`);
  }
}
const options = await api("launch/options", {});
if (options.modalRuntime?.enabled !== true || options.modalRuntime.followupVersion !== 1)
  throw Error("Modal dial-out v1 with same-conversation follow-up is unavailable; no launch attempted.");
const ordinaryMode = process.argv.includes("--ordinary");

if (process.argv.includes("--opencode") && process.argv.includes("--claude"))
  throw Error("Select only one harness; no launch attempted.");
const harness = process.argv.includes("--opencode")
  ? "opencode"
  : process.argv.includes("--claude")
    ? "claude"
    : "codex";
if (harness === "opencode") {
  if (options.modalRuntime.opencodeVersion !== 1)
    throw Error("Modal enrolled OpenCode v1 is unavailable; no launch attempted.");
  if (process.argv.includes("--mcp") && options.modalRuntime.opencodeMcpProofVersion !== 1)
    throw Error("OpenCode native MCP proof v1 is unavailable; no launch attempted.");
  if (
    ["--variables", "--github"].some((flag) => process.argv.includes(flag)) &&
    options.modalRuntime.opencodeShellProofVersion !== 1
  )
    throw Error("OpenCode native shell proof v1 is unavailable; no launch attempted.");
}
if (harness === "claude" && options.modalRuntime.claudeVersion !== 1)
  throw Error("Modal enrolled Claude v1 is unavailable; no launch attempted.");
const emptyResumeMode = process.argv.includes("--empty-resume");
if (emptyResumeMode && process.argv.includes("--resume"))
  throw Error("Select one retained activation mode; no launch attempted.");
if (emptyResumeMode && options.modalRuntime.emptyResumeVersion !== 1)
  throw Error("Modal empty-checkpoint resume v1 is unavailable; no launch attempted.");
const idleMode = process.argv.includes("--idle") || emptyResumeMode;
if (idleMode && options.modalRuntime.idleLaunchVersion !== 1)
  throw Error("Modal promptless launch/first-send v1 is unavailable; no launch attempted.");
if (idleMode && process.argv.includes("--variables") && options.modalRuntime.idleTemplateVersion !== 1)
  throw Error("Modal promptless template v1 is unavailable; no launch attempted.");
const resumeMode = process.argv.includes("--resume");
if (resumeMode && options.modalRuntime.resumeVersion !== 1)
  throw Error("Modal retained resume v1 is unavailable; no launch attempted.");
const usageMode = process.argv.includes("--usage");
if (usageMode && options.modalRuntime.usageVersion !== 1)
  throw Error("Modal runtime usage v1 is unavailable; no launch attempted.");
const usageCheck = createRuntimeUsageCheck(credentialId);
let usageProof: ReturnType<typeof usageCheck.verify> | undefined;
const variablesMode = process.argv.includes("--variables");
const templateId = process.env.ARMADA_RUNTIME_TEMPLATE_ID ?? "";
if (
  variablesMode &&
  (options.modalRuntime.variablesVersion !== 1 || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(templateId))
)
  throw Error(
    "Modal readable-variable check requires variables v1 and an existing template UUID; no launch attempted.",
  );
let templateSource:
  | { org: string; revision: number; revisionId: string; goldenId: string; definition: TemplateDefinition }
  | undefined;
let variableKeys: string[] = [];
let expectedVariableDigest: string | undefined;
const skillsMode = process.argv.includes("--skills");
if (skillsMode && options.modalRuntime.skillsVersion !== 1)
  throw Error("Modal runtime skills v1 is unavailable; no launch attempted.");
let defaultPins: string[] = [];
let defaultGoldenId: string | undefined;
const githubMode = process.argv.includes("--github");
const mcpMode = process.argv.includes("--mcp");
const repository = process.env.ARMADA_RUNTIME_GITHUB_REPOSITORY ?? "";
const mcpConnection = (process.env.ARMADA_RUNTIME_MCP_CONNECTION_ID ?? "").toLowerCase();
const mcpTool = process.env.ARMADA_RUNTIME_MCP_TOOL ?? "";
const mcpExpected = process.env.ARMADA_RUNTIME_MCP_EXPECT ?? "";
const mcpArgumentsJson = process.env.ARMADA_RUNTIME_MCP_ARGS_JSON ?? "{}";
let mcpArguments: Record<string, unknown> = {};
if (mcpMode) {
  if (
    options.modalRuntime.mcpVersion !== 2 ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(mcpConnection) ||
    !/^[A-Za-z0-9_.-]{1,64}$/.test(mcpTool) ||
    !mcpExpected ||
    mcpExpected.length > 1024 ||
    Buffer.byteLength(mcpArgumentsJson) > 4096
  )
    throw Error(
      "MCP check requires automatic delivery v2, connection UUID, read-only tool and non-secret JSON arguments/result; no launch attempted.",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(mcpArgumentsJson);
  } catch {
    throw Error("MCP arguments must be valid non-secret JSON; no launch attempted.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw Error("MCP arguments must be a non-secret JSON object; no launch attempted.");
  mcpArguments = parsed as Record<string, unknown>;
}
const mcpServer = `armada_${mcpConnection.replaceAll("-", "_")}`;
const nativeMcpName = `${mcpServer}_${mcpTool.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
let mcpInventoryOrg: string | undefined;
let frozenToolInventory: string[] | undefined;
function checkMcpInventory(reply: Reply) {
  const inventory = reply.mcpToolInventory;
  if (
    !Array.isArray(inventory) ||
    inventory.length !== 1 ||
    inventory[0]?.connectionId !== mcpConnection ||
    !Array.isArray(inventory[0].tools) ||
    inventory[0].tools.length > 10000 ||
    inventory[0].tools.some((name) => typeof name !== "string" || !name || name.length > 512)
  )
    throw Error("Complete authorized OpenCode MCP tool inventory is unavailable.");
  const tools = inventory[0].tools;
  const matches = tools.filter((name) => `${mcpServer}_${name.replace(/[^a-zA-Z0-9_-]/g, "_")}` === nativeMcpName);
  if (matches.length !== 1 || matches[0] !== mcpTool)
    throw Error("OpenCode MCP native tool name is missing or ambiguous; no proof accepted.");
  const ordered = [...tools].sort();
  if (frozenToolInventory && canonical(frozenToolInventory) !== canonical(ordered))
    throw Error("OpenCode MCP tool inventory changed; no proof accepted.");
  frozenToolInventory = ordered;
}
if (githubMode && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
  throw Error("GitHub check requires existing ARMADA_RUNTIME_GITHUB_REPOSITORY=owner/repo; no launch attempted.");
if (githubMode || mcpMode || skillsMode || variablesMode) {
  const choices = (await api("golden/list", { org })).goldens?.filter(
    (row) => row.provider === "modal" && (row.id === golden || row.name === golden),
  );
  if (choices?.length !== 1 || !choices[0])
    throw Error("No unique authorized Modal golden for preflight; no launch attempted.");
  if (variablesMode) {
    const selected = await api<{
      item?: { id?: string; status?: string; orgId?: string };
      revision?: { id?: string; revision?: number; definition?: TemplateDefinition };
    }>("templates/get", { org: choices[0].orgId, id: templateId });
    const revision = selected.revision,
      def = revision?.definition;
    if (
      selected.item?.id !== templateId ||
      selected.item.status !== "active" ||
      selected.item.orgId !== choices[0].orgId ||
      !revision?.id ||
      !Number.isSafeInteger(revision.revision) ||
      (revision.revision ?? 0) < 1 ||
      !def ||
      def.provider !== "modal" ||
      def.harness !== harness ||
      def.goldenId !== choices[0].id ||
      !Array.isArray(def.variables) ||
      !def.variables.length ||
      def.variables.some((binding) => !/^[A-Z_][A-Z0-9_]*$/.test(binding.key)) ||
      (def.secrets !== undefined && (!Array.isArray(def.secrets) || def.secrets.length > 0)) ||
      !Array.isArray(def.skills) ||
      def.skills.length ||
      !def.modelAccount ||
      def.modelAccount.id !== credentialId ||
      !Number.isSafeInteger(def.modelAccount.version) ||
      def.modelAccount.version < 1 ||
      !Array.isArray(def.connections) ||
      canonical([...def.connections].sort()) !== canonical(mcpMode ? [mcpConnection] : []) ||
      (process.env.ARMADA_RUNTIME_MODEL !== undefined && def.model !== process.env.ARMADA_RUNTIME_MODEL)
    )
      throw Error(
        "Existing Modal template is ineligible for the selected golden/account/readable bindings/connections; no launch attempted.",
      );
    variableKeys = def.variables.map((binding) => binding.key).sort();
    if (new Set(variableKeys).size !== variableKeys.length)
      throw Error("Template readable keys are not distinct; no launch attempted.");
    try {
      validateReadableVariables(Object.fromEntries(variableKeys.map((key) => [key, ""])));
    } catch {
      throw Error("Template readable keys are unavailable; no launch attempted.");
    }
    templateSource = {
      org: choices[0].orgId,
      revision: Number(revision.revision),
      revisionId: revision.id,
      goldenId: choices[0].id,
      definition: def,
    };
  }
  if (skillsMode) {
    defaultGoldenId = choices[0].id;
    defaultPins = await readDefaultPins(choices[0].orgId, defaultGoldenId, {
      request: api,
      step: async (_name, action) => action(),
    });
    if (!defaultPins.length)
      throw Error("No default skills configured for the smoke golden/org/user; no launch attempted.");
  }
  if (githubMode) {
    const preflight = await api("sandbox/github-preflight-v1", {
      runtimeVersion: 1,
      org: choices[0].orgId,
      golden: choices[0].name,
      repository,
    });
    if (preflight.githubReady !== true || preflight.provider !== "modal")
      throw Error("Modal GitHub preflight unavailable; no launch attempted.");
  }
  if (mcpMode) {
    const preflight = await api("sandbox/mcp-preflight-v1", {
      runtimeVersion: 1,
      org: choices[0].orgId,
      connections: [mcpConnection],
      ...(harness === "opencode" ? { toolInventory: true } : {}),
    });
    if (preflight.mcpReady !== true) throw Error("Modal MCP preflight refused; no launch attempted.");
    if (harness === "opencode") {
      mcpInventoryOrg = choices[0].orgId;
      checkMcpInventory(preflight);
    }
  }
}
const mcpInstruction = `Call the read-only MCP tool ${mcpTool} on server ${mcpServer} with exactly these non-secret JSON arguments: ${JSON.stringify(mcpArguments)}. Do not substitute a shell or another tool.`;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function exactCommand(command: unknown, expected: string): boolean {
  if (typeof command !== "string") return false;
  const quoted = `"${expected.replace(/["\\$`]/g, "\\$&")}"`;
  return [
    expected,
    ...["/bin/bash", "/usr/bin/bash", "bash", "/bin/sh", "sh"].flatMap((shell) => [
      `${shell} -lc ${shellQuote(expected)}`,
      `${shell} -lc ${quoted}`,
    ]),
  ].includes(command.trim());
}
const variableProgram = `process.stdout.write(require("node:crypto").createHash("sha256").update(JSON.stringify(Object.fromEntries(${JSON.stringify(variableKeys)}.map(k=>[k,process.env[k]??null])))).digest("hex"))`;
const variableCommand = `node -e ${shellQuote(variableProgram)}`;
const variableInstruction = `Run exactly: ${variableCommand} successfully. Do not print environment values or repeat tool output in your final answer.`;
const answer = `ARMADA_MODAL_${crypto.randomUUID().replaceAll("-", "")}`;
const memory = `ARMADA_MEMORY_${crypto.randomUUID().replaceAll("-", "")}`;
let id: string | undefined;
let epoch: string | undefined;
let promptId: string | undefined;
let failure: unknown;
let conversationId: string | undefined;
let followupPromptId: string | undefined;
let checkpointRequestId: string | undefined;
let checkpointReceipt: Reply | undefined;
let shouldStop = false;
let jobAdmission = false;
let initialGitHubRevision: string | undefined;
let launchSkills: unknown;
const verifySkillStatus = async () => {
  if (!skillsMode) return;
  const status = await api("sandbox/status", { id });
  try {
    verifyDefaultReceipts(launchSkills, status.skills, defaultPins);
  } catch {
    throw Error("Modal skill receipts do not match the effective default pins and launch identity.");
  }
};
const verifyUsageStatus = async () => {
  if (usageMode) usageProof = usageCheck.verify((await api("sandbox/status", { id })).usage);
};
const githubToolPrompts = new Set<string>();
const githubInstruction = `Run exactly: gh api repos/${repository} --jq .full_name successfully. After the tool succeeds, reply exactly with the token I originally asked you to remember. Do not change files.`;
const recallInstruction =
  "After the tool succeeds, reply exactly with the token I originally asked you to remember. Do not change files.";
const toolsInstruction = [
  ...(variablesMode ? [variableInstruction] : []),
  ...(mcpMode ? [mcpInstruction] : []),
  ...(githubMode ? [githubInstruction] : [recallInstruction]),
].join(" ");
const configureGitHub = async (expectedEpoch: string) => {
  const receipt = await api("github/refresh", { id });
  if (
    receipt.status !== "connected" ||
    receipt.runtime?.kind !== "armada" ||
    receipt.runtime.epoch !== expectedEpoch ||
    !receipt.revision
  )
    throw Error("GitHub configuration lacks current runtime epoch/revision.");
  return receipt.revision;
};
const verifyGitHub = async (expectedPromptId: string, expectedEpoch: string, revision: string) => {
  const audit = await api("github/runtime-status", { id });
  if (
    !githubToolPrompts.has(expectedPromptId) ||
    audit.configured !== true ||
    audit.runtime?.kind !== "armada" ||
    audit.runtime.epoch !== expectedEpoch ||
    audit.revision !== revision ||
    !Number.isSafeInteger(audit.credentialRequests) ||
    (audit.credentialRequests ?? 0) < 1
  )
    throw Error("Missing archived gh command and current-epoch credential acquisition proof.");
};
const verifyPrompt = async (
  expectedPromptId: string,
  expectedAnswer: string,
  expectedConversationId?: string,
  waitForPublicPrompt = false,
) => {
  let cursor: string | undefined;
  let foundAnswer = false;
  let finished = false;
  let foundMcp = !mcpMode;
  let foundVariables = !variablesMode;
  const claudeCalls = new Map<string, ToolCall>();
  const claudeResults = new Map<string, NonNullable<ToolCall["result"]>>();
  const deadline = Date.now() + 300_000;
  if (waitForPublicPrompt) {
    while (Date.now() < deadline) {
      const turn = await api("sandbox/status", { id, prompt_id: expectedPromptId }, Math.max(1, deadline - Date.now()));
      if (turn.id !== id || turn.prompt?.promptId !== expectedPromptId)
        throw Error("Queued Modal turn does not match its status.");
      if (turn.settled === true) {
        if (turn.prompt.state !== "finished" || !["ready", "running"].includes(turn.status ?? ""))
          throw Error("Queued Modal turn did not finish on an active sandbox.");
        break;
      }
      await Bun.sleep(1000);
    }
  }
  while (
    Date.now() < deadline &&
    (!foundAnswer || !finished || !foundMcp || !foundVariables || (usageMode && !usageCheck.has(expectedPromptId)))
  ) {
    const page = await api(
      "logs/read",
      { id, limit: 1000, ...(cursor ? { cursor } : {}) },
      Math.max(1, deadline - Date.now()),
    );
    if (page.source !== "armada-runtime") throw Error("Modal answer was not read from the common runtime archive.");
    if (page.runtimeFailure) throw Error("Modal enrolled runtime failed; inspect server diagnostics.");
    for (const event of page.events ?? []) {
      if (usageMode) usageCheck.observe(event);
      if (event.promptId !== expectedPromptId) continue;
      if (expectedConversationId && event.kind === "prompt" && event.conversationId !== expectedConversationId)
        throw Error("Admitted Modal prompt archive does not match its conversation.");
      if (harness === "opencode" && mcpMode && event.kind === "other" && event.type === "armada/opencodeMcp") {
        const proof = event.data as Record<string, unknown> | undefined;
        const result = proof?.result as { output?: unknown; isError?: unknown } | undefined;
        if (
          proof?.version === 1 &&
          typeof proof.nativeMessageId === "string" &&
          proof.nativeMessageId &&
          typeof proof.callId === "string" &&
          proof.callId &&
          typeof proof.configurationRevision === "string" &&
          proof.configurationRevision &&
          proof.server === mcpServer &&
          proof.nativeToolName === nativeMcpName &&
          canonical(proof.input) === canonical(mcpArguments) &&
          result?.isError === false &&
          typeof result.output === "string" &&
          result.output.includes(mcpExpected)
        )
          foundMcp = true;
      }
      if (harness === "opencode" && event.kind === "other" && event.type === "armada/opencodeShell") {
        const proof = event.data as Record<string, unknown> | undefined;
        if (
          proof &&
          proof.version === 1 &&
          typeof proof.nativeMessageId === "string" &&
          proof.nativeMessageId &&
          typeof proof.callId === "string" &&
          proof.callId &&
          ["bash", "shell"].includes(String(proof.tool)) &&
          proof.exitCode === 0 &&
          proof.truncated === false &&
          typeof proof.output === "string"
        ) {
          if (
            variablesMode &&
            expectedVariableDigest &&
            exactCommand(proof.command, variableCommand) &&
            proof.output.trim() === expectedVariableDigest
          )
            foundVariables = true;
          if (
            githubMode &&
            exactCommand(proof.command, `gh api repos/${repository} --jq .full_name`) &&
            proof.output.trim().toLowerCase() === repository.toLowerCase()
          )
            githubToolPrompts.add(expectedPromptId);
        }
      }
      if (
        harness !== "opencode" &&
        event.kind === "message" &&
        !event.parentToolUseId &&
        !event.retracted &&
        !event.partial
      ) {
        let tools = event.tools;
        if (harness === "claude") {
          for (const tool of tools) {
            if (event.responseKind === "tool_result" && tool.name === "tool_result" && tool.result)
              claudeResults.set(tool.id, tool.result);
            else if (event.responseKind !== "tool_result") claudeCalls.set(tool.id, tool);
          }
          // Claude archives the assistant use and user result separately. Join only
          // within this prompt and by the exact tool-use ID, including across pages.
          tools = [...claudeCalls.values()].flatMap((tool) => {
            const result = claudeResults.get(tool.id);
            return result ? [{ ...tool, result }] : [];
          });
        }
        for (const tool of tools) {
          const output = tool.result?.output;
          const text =
            typeof output === "string"
              ? output
              : Array.isArray(output) &&
                  output.every((block) => block?.type === "text" && typeof block.text === "string")
                ? output.map((block) => block.text).join("\n")
                : undefined;
          if (
            mcpMode &&
            (harness === "claude"
              ? tool.name === `mcp__${mcpServer}__${mcpTool}`
              : tool.server === mcpServer && tool.name === mcpTool) &&
            canonical(tool.input) === canonical(mcpArguments) &&
            tool.result?.isError === false &&
            JSON.stringify(output)?.includes(mcpExpected)
          )
            foundMcp = true;
          const shell = tool.name === (harness === "claude" ? "Bash" : "commandExecution");
          const command = (tool.input as { command?: unknown } | undefined)?.command;
          if (
            variablesMode &&
            shell &&
            exactCommand(command, variableCommand) &&
            tool.result?.isError === false &&
            expectedVariableDigest &&
            text?.trim() === expectedVariableDigest
          )
            foundVariables = true;
          if (
            githubMode &&
            shell &&
            exactCommand(command, `gh api repos/${repository} --jq .full_name`) &&
            tool.result?.isError === false &&
            text?.trim().toLowerCase() === repository.toLowerCase()
          )
            githubToolPrompts.add(expectedPromptId);
        }
      }
      if (
        event.kind === "message" &&
        event.partial === false &&
        event.responseKind !== "tool_result" &&
        !event.parentToolUseId &&
        !event.retracted &&
        event.text.trim() === expectedAnswer
      )
        foundAnswer = true;
      if (event.kind === "prompt" && event.status === "finished") finished = true;
      if (event.kind === "prompt" && ["failed", "interrupted"].includes(event.status))
        throw Error("Modal runtime prompt did not finish successfully.");
    }
    cursor = page.cursor ?? cursor;
    if (foundAnswer && finished && (!foundMcp || !foundVariables))
      throw Error("Missing this prompt's archived MCP or exact readable-environment command/result proof.");
    if (!foundAnswer || !finished || !foundMcp || !foundVariables || (usageMode && !usageCheck.has(expectedPromptId)))
      await Bun.sleep(1000);
  }
  if (!foundAnswer || !finished || !foundMcp || !foundVariables || (usageMode && !usageCheck.has(expectedPromptId)))
    throw Error(
      "Timed out waiting for this Modal prompt's archived answer, tool proof, harness usage and finished event.",
    );
  if (harness === "opencode" && mcpMode) {
    const inventory = await api("sandbox/mcp-preflight-v1", {
      runtimeVersion: 1,
      org: mcpInventoryOrg,
      connections: [mcpConnection],
      toolInventory: true,
    });
    if (inventory.mcpReady !== true) throw Error("OpenCode MCP authorization changed; no proof accepted.");
    checkMcpInventory(inventory);
  }
  await verifyUsageStatus();
};

function validateCheckpoint(
  receipt: Reply,
  expectedEpoch: string | undefined,
  requestId: string,
  watermark?: number,
): asserts receipt is Reply & {
  runtime: { kind: "armada"; epoch: string };
  checkpoint: { state: "complete"; watermark: number; acknowledgedSequence: number };
} {
  const proof = receipt.checkpoint;
  if (
    receipt.requestId !== requestId ||
    receipt.runtime?.kind !== "armada" ||
    !/^[1-9][0-9]{0,18}$/.test(receipt.runtime.epoch ?? "") ||
    (expectedEpoch !== undefined && receipt.runtime.epoch !== expectedEpoch) ||
    proof?.state !== "complete" ||
    !Number.isSafeInteger(proof.watermark) ||
    (proof.watermark ?? -1) < 0 ||
    proof.acknowledgedSequence !== proof.watermark ||
    (watermark !== undefined && proof.watermark !== watermark)
  )
    throw Error("Modal checkpoint lacks the current epoch and durable journal ACK.");
}
const checkpoint = async (expectedEpoch: string | undefined) => {
  const requestId = crypto.randomUUID();
  console.log(JSON.stringify({ operation: "runtime_checkpoint", sandboxId: id, requestId }));
  const receipt = await api("sandbox/checkpoint-runtime-v1", { id, runtimeVersion: 1, request_id: requestId });
  validateCheckpoint(receipt, expectedEpoch, requestId);
  return { requestId, receipt };
};
function acceptsFollowup(receipt: Reply, requestId: string, expectedEpoch: string | undefined) {
  if (receipt.requestId !== requestId || receipt.conversationId !== conversationId) return false;
  if (jobAdmission && receipt.status === "queued") return receipt.id === id && receipt.promptId === requestId;
  return (
    receipt.runtime?.kind === "armada" &&
    /^[1-9][0-9]{0,18}$/.test(receipt.runtime.epoch ?? "") &&
    (expectedEpoch === undefined || receipt.runtime.epoch === expectedEpoch)
  );
}
const terminalLaunchStates = ["failed", "stopped", "stopping", "deleted"];

async function correlateAdmittedLaunch(sandboxId: string, externalRef: string, timeoutMs: number) {
  const listed = await api(
    "sandbox/list",
    {
      owner: "me",
      org: templateSource?.org ?? org,
      externalRef,
      golden: templateSource?.goldenId ?? defaultGoldenId,
    },
    timeoutMs,
  );
  const row = listed.sandboxes?.[0];
  if (
    listed.sandboxes?.length !== 1 ||
    row?.id !== sandboxId ||
    row.provider !== launchProvider ||
    row.harness !== harness ||
    row.externalRef !== externalRef
  )
    throw Error("Admitted Modal sandbox does not match the owner inventory.");
  return row;
}

async function observeAdmittedLaunch(sandboxId: string, deadline: number) {
  const remaining = () => Math.max(1, deadline - Date.now());
  while (Date.now() < deadline) {
    const current = await api("sandbox/status", { id: sandboxId }, remaining());
    if (current.id !== sandboxId) throw Error("Admitted Modal status does not match the sandbox.");
    if (terminalLaunchStates.includes(current.status ?? "") || (current.settled === true && current.statusMessage))
      throw Error("Admitted Modal launch or initial turn failed.");
    if (idleMode && current.settled === true && current.status === "ready" && current.statusMessage === null) {
      if (current.prompt !== null || !Array.isArray(current.conversationIds) || current.conversationIds.length)
        throw Error("Admitted promptless Modal sandbox is not empty.");
      return { skills: current.skills };
    }
    const turn = current.prompt;
    if (!idleMode && current.settled === true && turn) {
      const conversation = current.conversationIds?.[0];
      if (
        !["ready", "running"].includes(current.status ?? "") ||
        turn.state !== "finished" ||
        typeof turn.promptId !== "string" ||
        !turn.promptId ||
        current.conversationIds?.length !== 1 ||
        typeof conversation !== "string" ||
        !conversation
      )
        throw Error("Admitted Modal initial turn did not finish with a verified conversation.");
      return { promptId: turn.promptId, conversationId: conversation, skills: current.skills };
    }
    if (Date.now() < deadline) await Bun.sleep(1000);
  }
  throw Error("Timed out waiting for the admitted Modal launch setup or initial turn.");
}
try {
  const launchRef = crypto.randomUUID();
  const ordinaryTemplate = Boolean(templateSource && ordinaryMode);
  if (templateSource)
    console.log(
      JSON.stringify({
        operation: "runtime_template_launch",
        templateId,
        revision: templateSource.revision,
        externalRef: launchRef,
        ...(ordinaryTemplate ? { requestKey: launchRef } : { idempotencyKey: launchRef }),
      }),
    );
  const initialPrompt =
    mcpMode || variablesMode
      ? `Remember token ${memory}. ${[...(variablesMode ? [variableInstruction] : []), ...(mcpMode ? [mcpInstruction] : [])].join(" ")} After it succeeds, reply exactly ${answer}. Do not change files.`
      : `Remember token ${memory}. Reply exactly ${answer}. Do not use tools or change files.`;
  const route = ordinaryTemplate ? "templates/launch" : "sandbox/launch";
  if (!templateSource) console.log(JSON.stringify({ operation: "runtime_launch", externalRef: launchRef }));
  const raw = await api(route, {
    ...(!ordinaryMode
      ? { runtimeVersion: 1, runtimeTransport: "dialout", provider: launchProvider, harness }
      : templateSource
        ? {}
        : { provider: launchProvider, harness }),
    ...(templateSource
      ? {
          org: templateSource.org,
          id: templateId,
          revision: templateSource.revision,
          externalRef: launchRef,
          ...(ordinaryTemplate ? { requestKey: launchRef } : { idempotencyKey: launchRef }),
        }
      : {
          org,
          golden,
          credentialId,
          externalRef: launchRef,
          ...(process.env.ARMADA_RUNTIME_MODEL ? { model: process.env.ARMADA_RUNTIME_MODEL } : {}),
          connections: mcpMode ? [mcpConnection] : [],
        }),
    ...(!skillsMode ? { skills: [], skipSkillDefaults: true } : {}),
    ttlSeconds: 900,
    ...(!idleMode ? { prompt: initialPrompt } : {}),
  });
  const launched: Reply =
    ordinaryTemplate && templateSource
      ? {
          ...raw,
          sandbox: {
            ...(raw.id ? { id: raw.id } : {}),
            goldenId: templateSource.goldenId,
            provider: "modal",
            ...(raw.runtimeTransport ? { runtimeTransport: raw.runtimeTransport } : {}),
            ...(raw.status ? { status: raw.status } : {}),
            skills: raw.manifest?.skillReceipts,
          },
        }
      : raw;
  const explicitPinnedAdmission = templateSource && !ordinaryTemplate ? parseExplicitPinnedAdmission(raw) : undefined;
  const admission =
    explicitPinnedAdmission ??
    parseLaunchAdmissionReceipt(launchProvider, ordinaryTemplate ? raw.envelope : templateSource ? undefined : raw);
  let queuedFirstTurn = false;
  if (
    ordinaryTemplate &&
    raw.envelope !== undefined &&
    (!admission ||
      raw.provider !== launchProvider ||
      raw.state !== "succeeded" ||
      raw.manifest?.requestKey !== launchRef ||
      raw.id !== admission.sandbox.id)
  )
    throw Error("Modal template admission does not match its recorded request.");
  const observationDeadline = Date.now() + launchBudgetMs;
  const correlate = async (sandboxId: string) => {
    const row = await correlateAdmittedLaunch(sandboxId, launchRef, Math.max(1, observationDeadline - Date.now()));
    shouldStop = true;
    if (terminalLaunchStates.includes(row.status))
      throw Error("Admitted Modal sandbox entered a terminal lifecycle state.");
  };
  if (admission) {
    jobAdmission = true;
    id = admission.sandbox.id;
    shouldStop = !explicitPinnedAdmission;
    if (ordinaryTemplate && (raw.status !== admission.sandbox.status || admission.sandbox.status !== "starting"))
      throw Error("Modal template admission has inconsistent starting status.");
    if (explicitPinnedAdmission) await correlate(id);
  } else {
    if (launched.sandbox?.provider !== "modal")
      throw Error("Missing Modal enrolled launch acknowledgement; reconcile existing allocation, never launch again.");
    if (templateSource && !ordinaryTemplate && launched.sandbox.externalRef !== launchRef)
      throw Error("Pinned Modal launch response does not match its reference; inspect the original allocation.");
    id = launched.sandbox.id;
    shouldStop = Boolean(id);
  }
  if (templateSource) {
    const m = ordinaryTemplate
      ? raw.manifest
      : explicitPinnedAdmission
        ? explicitPinnedAdmission.templateManifest
        : raw.sandbox?.templateManifest;
    const selectedGolden = ordinaryTemplate || explicitPinnedAdmission ? m?.golden : raw.golden;
    if (
      !id ||
      (ordinaryTemplate && (raw.state !== "succeeded" || raw.provider !== "modal" || m?.requestKey !== launchRef)) ||
      !m ||
      m.templateId !== templateId ||
      m.revision !== templateSource.revision ||
      m.revisionId !== templateSource.revisionId ||
      selectedGolden?.id !== templateSource.goldenId ||
      selectedGolden.orgId !== templateSource.org ||
      selectedGolden.provider !== "modal" ||
      m.account?.id !== templateSource.definition.modelAccount?.id ||
      m.account?.version !== templateSource.definition.modelAccount?.version ||
      canonical(m.definition) !== canonical(templateSource.definition)
    )
      throw Error(
        "Modal template launch manifest identity is unavailable; cleanup the known allocation, never launch again.",
      );
    if (explicitPinnedAdmission && canonical(m.resolvedSkills) !== canonical(defaultPins))
      throw Error("Modal frozen skill pins differ from the selected launch policy; no allocation retry.");
    let values: Record<string, string>;
    try {
      values = validateReadableVariables(m.variables);
    } catch {
      throw Error("Modal frozen readable manifest is invalid; no allocation retry.");
    }
    if (canonical(Object.keys(values).sort()) !== canonical(variableKeys))
      throw Error("Modal frozen readable keyset differs from the pinned template; no allocation retry.");
    expectedVariableDigest = createHash("sha256")
      .update(JSON.stringify(Object.fromEntries(variableKeys.map((key) => [key, values[key]]))))
      .digest("hex");
  }
  if (admission) {
    if (!explicitPinnedAdmission) await correlate(admission.sandbox.id);
    const turn = await observeAdmittedLaunch(admission.sandbox.id, observationDeadline);
    ({ promptId, conversationId, skills: launchSkills } = turn);
  } else {
    if (!launched.sandbox) throw Error("Missing Modal launch sandbox.");
    conversationId = launched.conversationId ?? undefined;
    epoch = launched.runtime?.epoch;
    promptId = launched.promptId ?? undefined;
    if (
      !id ||
      launched.sandbox.runtimeTransport !== "dialout" ||
      launched.runtime?.kind !== "armada" ||
      !/^[1-9][0-9]{0,18}$/.test(epoch ?? "") ||
      (!idleMode && (!promptId || !launched.conversationId))
    )
      throw Error("Missing Modal enrolled launch acknowledgement; reconcile existing allocation, never launch again.");
    if (skillsMode && launched.sandbox.goldenId !== defaultGoldenId)
      throw Error("Modal launch selected a different golden than the default-skill policy; no retry.");
    launchSkills = launched.sandbox.skills;
    if (idleMode && templateSource) {
      const current = await api("sandbox/status", { id });
      if (
        launched.sandbox.status !== "ready" ||
        current.id !== id ||
        current.status !== "ready" ||
        !Array.isArray(current.conversationIds) ||
        current.conversationIds.length ||
        current.prompt !== null
      )
        throw Error("Promptless template current status is not empty and ready; no first send attempted.");
      // Status evidence comes from the actual sandbox, never a synthesized empty list.
      launched.sandbox.status = current.status;
      launched.sandbox.conversationIds = current.conversationIds;
    }
  }
  if (idleMode) {
    if (
      !admission &&
      (launched.sandbox?.status !== "ready" ||
        !Array.isArray(launched.sandbox.conversationIds) ||
        launched.sandbox.conversationIds.length ||
        promptId !== undefined ||
        conversationId !== undefined)
    )
      throw Error("Idle Modal launch did not publish an empty ready sandbox.");
    const history = await api("logs/read", { id, limit: 1000 });
    if (
      history.source !== "armada-runtime" ||
      history.hasMore !== false ||
      history.runtimeFailure ||
      !Array.isArray(history.events) ||
      history.events.some((event) => event.kind === "prompt" || event.kind === "message")
    )
      throw Error("Idle archive already contains inference or lacks complete common-runtime provenance.");
    let emptySource: { epoch: string; watermark: number; file: string; nonce: string } | undefined;
    if (emptyResumeMode) {
      const file = `/home/user/.retained-${crypto.randomUUID()}`,
        nonce = `EMPTY_${crypto.randomUUID().replaceAll("-", "")}`;
      const written = await api<{ exitCode?: number; stdout?: string; timedOut?: boolean; truncated?: boolean }>(
        "sandbox/exec",
        { id, command: `printf %s ${shellQuote(nonce)} > ${shellQuote(file)}` },
      );
      if (written.exitCode !== 0 || written.stdout !== "" || written.timedOut !== false || written.truncated !== false)
        throw Error("Empty checkpoint file witness could not be written.");
      const sealed = await checkpoint(epoch);
      const sourceEpoch = sealed.receipt.runtime.epoch;
      await stopKnown(true);
      const stopped = await api("sandbox/checkpoint-runtime-v1", {
        id,
        runtimeVersion: 1,
        request_id: sealed.requestId,
      });
      validateCheckpoint(stopped, sourceEpoch, sealed.requestId, sealed.receipt.checkpoint?.watermark);
      const history = await api("logs/read", { id, limit: 1000 });
      if (
        history.source !== "armada-runtime" ||
        history.hasMore !== false ||
        history.runtimeFailure ||
        !Array.isArray(history.events) ||
        history.events.some((event) => event.kind === "prompt" || event.kind === "message")
      )
        throw Error("Stopped empty checkpoint contains inference or lost complete archive provenance.");
      emptySource = { epoch: sourceEpoch, watermark: sealed.receipt.checkpoint.watermark, file, nonce };
      shouldStop = true; // The known sandbox may activate even if its first-send response is lost.
    }
    const firstRequestId = crypto.randomUUID();
    console.log(JSON.stringify({ operation: "runtime_first_send", sandboxId: id, requestId: firstRequestId }));
    const first = await api(admission && emptySource ? "sandbox/resume-runtime-v1" : "sandbox/send", {
      id,
      request_id: firstRequestId,
      prompt: initialPrompt,
      ...(admission && emptySource ? { runtimeVersion: 1 } : {}),
    });
    queuedFirstTurn = jobAdmission && !emptySource && first.status === "queued";
    const firstEpoch = first.runtime?.epoch;
    const expectedEpoch = emptySource ? String(BigInt(emptySource.epoch) + 1n) : epoch;
    const validDispatch = queuedFirstTurn
      ? first.id === id && first.promptId === firstRequestId
      : first.runtime?.kind === "armada" &&
        /^[1-9][0-9]{0,18}$/.test(firstEpoch ?? "") &&
        (expectedEpoch === undefined || firstEpoch === expectedEpoch);
    if (
      first.requestId !== firstRequestId ||
      !validDispatch ||
      (jobAdmission && (first.id !== id || first.conversationId !== `first_${firstRequestId}`)) ||
      typeof first.promptId !== "string" ||
      !first.promptId ||
      typeof first.conversationId !== "string" ||
      !first.conversationId
    )
      throw Error(
        "Missing current-epoch first-send acknowledgement; reconcile the same request identity, never resend.",
      );
    if (emptySource) {
      if (
        first.resumed !== true ||
        first.sourceCheckpoint?.empty !== true ||
        first.sourceCheckpoint.epoch !== emptySource.epoch ||
        first.sourceCheckpoint.watermark !== emptySource.watermark
      )
        throw Error("Missing verified empty-checkpoint resume receipt; never retry activation.");
      const read = await api<{ exitCode?: number; stdout?: string; timedOut?: boolean; truncated?: boolean }>(
        "sandbox/exec",
        { id, command: `cat ${shellQuote(emptySource.file)} && rm ${shellQuote(emptySource.file)}` },
      );
      if (
        read.exitCode !== 0 ||
        read.stdout !== emptySource.nonce ||
        read.timedOut !== false ||
        read.truncated !== false
      )
        throw Error("Empty checkpoint did not preserve the file witness.");
    }
    epoch = firstEpoch;
    promptId = first.promptId;
    conversationId = first.conversationId;
  }
  if (!promptId || !conversationId) throw Error("Missing admitted initial Modal conversation.");
  await verifySkillStatus();
  await verifyPrompt(promptId, answer, admission ? conversationId : undefined, queuedFirstTurn);
  if (admission && githubMode) {
    const current = await api("github/runtime-status", { id });
    if (
      current.id !== id ||
      current.runtime?.kind !== "armada" ||
      !/^[1-9][0-9]{0,18}$/.test(current.runtime.epoch ?? "")
    )
      throw Error("Admitted Modal sandbox has no verified GitHub runtime epoch.");
    epoch = current.runtime.epoch;
  }
  initialGitHubRevision = githubMode ? await configureGitHub(epoch ?? "") : undefined;
  const followupRequestId = crypto.randomUUID();
  console.log(
    JSON.stringify({
      operation: "runtime_followup",
      sandboxId: id,
      conversationId,
      requestId: followupRequestId,
    }),
  );
  const followed = await api("sandbox/send", {
    id,
    prompt:
      githubMode || mcpMode || variablesMode
        ? toolsInstruction
        : "Reply exactly with the token I originally asked you to remember. Do not use tools or change files.",
    request_id: followupRequestId,
  });
  if (!acceptsFollowup(followed, followupRequestId, epoch) || !followed.promptId || followed.promptId === promptId)
    throw Error(
      "Missing same-conversation/current-epoch Modal follow-up acknowledgement; reconcile request_id, never send again.",
    );
  epoch ??= followed.runtime?.epoch;
  await verifyPrompt(
    followed.promptId,
    memory,
    jobAdmission ? conversationId : undefined,
    jobAdmission && followed.status === "queued",
  );
  if (initialGitHubRevision) await verifyGitHub(followed.promptId, epoch ?? "", initialGitHubRevision);
  followupPromptId = followed.promptId;
  const firstCheckpoint = await checkpoint(epoch);
  epoch ??= firstCheckpoint.receipt.runtime?.epoch;
  checkpointRequestId = firstCheckpoint.requestId;
  checkpointReceipt = firstCheckpoint.receipt;
  console.log(
    JSON.stringify({
      sandboxId: id,
      promptId,
      followupPromptId: followed.promptId,
      conversationId,
      followup: "verified",
      epoch,
      source: "armada-runtime",
      answer: "verified",
      ...(ordinaryMode ? { ordinaryDefault: "verified" } : {}),
      ...(idleMode ? { idleFirstSend: "verified" } : {}),
      ...(emptyResumeMode ? { emptyResume: "verified", retainedFile: "verified" } : {}),
      checkpoint: "verified",
      ...(githubMode ? { github: "verified" } : {}),
      ...(mcpMode ? { mcp: "verified" } : {}),
      ...(skillsMode ? { skills: "verified" } : {}),
      ...(variablesMode ? { variables: "verified" } : {}),
      ...(usageMode ? { usage: "verified", usageProof } : {}),
    }),
  );
} catch (error) {
  failure = error;
}
async function stopKnown(requireRetained = false) {
  if (id && shouldStop) {
    shouldStop = false; // Dispatch once even when its transport outcome is unknown.
    try {
      await api("sandbox/stop", { id }); // Exactly one stop dispatch, including inference/checkpoint failure.
      let stopped = false;
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline && !stopped) {
        const listed = await api("sandbox/list", { owner: "me", org: templateSource?.org ?? org, limit: 200 });
        stopped =
          listed.sandboxes?.some(
            (row) =>
              row.id === id &&
              (row.status === "stopped" ||
                (!requireRetained &&
                  row.status === "failed" &&
                  typeof row.stoppedAt === "string" &&
                  Number.isFinite(Date.parse(row.stoppedAt)))),
          ) === true;
        if (!stopped) await Bun.sleep(1000);
      }
      if (!stopped) throw Error(`Stop unconfirmed for ${id}; coordinator must inspect it, never launch again.`);
      console.log("Modal runtime compute stopped; no resume is claimed by this stop alone.");
    } catch {
      // Cleanup uncertainty is never hidden behind an earlier inference failure.
      throw Error(`Modal cleanup unconfirmed for ${id}; coordinator must inspect it, never launch again.`);
    }
    if (!jobAdmission || !failure || launchSkills !== undefined) await verifySkillStatus();
    if (!failure && usageProof) await verifyUsageStatus();
  }
}
try {
  await stopKnown();
} catch (error) {
  failure = error;
}
if (
  resumeMode &&
  !failure &&
  id &&
  epoch &&
  promptId &&
  followupPromptId &&
  conversationId &&
  checkpointReceipt &&
  checkpointRequestId
) {
  const sourceEpoch = epoch;
  const sourceWatermark = checkpointReceipt.checkpoint?.watermark ?? -1;
  let resumedReceipt: Reply | undefined;
  try {
    const stoppedCheckpoint = await api("sandbox/checkpoint-runtime-v1", {
      id,
      runtimeVersion: 1,
      request_id: checkpointRequestId,
    });
    validateCheckpoint(stoppedCheckpoint, sourceEpoch, checkpointRequestId, sourceWatermark);
    await verifyPrompt(promptId, answer);
    await verifyPrompt(followupPromptId, memory);
    const requestId = crypto.randomUUID();
    console.log(JSON.stringify({ operation: "runtime_resume", sandboxId: id, conversationId, requestId }));
    shouldStop = true; // The known sandbox may activate even if the response is lost.
    const resumed = await api("sandbox/resume-runtime-v1", {
      id,
      runtimeVersion: 1,
      request_id: requestId,
      prompt:
        mcpMode || variablesMode
          ? `${[...(variablesMode ? [variableInstruction] : []), ...(mcpMode ? [mcpInstruction] : [])].join(" ")} ${recallInstruction}`
          : "Again reply exactly with the token I originally asked you to remember. Do not use tools or change files.",
    });
    if (
      resumed.requestId !== requestId ||
      resumed.resumed !== true ||
      resumed.conversationId !== conversationId ||
      !resumed.promptId ||
      [promptId, followupPromptId].includes(resumed.promptId) ||
      resumed.runtime?.kind !== "armada" ||
      !/^[1-9][0-9]{0,18}$/.test(resumed.runtime.epoch ?? "") ||
      BigInt(resumed.runtime.epoch ?? "0") !== BigInt(sourceEpoch) + 1n ||
      resumed.sourceCheckpoint?.epoch !== sourceEpoch ||
      resumed.sourceCheckpoint.watermark !== sourceWatermark ||
      resumed.sourceCheckpoint.empty === true
    )
      throw Error(
        "Modal resume lacks same-conversation/new-epoch/restored-checkpoint acknowledgement; reconcile request_id, never activate again.",
      );
    await verifySkillStatus();
    await verifyPrompt(resumed.promptId, memory);
    await verifyPrompt(promptId, answer);
    await verifyPrompt(followupPromptId, memory);
    if (githubMode) {
      const currentEpoch = resumed.runtime.epoch ?? "";
      const before = await api("github/runtime-status", { id });
      if (
        before.runtime?.kind !== "armada" ||
        before.runtime.epoch !== currentEpoch ||
        typeof before.configured !== "boolean" ||
        (before.configured &&
          (typeof before.revision !== "string" || !before.revision || before.revision === initialGitHubRevision))
      )
        throw Error("GitHub configuration is stale or lacks current-epoch revision proof.");
      const revision = await configureGitHub(currentEpoch);
      if (revision === initialGitHubRevision) throw Error("Resume reused the previous GitHub revision.");
      const requestId = crypto.randomUUID();
      console.log(JSON.stringify({ operation: "runtime_github_followup", sandboxId: id, conversationId, requestId }));
      const sent = await api("sandbox/send", {
        id,
        request_id: requestId,
        prompt: toolsInstruction,
      });
      if (
        !acceptsFollowup(sent, requestId, currentEpoch) ||
        !sent.promptId ||
        [promptId, followupPromptId, resumed.promptId].includes(sent.promptId)
      )
        throw Error("Missing current-epoch GitHub follow-up acknowledgement.");
      await verifyPrompt(
        sent.promptId,
        memory,
        jobAdmission ? conversationId : undefined,
        jobAdmission && sent.status === "queued",
      );
      await verifyGitHub(sent.promptId, currentEpoch, revision);
    }
    await checkpoint(resumed.runtime.epoch ?? "");
    resumedReceipt = resumed;
  } catch (error) {
    failure ??= error;
  }
  try {
    await stopKnown();
  } catch (error) {
    failure = error;
  }
  if (!failure && resumedReceipt)
    console.log(
      JSON.stringify({
        sandboxId: id,
        conversationId,
        promptId: resumedReceipt.promptId,
        previousEpoch: sourceEpoch,
        epoch: resumedReceipt.runtime?.epoch,
        source: "armada-runtime",
        resume: "verified",
        ...(githubMode ? { githubAfterResume: "verified" } : {}),
        ...(mcpMode ? { mcpAfterResume: "verified" } : {}),
        ...(skillsMode ? { skillsAfterResume: "verified" } : {}),
        ...(variablesMode ? { variablesAfterResume: "verified" } : {}),
        ...(usageMode ? { usageAfterResume: "verified", usageProof, costAfterResume: usageProof?.cost.status } : {}),
      }),
    );
}
if (failure) throw failure;
