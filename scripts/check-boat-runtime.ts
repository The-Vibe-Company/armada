/** Coordinator-only staging check: ONE launch, no automatic allocation retry. */

import type { AgentEvent } from "../packages/core/src/provider.ts";
import type { SandboxUsage } from "../packages/core/src/sandbox-usage.ts";
import { readDefaultPins, verifyDefaultReceipts } from "./default-skill-smoke.ts";
import { createRuntimeUsageCheck } from "./runtime-usage-smoke.ts";

if (process.env.ARMADA_RUNTIME_SMOKE !== "one_real_boat_launch")
  throw Error("Set ARMADA_RUNTIME_SMOKE=one_real_boat_launch explicitly.");
const origin = new URL(process.env.ARMADA_URL ?? "");
if (origin.protocol !== "https:" || origin.href !== `${origin.origin}/`)
  throw Error("ARMADA_URL must be an HTTPS origin.");
const token = process.env.ARMADA_TOKEN;
const golden = process.env.ARMADA_RUNTIME_GOLDEN;
const org = process.env.ARMADA_RUNTIME_ORG;
const harness = process.env.ARMADA_RUNTIME_HARNESS ?? "codex";
if (harness !== "codex" && harness !== "claude")
  throw Error("ARMADA_RUNTIME_HARNESS must be codex or claude; no launch attempted.");
const credentialId = process.env.ARMADA_RUNTIME_CREDENTIAL_ID;
if (!token || !golden || !org || !credentialId) throw Error("Missing coordinator staging inputs.");
const idleMode = process.argv.includes("--idle");
const usageMode = process.argv.includes("--usage");
const usageCheck = createRuntimeUsageCheck(credentialId);
let usageProof: ReturnType<typeof usageCheck.verify> | undefined;
interface Reply {
  boatRuntime?: {
    enabled?: boolean;
    diagnosticsVersion?: number;
    followupVersion?: number;
    checkpointVersion?: number;
    resumeVersion?: number;
    githubVersion?: number;
    mcpVersion?: number;
    skillsVersion?: number;
    workspaceVersion?: number;
    controlsVersion?: number;
  };
  githubReady?: boolean;
  mcpReady?: boolean;
  connections?: (string | { id: string; defaultForLaunch?: boolean })[];
  servers?: string[];
  status?: string;
  revision?: string;
  configured?: boolean;
  credentialRequests?: number;
  sandbox?: {
    id?: string;
    goldenId?: string;
    boatRuntime?: boolean;
    status?: string;
    conversationIds?: string[];
    skills?: { reference: string; checksum: string; workspaceId?: string }[];
  };
  runtime?: { kind?: string; epoch?: string };
  promptId?: string;
  conversationId?: string;
  requestId?: string;
  resumed?: boolean;
  sourceCheckpoint?: { epoch?: string; watermark?: number };
  checkpoint?: { state?: string; watermark?: number; acknowledgedSequence?: number };
  source?: string;
  runtimeFailure?: { status: string; reason: string };
  cursor?: string | null;
  events?: AgentEvent[];
  sandboxes?: { id: string; status: string; stoppedAt?: string | null }[];
}
async function api<T = Reply>(path: string, body: object): Promise<T> {
  const response = await fetch(new URL(`/api/v1/${path}`, origin), {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600000),
  });
  if (!response.ok) throw Error(`Staging operation ${path} refused (${response.status}); no launch retry.`);
  return (await response.json()) as T;
}
const options = await api("launch/options", {});
if (options.boatRuntime?.enabled !== true || options.boatRuntime.diagnosticsVersion !== 1)
  throw Error(
    "Use the armada-server origin with experimental Boat runtime diagnostics v1 enabled; no launch attempted.",
  );
