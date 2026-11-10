import { goldenForSettings, MACHINE_SIZES, parseMachineSizePolicy } from "@armada/core";
import {
  assertGoldenMutation,
  connectGolden,
  DEFAULT_LAUNCH_TTL_SECONDS,
  EncryptionKeyError,
  type GoldenAdoption,
  type GoldenBuildJobs,
  GoldenError,
  type GoldenRecord,
  goldenForLaunch,
  HARNESSES,
  type LaunchCredentialResolver,
  LaunchError,
  type LaunchOptions,
  type LaunchStores,
  launchSandbox,
  MAX_LAUNCH_TTL_SECONDS,
  MAX_SANDBOX_EXTENSION_TTL_SECONDS,
  type MemberRole,
  MODEL_CATALOG,
  type ModelChoice,
  PROVIDER_LIMITS,
  type Provider,
  ProviderError,
  ProviderRoutingError,
  type ProviderTarget,
  redact,
  resolveModelChoice,
  resolveRepositoryDir,
  SANDBOX_PROVIDERS,
  type SandboxProviderId,
  type SandboxStatus,
  scanGoldenSandbox,
  snapshotGolden,
  VaultError,
  type Visibility,
} from "@armada/core/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { validateProviderResourceObservation } from "../../core/src/resource-validation.ts";
import { apiFailureCode } from "./api-failure.ts";
import type { Caller } from "./caller.ts";
import { describeFailure } from "./caller.ts";
import { CREDENTIAL_BINDING_GUIDANCE } from "./credential-binding.ts";
import { DataError, type SandboxView, type ScopedData } from "./data.ts";
import { redactForLog } from "./log.ts";
import { isPrivateModelEvent } from "./model-usage.ts";
import type { OrchestratorPair } from "./orchestrator-activation.ts";
import { callOrchestrator, orchestratorFailureCode } from "./orchestrator-api.ts";
import type { OrchestratorRuntime } from "./orchestrator-runtime.ts";
import { OrchestratorRuntimeError } from "./orchestrator-runtime-store.ts";
import type { GoldenProviderMetadata } from "./provider-metadata.ts";
import { summarizeResourceHistory } from "./resource-advice.ts";
import { sandboxActivity } from "./sandbox-activity.ts";
import { extendSandbox } from "./sandbox-extend.ts";
import { isInterruptedLaunch, latestPrompt, readStatus, type StatusReport, waitSettled } from "./turns.ts";

/** Everything a tool call may use, for one authenticated request. */
export interface ToolContext {
  orchestratorPairs?: readonly OrchestratorPair[];
  orchestrators?: OrchestratorRuntime;
  caller: Caller;
  data: ScopedData;
  /** The launch's credentials: the caller's own for the harness, else the golden's org's. Decrypted in this process. */
  launchCredentials: LaunchCredentialResolver;
  /** The caller's own and one org's model credentials, decrypted, for redacting command output. */
  exposedSecrets(orgId: string): Promise<string[]>;
  /** A provider paying with the boat.dev key of a golden of this org and visibility. The key never leaves the server. */
  /** The provider of a golden's or a sandbox's own backend (see `ProviderRegistry`). Its key never leaves the server. */
  provider(target: ProviderTarget): Promise<Provider>;
  /** Deletion only: resolve the sandbox owner's immutable source management authority after authorization. */
  deletionProvider?(sandbox: SandboxView): Promise<Provider>;
  providerMetadata?: (selection: { orgId: string; provider: SandboxProviderId }) => Promise<GoldenProviderMetadata>;
  goldenTarget?: (target: Omit<ProviderTarget, "modal">) => Promise<ProviderTarget>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  launch?: LaunchOptions;
  connections?: LaunchStores["connections"];
  /** Secure, server-orchestrated multi-repo golden creation. Absent: `golden_create` refuses. */
  goldenBuilds?: GoldenBuildJobs;
  goldenAdoption?: GoldenAdoption;
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

const buildOutput = {
  jobId: z.string(),
  provider: z.enum(SANDBOX_PROVIDERS).optional(),
  state: z.enum(["queued", "running", "recovery_required", "succeeded", "failed"]),
  phase: z.string(),
  errorCode: z.literal("build_failed").nullable(),
  result: z.object({ name: z.string(), visibility: z.enum(["org", "private"]), snapshot: z.string() }).nullable(),
};

const id = z.string().describe("Armada's sandbox id (a uuid, as returned by launch and list).");
const conversationId = z.string().min(1).optional().describe("A conversation of the sandbox. Default: the latest.");

const modelCatalogText = Object.entries(MODEL_CATALOG)
  .map(
    ([harness, entry]) =>
      `${harness}: ${entry.models.map((option) => `${option.id} (${option.reasoningEfforts.join("|")})`).join(", ")}; ` +
      `default ${entry.defaultModel} ${entry.defaultReasoningEffort}`,
  )
  .join(". ");
const modelInput = z.string().min(1).optional().describe(`The model, by id. ${modelCatalogText}.`);
const effortInput = z.string().min(1).optional().describe("The reasoning effort; one the model accepts (see model).");
const modelOutput = {
  credentialId: z.string().nullable().optional(),
  credentialVersion: z.number().int().nullable().optional(),
  model: z.string().nullable().describe("The model its turns run with. Null: launched before Armada recorded it."),
  reasoningEffort: z.string().nullable(),
};

const providerOutput = z.enum(SANDBOX_PROVIDERS).describe("The sandbox provider it runs on, fixed for its life.");
const compat = (name: string) =>
  z.string().nullable().describe(`The same as ${name} on a Boat golden or sandbox; null on any other provider.`);

const golden = z.object({
  id: z.string(),
  name: z.string(),
  orgId: z.string(),
  visibility: z.enum(["org", "private"]),
  ownerId: z.string(),
  provider: providerOutput,
  providerSnapshotId: z.string().nullable(),
  providerSandboxId: z.string().nullable(),
  modal: z
    .object({ workspace: z.string(), environment: z.string(), appId: z.string() })
    .nullable()
    .describe("The Modal workspace, environment and App id a Modal golden is pinned to."),
  boatSnapshotId: compat("providerSnapshotId"),
  boatSandboxId: compat("providerSandboxId"),
  repos: z.number().int(),
  config: z.object({
    repos: z.array(z.object({ url: z.string(), branch: z.string(), dir: z.string() })),
    init: z.array(z.string()),
  }),
});

const taskOutcome = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("ready"),
      prNumber: z.number().int().positive().optional(),
      prUrl: z.url().max(2048).optional(),
      headSha: z
        .string()
        .regex(/^[a-f0-9]{40}$/i)
        .optional(),
    })
    .strict(),
  z.object({ state: z.literal("blocked"), reason: z.string().trim().min(1).max(1000) }).strict(),
]);

