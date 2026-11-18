interface RequestBody {
  command: string;
  connections: string[];
  conversation_id: string;
  cursor?: string;
  goldenId: string;
  harness: string;
  id: string;
  org: string;
  prompt: string;
  provider: string;
  repository: string;
  request_id: string;
  requestKey: string;
  revision: number;
  runtimeTransport: string;
  runtimeVersion: number;
  scope: "golden" | "org" | "personal";
  skills: unknown[];
  skipSkillDefaults: boolean;
  toolInventory: boolean;
  ttlSeconds: number;
}
interface FixtureTool {
  id: string;
  name: string;
  server?: string;
  input?: { command?: string; label?: string; nested?: { a: number; b: number } } | undefined;
  result?: { isError: boolean; output: string | { type: string; text: string }[] };
}
interface FixtureEvent {
  id: string;
  at: number;
  promptId: string;
  kind: string;
  text?: string;
  partial?: boolean;
  responseKind?: string;
  tools?: FixtureTool[];
  status?: string;
  type?: string;
  data?: unknown;
}

import { createHash } from "node:crypto";
import type { Defect, Scenario } from "./modal-runtime-scenarios";

const { args, defects } = JSON.parse(process.env.ARMADA_MODAL_TEST_SCENARIO!) as Pick<Scenario, "args" | "defects">;
const ordinary = args.includes("--ordinary"),
  emptyResume = args.includes("--empty-resume"),
  idle = args.includes("--idle") || emptyResume,
  opencode = args.includes("--opencode"),
  claude = args.includes("--claude"),
  github = args.includes("--github"),
  mcp = args.includes("--mcp"),
  skills = args.includes("--skills"),
  variables = args.includes("--variables"),
  usage = args.includes("--usage"),
  resume = args.includes("--resume");
const shellOld = defects.includes("opencode-shell-old");
const inventoryReject = defects.some((d) =>
  ["opencode-mcp-collision", "opencode-mcp-duplicate-name", "opencode-mcp-inventory-missing"].includes(d),
);
const proofReject = defects.some((d) => ["opencode-mcp-inventory-drift", "opencode-mcp-display-only"].includes(d));
const templateId = "22222222-2222-4222-8222-222222222222",
  accountId = variables ? "33333333-3333-4333-8333-333333333333" : "account",
  mcpId = "11111111-1111-4111-8111-111111111111",
  mcpServer = "armada_" + mcpId.replaceAll("-", "_");
const readableValues = { APP_REGION: "readable-canary\n$(not-a-command)", EMPTY_VALUE: "" };
const readableDigest = createHash("sha256").update(JSON.stringify(readableValues)).digest("hex");
let launches = 0,
  stops = 0,
  checkpoints = 0,
  sends = 0,
  resumes = 0,
  answer = "",
  memory = "",
  now = 0,
  firstCheckpoint = "",
  githubRevision = 0,
  goldenReads = 0,
  defaultReads = 0,
  skillStatuses = 0,
  variableCommand = "",
  actualVariableOutput = "",
  usagePages = 0,
  mcpPreflights = 0,
  firstSends = 0,
  diskWrites = 0,
  diskReads = 0,
  diskValue = "";
