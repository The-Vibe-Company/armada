import {
  connectGolden,
  DEFAULT_LAUNCH_TTL_SECONDS,
  EncryptionKeyError,
  type GoldenCreateService,
  GoldenError,
  type GoldenRecord,
  goldenForLaunch,
  HARNESSES,
  type LaunchCredentialResolver,
  LaunchError,
  type LaunchOptions,
  launchSandbox,
  MAX_LAUNCH_TTL_SECONDS,
  type MemberRole,
  type Provider,
  ProviderError,
  redact,
  type SandboxStatus,
  scanGoldenSandbox,
  snapshotGolden,
  VaultError,
  type Visibility,
} from "@armada/core/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import type { Caller } from "./caller.ts";
import { describeFailure } from "./caller.ts";
import { DataError, type SandboxView, type ScopedData } from "./data.ts";
import { redactForLog } from "./log.ts";
import { readStatus, type StatusReport, waitSettled } from "./turns.ts";

/** Everything a tool call may use, for one authenticated request. */
export interface ToolContext {
  caller: Caller;
  data: ScopedData;
  /** The launch's credentials: the caller's own for the harness, else the golden's org's. Decrypted in this process. */
  launchCredentials: LaunchCredentialResolver;
  /** The caller's own and one org's model credentials, decrypted, for redacting command output. */
  exposedSecrets(orgId: string): Promise<string[]>;
  /** A provider paying with the boat.dev key of a golden of this org and visibility. The key never leaves the server. */
  provider(golden: { orgId: string; visibility: Visibility }): Promise<Provider>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  launch?: LaunchOptions;
  /** Secure, server-orchestrated multi-repo golden creation. Absent: `golden_create` refuses. */
  goldenCreate?: GoldenCreateService;
  /** Where the real cause of an internal or unavailable tool error goes, redacted. Defaults to stderr. */
  logError?: (line: string) => void;
}

export const SANDBOX_STATUSES = ["starting", "ready", "running", "stopping", "stopped", "failed", "deleted"] as const;
export const DEFAULT_WAIT_SECONDS = 60;
export const MAX_WAIT_SECONDS = 600;
const OUTPUT_LIMIT = 20_000;
const MAX_LOG_PAGES = 100;
/** Mirrors `GoldenCreateService`'s own limit: one GitHub App installation token covers at most this many repos. */
const MAX_CREATE_REPOS = 16;