const workspaceMode = process.argv.includes("--workspace");
const workspaceSteps = new Map<string, string>();
const workspaceEvents = new Set<string>();
let workspaceLocked = false;
if (workspaceMode) {
  if (options.boatRuntime.workspaceVersion !== 1)
    throw Error("Server has no runtime workspace setup v1; no launch attempted.");
  const listed = await api<{
    goldens: {
      id: string;
      name: string;
      orgId: string;
      provider: string;
      config: { repos: unknown[]; init: unknown[] };
    }[];
  }>("golden/list", {});
  const selected = listed.goldens?.filter(
    (g) => g.orgId === org && g.provider === "boat" && (g.name === golden || g.id === golden),
  );
  if (selected?.length !== 1 || !Array.isArray(selected[0]?.config?.repos) || !Array.isArray(selected[0]?.config?.init))
    throw Error("Cannot resolve workspace recipe; no launch attempted.");
  selected[0].config.repos.forEach((_, i) => {
    workspaceSteps.set(`repository:${i}`, "pending");
  });
  selected[0].config.init.forEach((_, i) => {
    workspaceSteps.set(`init:${i}`, "pending");
  });
  if (!workspaceSteps.size)
    throw Error("Workspace check needs an existing recipe with setup work; no launch attempted.");
}
function observeWorkspace(event: AgentEvent) {
  if (!workspaceMode) return;
  if (event.kind === "other" && event.type === "armada/workspaceStep") {
    if (workspaceEvents.has(event.id)) return;
    if (workspaceLocked) throw Error("Workspace setup reran after first inference/resume.");
    const data = event.data as { phase?: unknown; index?: unknown; status?: unknown };
    const key = `${data?.phase}:${data?.index}`;
    if (!workspaceSteps.has(key) || !["running", "finished", "failed"].includes(String(data?.status)))
      throw Error("Unexpected runtime workspace step.");
    workspaceEvents.add(event.id);
    workspaceSteps.set(key, String(data.status));
  }
  if (event.promptId && !workspaceLocked) {
    if ([...workspaceSteps.values()].some((s) => s !== "finished"))
      throw Error("Runtime inference preceded successful repository/init setup.");
    workspaceLocked = true;
  }
}
const steerMode = process.argv.includes("--steer");
const interruptMode = process.argv.includes("--interrupt");
const execMode = process.argv.includes("--exec");
if ((steerMode || interruptMode || execMode) && options.boatRuntime.controlsVersion !== 1)
  throw Error("Server has no Boat runtime controls v1; no launch attempted.");