const variableValues = readableValues;
const variableDigest = readableDigest;
const templateDefinition = {
  provider: "modal",
  harness: opencode ? "opencode" : claude ? "claude" : "codex",
  goldenId: defects.includes("variables-wrong-golden") ? "foreign" : "golden-id",
  model: usage ? "gpt-6.1-sol" : "fixture-model",
  reasoningEffort: "high",
  modelAccount: { id: defects.includes("variables-wrong-account") ? "foreign" : accountId, version: 1 },
  variables: defects.includes("variables-missing-vars")
    ? []
    : [
        { key: "APP_REGION", variableId: "region", version: 1 },
        {
          key: defects.includes("variables-wrong-keys") ? "APP_REGION" : "EMPTY_VALUE",
          variableId: "empty",
          version: 1,
        },
      ],
  secrets: defects.includes("variables-secrets") ? [{ key: "APP_TOKEN", secretId: "foreign", version: 1 }] : [],
  skills: [],
  connections: mcp ? [mcpId] : [],
};
const receipts = ["personal/notes@3.0.0", "catalog/other@1.0.0"].map((reference) => ({
  reference,
  version: reference.split("@")[1],
  skillId: "11111111-1111-4111-8111-111111111111",
  checksum: "sha256:" + "a".repeat(64),
  origin: "https://skillpack.app/v1",
}));
const usageIds = () => [
  ...(idle && !firstSends ? [] : ["prompt"]),
  ...(sends ? ["followup"] : []),
  ...(resumes && !emptyResume ? ["resumed"] : []),
  ...(resumes && !emptyResume && sends > 1 ? ["github-resumed"] : []),
  ...(defects.includes("usage-extra-observation") ? ["background"] : []),
];
const usageData = () => ({
  model: "gpt-6.1-sol",
  inputTokens: 100,
  outputTokens: 20,
  cachedTokens: 10,
  cacheWriteTokens: ["usage-unknown", "usage-zero-missing"].some((defect) => defects.includes(defect as Defect))
    ? null
    : 0,
  reasoningTokens: null,
  ...(defects.includes("usage-forged-guest-money") ? { usd: "999", pricing: { usd: "999" } } : {}),
});
const projectedUsage = () => {
  const raw = usageData(),
    ids = usageIds(),
    missing = defects.includes("usage-unknown");
  const counts = {
    inputTokens: 100,
    outputTokens: 20,
    cachedTokens: 10,
    cacheWriteTokens: defects.includes("usage-zero-missing") ? 0 : raw.cacheWriteTokens,
    reasoningTokens: null,
  };
  const quote = {
    schemaVersion: 1,
    basis: "estimated",
    credentialId: defects.includes("usage-wrong-account") ? "foreign" : accountId,
    credentialVersion: 1,
    capturedAt: "2026-11-13T00:00:00Z",
    snapshot: {
      schemaVersion: 1,
      provider: "openai",
      model: raw.model,
      source: "connection",
      revision: "1",
      connectionId: accountId,
      unsupported: false,
      rates: {
        input: defects.includes("usage-resume-repricing") && resumes ? "200" : "2",
        output: "5",
        cacheRead: "1",
        cacheWrite: null,
        reasoning: null,
      },
    },
    inputs: { ...counts, cacheWriteTtl: null },
    usd: missing ? null : "0.00029",
    unknown: missing ? "tokens" : null,
  };
  return {
    turnCount: ids.length,
    computeSeconds: 1,
    turns: ids.map((promptId) => ({
      ...counts,
      promptId,
      model: defects.includes("usage-wrong-model") ? "foreign" : "gpt-6.1-sol",
      pricing: defects.includes("usage-no-admission") ? null : quote,
    })),
    tokenTotals: {
      inputTokens:
        100 * ids.length +
        (defects.includes("usage-wrong-totals") ||
        (stops > 0 && defects.includes("usage-stopped-drift")) ||
        (stops === 2 && defects.includes("usage-resume-stopped-drift"))
          ? 1
          : 0),
      outputTokens: 20 * ids.length,
      cachedTokens: 10 * ids.length,
      cacheWriteTokens: missing ? null : 0,
      reasoningTokens: null,
      incomplete: true,
    },
    cost: {
      currency: "USD",
      basis: "estimated",
      usd: missing
        ? null
        : defects.includes("usage-forged-cost")
          ? "999"
          : ["0", "0.00029", "0.00058", "0.00087", "0.00116", "0.00145"][ids.length],
      unknown: missing ? "tokens" : null,
      unpricedTurns: missing ? ids.length : 0,
    },
  };
};
Date.now = () => now;
Bun.sleep = async (ms) => {
  now += Number(ms);
};
process.on("exit", () => {
  console.log("COUNTERS " + JSON.stringify({ launches, stops, checkpoints, sends, resumes }));
  console.log("SKILLS " + JSON.stringify({ defaultReads, skillStatuses, goldenReads }));
  console.log("IDLE " + JSON.stringify({ firstSends }));
  console.log("EMPTY " + JSON.stringify({ diskWrites, diskReads }));
});
const readPrompt = (prompt: string) => {
  if (variables) {
    variableCommand = prompt.match(/(node -e '.*?') successfully/)![1]!;
    const env: Record<string, string | undefined> = { ...process.env, ...variableValues };
    if (defects.includes("variables-missing-env")) delete env.EMPTY_VALUE;
    const program = variableCommand.slice("node -e '".length, -1);
    const executed = Bun.spawnSync([process.execPath, "-e", program], { env });
    if (executed.exitCode !== 0) throw Error("readable program failed");
    actualVariableOutput = executed.stdout.toString();
    if (
      prompt.includes(variableDigest) ||
      Object.values(variableValues).some((value) => value && prompt.includes(value))
    )
      throw Error("readable data leaked into prompt");
  }
  if (mcp && (!prompt.includes(mcpServer) || !prompt.includes("read_counter"))) throw Error("MCP instruction missing");
  answer = prompt.match(/ARMADA_MODAL_[a-f0-9]+/)![0]!;
  memory = prompt.match(/ARMADA_MEMORY_[a-f0-9]+/)![0]!;
};
const templateReceipt = (body: RequestBody, idle: boolean) => ({
  state: "succeeded",
  status: idle ? "ready" : "running",
  id: "worker",
  provider: "modal",
  ...(defects.includes("ordinary-template-missing-transport") ? {} : { runtimeTransport: "dialout" }),
  runtime: { kind: "armada", epoch: "1" },
  promptId: idle ? null : "prompt",
  conversationId: idle ? null : "conversation",
  manifest: {
    templateId: templateId,
    requestKey: body.requestKey,
    revision: 2,
    revisionId: "44444444-4444-4444-8444-444444444444",
    golden: { id: "golden-id", orgId: "org-id", provider: "modal" },
    account: defects.includes("variables-receipt-mismatch")
      ? { id: "foreign", version: 1 }
      : templateDefinition.modelAccount,
    definition: templateDefinition,
    variables: variableValues,
    skillReceipts: receipts,
  },
});
const fakeFetch = async (url: string | URL | Request, options?: RequestInit): Promise<Response> => {
  if (!options || typeof options.body !== "string") throw Error("Missing JSON request body");
  const path = new URL(url instanceof Request ? url.url : url).pathname,
    body = JSON.parse(options.body) as RequestBody;
  if (new Headers(options.headers).get("authorization") !== "Bearer " + process.env.ARMADA_TOKEN) throw Error("auth");
  if (path.endsWith("/launch/options"))
    return Response.json({
      modalRuntime: {
        defaultPath: defects.includes("ordinary-default-off") ? "native" : "runtime",
        version: 1,
        enabled: !defects.includes("disabled"),
        followupVersion: defects.includes("old-followup") && !claude && !opencode && !idle && !ordinary ? 0 : 1,
        claudeVersion: defects.includes("claude-old-version") ? 0 : 1,
        idleLaunchVersion: defects.includes("idle-old-version") ? 0 : 1,
        emptyResumeVersion: defects.includes("empty-old-version") ? 0 : 1,
        idleTemplateVersion: defects.includes("idle-template-old-version") ? 0 : 1,
        opencodeVersion: defects.includes("opencode-old-version") ? 0 : 1,
        opencodeShellProofVersion: shellOld ? 0 : 1,
        opencodeMcpProofVersion: defects.includes("opencode-mcp-old-version") ? 0 : 1,
        resumeVersion: defects.includes("old-resume") ? 0 : 1,
        mcpVersion: defects.includes("mcp-old-version") ? 1 : 2,
        skillsVersion: defects.includes("skills-old-version") ? 0 : 1,
        variablesVersion: defects.includes("variables-old-version") ? 0 : 1,
        usageVersion: defects.includes("usage-old-version") ? 0 : 1,
      },
    });
  if (path.endsWith("/golden/list")) {
    if (++goldenReads !== 1) throw Error("golden resolved twice");
    return Response.json({ goldens: [{ id: "golden-id", name: "golden", provider: "modal", orgId: "org-id" }] });
  }
  if (path.endsWith("/templates/get")) {
    if (body.org !== "org-id" || body.id !== templateId || Object.hasOwn(body, "revision"))
      throw Error("wrong template lookup");
    return Response.json({
      item: {
        id: defects.includes("variables-wrong-template") ? "foreign" : templateId,
        status: "active",
        orgId: "org-id",
      },
      revision: { id: "44444444-4444-4444-8444-444444444444", revision: 2, definition: templateDefinition },
    });
  }
  if (path.endsWith("/sandbox/mcp-preflight-v1")) {
    if (
      body.org !== "org-id" ||
      body.runtimeVersion !== 1 ||
      JSON.stringify(body.connections) !== JSON.stringify([mcpId])
    )
      throw Error("wrong MCP preflight");
    if (opencode && body.toolInventory !== true) throw Error("missing inventory admission");
    mcpPreflights++;
    return Response.json({
      mcpReady: !defects.includes("mcp-preflight-denied") || inventoryReject,
      ...(opencode && !defects.includes("opencode-mcp-inventory-missing")
        ? {
            mcpToolInventory: [
              {
                connectionId: mcpId,
                tools: [
                  "read_counter",
                  ...(defects.includes("opencode-mcp-collision") ? ["read.counter"] : []),
                  ...(defects.includes("opencode-mcp-duplicate-name") ? ["read_counter"] : []),
                  ...(defects.includes("opencode-mcp-inventory-drift") && mcpPreflights > 1 ? ["changed"] : []),
                ],
              },
            ],
          }
        : {}),
    });
  }
  if (path.endsWith("/skills/defaults/get")) {
    defaultReads++;
    if (
      body.org !== "org-id" ||
      (body.scope === "golden" ? body.goldenId !== "golden-id" : Object.hasOwn(body, "goldenId"))
    )
      throw Error("wrong defaults scope");
    return Response.json({
      skills: defects.includes("skills-empty")
        ? []
        : {
            golden: ["catalog/notes@1.0.0", "catalog/other@1.0.0"],
            org: ["notes@2.0.0"],
            personal: ["personal/notes@3.0.0"],
          }[body.scope],
    });
  }
  if (path.endsWith("/sandbox/status")) {
    skillStatuses++;
    return Response.json({
      ...(idle && variables && !firstSends
        ? {
            id: defects.includes("idle-template-foreign-status") ? "foreign" : "worker",
            status: defects.includes("idle-template-wrong-status") ? "running" : "ready",
            conversationIds: defects.includes("idle-template-active-conversation") ? ["foreign"] : [],
            prompt: null,
          }
        : {}),
      ...(usage ? { usage: projectedUsage() } : {}),
      skills:
        defects.includes("skills-status-mismatch") ||
        (resumes && stops === 1 && defects.includes("skills-resume-status-mismatch")) ||
        (stops === 2 && defects.includes("skills-resume-stop-status-mismatch"))
          ? receipts.slice(1)
          : receipts,
    });
  }
  if (path.endsWith("/sandbox/github-preflight-v1")) {
    if (body.org !== "org-id" || body.repository !== "example/web") throw Error("bad preflight");
    return Response.json({
      githubReady: true,
      provider: defects.includes("github-old-preflight") ? undefined : "modal",
    });
  }
  if (path.endsWith("/github/refresh")) {
    githubRevision++;
    return Response.json({
      status: "connected",
      runtime: { kind: "armada", epoch: defects.includes("github-wrong-epoch") ? "99" : resumes ? "2" : "1" },
      revision: defects.includes("github-resume-reused-revision") ? "1" : String(githubRevision),
    });
  }
  if (path.endsWith("/github/runtime-status")) {
    const configured =
      !resumes || githubRevision > (emptyResume ? 0 : 1) || defects.includes("github-resume-old-config");
    return Response.json({
      configured,
      runtime: { kind: "armada", epoch: resumes ? "2" : "1" },
      revision: defects.includes("github-stale-revision")
        ? "foreign"
        : defects.includes("github-resume-reused-revision")
          ? "1"
          : String(githubRevision),
      credentialRequests: defects.includes("github-no-acquisition") ? 0 : 1,
    });
  }
  if (path.endsWith("/sandbox/launch") || path.endsWith("/templates/launch")) {
    if (path !== (variables ? "/api/v1/templates/launch" : "/api/v1/sandbox/launch"))
      throw Error("wrong default launch route");
    if (ordinary && ["runtimeVersion", "runtimeTransport", "boatRuntime"].some((key) => Object.hasOwn(body, key)))
      throw Error("ordinary launch must not opt itself in");
    launches++;
    if (
      launches !== 1 ||
      (ordinary
        ? variables
          ? ["provider", "harness"].some((key) => Object.hasOwn(body, key))
          : body.provider !== "modal" || body.harness !== (opencode ? "opencode" : claude ? "claude" : "codex")
        : body.provider !== "modal" ||
          body.runtimeTransport !== "dialout" ||
          body.runtimeVersion !== 1 ||
          body.harness !== (opencode ? "opencode" : claude ? "claude" : "codex")) ||
      body.ttlSeconds !== 900 ||
      (skills
        ? defaultReads !== 3 || Object.hasOwn(body, "skipSkillDefaults") || Object.hasOwn(body, "skills")
        : body.skipSkillDefaults !== true || body.skills.length)
    )
      throw Error("unsafe launch");
    if (variables) {
      if (
        body.id !== templateId ||
        body.revision !== 2 ||
        !body.requestKey ||
        body.org !== "org-id" ||
        ["golden", "credentialId", "model", "connections"].some((key) => Object.hasOwn(body, key))
      )
        throw Error("ambiguous template launch");
    } else if (JSON.stringify(body.connections) !== JSON.stringify(mcp ? [mcpId] : []))
      throw Error("unsafe direct connections");
    if (idle) {
      if (Object.hasOwn(body, "prompt")) throw Error("Idle launch must omit prompt");
      if (variables) return Response.json(templateReceipt(body, true));
      return Response.json({
        sandbox: {
          id: "worker",
          provider: "modal",
          runtimeTransport: "dialout",
          status: defects.includes("idle-bad-receipt") ? "running" : "ready",
          conversationIds: [],
          goldenId: "golden-id",
          ...(skills ? { skills: receipts } : {}),
        },
        runtime: { kind: "armada", epoch: "1" },
        promptId: null,
        conversationId: null,
      });
    }
    readPrompt(body.prompt);
    if (defects.includes("lost-launch")) throw Error("private transport diagnostics must not surface");
    if (variables) return Response.json(templateReceipt(body, false));
    return Response.json({
      sandbox: {
        id: "worker",
        provider: "modal",
        ...(defects.includes("ordinary-missing-transport") ? {} : { runtimeTransport: "dialout" }),
        goldenId: defects.includes("skills-wrong-golden") ? "foreign" : "golden-id",
        ...(skills && !defects.includes("skills-missing-launch") ? { skills: receipts } : {}),
      },
      runtime: { kind: "armada", epoch: "1" },
      promptId: "prompt",
      conversationId: "conversation",
    });
  }
  if (path.endsWith("/sandbox/exec")) {
    if (!emptyResume || body.id !== "worker") throw Error("Unexpected exec");
    if (body.command.startsWith("printf %s ")) {
      if (++diskWrites !== 1 || stops || firstSends) throw Error("Unsafe witness write");
      diskValue = body.command.match(/EMPTY_[a-f0-9]+/)![0]!;
      return Response.json({ exitCode: 0, stdout: "", timedOut: false, truncated: false });
    }
    if (++diskReads !== 1 || resumes !== 1 || firstSends !== 1 || !body.command.startsWith("cat "))
      throw Error("Unsafe witness read");
    return Response.json({
      exitCode: 0,
      stdout: defects.includes("empty-disk-mismatch") ? "foreign" : diskValue,
      timedOut: false,
      truncated: false,
    });
  }
  if (path.endsWith("/sandbox/send")) {
    if (idle && !firstSends) {
      firstSends++;
      if (Object.hasOwn(body, "conversation_id") || body.id !== "worker" || !/^[a-f0-9-]{36}$/.test(body.request_id))
        throw Error("Unsafe first send");
      if (emptyResume) {
        if (stops !== 1 || checkpoints !== 2 || ++resumes !== 1) throw Error("Unsafe empty activation");
      }
      readPrompt(body.prompt);
      if (defects.includes("idle-lost-first-send") || defects.includes("empty-lost-first-send"))
        throw Error("private transport diagnostics must not surface");
      return Response.json({
        requestId: defects.includes("idle-wrong-first-request") ? "wrong" : body.request_id,
        runtime: {
          kind: "armada",
          epoch: defects.includes("idle-wrong-first-epoch")
            ? "2"
            : emptyResume && !defects.includes("empty-wrong-epoch")
              ? "2"
              : "1",
        },
        promptId: "prompt",
        conversationId: defects.includes("idle-wrong-first-conversation") ? "" : "conversation",
        ...(emptyResume
          ? {
              resumed: true,
              sourceCheckpoint: {
                epoch: "1",
                watermark: defects.includes("empty-wrong-watermark") ? 3 : 4,
                empty: !defects.includes("empty-missing-proof"),
              },
            }
          : {}),
      });
    }
    if (
      ++sends > (github && resume ? 2 : 1) ||
      body.id !== "worker" ||
      body.conversation_id !== "conversation" ||
      !/^[a-f0-9-]{36}$/.test(body.request_id) ||
      body.prompt.includes(memory)
    )
      throw Error("unsafe followup");
    if (mcp && (!body.prompt.includes(mcpServer) || !body.prompt.includes("read_counter")))
      throw Error("MCP instruction missing");
    if (
      variables &&
      (!body.prompt.includes(variableCommand) ||
        body.prompt.includes(variableDigest) ||
        Object.values(variableValues).some((value) => value && body.prompt.includes(value)))
    )
      throw Error("invalid readable followup instruction");
    if (defects.includes("lost-followup")) throw Error("private transport diagnostics must not surface");
    return Response.json({
      requestId: defects.includes("wrong-request") ? "wrong" : body.request_id,
      runtime: { kind: "armada", epoch: defects.includes("stale-epoch") ? "2" : resumes ? "2" : "1" },
      promptId: defects.includes("reused-prompt") ? "prompt" : resumes && !emptyResume ? "github-resumed" : "followup",
      conversationId: defects.includes("wrong-conversation") ? "foreign" : "conversation",
    });
  }
  if (path.endsWith("/logs/read")) {
    if (idle && !firstSends)
      return Response.json({
        source: "armada-runtime",
        events:
          defects.includes("idle-running-history") || (defects.includes("empty-hidden-history") && stops > 0)
            ? [{ id: "unexpected", at: 1, kind: "prompt", promptId: "unexpected", status: "finished", text: "" }]
            : [],
      });
    const pair = (promptId: string, text: string, kind = "assistant"): FixtureEvent[] => [
      {
        id: "answer-" + promptId,
        at: 1,
        promptId,
        kind: "message",
        partial: false,
        responseKind: kind,
        tools: [],
        text,
      },
      { id: "finished-" + promptId, at: 2, promptId, kind: "prompt", text: "", status: "finished" },
    ];
    let events: FixtureEvent[] = [
      ...pair(
        defects.includes("wrong-prompt") ? "foreign" : "prompt",
        answer,
        defects.includes("tool-result") ? "tool_result" : "assistant",
      ),
      ...(sends ? pair("followup", memory) : []),
      ...(resumes && !emptyResume
        ? pair("resumed", memory, defects.includes("resume-tool-result") ? "tool_result" : "assistant")
        : []),
    ];
    if (
      github &&
      sends &&
      !(defects.includes("github-missing-tool") && !defects.includes("opencode-github-display-only"))
    ) {
      const toolPrompt = resumes && !emptyResume && sends > 1 ? "github-resumed" : "followup";
      events.push(...pair("github-resumed", memory).filter(() => resumes && !emptyResume && sends > 1));
      events.push({
        id: "gh-tool",
        at: 3,
        kind: "message",
        promptId: toolPrompt,
        partial: false,
        text: "",
        tools: [
          {
            id: "gh",
            name: "commandExecution",
            input: {
              command: defects.includes("github-wrapper")
                ? "/bin/bash -lc 'gh api repos/example/web --jq .full_name'"
                : "gh api repos/example/web --jq .full_name" +
                  (defects.includes("github-echo-mask") ? " || echo example/web" : ""),
            },
            result: {
              isError: false,
              output: defects.includes("github-wrong-output") ? "echo example/web" : "example/web",
            },
          },
        ],
      });
    }
    if (mcp) {
      const promptIds = [...new Set(events.filter((event) => event.kind === "message").map((event) => event.promptId))];
      for (const promptId of promptIds) {
        if (resumes && promptId === "resumed" && defects.includes("mcp-resume-replay")) continue;
        events.push({
          id: "mcp-" + promptId,
          at: 3,
          promptId: defects.includes("mcp-old-prompt") ? "foreign" : promptId,
          kind: "message",
          partial: false,
          text: "",
          tools: [
            {
              id: "mcp",
              server: defects.includes("mcp-wrong-server") ? "foreign" : mcpServer,
              name: defects.includes("mcp-wrong-tool") ? "foreign" : "read_counter",
              input: { label: "fixture", nested: { a: 1, b: defects.includes("mcp-wrong-args") ? 3 : 2 } },
              ...(defects.includes("mcp-no-result") && !defects.includes("claude-mcp-wrong-result-id") && !proofReject
                ? {}
                : {
                    result: {
                      isError: defects.includes("mcp-error-result"),
                      output: defects.includes("mcp-wrong-output") ? "foreign" : "independent result",
                    },
                  }),
            },
          ],
        });
      }
    }
    if (variables && !defects.includes("variables-no-tool")) {
      const quote = (value: string) =>
        String.fromCharCode(39) +
        value.split(String.fromCharCode(39)).join(String.fromCharCode(39, 92, 39, 39)) +
        String.fromCharCode(39);
      for (const promptId of [
        ...new Set(events.filter((event) => event.kind === "message").map((event) => event.promptId)),
      ]) {
        if (resumes && promptId === "resumed" && defects.includes("variables-resume-replay")) continue;
        const output =
          defects.includes("variables-wrong-hash") &&
          !["opencode-variables-bad-exit", "opencode-variables-truncated"].some((defect) =>
            defects.includes(defect as Defect),
          )
            ? "0".repeat(64)
            : actualVariableOutput;
        const command = defects.includes("variables-wrapper")
          ? "bash -lc " + quote(variableCommand)
          : variableCommand + (defects.includes("variables-echo-mask") ? " || echo " + variableDigest : "");
        events.push({
          id: "env-" + promptId,
          at: 3,
          promptId: defects.includes("variables-old-prompt") ? "foreign" : promptId,
          kind: "message",
          partial: false,
          text: "",
          tools: [{ id: "env", name: "commandExecution", input: { command }, result: { isError: false, output } }],
        });
      }
    }
    if (usage && !defects.includes("usage-missing-facts")) {
      usagePages++;
      if (!defects.includes("usage-late") || usagePages > 1)
        for (const promptId of usageIds())
          events.push({
            id: "usage-" + promptId,
            at: 4,
            promptId,
            kind: "other",
            type: "armada/turnUsage",
            data: usageData(),
          });
    }
    if (sends && defects.includes("replayed-answer")) events = pair("prompt", memory);
    if (
      (stops === 1 && !resumes && defects.includes("resume-lost-stopped-history")) ||
      (resumes && defects.includes("resume-lost-old-history"))
    )
      events = events.filter((event) => event.promptId === "resumed");
    if (opencode && !defects.includes("opencode-github-display-only")) {
      for (const event of [...events])
        for (const tool of event.tools ?? []) {
          if (tool.server && tool.result && !defects.includes("opencode-mcp-display-only"))
            events.push({
              id: event.id + "-native-mcp",
              at: 4,
              promptId: event.promptId,
              kind: "other",
              type: "armada/opencodeMcp",
              data: {
                version: 1,
                nativeMessageId: "native-" + event.promptId,
                callId: tool.id,
                server: tool.server,
                configurationRevision: "r" + resumes,
                nativeToolName:
                  tool.server.replace(/[^a-zA-Z0-9_-]/g, "_") + "_" + tool.name.replace(/[^a-zA-Z0-9_-]/g, "_"),
                input: tool.input,
                result: tool.result,
              },
            });
          if (tool.name !== "commandExecution" || !tool.result) continue;
          events.push({
            id: event.id + "-native",
            at: 4,
            promptId: event.promptId,
            kind: "other",
            type: "armada/opencodeShell",
            data: {
              version: 1,
              nativeMessageId: "native-" + event.promptId,
              callId: tool.id,
              tool: "bash",
              command: tool.input?.command,
              output: tool.result!.output,
              exitCode: defects.includes("opencode-variables-bad-exit") ? 1 : 0,
              truncated: defects.includes("opencode-variables-truncated"),
            },
          });
        }
    }
    if (claude) {
      events = events.flatMap((event) => {
        if (event.kind !== "message" || !event.tools?.length) return [event];
        const calls = event.tools!.map((tool) => ({
          id: tool.id,
          name: tool.server
            ? "mcp__" + tool.server + "__" + tool.name
            : tool.name === "commandExecution"
              ? "Bash"
              : tool.name,
          input: tool.input,
        }));
        const results = event
          .tools!.filter((tool) => tool.result)
          .map((tool) => ({
            ...event,
            id: event.id + "-result",
            responseKind: "tool_result",
            tools: [
              {
                id: defects.includes("claude-mcp-wrong-result-id") ? "unrelated" : tool.id,
                name: "tool_result",
                result: {
                  ...tool.result!,
                  output:
                    typeof tool.result!.output === "string"
                      ? [{ type: "text", text: tool.result!.output }]
                      : tool.result!.output,
                },
              },
            ],
          }));
        return [{ ...event, responseKind: "assistant", tools: calls }, ...results];
      });
      // Uses and results really arrive on separate archive pages.
      if (!body.cursor)
        return Response.json({
          source: "armada-runtime",
          cursor: "claude-results",
          events: events.filter(
            (event) => event.kind === "message" && event.responseKind === "assistant" && event.tools?.length,
          ),
        });
      events = events.filter(
        (event) => !(event.kind === "message" && event.responseKind === "assistant" && event.tools?.length),
      );
    }
    return Response.json({ source: defects.includes("wrong-source") ? "modal-native" : "armada-runtime", events });
  }
  if (path.endsWith("/sandbox/checkpoint-runtime-v1")) {
    checkpoints++;
    if (body.id !== "worker" || body.runtimeVersion !== 1 || !body.request_id) throw Error("bad checkpoint input");
    if (checkpoints === 1) firstCheckpoint = body.request_id;
    else if ((!resumes && body.request_id !== firstCheckpoint) || (resumes && body.request_id === firstCheckpoint))
      throw Error("wrong checkpoint replay identity");
    return Response.json({
      requestId: body.request_id,
      runtime: { kind: "armada", epoch: resumes ? "2" : "1" },
      checkpoint: {
        state: "complete",
        watermark: resumes ? 6 : 4,
        acknowledgedSequence:
          defects.includes("bad-checkpoint") || defects.includes("empty-bad-checkpoint")
            ? 1
            : resumes && defects.includes("resume-bad-checkpoint")
              ? 5
              : resumes
                ? 6
                : 4,
      },
    });
  }
  if (path.endsWith("/sandbox/resume-runtime-v1")) {
    if (
      ++resumes !== 1 ||
      stops !== 1 ||
      body.id !== "worker" ||
      body.conversation_id !== "conversation" ||
      !body.request_id ||
      body.runtimeVersion !== 1 ||
      body.prompt.includes(memory)
    )
      throw Error("unsafe resume");
    if (mcp && (!body.prompt.includes(mcpServer) || !body.prompt.includes("read_counter")))
      throw Error("MCP resume instruction missing");
    if (
      variables &&
      (!body.prompt.includes(variableCommand) ||
        body.prompt.includes(variableDigest) ||
        Object.values(variableValues).some((value) => value && body.prompt.includes(value)))
    )
      throw Error("invalid readable resumed instruction");
    if (
      github &&
      !["github-resume-old-config", "github-resume-reused-revision"].some((defect) =>
        defects.includes(defect as Defect),
      )
    )
      githubRevision++;
    if (defects.includes("resume-lost")) throw Error("private transport diagnostics must not surface");
    return Response.json({
      requestId: defects.includes("resume-wrong-request") ? "wrong" : body.request_id,
      resumed: !defects.includes("resume-not-resumed"),
      runtime: { kind: "armada", epoch: defects.includes("resume-bad-epoch") ? "1" : "2" },
      sourceCheckpoint: {
        epoch: defects.includes("resume-wrong-source") ? "0" : "1",
        watermark: defects.includes("resume-wrong-watermark") ? 3 : 4,
        ...(defects.includes("resume-empty-checkpoint") ? { empty: true } : {}),
      },
      promptId: defects.includes("resume-reused-prompt") ? "followup" : "resumed",
      conversationId: defects.includes("resume-wrong-conversation") ? "foreign" : "conversation",
    });
  }
  if (path.endsWith("/sandbox/stop")) {
    if (++stops > (resume || emptyResume ? 2 : 1) || body.id !== "worker") throw Error("repeated or foreign stop");
    if (
      (stops === 2 && defects.includes("resume-stop-unknown")) ||
      (stops === 1 && defects.includes("empty-stop-unknown"))
    )
      throw Error("private transport diagnostics must not surface");
    return Response.json({});
  }
  if (path.endsWith("/sandbox/list")) return Response.json({ sandboxes: [{ id: "worker", status: "stopped" }] });
  throw Error("unexpected operation");
};

globalThis.fetch = Object.assign(fakeFetch, { preconnect: globalThis.fetch.preconnect });