export class ToolError extends Error {
  override readonly name = "ToolError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const serverInfo = { name: "armada" } as const;

const id = z.string().describe("Armada's sandbox id (a uuid, as returned by launch and list).");
const conversationId = z.string().min(1).optional().describe("A conversation of the sandbox. Default: the latest.");

const golden = z.object({
  name: z.string(),
  orgId: z.string(),
  visibility: z.enum(["org", "private"]),
  ownerId: z.string(),
  boatSnapshotId: z.string().nullable(),
  boatSandboxId: z.string().nullable(),
  repos: z.number().int(),
  config: z.object({
    repos: z.array(z.object({ url: z.string(), branch: z.string(), dir: z.string() })),
    init: z.array(z.string()),
  }),
});

const sandbox = z.object({
  id: z.string(),
  boatId: z.string(),
  golden: z.string(),
  visibility: z.enum(["org", "private"]),
  harness: z.enum(HARNESSES),
  status: z.enum(SANDBOX_STATUSES),
  statusReason: z.string().nullable(),
  orgId: z.string(),
  ownerId: z.string(),
  conversationIds: z.array(z.string()),
  createdAt: z.string(),
  stoppedAt: z.string().nullable(),
});

const prompt = z.object({
  promptId: z.string(),
  conversationId: z.string().nullable(),
  state: z.enum(["running", "finished", "interrupted", "failed"]),
  reason: z.string().nullable(),
});

const status = {
  id: z.string(),
  golden: z.string(),
  visibility: z.enum(["org", "private"]),
  harness: z.enum(HARNESSES),
  status: z.enum(SANDBOX_STATUSES),
  statusReason: z.string().nullable(),
  providerState: z.string().nullable(),
  conversationIds: z.array(z.string()),
  expiresAt: z.string().nullable(),
  prompt: prompt.nullable(),
  settled: z.boolean(),
};

const event = z.looseObject({
  id: z.string(),
  at: z.number(),
  kind: z.enum(["prompt", "message", "steer", "other"]),
  conversationId: z.string().optional(),
  promptId: z.string().optional(),
});

/** One MCP server per request: the principal is fixed for its whole life, and nothing outlives the request. */
export function createArmadaServer(context: ToolContext, version: string): McpServer {
  const server = new McpServer(
    { ...serverInfo, version },
    {
      instructions:
        "Armada launches Claude Code or Codex agents in boat.dev sandboxes forked from a golden. " +
        "Typical flow: golden_list, launch (with a prompt to start at once), then wait or status, logs to read " +
        "what the agent did, send for the next instruction, and stop when done. Ids are Armada sandbox ids.",
    },
  );
  const { caller, data } = context;
  const orgIds = caller.orgs.map((org) => org.orgId);

  const tool = <In extends z.ZodRawShape, Out extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; input: In; output: Out; readOnly?: boolean; destructive?: boolean },
    run: (args: z.infer<z.ZodObject<In>>) => Promise<z.infer<z.ZodObject<Out>>>,
  ) => {
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.input,
        outputSchema: config.output,
        annotations: {
          readOnlyHint: config.readOnly ?? false,
          destructiveHint: config.destructive ?? false,
          openWorldHint: true,
        },
      },
      // The SDK's callback type is generic over every schema flavour; the input is the parsed `In`.
      (async (args: z.infer<z.ZodObject<In>>): Promise<CallToolResult> => {
        try {
          const result = await run(args);
          return {
            structuredContent: result as Record<string, unknown>,
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
        } catch (error) {
          return errorResult(error, name, context.logError ?? ((line) => console.error(line)));
        }
      }) as never,
    );
  };

  const visible = async (sandboxId: string): Promise<SandboxView> => {
    const found = await data.sandboxes.get(sandboxId);
    if (!found) throw new ToolError("not_found", `No sandbox with id '${sandboxId}' that you can see.`);
    return found;
  };
  const live = async (sandboxId: string) => {
    const found = await visible(sandboxId);
    if (found.status === "deleted") throw new ToolError("conflict", `Sandbox '${sandboxId}' is deleted.`);
    return { sandbox: found, provider: await context.provider(found) };
  };
  const statusOf = async (sandboxId: string, promptId: string | undefined): Promise<StatusReport> => {
    const found = await visible(sandboxId);
    const provider = found.status === "deleted" ? null : await context.provider(found);
    return readStatus(provider, data.sandboxes, found, {
      ...(promptId ? { promptId } : {}),
      now: context.now(),
    });
  };

  tool(
    "golden_list",
    {
      title: "List goldens",
      description:
        "The goldens you can launch from: your orgs', and your own private ones. A golden without a " +
        "boatSnapshotId cannot be launched yet.",
      input: {},
      output: { goldens: z.array(golden) },
      readOnly: true,
    },
    async () => {
      const goldens: GoldenRecord[] = [];
      for (const orgId of orgIds) goldens.push(...(await data.goldens.list(orgId)));
      return { goldens: goldens.map(goldenJson) };
    },
  );

  tool(
    "golden_create",
    {
      title: "Create a golden",
      description:
        "Securely builds a golden from one or more GitHub repositories you can access, in a disposable sandbox " +
        "with none of the boat.dev account's credentials: clones each over your own cached GitHub connection " +
        "(see `launch`'s `github`), optionally runs a setup script, scans the builder for leaked GitHub tokens, " +
        "and only saves the snapshot when that scan passes. All repos must share one GitHub App installation.",
      input: {
        name: z.string().min(1).describe("The golden's name."),
        repos: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_CREATE_REPOS)
          .describe("owner/repo, repeated, from one GitHub App installation."),
        org: z
          .string()
          .optional()
          .describe("The orgId to create it in, as in golden_list. Needed only when you belong to more than one."),
        private: z.boolean().optional().describe("Default false: visible to your whole org. True: only you."),
        setup: z.string().optional().describe("A shell script run in the builder after cloning, before the snapshot."),
      },
      output: { name: z.string(), visibility: z.enum(["org", "private"]), snapshot: z.string() },
    },
    async (args) => {
      if (!context.goldenCreate) {
        throw new ToolError("unsupported", "Secure golden creation is not configured on this server.");
      }
      const visibility: Visibility = args.private ? "private" : "org";
      const member = resolveCreateOrg(caller.orgs, args.org);
      const actor = { userId: caller.userId, orgId: member.orgId, role: member.role };
      const provider = await context.provider({ orgId: member.orgId, visibility });
      const result = await context.goldenCreate.create(
        provider,
        actor,
        {
          name: args.name,
          visibility,
          repos: args.repos,
          ...(args.setup ? { setup: args.setup } : {}),
        },
        context.launch ?? {},
      );
      return { name: args.name, visibility, snapshot: result.snapshot };
    },
  );

  tool(
    "golden_update",
    {
      title: "Rebuild a golden",
      description:
        "Rebuilds an existing golden in place. Private goldens require their owner; org goldens require an org admin.",
      input: {
        name: z.string().min(1),
        org: z.string().optional(),
        repos: z.array(z.string().min(1)).min(1).max(MAX_CREATE_REPOS),
        setup: z.string().optional(),
      },
      output: { name: z.string(), visibility: z.enum(["org", "private"]), snapshot: z.string() },
    },
    async (args) => {
      if (!context.goldenCreate)
        throw new ToolError("unsupported", "Secure golden creation is not configured on this server.");
      const member = resolveCreateOrg(caller.orgs, args.org);
      const rows = await data.goldens.findByName(member.orgId, args.name);
      if (rows.length !== 1 || !rows[0]) throw new ToolError("not_found", `No golden named '${args.name}'.`);
      const existingGolden = rows[0];
      const actor = { userId: caller.userId, orgId: member.orgId, role: member.role };
      const provider = await context.provider({ orgId: existingGolden.orgId, visibility: existingGolden.visibility });
      const result = await context.goldenCreate.create(
        provider,
        actor,
        {
          name: existingGolden.name,
          visibility: existingGolden.visibility,
          repos: args.repos,
          ...(args.setup ? { setup: args.setup } : {}),
          existingGolden,
        },
        context.launch ?? {},
      );
      return { name: existingGolden.name, visibility: existingGolden.visibility, snapshot: result.snapshot };
    },
  );

  tool(
    "golden_snapshot",
    {
      title: "Snapshot a golden",
      description: "Restores the golden master if needed, scans it for leaked GitHub tokens, then saves a snapshot.",
      input: { name: z.string().min(1), org: z.string().optional() },
      output: { name: z.string(), snapshot: z.string() },
    },
    async (args) => {
      const member = resolveCreateOrg(caller.orgs, args.org);
      const rows = await data.goldens.findByName(member.orgId, args.name);
      if (rows.length !== 1 || !rows[0]) throw new ToolError("not_found", `No golden named '${args.name}'.`);
      const golden = rows[0];
      const actor = { userId: caller.userId, orgId: member.orgId, role: member.role };
      const provider = await context.provider({ orgId: golden.orgId, visibility: golden.visibility });
      let target = golden;
      if (!target.boatSandboxId) target = (await connectGolden(provider, data.goldens, actor, target.name)).golden;
      if (!target.boatSandboxId) throw new ToolError("conflict", `Golden '${target.name}' has no sandbox yet.`);
      await scanGoldenSandbox(provider, target.boatSandboxId);
      const saved = await snapshotGolden(provider, data.goldens, actor, target.name, context.launch ?? {});
      return { name: saved.golden.name, snapshot: saved.snapshotName };
    },
  );

  tool(
    "launch",
    {
      title: "Launch an agent",
      description:
        "Forks a golden into a new sandbox, pulls its repos, runs its init commands, and starts the agent. " +
        "With `prompt` the agent starts working at once (status running). Without it the sandbox is left ready " +
        "and the conversation starts at the first `send`. The sandbox gets only your (or your org's) Armada " +
        "credentials for this agent, never the boat.dev account's. When the caller connected GitHub, git and gh in " +
        "the sandbox act as that person (8 hour token): see `github` in the answer. Setup can take a few minutes.",
      input: {
        golden: z.string().min(1).describe("The golden's name, as in golden_list."),
        org: z
          .string()
          .optional()
          .describe("The golden's orgId, as in golden_list. Needed only when the name is in several of your orgs."),
        harness: z.enum(HARNESSES).describe("claude (Claude Code) or codex."),
        prompt: z.string().min(1).optional().describe("The first instruction. Leave out for an idle sandbox."),
        ttl_seconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_LAUNCH_TTL_SECONDS)
          .optional()
          .describe(`Seconds before the machine stops by itself. Default ${DEFAULT_LAUNCH_TTL_SECONDS} (4 hours).`),
      },
      output: {
        id: z.string(),
        boatId: z.string(),
        golden: z.string(),
        visibility: z.enum(["org", "private"]),
        harness: z.enum(HARNESSES),
        status: z.enum(SANDBOX_STATUSES),
        conversationIds: z.array(z.string()),
        promptId: z.string().nullable(),
        ttlSeconds: z.number().int(),
        expiresAt: z.string().nullable(),
        github: z
          .object({
            status: z.enum(["connected", "not_connected", "revoked", "unavailable"]),
            login: z.string().nullable(),
            message: z.string().nullable(),
          })
          .describe(
            "Whether git and gh in the sandbox act as the caller. Anything but connected means they are not signed in; message says how to fix it.",
          ),
      },
    },
    async (args) => {
      const actor = await launchActor(args.golden, args.org);
      const chosen: GoldenRecord = await goldenForLaunch(data.goldens, actor, args.golden);
      const provider = await context.provider(chosen);
      const result = await launchSandbox(
        provider,
        { goldens: data.goldens, sandboxes: data.sandboxes, credentials: context.launchCredentials },
        actor,
        {
          golden: args.golden,
          harness: args.harness,
          ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
          ...(args.ttl_seconds === undefined ? {} : { ttlSeconds: args.ttl_seconds }),
        },
        context.launch ?? {},
      );
      return {
        id: result.sandbox.id,
        boatId: result.sandbox.boatId,
        golden: result.golden.name,
        visibility: result.golden.visibility,
        harness: result.sandbox.harness,
        status: result.sandbox.status,
        conversationIds: result.sandbox.conversationIds,
        promptId: result.promptId ?? null,
        ttlSeconds: result.ttlSeconds,
        expiresAt: result.expiresAt ? result.expiresAt.toISOString() : null,
        github: {
          status: result.github.status,
          login: result.github.login ?? null,
          message: result.github.message ?? null,
        },
      };
    },
  );

  tool(
    "list",
    {
      title: "List sandboxes",
      description:
        "Sandboxes you can see, newest first: those of your org's goldens, and of your own private goldens. " +
        "Deleted ones are left out unless asked for. Statuses are as recorded; call status for a fresh read.",
      input: {
        status: z.array(z.enum(SANDBOX_STATUSES)).optional().describe("Only these statuses."),
        limit: z.number().int().min(1).max(200).optional().describe("At most this many. Default 50."),
      },
      output: { sandboxes: z.array(sandbox) },
      readOnly: true,
    },
    async (args) => {
      const statuses: readonly SandboxStatus[] = args.status ?? SANDBOX_STATUSES.filter((name) => name !== "deleted");
      const rows = await data.sandboxes.list({ statuses, limit: args.limit ?? 50 });
      return {
        sandboxes: rows.map((row) => ({
          id: row.id,
          boatId: row.boatId,
          golden: row.golden,
          visibility: row.visibility,
          harness: row.harness,
          status: row.status,
          statusReason: row.statusReason,
          orgId: row.orgId,
          ownerId: row.ownerId,
          conversationIds: row.conversationIds,
          createdAt: row.createdAt,
          stoppedAt: row.stoppedAt,
        })),
      };
    },
  );

  tool(
    "status",
    {
      title: "Sandbox status",
      description:
        "Where a sandbox and its latest turn are, read fresh from boat.dev and recorded. prompt.state is " +
        "running, finished, interrupted or failed; failed includes a usage limit or an expired login, with " +
        "the reason. settled is true when the agent is not working.",
      input: { id, prompt_id: z.string().min(1).optional().describe("A specific turn. Default: the latest.") },
      output: status,
      readOnly: true,
    },
    (args) => statusOf(args.id, args.prompt_id),
  );

  tool(
    "wait",
    {
      title: "Wait for the agent",
      description:
        `Blocks until the agent settles (its turn finished, failed or was interrupted, or the machine stopped) ` +
        `or the timeout passes, then answers like status with timedOut. Default ${DEFAULT_WAIT_SECONDS}s, ` +
        `at most ${MAX_WAIT_SECONDS}s: call again to keep waiting.`,
      input: {
        id,
        timeout_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional(),
        prompt_id: z.string().min(1).optional().describe("A specific turn. Default: the latest."),
      },
      output: { ...status, timedOut: z.boolean() },
      readOnly: true,
    },
    (args) =>
      waitSettled(() => statusOf(args.id, args.prompt_id), {
        timeoutMs: (args.timeout_seconds ?? DEFAULT_WAIT_SECONDS) * 1000,
        now: context.now,
        sleep: context.sleep,
      }),
  );

  tool(
    "logs",
    {
      title: "Read events",
      description:
        "The agent's events oldest first: prompts (with status and failure reason), messages and tool calls, " +
        "steers. The default is one bounded page (100 events). Set all to read every available page (up to " +
        `${MAX_LOG_PAGES} pages) in one response. Pass the returned cursor as since_cursor to read only what is new. ` +
        "An event read twice has the same id and the newer body; each id appears once per response.",
      input: {
        id,
        since_cursor: z.string().min(1).optional().describe("The cursor of the previous page."),
        conversation_id: conversationId,
        limit: z.number().int().min(1).max(500).optional(),
        all: z.boolean().optional().describe("Read all available pages, bounded at 100 pages."),
      },
      output: { events: z.array(event), cursor: z.string().nullable(), hasMore: z.boolean() },
      readOnly: true,
    },
    async (args) => {
      const { sandbox: found, provider } = await live(args.id);
      const page = await readLogs(provider, found.boatId, {
        ...(args.since_cursor ? { since_cursor: args.since_cursor } : {}),
        ...(args.conversation_id ? { conversation_id: args.conversation_id } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
        ...(args.all ? { all: true } : {}),
      });
      return { ...page, events: page.events.map((item) => ({ ...item })) };
    },
  );

  tool(
    "send",
    {
      title: "Send a prompt",
      description:
        "Gives the agent its next instruction as a new turn. Without conversation_id the first send of an idle " +
        "sandbox opens a conversation and later sends continue the latest one. To redirect a turn that is " +
        "still running, use steer.",
      input: {
        id,
        prompt: z.string().min(1).describe("The instruction."),
        conversation_id: conversationId,
      },
      output: {
        id: z.string(),
        promptId: z.string(),
        conversationId: z.string(),
        status: z.enum(["queued", "running", "finished", "failed", "interrupted"]),
      },
    },
    async (args) => {
      const { sandbox: found, provider } = await live(args.id);
      if (args.prompt.trim() === "") throw new ToolError("invalid_request", "The prompt is empty.");
      const conversation = args.conversation_id ?? found.conversationIds.at(-1);
      const receipt = await provider.prompt({
        sandboxId: found.boatId,
        harness: found.harness,
        text: args.prompt,
        ...(conversation ? { conversationId: conversation } : {}),
      });
      const conversationIds = found.conversationIds.includes(receipt.conversationId)
        ? found.conversationIds
        : [...found.conversationIds, receipt.conversationId];
      await data.sandboxes.update(found.id, {
        status: "running",
        statusReason: null,
        conversationIds,
        ...(found.stoppedAt === null ? {} : { stoppedAt: null }),
      });
      return {
        id: found.id,
        promptId: receipt.promptId,
        conversationId: receipt.conversationId,
        status: receipt.status,
      };
    },
  );

  tool(
    "steer",
    {
      title: "Steer the running turn",
      description:
        "Redirects the turn that is running now. delivery says how: native joins the turn (Claude Code); " +
        "restart interrupts it and continues the same conversation with this text (Codex). Refused when no " +
        "turn runs: use send then.",
      input: { id, text: z.string().min(1), conversation_id: conversationId },
      output: {
        id: z.string(),
        promptId: z.string(),
        conversationId: z.string(),
        delivery: z.enum(["native", "restart"]),
        mode: z.string().nullable(),
      },
    },
    async (args) => {
      const { sandbox: found, provider } = await live(args.id);
      const delivery = provider.capabilities[found.harness].steer;
      if (delivery === "none") throw new ToolError("unsupported", `${found.harness} cannot be steered here.`);
      const receipt = await provider.steer({
        sandboxId: found.boatId,
        text: args.text,
        ...(args.conversation_id ? { conversationId: args.conversation_id } : {}),
      });
      return {
        id: found.id,
        promptId: receipt.promptId,
        conversationId: receipt.conversationId,
        delivery,
        mode: receipt.mode ?? null,
      };
    },
  );

  tool(
    "interrupt",
    {
      title: "Interrupt the running turn",
      description: "Stops the running turn of one conversation, or of all. The sandbox stays up for the next send.",
      input: { id, conversation_id: conversationId },
      output: { id: z.string(), interrupted: z.boolean() },
    },
    async (args) => {
      const { sandbox: found, provider } = await live(args.id);
      if (!provider.capabilities[found.harness].interrupt) {
        throw new ToolError("unsupported", `${found.harness} cannot be interrupted here.`);
      }
      await provider.interrupt({
        sandboxId: found.boatId,
        ...(args.conversation_id ? { conversationId: args.conversation_id } : {}),
      });
      return { id: found.id, interrupted: true };
    },
  );

  tool(
    "exec",
    {
      title: "Run a command",
      description:
        "Runs a shell command in the sandbox (cwd /home/user by default) and returns its output. Output that " +
        "contains the agent's credentials is redacted. Use it to inspect the repos, not to drive the agent.",
      input: {
        id,
        command: z.string().min(1),
        cwd: z.string().min(1).optional(),
        timeout_seconds: z.number().int().min(1).max(600).optional().describe("Default 120."),
      },
      output: {
        id: z.string(),
        exitCode: z.number().int().nullable(),
        stdout: z.string(),
        stderr: z.string(),
        timedOut: z.boolean(),
        truncated: z.boolean(),
      },
    },
    async (args) => {
      const { sandbox: found, provider } = await live(args.id);
      const result = await provider.exec({
        sandboxId: found.boatId,
        command: args.command,
        cwd: args.cwd ?? "/home/user",
        timeoutSeconds: args.timeout_seconds ?? 120,
      });
      if (result.detached) throw new ToolError("unknown", "The command started in the background.");
      const secrets = await context.exposedSecrets(found.orgId);
      const clip = (text: string) => {
        const safe = redact(text, secrets);
        return safe.length <= OUTPUT_LIMIT ? safe : `...${safe.slice(-OUTPUT_LIMIT)}`;
      };
      return {
        id: found.id,
        exitCode: result.exitCode,
        stdout: clip(result.stdout),
        stderr: clip(result.stderr),
        timedOut: result.timedOut,
        truncated: result.truncated || result.stdout.length > OUTPUT_LIMIT || result.stderr.length > OUTPUT_LIMIT,
      };
    },
  );

  tool(
    "stop",
    {
      title: "Stop a sandbox",
      description:
        "Removes the machine and keeps its disk and conversations. A later send resumes it. Use it when the " +
        "agent is done, so the sandbox stops costing.",
      input: { id },
      output: { id: z.string(), status: z.enum(SANDBOX_STATUSES) },
      destructive: true,
    },
    async (args) => {
      const { sandbox: found, provider } = await live(args.id);
      await provider.stop({ sandboxId: found.boatId });
      const status: SandboxStatus = found.status === "failed" ? "failed" : "stopped";
      await data.sandboxes.update(found.id, { status, stoppedAt: context.now().toISOString() });
      return { id: found.id, status };
    },
  );

  /** The org a launch acts in: the given one, else the one of the caller's orgs that has this golden. */
  async function launchActor(name: string, org: string | undefined) {
    const member = (orgId: string) => {
      const found = caller.orgs.find((item) => item.orgId === orgId);
      return found ? { userId: caller.userId, orgId: found.orgId, role: found.role } : null;
    };
    if (org !== undefined) {
      const chosen = member(org);
      if (!chosen) throw new ToolError("not_found", `You are not a member of org '${org}'.`);
      return chosen;
    }
    const [first] = caller.orgs;
    if (!first) throw new ToolError("not_found", "You are not a member of any org.");
    if (caller.orgs.length === 1) return member(first.orgId) ?? fail();
    const holders: string[] = [];
    for (const orgId of orgIds) if ((await data.goldens.findByName(orgId, name)).length > 0) holders.push(orgId);
    if (holders.length > 1) {
      throw new ToolError("invalid_request", `'${name}' is a golden in several of your orgs. Pass org (an orgId).`);
    }
    return member(holders[0] ?? first.orgId) ?? fail();
  }

  return server;
}

