/** Coordinator-only staging check: exactly one Modal allocation, never retried. */
import { createHash } from "node:crypto";
import type { AgentEvent, ToolCall } from "../packages/core/src/provider.ts";
import { validateReadableVariables } from "../packages/core/src/readable-variables.ts";
import type { SandboxUsage } from "../packages/core/src/sandbox-usage.ts";
import { shellQuote } from "../packages/core/src/shell-quote.ts";
import type { TemplateDefinition } from "../packages/core/src/templates.ts";
import { readDefaultPins, verifyDefaultReceipts } from "./default-skill-smoke.ts";
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

interface Reply {
  id?: string;
  state?: string;
  manifest?: {
    templateId?: string;
    requestKey?: string;
    revision?: number;
    revisionId?: string;
    golden?: { id?: string; orgId?: string; provider?: string };
    account?: { id?: string; version?: number };
    definition?: TemplateDefinition;
    variables?: unknown;
    skillReceipts?: unknown;
  };
  provider?: import("../packages/core/src/sandbox-provider.ts").SandboxProviderId;
  githubReady?: boolean;
  mcpReady?: boolean;
  status?: string;
  revision?: string;
  configured?: boolean;
  credentialRequests?: number;
  goldens?: { id: string; name: string; provider: string; orgId: string }[];
  modalRuntime?: {
    version?: number;
    enabled?: boolean;
    followupVersion?: number;
    idleLaunchVersion?: number;
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
  };
  runtime?: { kind?: string; epoch?: string };
  promptId?: string;
  conversationId?: string;
  requestId?: string;
  resumed?: boolean;
  sourceCheckpoint?: { epoch?: string; watermark?: number };
  checkpoint?: { state?: string; watermark?: number; acknowledgedSequence?: number };
  source?: string;
  cursor?: string | null;
  events?: AgentEvent[];
  runtimeFailure?: unknown;
  sandboxes?: { id: string; status: string; stoppedAt?: string | null }[];
}
async function api<T = Reply>(path: string, body: object): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(`/api/v1/${path}`, origin), {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600000),
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
if (
  options.modalRuntime?.version !== 1 ||
  options.modalRuntime.enabled !== true ||
  options.modalRuntime.followupVersion !== 1
)
  throw Error("Modal dial-out v1 with same-conversation follow-up is unavailable; no launch attempted.");
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
const idleMode = process.argv.includes("--idle");
if (idleMode && options.modalRuntime.idleLaunchVersion !== 1)
  throw Error("Modal promptless launch/first-send v1 is unavailable; no launch attempted.");