const sandboxUsage = z
  .object({
    computeSeconds: z.number().nullable(),
    turnCount: z.number().nullable(),
    tokenTotals: z
      .object({
        inputTokens: z.number().nullable(),
        outputTokens: z.number().nullable(),
        cachedTokens: z.number().nullable(),
        cacheWriteTokens: z.number().nullable(),
        reasoningTokens: z.number().nullable(),
      })
      .optional(),
    turns: z.array(
      z.object({
        promptId: z.string(),
        model: z.string().nullable(),
        inputTokens: z.number().nullable(),
        outputTokens: z.number().nullable(),
        cachedTokens: z.number().nullable(),
        cacheWriteTokens: z.number().nullable().optional(),
        reasoningTokens: z.number().nullable().optional(),
      }),
    ),
  })
  .nullable()
  .optional();

const sandboxListMetadata = z.object({
  usage: sandboxUsage,
  preservationNote: z.string().nullable().optional(),
  providerSandboxId: z.string().nullable(),
  boatId: z.string().nullable(),
  id: z.string(),
  orgId: z.string(),
  ownerId: z.string(),
  provider: providerOutput,
  harness: z.enum(HARNESSES),
  model: modelOutput.model,
  reasoningEffort: modelOutput.reasoningEffort,
  status: z.enum(SANDBOX_STATUSES),
  createdAt: z.string(),
  stoppedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  effectiveTtlSeconds: z.number().nullable(),
  machineSize: z.enum(["small", "medium", "large", "xlarge"]).nullable(),
  displayLabel: z.string(),
  taskOutcome: taskOutcome.nullable().optional(),
  canOpen: z.boolean(),
  canManage: z.boolean(),
});

const prompt = z.object({
  promptId: z.string(),
  conversationId: z.string().nullable(),
  state: z.enum(["running", "finished", "interrupted", "failed"]),
  reason: z.string().nullable(),
});