const skillsMode = process.argv.includes("--skills");
let defaultPins: string[] = [];
let defaultGoldenId: string | undefined;
if (skillsMode) {
  if (options.boatRuntime.skillsVersion !== 1) throw Error("Server has no runtime skills v1; no launch attempted.");
  const available = await api<{ goldens: { id: string; name: string; orgId: string; provider: string }[] }>(
    "golden/list",
    {},
  );
  const selected = available.goldens?.filter(
    (row) => row.orgId === org && row.provider === "boat" && (row.name === golden || row.id === golden),
  );
  if (selected?.length !== 1 || !selected[0]?.id)
    throw Error("Cannot uniquely resolve the smoke Boat golden in this organization; no launch attempted.");
  defaultGoldenId = selected[0].id;
  defaultPins = await readDefaultPins(org, defaultGoldenId, { request: api, step: async (_name, action) => action() });
  if (!defaultPins.length)
    throw Error("No default skills configured for the smoke golden/org/user; no launch attempted.");
}
const mcpMode = process.argv.includes("--mcp");
const mcpConnection = (process.env.ARMADA_RUNTIME_MCP_CONNECTION_ID ?? "").toLowerCase();
const mcpTool = process.env.ARMADA_RUNTIME_MCP_TOOL ?? "";
const mcpExpected = process.env.ARMADA_RUNTIME_MCP_EXPECT ?? "";
const mcpArgumentsJson = process.env.ARMADA_RUNTIME_MCP_ARGS_JSON ?? "{}";
let mcpArguments: Record<string, unknown> = {};
const mcpServer = `armada_${mcpConnection.replaceAll("-", "_")}`;
if (mcpMode) {
  if (
    options.boatRuntime.mcpVersion !== 2 ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(mcpConnection) ||
    !/^[A-Za-z0-9_.-]{1,64}$/.test(mcpTool) ||
    !mcpExpected ||
    mcpExpected.length > 1024 ||
    Buffer.byteLength(mcpArgumentsJson) > 4096
  )
    throw Error(
      "MCP check requires automatic delivery v2, connection UUID, read-only tool, non-secret JSON args and expected substring; no launch attempted.",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(mcpArgumentsJson);
  } catch {
    throw Error("MCP args must be valid non-secret JSON; no launch attempted.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw Error("MCP args must be a non-secret JSON object; no launch attempted.");
  mcpArguments = parsed as Record<string, unknown>;
  const preflight = await api("sandbox/mcp-preflight-v1", { runtimeVersion: 1, org, connections: [mcpConnection] });
  if (preflight.mcpReady !== true) throw Error("MCP preflight refused; no launch attempted.");
  const available = await api("mcp/list", { org });
  if (
    !available.connections?.some((c) => typeof c !== "string" && c.id === mcpConnection && c.defaultForLaunch === true)
  )
    throw Error("Choose an existing default-for-launch MCP connection; no launch attempted.");
}
const githubMode = process.argv.includes("--github");
const repository = process.env.ARMADA_RUNTIME_GITHUB_REPOSITORY ?? "";
const resumeMode = process.argv.includes("--resume");
const checkpointMode = process.argv.includes("--checkpoint") || resumeMode;
if (resumeMode && options.boatRuntime.resumeVersion !== 1)
  throw Error("Server has no verified runtime resume v1; no launch attempted.");
const followup = process.argv.includes("--followup") || checkpointMode || githubMode || mcpMode;
if (githubMode) {
  if (options.boatRuntime.githubVersion !== 1 || !repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw Error("GitHub check requires broker v1, ARMADA_RUNTIME_GITHUB_REPOSITORY=owner/repo; no launch attempted.");
  const preflight = await api("sandbox/github-preflight-v1", { runtimeVersion: 1, org, golden, repository });
  if (preflight.githubReady !== true) throw Error("GitHub preflight refused; no launch attempted.");
}
if (checkpointMode && options.boatRuntime.checkpointVersion !== 1)
  throw Error("Server has no runtime checkpoint v1; no launch attempted.");
if (followup && options.boatRuntime.followupVersion !== 1)
  throw Error("Server has no runtime follow-up v1; no launch attempted.");
const memory = `ARMADA_MEMORY_${crypto.randomUUID().replaceAll("-", "")}`;
const marker = `ARMADA_RUNTIME_${crypto.randomUUID().replaceAll("-", "")}`;
let id: string | undefined;
let goldenId: string | undefined;
let launchSkills: unknown;
async function verifyUsageStatus() {
  if (!usageMode) return;
  const status = await api<{ usage?: SandboxUsage }>("sandbox/status", { id, org });
  usageProof = usageCheck.verify(status.usage);
}
async function verifySkillStatus() {
  if (!skillsMode) return;
  const status = await api<{ skills?: unknown }>("sandbox/status", { id, org });
  verifyDefaultReceipts(launchSkills, status.skills, defaultPins);
}
let failure: unknown;
let checkpointInput: { id: string; request_id: string; runtimeVersion: 1 } | undefined;
let checkpointReceipt: Reply | undefined;
let verifyStoppedHistory: (() => Promise<void>) | undefined;
let verifyPrompt: ((id: string, expected: string) => Promise<void>) | undefined;
let initialConversation: string | undefined;
interface GitHubProof {
  repository: string;
  epoch: string;
  revision: string;
  promptId: string;
  credentialRequests: number;
}
let githubProof: GitHubProof | undefined;
const githubToolPrompts = new Set<string>();
const mcpInstruction = `Call the read-only MCP tool ${mcpTool} on server ${mcpServer} with exactly these non-secret JSON arguments: ${JSON.stringify(mcpArguments)}. Do not substitute a shell or another tool.`;
const checks = [
  ...(githubMode
    ? [`Run this read-only shell command using your command tool: \`gh api repos/${repository} --jq .full_name\`.`]
    : []),
  ...(mcpMode ? [mcpInstruction] : []),
];
const toolsPrompt = `${checks.join(" ")} After all tools succeed, reply exactly with the token I originally asked you to remember. Do not change files.`;
const mcpToolPrompts = new Set<string>();
let mcpProof: ReturnType<typeof verifyMcp> | undefined;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function verifyMcp(promptId: string, epoch: string) {
  if (!mcpToolPrompts.has(promptId))
    throw Error("Missing this prompt's successful MCP result from the selected runtime server and exact arguments.");
  return { epoch, promptId, connectionId: mcpConnection, server: mcpServer, tool: mcpTool };
}
async function configureGitHub(epoch: string) {
  const result = await api("github/refresh", { id });
  if (
    result.status !== "connected" ||
    result.runtime?.kind !== "armada" ||
    result.runtime.epoch !== epoch ||
    !result.revision
  )
    throw Error("Missing current-epoch runtime GitHub configuration acknowledgement.");
  return result.revision;
}
async function verifyGitHub(promptId: string, epoch: string, revision: string): Promise<GitHubProof> {
  const audit = await api("github/runtime-status", { id });
  if (
    !githubToolPrompts.has(promptId) ||
    audit.configured !== true ||
    audit.runtime?.kind !== "armada" ||
    audit.runtime.epoch !== epoch ||
    audit.revision !== revision ||
    typeof audit.credentialRequests !== "number" ||
    !Number.isSafeInteger(audit.credentialRequests) ||
    audit.credentialRequests < 1
  )
    throw Error("Missing successful archived gh command AND current runtime broker credential-delivery proof.");
  return { repository, epoch, revision, promptId, credentialRequests: audit.credentialRequests };
}
let firstPrompt: string | undefined, followupPrompt: string | undefined;
function validateCheckpoint(candidate: Reply, epoch: string | undefined, requestId: string) {
  const proof = candidate.checkpoint;
  if (
    !epoch ||
    candidate.requestId !== requestId ||
    candidate.runtime?.kind !== "armada" ||
    candidate.runtime.epoch !== epoch ||
    proof?.state !== "complete" ||
    typeof proof.watermark !== "number" ||
    !Number.isSafeInteger(proof.watermark) ||
    proof.watermark < 0 ||
    proof.acknowledgedSequence !== proof.watermark
  )
    throw Error("Missing complete runtime checkpoint acknowledgement. Do not claim resume.");
}
try {
  const initialPrompt = mcpMode
    ? `Remember token ${memory}. ${mcpInstruction} After it succeeds, reply exactly ${marker}. Do not change files.`
    : `${followup ? `Remember token ${memory}. ` : ""}Reply exactly ${marker}. Do not use tools or change files.`;
  const launchStarted = performance.now();
  const launched = await api("sandbox/launch-runtime-v1", {
    runtimeVersion: 1,
    boatRuntime: true,
    provider: "boat",
    harness,
    golden,
    org,
    credentialId,
    ...(process.env.ARMADA_RUNTIME_MODEL ? { model: process.env.ARMADA_RUNTIME_MODEL } : {}),
    ...(!idleMode ? { prompt: initialPrompt } : {}),
    ...(mcpMode ? {} : { connections: [] }),
    ...(!skillsMode ? { skipSkillDefaults: true } : {}),
    ttlSeconds: 900,
  });
  const launchRequestMs = performance.now() - launchStarted;
  console.log(
    JSON.stringify({
      operation: "runtime_launch_timing",
      harness,
      mode: idleMode ? "idle" : "prompt",
      launchRequestMs,
      boundary: "launch_request_to_response",
    }),
  );
  id = launched.sandbox?.id;
  goldenId = launched.sandbox?.goldenId;
  if (idleMode) {
    if (
      !id ||
      launched.sandbox?.boatRuntime !== true ||
      launched.sandbox.status !== "ready" ||
      launched.promptId ||
      launched.conversationId ||
      launched.sandbox.conversationIds?.length !== 0 ||
      launched.runtime?.kind !== "armada" ||
      !/^[1-9][0-9]{0,18}$/.test(launched.runtime.epoch ?? "")
    )
      throw Error("Idle runtime launch did not publish ready without a conversation.");
    const epoch = launched.runtime.epoch;
    const requestId = crypto.randomUUID();
    console.log(JSON.stringify({ operation: "runtime_first_send", sandboxId: id, requestId }));
    const first = await api("sandbox/send", { id, request_id: requestId, prompt: initialPrompt });
    if (
      !first.promptId ||
      !first.conversationId ||
      first.requestId !== requestId ||
      first.runtime?.kind !== "armada" ||
      first.runtime.epoch !== epoch
    )
      throw Error("Missing first-send runtime acknowledgement; reconcile the original request_id, never launch again.");
    Object.assign(launched, { promptId: first.promptId, conversationId: first.conversationId });
  }
  if (
    !id ||
    launched.sandbox?.boatRuntime !== true ||
    launched.runtime?.kind !== "armada" ||
    !/^[1-9][0-9]{0,18}$/.test(launched.runtime?.epoch ?? "") ||
    !launched.promptId
  )
    throw Error("Missing runtime launch acknowledgement.");
  launchSkills = launched.sandbox?.skills;
  if (skillsMode && goldenId !== defaultGoldenId)
    throw Error("Launch used a different golden than the defaults preflight.");
  await verifySkillStatus();
  const verify = async (promptId: string, expected: string, requireMcp = mcpMode) => {
    const deadline = Date.now() + 300000;
    let cursor: string | undefined;
    let answer = false,
      finished = false;
    mcpToolPrompts.delete(promptId);
    while (
      Date.now() < deadline &&
      (!answer ||
        !finished ||
        (usageMode && !usageCheck.has(promptId)) ||
        (requireMcp && !mcpToolPrompts.has(promptId)))
    ) {
      const page = await api("logs/read", { id, all: true, ...(cursor ? { cursor } : {}) });
      if (page.runtimeFailure?.status === "failed")
        throw Error(
          "Armada runtime failed; inspect logs/read.runtimeFailure.reason and sandbox statusReason. No launch retry.",
        );
      if (page.source !== "armada-runtime") throw Error("History did not come from the Armada journal archive.");
      for (const event of page.events ?? []) {
        observeWorkspace(event);
        if (event.promptId !== promptId) continue;
        if (usageMode) usageCheck.observe(event);
        if (requireMcp && event.kind === "message") {
          for (const tool of event.tools)
            if (
              tool.server === mcpServer &&
              tool.name === mcpTool &&
              canonical(tool.input) === canonical(mcpArguments) &&
              tool.result?.isError === false &&
              JSON.stringify(tool.result.output)?.includes(mcpExpected)
            )
              mcpToolPrompts.add(promptId);
        }
        if (githubMode && event.kind === "message") {
          for (const tool of event.tools) {
            const command = (tool.input as { command?: unknown } | undefined)?.command;
            if (
              tool.name === "commandExecution" &&
              typeof command === "string" &&
              command.includes("gh api") &&
              command.includes(repository) &&
              tool.result?.isError === false &&
              typeof tool.result.output === "string" &&
              tool.result.output.toLowerCase().includes(repository.toLowerCase())
            )
              githubToolPrompts.add(promptId);
          }
        }
        if (
          event.kind === "message" &&
          event.responseKind !== "tool_result" &&
          event.partial === false &&
          event.text.trim() === expected
        )
          answer = true;
        if (event.kind === "prompt" && event.status === "finished") finished = true;
        if (event.kind === "prompt" && ["failed", "interrupted"].includes(event.status))
          throw Error("Runtime prompt did not finish successfully.");
      }
      cursor = page.cursor ?? cursor;
      if (finished && answer && requireMcp && !mcpToolPrompts.has(promptId))
        throw Error("Missing this prompt's automatic MCP tool evidence.");
      if (
        !answer ||
        !finished ||
        (usageMode && !usageCheck.has(promptId)) ||
        (requireMcp && !mcpToolPrompts.has(promptId))
      )
        await Bun.sleep(1000);
    }
    if (
      !answer ||
      !finished ||
      (usageMode && !usageCheck.has(promptId)) ||
      (requireMcp && !mcpToolPrompts.has(promptId))
    )
      throw Error("Missing archived runtime answer, terminal event, MCP tool or harness usage evidence.");
    await verifyUsageStatus();
  };
  verifyPrompt = verify;
  initialConversation = launched.conversationId;
  firstPrompt = launched.promptId;
  await verify(launched.promptId, marker);
  if (idleMode) console.log(JSON.stringify({ idleLaunch: "verified", firstSend: "verified" }));
  if (mcpMode) mcpProof = verifyMcp(launched.promptId, launched.runtime.epoch ?? "");
  if (execMode) {
    const expected = crypto.randomUUID();
    const result = await api<{
      stdout: string;
      stderr: string;
      exitCode: number;
      timedOut: boolean;
      truncated: boolean;
    }>("sandbox/exec", { id, command: `printf '%s' '${expected}'`, timeout_seconds: 10 });
    if (
      result.stdout !== expected ||
      result.stderr !== "" ||
      result.exitCode !== 0 ||
      result.timedOut ||
      result.truncated
    )
      throw Error("Runtime exec output did not match.");
    console.log(JSON.stringify({ sandboxId: id, exec: "verified" }));
  }
  for (const operation of [...(steerMode ? ["steer"] : []), ...(interruptMode ? ["interrupt"] : [])]) {
    const control = await api("sandbox/send", {
      id,
      request_id: crypto.randomUUID(),
      conversation_id: launched.conversationId,
      prompt: "Run the shell command sleep 90, then reply WAITED. Do not change files or forget the remembered token.",
    });
    if (!control.promptId || control.conversationId !== launched.conversationId)
      throw Error("Missing control turn receipt.");
    const deadline = Date.now() + 60000;
    let running = false;
    while (Date.now() < deadline && !running) {
      const page = await api("logs/read", { id, all: true });
      if (page.source !== "armada-runtime") throw Error("Control history is not runtime-owned.");
      running = (page.events ?? []).some(
        (event) => event.kind === "prompt" && event.promptId === control.promptId && event.status === "running",
      );
      if (!running) await Bun.sleep(500);
    }
    if (!running) throw Error("Control turn did not start.");
    const expected = `STEER_${crypto.randomUUID()}`;
    const receipt = await api<{ interrupted?: boolean; delivery?: string; promptId?: string; conversationId?: string }>(
      `sandbox/${operation}`,
      {
        id,
        conversation_id: launched.conversationId,
        ...(operation === "steer"
          ? { text: `Stop waiting and reply exactly ${expected}. Do not use more tools.` }
          : {}),
      },
    );
    if (operation === "steer") {
      if (
        receipt.delivery !== (harness === "codex" ? "restart" : "native") ||
        receipt.promptId !== control.promptId ||
        receipt.conversationId !== launched.conversationId
      )
        throw Error("Steering receipt did not identify the runtime turn and delivery semantics.");
      await verify(control.promptId, expected, false);
    } else {
      if (receipt.interrupted !== true) throw Error("Interrupt was not acknowledged.");
      let interrupted = false;
      const until = Date.now() + 60000;
      while (Date.now() < until && !interrupted) {
        const page = await api("logs/read", { id, all: true });
        if (page.source !== "armada-runtime") throw Error("Interrupt history is not runtime-owned.");
        interrupted = (page.events ?? []).some(
          (event) => event.kind === "prompt" && event.promptId === control.promptId && event.status === "interrupted",
        );
        if (!interrupted) await Bun.sleep(500);
      }
      if (!interrupted) throw Error("Missing archived interrupted terminal event.");
    }
    console.log(JSON.stringify({ sandboxId: id, promptId: control.promptId, [operation]: "verified" }));
  }

  let nextPromptId: string | undefined;
  if (followup) {
    if (!launched.conversationId) throw Error("Launch did not return a conversation ID.");
    const revision = githubMode ? await configureGitHub(launched.runtime.epoch ?? "") : undefined;
    const requestId = crypto.randomUUID();
    console.log(
      JSON.stringify({
        operation: "runtime_followup",
        sandboxId: id,
        conversationId: launched.conversationId,
        requestId,
      }),
    );
    const sent = await api("sandbox/send", {
      id,
      request_id: requestId,
      conversation_id: launched.conversationId,
      prompt:
        githubMode || mcpMode
          ? toolsPrompt
          : "Reply exactly with the token I asked you to remember in my previous message. Do not use tools or change files.",
    });
    if (
      !sent.promptId ||
      sent.promptId === launched.promptId ||
      sent.conversationId !== launched.conversationId ||
      sent.requestId !== requestId ||
      sent.runtime?.kind !== "armada" ||
      sent.runtime.epoch !== launched.runtime.epoch
    )
      throw Error(
        "Missing same-conversation/epoch runtime follow-up acknowledgement. Reconcile with the original request_id; do not launch again.",
      );
    await verify(sent.promptId, memory);
    if (mcpMode) mcpProof = verifyMcp(sent.promptId, launched.runtime.epoch ?? "");
    if (revision) githubProof = await verifyGitHub(sent.promptId, launched.runtime.epoch ?? "", revision);
    nextPromptId = sent.promptId;
    followupPrompt = sent.promptId;
  }
  if (checkpointMode) {
    checkpointInput = { id, request_id: crypto.randomUUID(), runtimeVersion: 1 };
    console.log(
      JSON.stringify({ operation: "runtime_checkpoint", sandboxId: id, requestId: checkpointInput.request_id }),
    );
    const candidate = await api("sandbox/checkpoint-runtime-v1", checkpointInput);
    validateCheckpoint(candidate, launched.runtime.epoch, checkpointInput.request_id);
    checkpointReceipt = candidate;
    const first = launched.promptId,
      second = nextPromptId;
    verifyStoppedHistory = async () => {
      await verify(first, marker);
      if (second) await verify(second, memory);
    };
  }
  console.log(
    JSON.stringify({
      sandboxId: id,
      source: "armada-runtime",
      epoch: launched.runtime.epoch,
      promptId: launched.promptId,
      answer: "verified",
      ...(githubProof ? { github: "verified", githubProof } : {}),
      ...(mcpProof ? { mcp: "verified", mcpProof } : {}),
      ...(skillsMode ? { skills: "verified", skillReferences: defaultPins } : {}),
      ...(usageMode ? { usage: "verified", usageProof } : {}),
      ...(workspaceMode ? { workspace: "verified", workspaceSteps: workspaceSteps.size } : {}),
      ...(checkpointReceipt ? { checkpoint: "verified", watermark: checkpointReceipt.checkpoint?.watermark } : {}),
      ...(nextPromptId
        ? { followup: "verified", followupPromptId: nextPromptId, conversationId: launched.conversationId }
        : {}),
    }),
  );
} catch (error) {
  failure = error;
}
const stopKnown = async () => {
  if (id) {
    await api("sandbox/stop", { id });
    const deadline = Date.now() + 180000;
    let stopped = false;
    while (Date.now() < deadline) {
      const page = await api("sandbox/list", { owner: "me", ...(goldenId ? { golden: goldenId } : {}), limit: 200 });
      if (
        page.sandboxes?.some(
          (row) =>
            row.id === id &&
            (row.status === "stopped" ||
              (row.status === "failed" &&
                typeof row.stoppedAt === "string" &&
                Number.isFinite(Date.parse(row.stoppedAt)))),
        )
      ) {
        stopped = true;
        break;
      }
      await Bun.sleep(1000);
    }
    if (!stopped) throw Error(`Stop not confirmed for ${id}; coordinator must inspect it. Do not launch again.`);
    await verifySkillStatus();
    await verifyUsageStatus();
    console.log(
      checkpointReceipt
        ? "Runtime compute stopped after acknowledged checkpoint; resume was not tested in this phase."
        : "Experimental runtime compute stopped; resume/work preservation unsupported.",
    );
    if (checkpointInput && checkpointReceipt) {
      const cached = await api("sandbox/checkpoint-runtime-v1", checkpointInput);
      if (
        cached.requestId !== checkpointInput.request_id ||
        cached.runtime?.kind !== "armada" ||
        cached.runtime.epoch !== checkpointReceipt.runtime?.epoch ||
        cached.checkpoint?.state !== "complete" ||
        cached.checkpoint.watermark !== checkpointReceipt.checkpoint?.watermark ||
        cached.checkpoint.acknowledgedSequence !== cached.checkpoint.watermark
      )
        throw Error("Stopped checkpoint receipt did not survive. Do not claim resume.");
      await verifyStoppedHistory?.();
      console.log("Runtime checkpoint and stopped history verified.");
    }
  }
};
try {
  await stopKnown();
} catch (error) {
  failure ??= error;
}
if (resumeMode && !failure && id && checkpointReceipt && initialConversation && verifyPrompt) {
  const source = checkpointReceipt;
  const previousEpoch = source.runtime?.epoch;
  const check = verifyPrompt;
  const priorHistory = verifyStoppedHistory;
  checkpointReceipt = undefined;
  checkpointInput = undefined;
  let resumed: Reply | undefined;
  try {
    const requestId = crypto.randomUUID();
    console.log(
      JSON.stringify({ operation: "runtime_resume", sandboxId: id, conversationId: initialConversation, requestId }),
    );
    resumed = await api<Reply>("sandbox/resume-runtime-v1", {
      id,
      request_id: requestId,
      runtimeVersion: 1,
      conversation_id: initialConversation,
      prompt: mcpMode
        ? `${mcpInstruction} After it succeeds, reply exactly with the token I originally asked you to remember. Do not change files.`
        : "Again reply exactly with the token I originally asked you to remember. Do not use tools or change files.",
    });
    if (
      !previousEpoch ||
      !resumed.promptId ||
      [firstPrompt, followupPrompt].includes(resumed.promptId) ||
      resumed.requestId !== requestId ||
      resumed.resumed !== true ||
      resumed.conversationId !== initialConversation ||
      resumed.runtime?.kind !== "armada" ||
      !/^[1-9][0-9]{0,18}$/.test(resumed.runtime.epoch ?? "") ||
      BigInt(resumed.runtime.epoch ?? "0") !== BigInt(previousEpoch) + 1n ||
      resumed.sourceCheckpoint?.epoch !== previousEpoch ||
      resumed.sourceCheckpoint.watermark !== source.checkpoint?.watermark
    )
      throw Error(
        "Missing restored same-conversation/new-epoch acknowledgement. Reconcile the original request_id; do not activate again.",
      );
    await verifySkillStatus();
    await check(resumed.promptId, memory);
    if (mcpMode) mcpProof = verifyMcp(resumed.promptId, resumed.runtime.epoch ?? "");
    await priorHistory?.();
    const third = resumed.promptId;
    let fourth: string | undefined;
    // MCP already ran in the first resumed prompt; only GitHub needs a new
    // post-refresh turn. Do not spend another MCP-only model turn.
    if (githubMode) {
      const epoch = resumed.runtime.epoch ?? "";
      let revision: string | undefined;
      if (githubMode) {
        const automatic = await api("github/runtime-status", { id });
        if (automatic.configured !== true || automatic.runtime?.kind !== "armada" || automatic.runtime.epoch !== epoch)
          throw Error("Missing automatic current-epoch GitHub preparation after resume.");
        if (!automatic.revision || automatic.revision === githubProof?.revision)
          throw Error("Resume reused the previous GitHub revision.");
        revision = await configureGitHub(epoch);
        if (revision === githubProof?.revision) throw Error("Resume reused the previous GitHub revision.");
      }
      const requestId = crypto.randomUUID();
      console.log(
        JSON.stringify({
          operation: "runtime_followup",
          sandboxId: id,
          conversationId: initialConversation,
          requestId,
        }),
      );
      const sent = await api("sandbox/send", {
        id,
        request_id: requestId,
        conversation_id: initialConversation,
        prompt: toolsPrompt,
      });
      if (
        !sent.promptId ||
        [firstPrompt, followupPrompt, third].includes(sent.promptId) ||
        sent.requestId !== requestId ||
        sent.conversationId !== initialConversation ||
        sent.runtime?.kind !== "armada" ||
        sent.runtime.epoch !== epoch
      )
        throw Error(
          "Missing new-epoch GitHub follow-up acknowledgement. Reconcile the original request_id; do not activate again.",
        );
      await check(sent.promptId, memory);
      if (revision) githubProof = await verifyGitHub(sent.promptId, epoch, revision);
      if (mcpMode) mcpProof = verifyMcp(sent.promptId, epoch);
      fourth = sent.promptId;
    }
    verifyStoppedHistory = async () => {
      await priorHistory?.();
      await check(third, memory);
      if (fourth) await check(fourth, memory);
    };
    checkpointInput = { id, request_id: crypto.randomUUID(), runtimeVersion: 1 };
    console.log(
      JSON.stringify({ operation: "runtime_checkpoint", sandboxId: id, requestId: checkpointInput.request_id }),
    );
    const candidate = await api("sandbox/checkpoint-runtime-v1", checkpointInput);
    validateCheckpoint(candidate, resumed.runtime.epoch, checkpointInput.request_id);
    checkpointReceipt = candidate;
  } catch (error) {
    failure ??= error;
  }
  try {
    await stopKnown();
  } catch (error) {
    failure ??= error;
  }
  if (!failure && resumed) {
    console.log(
      JSON.stringify({
        sandboxId: id,
        conversationId: initialConversation,
        resume: "verified",
        ...(githubMode ? { githubAfterResume: "verified", githubProof } : {}),
        ...(mcpMode ? { mcpAfterResume: "verified", mcpProof } : {}),
        ...(skillsMode ? { skillsAfterResume: "verified" } : {}),
        ...(workspaceMode ? { workspaceAfterResume: "preserved_without_rerun" } : {}),
        ...(usageMode ? { usageAfterResume: "verified", usageProof, costAfterResume: usageProof?.cost.status } : {}),
        source: "armada-runtime",
        previousEpoch,
        epoch: resumed.runtime?.epoch,
        promptId: resumed.promptId,
      }),
    );
    console.log("Runtime resume and stopped history verified.");
  }
}

if (failure) throw failure;