function fail(): never {
  throw new ToolError("internal", "Armada could not complete the call.");
}

/** The org `golden_create` acts in: the given one, else the caller's only org. There is no existing golden to disambiguate by. */
function resolveCreateOrg(
  orgs: readonly { orgId: string; role: MemberRole }[],
  org: string | undefined,
): { orgId: string; role: MemberRole } {
  if (org !== undefined) {
    const found = orgs.find((item) => item.orgId === org);
    if (!found) throw new ToolError("not_found", `You are not a member of org '${org}'.`);
    return found;
  }
  const [first] = orgs;
  if (!first) throw new ToolError("not_found", "You are not a member of any org.");
  if (orgs.length > 1) throw new ToolError("invalid_request", "You belong to more than one org. Pass org (an orgId).");
  return first;
}

function goldenJson(row: GoldenRecord) {
  return {
    name: row.name,
    orgId: row.orgId,
    visibility: row.visibility,
    ownerId: row.ownerId,
    boatSnapshotId: row.boatSnapshotId,
    boatSandboxId: row.boatSandboxId,
    repos: row.config.repos.length,
    config: row.config,
  };
}

/** A streaming answer is rewritten in place: within a page the newest body of each id wins. */
function dedupe<T extends { id: string }>(events: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of events) byId.set(item.id, item);
  return [...byId.values()];
}