const status = {
  usage: sandboxUsage,
  preservationNote: z.string().nullable().optional(),
  id: z.string(),
  golden: z.string(),
  visibility: z.enum(["org", "private"]),
  harness: z.enum(HARNESSES),
  repositoryDir: z
    .string()
    .nullable()
    .describe("Configured directory used to prepare native agent cwd; not confinement."),
  ...modelOutput,
  machineSize: z.unknown().nullable(),
  status: z.enum(SANDBOX_STATUSES),
  statusReason: z.string().nullable(),
  taskOutcome: taskOutcome.nullable().optional(),
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

  for (const action of [
    "capabilities",
    "create",
    "list",
    "detail",
    "events",
    "message",
    "steer",
    "stop",
    "resume",
    "recover",
    "reconcile",
  ]) {
    server.registerTool(
      `orchestrator_${action}`,
      {
        description: "Owner-private persistent orchestrator operation. Unverified native backends remain disabled.",
        inputSchema: { args: z.record(z.string(), z.unknown()), idempotencyKey: z.string().optional() },
        outputSchema: z.object({ version: z.literal(1) }).passthrough(),
      },
      async ({ args, idempotencyKey }) => {
        try {
          const result = await callOrchestrator(
            context.orchestrators,
            context.caller,
            action,
            args,
            idempotencyKey,
            context.orchestratorPairs,
          );
          return {
            structuredContent: result as Record<string, unknown>,
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        } catch (error) {
          const code = orchestratorFailureCode(error);
          return {
            isError: true,
            content: [
              { type: "text" as const, text: code },
              { type: "text" as const, text: `error code: ${code}` },
              ...(error instanceof OrchestratorRuntimeError && error.admission
                ? [
                    {
                      type: "text" as const,
                      text: JSON.stringify({
                        code,
                        admission: error.admission,
                        ...(error.operation ? { operation: error.operation } : {}),
                      }),
                    },
                  ]
                : []),
            ],
          };
        }
      },
    );
  }

  const visible = async (sandboxId: string): Promise<SandboxView> => {
    const found = await data.sandboxes.get(sandboxId);
    if (!found) throw new ToolError("not_found", `No sandbox with id '${sandboxId}' that you can see.`);
    return found;
  };
  const live = async (sandboxId: string, allowUnbound = false) => {
    const found = await visible(sandboxId);
    if (found.status === "deleted") throw new ToolError("conflict", `Sandbox '${sandboxId}' is deleted.`);
    if (!allowUnbound && found.provider === "modal" && !found.credentialId)
      throw new VaultError("credential_binding_required", CREDENTIAL_BINDING_GUIDANCE);
    return {
      sandbox: found,
      provider: await context.provider(found),
    };
  };
  const statusOf = async (sandboxId: string, promptId: string | undefined): Promise<StatusReport> => {
    const found = await visible(sandboxId);
    const provider =
      found.status === "deleted" ||
      found.status === "starting" ||
      isInterruptedLaunch(found) ||
      (found.status === "failed" && found.stoppedAt !== null)
        ? null
        : await context.provider(found);
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
        "providerSnapshotId cannot be launched yet. The same name may exist on several providers.",
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
    "golden_capabilities",
    {
      title: "Golden provider capabilities",
      description:
        "Reads the selected provider adapter's golden capacity without creating an App or resource. Null is unknown/unbounded, not a workspace quota.",
      input: { org: z.string().optional(), provider: z.enum(SANDBOX_PROVIDERS).optional() },
      output: {
        provider: z.enum(SANDBOX_PROVIDERS),
        maxGoldens: z.number().int().positive().nullable(),
        bindings: z
          .array(
            z.object({
              goldenId: z.string().uuid(),
              relation: z.enum(["current_backend", "other_backend", "unbound"]),
            }),
          )
          .optional(),
      },
      readOnly: true,
    },
    async (args) => {
      const member = resolveCreateOrg(caller.orgs, args.org);
      if (!context.providerMetadata)
        throw new ToolError("unsupported", "Read-only provider metadata is not configured.");
      return context.providerMetadata({ orgId: member.orgId, provider: args.provider ?? "boat" });
    },
  );

  tool(
    "golden_adopt",
    {
      title: "Adopt canonical Boat golden",
      description:
        "Dry-run first: select an existing visible golden by id. Confirm with the returned receipt within ten minutes. Preserves all rows and ACLs.",
      input: { id: z.string().uuid(), confirmation: z.string().uuid().optional() },
      output: { goldenId: z.string(), dryRun: z.boolean(), confirmation: z.string() },
    },
    async (args) => {
      if (!context.goldenAdoption) throw new ToolError("unsupported", "Canonical adoption is not configured.");
      let golden: GoldenRecord | undefined;
      for (const { orgId } of caller.orgs) {
        golden = (await data.goldens.list(orgId)).find((row) => row.id === args.id);
        if (golden) break;
      }
      if (!golden) throw new ToolError("not_found", "Canonical adoption unavailable.");
      const member = caller.orgs.find((org) => org.orgId === golden.orgId)!;
      const actor = { userId: caller.userId, orgId: member.orgId, role: member.role };
      assertGoldenMutation(actor, golden);
      return context.goldenAdoption(await context.provider(golden), actor, golden, args.confirmation);
    },
  );

  tool(
    "golden_build_status",
    {
      title: "Golden build status",
      description: "Read a durable build job. Poll this bounded request; never resubmit a disconnected build.",
      input: {
        jobId: z.string().uuid().optional(),
        idempotencyKey: z.string().min(16).max(128).optional(),
        org: z.string().optional(),
      },
      readOnly: true,
      output: buildOutput,
    },
    async ({ jobId, idempotencyKey, org }) => {
      if (!context.goldenBuilds) throw new ToolError("unsupported", "Durable golden builds are not configured.");
      if (!jobId && !idempotencyKey) throw new ToolError("invalid", "Pass jobId or idempotencyKey.");
      return context.goldenBuilds.status(
        caller.userId,
        jobId ?? "",
        idempotencyKey ? resolveCreateOrg(caller.orgs, org).orgId : undefined,
        idempotencyKey,
        caller.orgs.map((org) => org.orgId),
      );
    },
  );

  tool(
    "golden_create",
    {
      title: "Create a golden",
      description:
        "Admits a durable build job; poll golden_build_status. Builds from one or more GitHub repositories you can access, in a disposable sandbox " +
        "with none of the boat.dev account's credentials: clones each over your own cached GitHub connection " +
        "(see `launch`'s `github`), optionally runs a setup script, scans the builder for leaked GitHub tokens, " +
        "and only saves the snapshot when that scan passes. All repos must share one GitHub App installation.",
      input: {
        provider: z.enum(["boat", "modal"]).optional(),
        idempotencyKey: z.string().min(16).max(128),
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
      output: buildOutput,
    },
    async (args) => {
      if (!context.goldenBuilds) {
        throw new ToolError("unsupported", "Secure golden creation is not configured on this server.");
      }
      const visibility: Visibility = args.private ? "private" : "org";
      const member = resolveCreateOrg(caller.orgs, args.org);
      const actor = { userId: caller.userId, orgId: member.orgId, role: member.role };
      assertGoldenMutation(actor, { orgId: member.orgId, visibility, ownerId: caller.userId, name: args.name });
      const input = { orgId: member.orgId, visibility, provider: args.provider ?? "boat" } as const;
      const target = context.goldenTarget ? await context.goldenTarget(input) : { ...input, modal: null };
      const provider = await context.provider(target);
      return context.goldenBuilds.admit(
        provider,
        actor,
        {
          ...(target.modal ? { modal: target.modal } : {}),
          name: args.name,
          visibility,
          repos: args.repos,
          ...(args.setup ? { setup: args.setup } : {}),
        },
        args.idempotencyKey,
      );
    },
  );

  tool(
    "golden_update",
    {
      title: "Rebuild a golden",
      description:
        "Admits a durable rebuild job; poll golden_build_status. Private goldens require their owner; org goldens require an org admin.",
      input: {
        provider: z.enum(["boat", "modal"]).optional(),
        idempotencyKey: z.string().min(16).max(128),
        name: z.string().min(1),
        org: z.string().optional(),
        repos: z.array(z.string().min(1)).min(1).max(MAX_CREATE_REPOS),
        setup: z.string().optional(),
      },
      output: buildOutput,
    },
    async (args) => {
      if (!context.goldenBuilds)
        throw new ToolError("unsupported", "Secure golden creation is not configured on this server.");
      const member = resolveCreateOrg(caller.orgs, args.org);
      const rows = (await data.goldens.findByName(member.orgId, args.name)).filter(
        (row) => !args.provider || row.provider === args.provider,
      );
      if (rows.length > 1) throw new ToolError("conflict", "Golden exists on multiple providers; select a provider.");
      if (rows.length !== 1 || !rows[0]) throw new ToolError("not_found", `No golden named '${args.name}'.`);
      const existingGolden = rows[0];
      const actor = { userId: caller.userId, orgId: member.orgId, role: member.role };
      assertGoldenMutation(actor, existingGolden);
      const provider = await context.provider(existingGolden);
      return context.goldenBuilds.admit(
        provider,
        actor,
        {
          name: existingGolden.name,
          visibility: existingGolden.visibility,
          repos: args.repos,
          ...(args.setup ? { setup: args.setup } : {}),
          existingGolden,
        },
        args.idempotencyKey,
      );
    },
  );

  tool(
    "golden_snapshot",
    {
      title: "Snapshot a golden",
      description: "Restores the golden master if needed, scans it for leaked GitHub tokens, then saves a snapshot.",
      input: { name: z.string().min(1), org: z.string().optional(), provider: z.enum(SANDBOX_PROVIDERS).optional() },
      output: { name: z.string(), snapshot: z.string() },
    },
    async (args) => {
      const member = resolveCreateOrg(caller.orgs, args.org);
      const rows = (await data.goldens.findByName(member.orgId, args.name)).filter(
        (row) => !args.provider || row.provider === args.provider,
      );
      if (rows.length > 1) throw new ToolError("conflict", "Golden exists on multiple providers; select a provider.");
      if (rows.length !== 1 || !rows[0]) throw new ToolError("not_found", `No golden named '${args.name}'.`);
      const golden = rows[0];
      const actor = { userId: caller.userId, orgId: member.orgId, role: member.role };
      assertGoldenMutation(actor, golden);
      const provider = await context.provider(golden);
      await data.goldens.assertBackendBinding?.(golden, provider);
      const target = (await connectGolden(provider, data.goldens, actor, golden.name)).golden;
      if (!target.providerSandboxId) throw new ToolError("conflict", `Golden '${target.name}' has no sandbox yet.`);
      await scanGoldenSandbox(provider, target.providerSandboxId);
      const saved = await snapshotGolden(provider, data.goldens, actor, target.name, context.launch ?? {});
      return { name: saved.golden.name, snapshot: saved.snapshotName };
    },
  );

  tool(
    "golden_size_policy",
    {
      title: "Golden machine size policy",
      description:
        "Read or replace defaults for this provider golden only. Org writes require admin; private writes require owner. Does not rebuild snapshots or resize machines.",
      input: {
        golden: z.string(),
        org: z.string().optional(),
        provider: z.enum(SANDBOX_PROVIDERS).optional(),
        policy: z.unknown().optional(),
      },
      output: {
        goldenId: z.string(),
        provider: providerOutput,
        repositories: z.array(z.object({ url: z.string(), branch: z.string(), dir: z.string() })),
        policy: z.unknown().nullable(),
      },
    },
    async (args) => {
      const actor = await launchActor(args.golden, args.org);
      const golden = await goldenForSettings(data.goldens, actor, args.golden, args.provider);
      if (args.policy !== undefined) {
        const policy = parseMachineSizePolicy(
          args.policy,
          golden.config.repos.map((r) => r.dir),
        );
        if (!data.goldens.setSizePolicy) throw new GoldenError("conflict", "Policy writes are unavailable.");
        await data.goldens.setSizePolicy(golden, actor, policy);
        return { goldenId: golden.id, provider: golden.provider, repositories: golden.config.repos, policy };
      }
      return {
        goldenId: golden.id,
        provider: golden.provider,
        repositories: golden.config.repos,
        policy: golden.sizePolicy ?? null,
      };
    },
  );

  for (const launchTool of ["launch", "launch_sized_v1"] as const) {
    tool(
      launchTool,
      {
        title: "Launch an agent",
        description:
          "Forks a golden into a new sandbox, pulls its repos, runs its init commands, and starts the agent. " +
          "With `prompt` the agent starts working at once (status running). Without it the sandbox is left ready " +
          "and the conversation starts at the first `send`. The sandbox gets only your (or your org's) Armada " +
          "credentials for this agent, never the boat.dev account's. When the caller connected GitHub, git and gh in " +
          "the sandbox act as that person (8 hour token): see `github` in the answer. Setup can take a few minutes.",
        input: {
          ...(launchTool === "launch_sized_v1" ? { size_policy_version: z.literal(1) } : {}),
          visibility: z.enum(["private", "org"]).optional(),
          connections: z.array(z.string().uuid()).max(100).optional(),
          golden: z.string().min(1).describe("The golden's name, as in golden_list."),
          org: z
            .string()
            .optional()
            .describe("The golden's orgId, as in golden_list. Needed only when the name is in several of your orgs."),
          provider: z
            .enum(SANDBOX_PROVIDERS)
            .optional()
            .describe("The golden's provider. Needed only when the name exists on several providers."),
          harness: z.enum(HARNESSES).describe("claude (Claude Code) or codex."),
          model: modelInput,
          reasoning_effort: effortInput,
          size: z.enum(MACHINE_SIZES).optional(),
          repo: z
            .string()
            .optional()
            .describe(
              "Configured directory or owner/repo from the golden. Prepares native agent cwd, including idle launches. Not confinement.",
            ),
          credentialId: z.string().uuid().optional(),
          prompt: z.string().min(1).optional().describe("The first instruction. Leave out for an idle sandbox."),
          ttl_seconds: z
            .number()
            .int()
            .min(1)
            .max(MAX_LAUNCH_TTL_SECONDS)
            .optional()
            .describe(
              `Seconds before the machine stops by itself. Default ${DEFAULT_LAUNCH_TTL_SECONDS} (4 hours). At most ` +
                `${providerLimitsText}; a longer TTL is refused.`,
            ),
        },
        output: {
          id: z.string(),
          provider: providerOutput,
          providerSandboxId: z.string(),
          boatId: compat("providerSandboxId"),
          golden: z.string(),
          visibility: z.enum(["org", "private"]),
          harness: z.enum(HARNESSES),
          repositoryDir: z
            .string()
            .nullable()
            .describe("Configured directory used to prepare native agent cwd; not confinement."),
          ...modelOutput,
          machineSize: z.unknown().nullable(),
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
        // Refused before any lookup or allocation.
        resolveModelChoice(args.harness, { model: args.model, reasoningEffort: args.reasoning_effort });
        const actor = await launchActor(args.golden, args.org);
        const chosen: GoldenRecord = await goldenForLaunch(data.goldens, actor, args.golden, args.provider);
        resolveRepositoryDir(chosen, args.repo);
        const provider = await context.provider(chosen);
        const result = await launchSandbox(
          provider,
          {
            goldens: data.goldens,
            sandboxes: data.sandboxes,
            credentials: context.launchCredentials,
            ...(context.connections ? { connections: context.connections } : {}),
          },
          actor,
          {
            golden: args.golden,
            ...(args.size === undefined ? {} : { size: args.size }),
            provider: chosen.provider,
            harness: args.harness,
            ...(args.repo === undefined ? {} : { repo: args.repo }),
            ...(args.model === undefined ? {} : { model: args.model }),
            ...(args.visibility === undefined ? {} : { visibility: args.visibility }),
            ...(args.connections === undefined ? {} : { connections: args.connections }),
            ...(args.credentialId ? { credentialId: args.credentialId } : {}),
            ...(args.reasoning_effort === undefined ? {} : { reasoningEffort: args.reasoning_effort }),
            ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
            ...(args.ttl_seconds === undefined ? {} : { ttlSeconds: args.ttl_seconds }),
          },
          context.launch ?? {},
        );
        return {
          id: result.sandbox.id,
          ...sandboxIds(result.sandbox),
          golden: result.golden.name,
          visibility: result.sandbox.visibility ?? result.golden.visibility,
          harness: result.sandbox.harness,
          repositoryDir: result.sandbox.repositoryDir ?? null,
          model: result.sandbox.model,
          reasoningEffort: result.sandbox.reasoningEffort,
          credentialId: result.sandbox.credentialId ?? null,
          credentialVersion: result.sandbox.credentialVersion ?? null,
          machineSize: result.sandbox.machineSize ?? null,
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
  }

  tool(
    "list",
    {
      title: "List sandboxes",
      description:
        "Allowlisted metadata of sandboxes in your current organizations, newest first. Interior is owner/admin only. " +
        "Deleted ones are left out unless asked for. Statuses are as recorded; call status for a fresh read.",
      input: {
        harness: z.enum(HARNESSES).optional(),
        golden: z.string().uuid().optional().describe("Golden UUID, not a name."),
        owner: z.union([z.string().uuid(), z.literal("me")]).optional(),
        page: z.number().int().min(1).max(1_000_000).optional().describe("1-based page, default 1."),
        status: z.array(z.enum(SANDBOX_STATUSES)).min(1).optional().describe("Only these statuses."),
        limit: z.number().int().min(1).max(200).optional().describe("At most this many. Default 25."),
      },
      output: {
        sandboxes: z.array(sandboxListMetadata),
        total: z.number().int(),
        page: z.number().int(),
        limit: z.number().int(),
        hasMore: z.boolean(),
        nextPage: z.number().int().nullable(),
      },
      readOnly: true,
    },
    async (args) => {
      const statuses: readonly SandboxStatus[] = args.status ?? SANDBOX_STATUSES.filter((name) => name !== "deleted");
      const limit = args.limit ?? 25;
      const page = args.page ?? 1;
      const { rows, total } = await data.sandboxes.list({
        statuses,
        limit,
        page,
        ...(args.harness === undefined ? {} : { harness: args.harness }),
        ...(args.golden === undefined ? {} : { goldenId: args.golden }),
        ...(args.owner === undefined ? {} : { ownerId: args.owner === "me" ? caller.userId : args.owner }),
      });
      const hasMore = page * limit < total;
      return {
        total,
        page,
        limit,
        hasMore,
        nextPage: hasMore && page < 1_000_000 ? page + 1 : null,
        sandboxes: rows,
      };
    },
  );

  tool(
    "resource_advice",
    {
      title: "Resource sizing evidence",
      description:
        "Collects one bounded read-only VM observation and reports the last ten comparable repository sessions. Missing evidence causes abstention; never resizes or changes defaults.",
      input: { id },
      output: { advice: z.unknown() },
    },
    async (args) => {
      const found = await visible(args.id);
      const store = data.resourceObservations;
      if (!store) throw new ToolError("dependency_unavailable", "Resource observation persistence is unavailable.");
      const admission =
        found.resourceProject && found.machineSize?.capacity && ["ready", "running"].includes(found.status)
          ? await store.claim(found.id, context.now())
          : null;
      if (admission) {
        let observation = null;
        try {
          observation = (await (await context.provider(found)).observeResources?.(found.providerSandboxId)) ?? null;
        } catch {
          /* Collection failure is unavailable; never ingest raw provider diagnostics. */
        }
        if (
          observation &&
          validateProviderResourceObservation(observation) &&
          observation.reading.cpuLogicalCpus !== null &&
          observation.reading.memoryTotalBytes !== null
        ) {
          try {
            await store.append(found.id, observation, context.now(), admission);
          } catch (error) {
            if (!(error instanceof GoldenError && error.code === "conflict")) throw error;
          }
        }
      }
      return { advice: summarizeResourceHistory(await store.history(found.id, context.now()), context.now()) };
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
        direction: z.enum(["forward", "backward"]).optional(),
        maxBytes: z.number().int().min(256).max(1048576).optional(),
        coalesce: z.boolean().optional(),
      },
      output: {
        events: z.array(event),
        cursor: z.string().nullable(),
        olderCursor: z.string().optional(),
        hasMore: z.boolean(),
      },
      readOnly: true,
    },
    async (args) => {
      const { sandbox: found, provider } = await live(args.id, true);
      const page = await readLogs(provider, found.providerSandboxId, {
        ...(args.since_cursor ? { since_cursor: args.since_cursor } : {}),
        ...(args.conversation_id ? { conversation_id: args.conversation_id } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
        ...(args.all ? { all: true } : {}),
        ...(args.direction ? { direction: args.direction } : {}),
        ...(args.maxBytes ? { maxBytes: args.maxBytes } : {}),
        ...(args.coalesce !== undefined ? { coalesce: args.coalesce } : {}),
      });
      return { ...page, events: page.events.map((item) => ({ ...item })) };
    },
  );

  tool(
    "report",
    {
      title: "Report a task outcome",
      description:
        "Explicit result for the latest finished turn. Call after wait; never inferred from message text. A new send clears it. Only the sandbox owner or current org admin may report or read it.",
      input: { id, prompt_id: z.string().min(1), outcome: taskOutcome },
      output: { id: z.string(), taskOutcome },
    },
    async (args) => {
      const found = await visible(args.id);
      const provider =
        found.status === "deleted" ||
        found.status === "starting" ||
        (found.status === "failed" && found.stoppedAt !== null)
          ? null
          : await context.provider(found);
      // Empty is a successful-steer marker, not a provider run ID. Null remains
      // unreportable after an ambiguous admission or for legacy rows.
      const target =
        found.taskPromptId === ""
          ? provider
            ? (await latestPrompt(provider, found.providerSandboxId, true))?.promptId
            : null
          : found.taskPromptId;
      if (!target || target !== args.prompt_id)
        throw new ToolError("conflict", "Report only the latest finished turn, using its prompt id.");
      const report = await readStatus(provider, data.sandboxes, found, { promptId: target, now: context.now() });
      if (!report.prompt || report.prompt.state !== "finished")
        throw new ToolError("conflict", "Report only the latest finished turn, using its prompt id.");
      if (!data.sandboxes.reportTaskOutcome) throw new ToolError("conflict", "Task reporting is unavailable.");
      await data.sandboxes.reportTaskOutcome(args.id, found.taskPromptId!, args.outcome, found.lifecycleGeneration);
      return { id: args.id, taskOutcome: args.outcome };
    },
  );

  tool(
    "send",
    {
      title: "Send a prompt",
      description:
        "Gives the agent its next instruction as a new turn. Without conversation_id the first send of an idle " +
        "sandbox opens a conversation and later sends continue the latest one. To redirect a turn that is " +
        "still running, use steer. The turn runs with the model and effort chosen at launch; model and " +
        "reasoning_effort override them for this turn only.",
      input: {
        id,
        prompt: z.string().min(1).describe("The instruction."),
        conversation_id: conversationId,
        model: modelInput,
        reasoning_effort: effortInput,
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
      if (found.credentialId)
        await context.launchCredentials.resolve(
          { userId: caller.userId, orgId: found.orgId, role: "member" },
          found.harness,
          found.credentialId,
          found.credentialVersion ?? undefined,
        );
      const choice = turnModel(found, { model: args.model, reasoningEffort: args.reasoning_effort });
      const conversation = args.conversation_id ?? found.conversationIds.at(-1);
      const machine = await provider.get(found.providerSandboxId);
      if (machine.state === "stopped" && found.stoppedAt === null) {
        await data.sandboxes.update(found.id, {
          status: "stopped",
          stoppedAt: (machine.stoppedAt ?? context.now()).toISOString(),
          ...(machine.stoppedAt ? {} : { usageRuntimeUnknown: true }),
          ...(found.lifecycleGeneration === undefined ? {} : { expectedGeneration: found.lifecycleGeneration }),
        });
      }
      await context.launchCredentials.assertTurn?.(
        { userId: found.ownerId, orgId: found.orgId, role: "member" },
        found.id,
        machine.state === "stopped",
      );
      let acknowledged = false;
      return sandboxActivity(
        data.sandboxes,
        found,
        {
          clearTaskOutcome: true,
          renewLifecycle: machine.state === "stopped",
          stopRequested: false,
          ...(machine.state === "stopped" ? { status: "starting" as const, stoppedAt: null } : {}),
        },
        async (signal) => {
          const receipt = await provider
            .prompt({
              sandboxId: found.providerSandboxId,
              harness: found.harness,
              text: args.prompt,
              signal,
              ...(conversation ? { conversationId: conversation } : {}),
              ...(choice ?? {}),
            })
            .catch(unknownMutationOutcome);
          acknowledged = true;
          const conversationIds = found.conversationIds.includes(receipt.conversationId)
            ? found.conversationIds
            : [...found.conversationIds, receipt.conversationId];
          return {
            patch: {
              status: "running",
              taskPromptId: receipt.promptId,
              statusReason: null,
              conversationIds,
              stoppedAt: null,
              rearmDeadline: receipt.resumed === true,
            },
            result: {
              id: found.id,
              promptId: receipt.promptId,
              conversationId: receipt.conversationId,
              status: receipt.status,
            },
          };
        },
      ).catch((error) => publicationFailure(error, acknowledged));
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
      if (delivery === "restart" && found.credentialId)
        await context.launchCredentials.resolve(
          { userId: caller.userId, orgId: found.orgId, role: "member" },
          found.harness,
          found.credentialId,
          found.credentialVersion ?? undefined,
        );
      const member = caller.orgs.find((entry) => entry.orgId === found.orgId);
      if (!member) throw new ToolError("forbidden", "No current organization membership.");
      await context.connections?.prepare?.(provider, found, {
        userId: caller.userId,
        orgId: found.orgId,
        role: member.role,
      });
      let acknowledged = false;
      return sandboxActivity(
        data.sandboxes,
        found,
        { clearTaskOutcome: true },
        async () => {
          const receipt = await provider
            .steer({
              sandboxId: found.providerSandboxId,
              text: args.text,
              ...(args.conversation_id ? { conversationId: args.conversation_id } : {}),
            })
            .catch(unknownMutationOutcome);
          acknowledged = true;
          return {
            patch: {
              status: "running",
              // Boat returns a steer-record ID; resolve the actual run from events.
              taskPromptId: "",
              conversationIds: found.conversationIds.includes(receipt.conversationId)
                ? found.conversationIds
                : [...found.conversationIds, receipt.conversationId],
            },
            result: {
              id: found.id,
              promptId: receipt.promptId,
              conversationId: receipt.conversationId,
              delivery,
              mode: receipt.mode ?? null,
            },
          };
        },
        {
          failurePatch(error) {
            // A definite refusal admitted no work, so the next send need not wait
            // for lease expiry. Unknown/transport errors retain the bounded lease.
            if (
              error instanceof ProviderError &&
              [
                "no_running_turn",
                "invalid_request",
                "unauthorized",
                "forbidden",
                "not_found",
                "provider_not_configured",
                "sandbox_not_ready",
              ].includes(error.code)
            )
              return {};
            throw error;
          },
        },
      ).catch((error) => publicationFailure(error, acknowledged));
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
      await provider
        .interrupt({
          sandboxId: found.providerSandboxId,
          ...(args.conversation_id ? { conversationId: args.conversation_id } : {}),
        })
        .catch(unknownMutationOutcome);
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
      const managedNative = await context.launchCredentials.assertExec?.(
        { userId: found.ownerId, orgId: found.orgId, role: "member" },
        found.id,
      );
      let acknowledged = false;
      const execute = async () => {
        const membership = caller.orgs.find((member) => member.orgId === found.orgId);
        if (!membership) throw new ToolError("forbidden", "No current organization membership.");
        await context.connections?.prepare?.(provider, found, {
          userId: caller.userId,
          orgId: found.orgId,
          role: membership.role,
        });
        const nativeActor = { userId: found.ownerId, orgId: found.orgId, role: "member" as const };
        const nativeBefore =
          (await context.launchCredentials.nativeSecrets?.(
            nativeActor,
            found.id,
            provider,
            found.providerSandboxId,
            "before",
          )) ?? [];
        const result = await provider
          .exec({
            sandboxId: found.providerSandboxId,
            command: args.command,
            cwd: args.cwd ?? "/home/user",
            timeoutSeconds: args.timeout_seconds ?? 120,
          })
          .catch(unknownMutationOutcome);
        acknowledged = true;
        if (result.detached)
          throw new ToolError(
            "outcome_unknown",
            "The command started in the background. Check sandbox status before retrying.",
          );
        try {
          const nativeAfter =
            (await context.launchCredentials.nativeSecrets?.(
              nativeActor,
              found.id,
              provider,
              found.providerSandboxId,
              "after",
            )) ?? [];
          const secrets = [...(await context.exposedSecrets(found.orgId)), ...nativeBefore, ...nativeAfter];
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
        } catch (error) {
          throw new LaunchError(
            "outcome_unknown",
            "The command ran but its result could not be safely published. Check sandbox status before retrying.",
            { cause: error },
          );
        }
      };
      if (!managedNative) return execute();
      // Stop and native-file mutation must not interleave: a stop receipt sampled
      // before this command cannot authenticate output produced after auto-resume.
      return sandboxActivity(
        data.sandboxes,
        found,
        {},
        async (signal) => {
          signal.throwIfAborted();
          const result = await execute();
          signal.throwIfAborted();
          return { result, patch: {} };
        },
        { deadlineMs: ((args.timeout_seconds ?? 120) + 60) * 1000 },
      ).catch((error) => publicationFailure(error, acknowledged));
    },
  );

  tool(
    "work_recovery",
    {
      title: "Retrieve preserved work",
      description: "Owner/admin only. Returns sensitive base64 recovery archive; never log it.",
      input: { id, recovery_id: z.string().uuid().optional() },
      output: { archive: z.string().nullable() },
      readOnly: true,
    },
    async (args) => {
      const found = await data.sandboxes.get(args.id);
      if (!found) throw new ToolError("not_found", "No such sandbox.");
      return { archive: (await data.sandboxes.readWorkRecovery?.(found.id, args.recovery_id)) ?? null };
    },
  );

  tool(
    "delete",
    {
      title: "Delete a stopped sandbox",
      description:
        "Owner/admin only. Permanently removes provider resources and recovery archives. Stop first. Managed orchestrator parents and children are refused.",
      input: { id },
      output: { id: z.string(), status: z.literal("deleted") },
      destructive: true,
    },
    async (args) => {
      if (!data.sandboxes.assertDeletionAllowed)
        throw new ToolError("unavailable", "Sandbox deletion is not configured.");
      await data.sandboxes.assertDeletionAllowed(args.id);
      const found = await visible(args.id);
      if (found.status === "deleted") return { id: found.id, status: "deleted" as const };
      const deletionProvider = context.deletionProvider;
      if (found.providerSandboxId && !deletionProvider)
        throw new ToolError("unavailable", "Sandbox deletion provider is not configured.");
      const provider = found.providerSandboxId && deletionProvider ? await deletionProvider(found) : null;
      return sandboxActivity(data.sandboxes, found, { deleteRequested: true }, async (signal) => {
        signal.throwIfAborted();
        if (provider) {
          try {
            const receipt = await provider.delete({ sandboxId: found.providerSandboxId });
            if (!["deleted", "completed"].includes(receipt.status))
              throw new ToolError(
                "conflict",
                "Provider deletion is pending. Retry deletion to confirm completion; do not resume this sandbox.",
              );
          } catch (error) {
            if (!(error instanceof ProviderError && error.code === "not_found")) throw error;
          }
        }
        return {
          result: { id: found.id, status: "deleted" as const },
          patch: {
            status: "deleted",
            deletedAt: context.now().toISOString(),
            ...(found.stoppedAt === null ? { usageRuntimeUnknown: true } : {}),
          },
        };
      });
    },
  );

  tool(
    "extend",
    {
      title: "Extend a sandbox lifetime",
      description:
        "Set a later expiry, measured from now. Owner/admin only. Modal extensions must fit inside the current physical machine lifetime; stop and resume for a new physical lifetime.",
      input: { id, ttl_seconds: z.number().int().positive().max(MAX_SANDBOX_EXTENSION_TTL_SECONDS) },
      output: { id: z.string(), expiresAt: z.string(), ttlSeconds: z.number().int() },
    },
    async (args) => {
      const { sandbox, provider } = await live(args.id);
      return extendSandbox(
        data.sandboxes,
        sandbox,
        provider,
        args.ttl_seconds,
        () => context.connections?.renewLifetime?.(provider, sandbox.id) ?? Promise.resolve(),
      );
    },
  );

  tool(
    "stop",
    {
      title: "Stop a sandbox",
      description:
        "Stops the machine. Modal keeps its disk only if checkpoint succeeds; fallback termination returns " +
        "checkpoint_failed_disk_not_retained and cannot resume. Other retained stops can resume on send. Use it when the " +
        "agent is done, so the sandbox stops costing.",
      input: { id },
      output: { id: z.string(), status: z.enum(SANDBOX_STATUSES), preservationNote: z.string().optional() },
      destructive: true,
    },
    async (args) => {
      const { sandbox: found, provider } = await live(args.id, true);
      return sandboxActivity(
        data.sandboxes,
        found,
        {
          status: found.status === "failed" ? "failed" : "stopping",
          stoppedAt: null,
          stopRequested: true,
          ...(found.statusReason === "expired" ? { statusReason: "expired" } : {}),
        },
        async (signal) => {
          signal.throwIfAborted();
          if (
            !(found.status === "stopping" && found.preservationNote?.startsWith("unpushed work could not be preserved"))
          )
            await data.sandboxes.preserveWork?.(found.id, provider, found.providerSandboxId).catch(() => {});
          let terminal = false;
          let stoppedAt: Date | undefined;
          let preservationNote: string | undefined;
          try {
            await provider.stop({ sandboxId: found.providerSandboxId });
            signal.throwIfAborted();
            const observed = await provider.get(found.providerSandboxId);
            terminal = observed.state === "stopped";
            stoppedAt = observed.stoppedAt;
            preservationNote = observed.stopNote;
          } catch (error) {
            if (!(error instanceof ProviderError && error.code === "not_found")) throw error;
            terminal = true;
          }
          signal.throwIfAborted();
          const status: SandboxStatus = found.status === "failed" ? "failed" : terminal ? "stopped" : "stopping";
          return {
            result: { id: found.id, status, ...(preservationNote ? { preservationNote } : {}) },
            patch: {
              status,
              stopRequested: !terminal,
              ...(status === "failed" || found.statusReason === "expired" ? { statusReason: found.statusReason } : {}),
              ...(terminal
                ? {
                    stoppedAt: (stoppedAt ?? context.now()).toISOString(),
                    usageRuntimeUnknown: !stoppedAt && found.stoppedAt === null,
                  }
                : {}),
            },
          };
        },
      );
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

/**
 * What a send runs with: an override, else the sandbox's recorded choice. A sandbox launched before the
 * choice was recorded keeps the provider's default unless the send names a model or an effort. An override
 * applies to this turn only.
 */
function turnModel(
  sandbox: SandboxView,
  requested: { model?: string | undefined; reasoningEffort?: string | undefined },
): ModelChoice | undefined {
  const stored =
    sandbox.model !== null && sandbox.reasoningEffort !== null
      ? { model: sandbox.model, reasoningEffort: sandbox.reasoningEffort }
      : undefined;
  // The recorded choice was checked at launch; it is sent as is, even if the catalog has moved on since.
  if (requested.model === undefined && requested.reasoningEffort === undefined) return stored;
  return resolveModelChoice(sandbox.harness, requested, stored);
}

/** A sandbox's ids, with the Boat field of earlier clients kept for Boat sandboxes only. */
function sandboxIds(row: { provider: SandboxProviderId; providerSandboxId: string }) {
  return {
    provider: row.provider,
    providerSandboxId: row.providerSandboxId,
    boatId: row.provider === "boat" ? row.providerSandboxId : null,
  };
}

const providerLimitsText = Object.entries(PROVIDER_LIMITS)
  .map(([provider, limits]) => `${limits.maxTtlSeconds} (${limits.maxTtlLabel}) on ${provider}`)
  .join(", ");

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
    id: row.id,
    name: row.name,
    orgId: row.orgId,
    visibility: row.visibility,
    ownerId: row.ownerId,
    provider: row.provider,
    providerSnapshotId: row.providerSnapshotId,
    providerSandboxId: row.providerSandboxId,
    modal: row.modal,
    boatSnapshotId: row.provider === "boat" ? row.providerSnapshotId : null,
    boatSandboxId: row.provider === "boat" ? row.providerSandboxId : null,
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
  args: {
    since_cursor?: string;
    conversation_id?: string;
    limit?: number;
    all?: boolean;
    direction?: "forward" | "backward";
    maxBytes?: number;
    coalesce?: boolean;
  },
): Promise<{
  events: Awaited<ReturnType<Provider["events"]>>["events"];
  cursor: string | null;
  olderCursor?: string;
  hasMore: boolean;
}> {
  if (args.direction === "backward" && args.all) throw new Error("Backward reads cannot drain all pages.");
  let olderCursor: string | undefined;
  const events: Awaited<ReturnType<Provider["events"]>>["events"] = [];
  let cursor = args.since_cursor;
  let hasMore = false;
  for (let pageNumber = 0; pageNumber < (args.all ? MAX_LOG_PAGES : 1); pageNumber += 1) {
    const page = await provider.events({
      sandboxId,
      ...(args.direction ? { direction: args.direction } : {}),
      ...(args.maxBytes ? { maxBytes: args.maxBytes } : {}),
      ...(args.coalesce !== undefined ? { coalesce: args.coalesce } : {}),
      ...(cursor ? { cursor } : {}),
      ...(args.conversation_id ? { conversationId: args.conversation_id } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
    });
    olderCursor = page.olderCursor;
    events.push(...page.events);
    hasMore = page.hasMore;
    const next = page.cursor ?? cursor;
    if (!page.hasMore || !next || next === cursor) {
      cursor = next;
      break;
    }
    cursor = next;
  }
  return {
    ...(olderCursor ? { olderCursor } : {}),
    events: dedupe(events).filter((event) => !isPrivateModelEvent(event)),
    cursor: cursor ?? null,
    hasMore,
  };
}

function errorResult(error: unknown, tool: string, logError: (line: string) => void): CallToolResult {
  const { code, message } = describe(error);
  if (["internal", "unavailable", "provider_unavailable", "dependency_unavailable", "outcome_unknown"].includes(code)) {
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
  const failure = apiFailureCode(error);
  if (failure) return { code: failure, message: error instanceof Error ? error.message : failure };
  if (error instanceof ToolError) return { code: error.code, message: error.message };
  if (error instanceof LaunchError) {
    const tail = error.sandboxId ? ` Sandbox ${error.sandboxId} is recorded as failed and its machine is stopped.` : "";
    return { code: error.code, message: `${error.message}${tail}` };
  }
  if (error instanceof GoldenError) return { code: error.code, message: error.message };
  if (error instanceof ProviderRoutingError) return { code: error.code, message: error.message };
  if (error instanceof ProviderError) {
    if (error.code === "no_running_turn") {
      return { code: error.code, message: "No turn is running. Use send to start one." };
    }
    return { code: error.code, message: error.message };
  }
  if (error instanceof VaultError)
    return {
      code: error.code.startsWith("credential_binding_")
        ? error.code
        : error.code === "unavailable"
          ? "dependency_unavailable"
          : "missing_credential",
      message: error.message,
    };
  if (error instanceof EncryptionKeyError) return { code: "dependency_unavailable", message: error.message };
  if (error instanceof DataError)
    return { code: error.code === "unavailable" ? "dependency_unavailable" : error.code, message: error.message };
  return { code: "internal", message: "Armada could not complete the call." };
}

/** This catch belongs on the dispatch itself, never on preparation or provider reads. */
function unknownMutationOutcome(error: unknown): never {
  if (!(error instanceof ProviderError) || error.code === "unavailable" || error.code === "unknown")
    throw new LaunchError(
      "outcome_unknown",
      "The operation outcome is unknown. Check sandbox status before retrying.",
      { cause: error },
    );
  throw error;
}

function publicationFailure(error: unknown, acknowledged: boolean): never {
  if (acknowledged)
    throw new LaunchError(
      "outcome_unknown",
      "The operation was accepted but its result could not be published. Check sandbox status before retrying.",
      { cause: error },
    );
  throw error;
}