if (idleMode && process.argv.includes("--variables"))
  throw Error("Idle smoke currently requires a direct golden, not a template; no launch attempted.");
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
const verifyPrompt = async (expectedPromptId: string, expectedAnswer: string) => {
  let cursor: string | undefined;
  let foundAnswer = false;
  let finished = false;
  let foundMcp = !mcpMode;
  let foundVariables = !variablesMode;
  const claudeCalls = new Map<string, ToolCall>();
  const claudeResults = new Map<string, NonNullable<ToolCall["result"]>>();
  const deadline = Date.now() + 300000;
  while (
    Date.now() < deadline &&
    (!foundAnswer || !finished || !foundMcp || !foundVariables || (usageMode && !usageCheck.has(expectedPromptId)))
  ) {
    const page = await api("logs/read", { id, limit: 1000, ...(cursor ? { cursor } : {}) });
    if (page.source !== "armada-runtime") throw Error("Modal answer was not read from the common runtime archive.");
    if (page.runtimeFailure) throw Error("Modal enrolled runtime failed; inspect server diagnostics.");
    for (const event of page.events ?? []) {
      if (usageMode) usageCheck.observe(event);
      if (event.promptId !== expectedPromptId) continue;
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

const validateCheckpoint = (receipt: Reply, expectedEpoch: string, requestId: string, watermark?: number) => {
  const proof = receipt.checkpoint;
  if (
    receipt.requestId !== requestId ||
    receipt.runtime?.kind !== "armada" ||
    receipt.runtime.epoch !== expectedEpoch ||
    proof?.state !== "complete" ||
    !Number.isSafeInteger(proof.watermark) ||
    (proof.watermark ?? -1) < 0 ||
    proof.acknowledgedSequence !== proof.watermark ||
    (watermark !== undefined && proof.watermark !== watermark)
  )
    throw Error("Modal checkpoint lacks the current epoch and durable journal ACK.");
};
const checkpoint = async (expectedEpoch: string) => {
  const requestId = crypto.randomUUID();
  console.log(JSON.stringify({ operation: "runtime_checkpoint", sandboxId: id, requestId }));
  const receipt = await api("sandbox/checkpoint-runtime-v1", { id, runtimeVersion: 1, request_id: requestId });
  validateCheckpoint(receipt, expectedEpoch, requestId);
  return { requestId, receipt };
};
try {
  const templateRequestKey = templateSource ? crypto.randomUUID() : undefined;
  if (templateSource)
    console.log(
      JSON.stringify({
        operation: "runtime_template_launch",
        templateId,
        revision: templateSource.revision,
        requestKey: templateRequestKey,
      }),
    );
  const initialPrompt =
    mcpMode || variablesMode
      ? `Remember token ${memory}. ${[...(variablesMode ? [variableInstruction] : []), ...(mcpMode ? [mcpInstruction] : [])].join(" ")} After it succeeds, reply exactly ${answer}. Do not change files.`
      : `Remember token ${memory}. Reply exactly ${answer}. Do not use tools or change files.`;
  const raw = await api("sandbox/launch-modal-runtime-v1", {
    runtimeVersion: 1,
    runtimeTransport: "dialout",
    provider: "modal",
    harness,
    ...(templateSource
      ? { org: templateSource.org, id: templateId, revision: templateSource.revision, requestKey: templateRequestKey }
      : {
          org,
          golden,
          credentialId,
          ...(process.env.ARMADA_RUNTIME_MODEL ? { model: process.env.ARMADA_RUNTIME_MODEL } : {}),
          connections: mcpMode ? [mcpConnection] : [],
        }),
    ...(!skillsMode ? { skills: [], skipSkillDefaults: true } : {}),
    ttlSeconds: 900,
    ...(!idleMode ? { prompt: initialPrompt } : {}),
  });
  id = templateSource ? raw.id : raw.sandbox?.id;
  shouldStop = Boolean(id);
  if (templateSource) {
    const m = raw.manifest;
    if (
      raw.state !== "succeeded" ||
      !id ||
      raw.provider !== "modal" ||
      !m ||
      m.templateId !== templateId ||
      m.requestKey !== templateRequestKey ||
      m.revision !== templateSource.revision ||
      m.revisionId !== templateSource.revisionId ||
      m.golden?.id !== templateSource.goldenId ||
      m.golden.orgId !== templateSource.org ||
      m.golden.provider !== "modal" ||
      m.account?.id !== templateSource.definition.modelAccount?.id ||
      m.account?.version !== templateSource.definition.modelAccount?.version ||
      canonical(m.definition) !== canonical(templateSource.definition)
    )
      throw Error(
        "Modal template launch manifest identity is unavailable; cleanup the known allocation, never launch again.",
      );
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
  const launched: Reply = templateSource
    ? {
        ...raw,
        sandbox: {
          ...(id ? { id } : {}),
          goldenId: templateSource.goldenId,
          provider: "modal",
          runtimeTransport: "dialout",
          skills: raw.manifest?.skillReceipts,
        },
      }
    : raw;
  conversationId = launched.conversationId ?? undefined;
  epoch = launched.runtime?.epoch;
  promptId = launched.promptId ?? undefined;
  if (
    !id ||
    launched.sandbox?.provider !== "modal" ||
    launched.sandbox.runtimeTransport !== "dialout" ||
    launched.runtime?.kind !== "armada" ||
    !/^[1-9][0-9]{0,18}$/.test(epoch ?? "") ||
    (!idleMode && (!promptId || !launched.conversationId))
  )
    throw Error("Missing Modal enrolled launch acknowledgement; reconcile existing allocation, never launch again.");
  if (idleMode) {
    if (
      launched.sandbox.status !== "ready" ||
      !Array.isArray(launched.sandbox.conversationIds) ||
      launched.sandbox.conversationIds.length ||
      promptId !== undefined ||
      conversationId !== undefined
    )
      throw Error("Idle Modal launch did not publish an empty ready sandbox.");
    const history = await api("logs/read", { id, limit: 1000 });
    if (
      history.source !== "armada-runtime" ||
      history.runtimeFailure ||
      !Array.isArray(history.events) ||
      history.events.some((event) => event.kind === "prompt" || event.kind === "message")
    )
      throw Error("Idle archive already contains inference or lacks common-runtime provenance.");
    const firstRequestId = crypto.randomUUID();
    console.log(JSON.stringify({ operation: "runtime_first_send", sandboxId: id, requestId: firstRequestId }));
    const first = await api("sandbox/send", { id, request_id: firstRequestId, prompt: initialPrompt });
    if (
      first.requestId !== firstRequestId ||
      first.runtime?.kind !== "armada" ||
      first.runtime.epoch !== epoch ||
      typeof first.promptId !== "string" ||
      !first.promptId ||
      typeof first.conversationId !== "string" ||
      !first.conversationId
    )
      throw Error(
        "Missing current-epoch first-send acknowledgement; reconcile the same request identity, never resend.",
      );
    launched.promptId = promptId = first.promptId;
    launched.conversationId = conversationId = first.conversationId;
  }
  if (!promptId || !conversationId) throw Error("Missing admitted initial Modal conversation.");
  if (skillsMode && launched.sandbox.goldenId !== defaultGoldenId)
    throw Error("Modal launch selected a different golden than the default-skill policy; no retry.");
  launchSkills = launched.sandbox.skills;
  await verifySkillStatus();
  await verifyPrompt(promptId, answer);
  initialGitHubRevision = githubMode ? await configureGitHub(epoch ?? "") : undefined;
  const followupRequestId = crypto.randomUUID();
  console.log(
    JSON.stringify({
      operation: "runtime_followup",
      sandboxId: id,
      conversationId: launched.conversationId,
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
    conversation_id: launched.conversationId,
  });
  if (
    followed.requestId !== followupRequestId ||
    followed.runtime?.kind !== "armada" ||
    followed.runtime.epoch !== epoch ||
    !followed.promptId ||
    followed.promptId === promptId ||
    followed.conversationId !== launched.conversationId
  )
    throw Error(
      "Missing same-conversation/current-epoch Modal follow-up acknowledgement; reconcile request_id, never send again.",
    );
  await verifyPrompt(followed.promptId, memory);
  if (initialGitHubRevision) await verifyGitHub(followed.promptId, epoch ?? "", initialGitHubRevision);
  followupPromptId = followed.promptId;
  const firstCheckpoint = await checkpoint(epoch ?? "");
  checkpointRequestId = firstCheckpoint.requestId;
  checkpointReceipt = firstCheckpoint.receipt;
  console.log(
    JSON.stringify({
      sandboxId: id,
      promptId,
      followupPromptId: followed.promptId,
      conversationId: launched.conversationId,
      followup: "verified",
      epoch,
      source: "armada-runtime",
      answer: "verified",
      ...(idleMode ? { idleFirstSend: "verified" } : {}),
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
const stopKnown = async () => {
  if (id && shouldStop) {
    shouldStop = false; // Dispatch once even when its transport outcome is unknown.
    try {
      await api("sandbox/stop", { id }); // Exactly one stop dispatch, including inference/checkpoint failure.
      let stopped = false;
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline && !stopped) {
        const listed = await api("sandbox/list", { owner: "me", org, limit: 200 });
        stopped =
          listed.sandboxes?.some(
            (row) =>
              row.id === id &&
              (row.status === "stopped" ||
                (row.status === "failed" &&
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
    await verifySkillStatus();
    if (!failure && usageProof) await verifyUsageStatus();
  }
};
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
      conversation_id: conversationId,
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
      resumed.sourceCheckpoint.watermark !== sourceWatermark
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
      if (before.configured !== false || before.runtime?.epoch !== currentEpoch)
        throw Error("Old GitHub configuration survived the runtime epoch change.");
      const revision = await configureGitHub(currentEpoch);
      if (revision === initialGitHubRevision) throw Error("Resume reused the previous GitHub revision.");
      const requestId = crypto.randomUUID();
      console.log(JSON.stringify({ operation: "runtime_github_followup", sandboxId: id, conversationId, requestId }));
      const sent = await api("sandbox/send", {
        id,
        request_id: requestId,
        conversation_id: conversationId,
        prompt: toolsInstruction,
      });
      if (
        sent.requestId !== requestId ||
        sent.runtime?.epoch !== currentEpoch ||
        sent.runtime.kind !== "armada" ||
        sent.conversationId !== conversationId ||
        !sent.promptId ||
        [promptId, followupPromptId, resumed.promptId].includes(sent.promptId)
      )
        throw Error("Missing current-epoch GitHub follow-up acknowledgement.");
      await verifyPrompt(sent.promptId, memory);
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