async function readLogs(
  provider: Provider,
  sandboxId: string,
  args: { since_cursor?: string; conversation_id?: string; limit?: number; all?: boolean },
): Promise<{ events: Awaited<ReturnType<Provider["events"]>>["events"]; cursor: string | null; hasMore: boolean }> {
  const events: Awaited<ReturnType<Provider["events"]>>["events"] = [];
  let cursor = args.since_cursor;
  let hasMore = false;
  for (let pageNumber = 0; pageNumber < (args.all ? MAX_LOG_PAGES : 1); pageNumber += 1) {
    const page = await provider.events({
      sandboxId,
      ...(cursor ? { cursor } : {}),
      ...(args.conversation_id ? { conversationId: args.conversation_id } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
    });
    events.push(...page.events);
    hasMore = page.hasMore;
    const next = page.cursor ?? cursor;
    if (!page.hasMore || !next || next === cursor) {
      cursor = next;
      break;
    }
    cursor = next;
  }
  return { events: dedupe(events), cursor: cursor ?? null, hasMore };
}

function errorResult(error: unknown, tool: string, logError: (line: string) => void): CallToolResult {
  const { code, message } = describe(error);
  if (code === "internal" || code === "unavailable") {
    logError(redactForLog(`armada serve: tool ${tool} failed (${code}): ${describeFailure(error)}`));
  }
  return {
    isError: true,
    content: [
      { type: "text", text: message },
      { type: "text", text: `error code: ${code}` },
    ],
  };
}

function describe(error: unknown): { code: string; message: string } {
  if (error instanceof ToolError) return { code: error.code, message: error.message };
  if (error instanceof LaunchError) {
    const tail = error.sandboxId ? ` Sandbox ${error.sandboxId} is recorded as failed and its machine is stopped.` : "";
    return { code: error.code, message: `${error.message}${tail}` };
  }
  if (error instanceof GoldenError) return { code: error.code, message: error.message };
  if (error instanceof ProviderError) {
    if (error.code === "no_running_turn") {
      return { code: error.code, message: "No turn is running. Use send to start one." };
    }
    return { code: error.code, message: error.message };
  }
  if (error instanceof VaultError) return { code: "missing_credential", message: error.message };
  if (error instanceof EncryptionKeyError) return { code: "unavailable", message: error.message };
  if (error instanceof DataError) return { code: "unavailable", message: error.message };
  return { code: "internal", message: "Armada could not complete the call." };
}
