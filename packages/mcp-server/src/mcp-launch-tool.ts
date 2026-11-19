import { launchResponse } from "@armada/core";
import { launch } from "@armada/core/contract";
import {
  type GoldenRecord,
  goldenForLaunch,
  HARNESSES,
  launchSandbox,
  resolveModelChoice,
  resolveRepositoryDir,
  SANDBOX_PROVIDERS,
  VaultError,
} from "@armada/core/server";
import * as z from "zod";
import { UUID } from "./control-input.ts";
import { INTERNAL_FAILURE_MESSAGE } from "./control-response.ts";
import { prepareGoldenLaunchAccount } from "./launch-account-admission.ts";
import { observeGoldenLaunch } from "./request-timing.ts";
import { externalRefOutput, modelOutput, SANDBOX_STATUSES, skillReceipts } from "./sandbox-tool-schemas.ts";
import { ToolError } from "./tool-error.ts";
import type { ToolContext } from "./tools.ts";

const providerOutput = z.enum(SANDBOX_PROVIDERS).describe("The sandbox provider it runs on, fixed for its life.");
const compat = (name: string) =>
  z.string().nullable().describe(`The same as ${name} on a Boat golden or sandbox; null on any other provider.`);

const [ordinaryBoatLaunch, , ordinaryModalLaunch] = launch.input.body.options;
const mcpLaunchOmissions = { armadaAccess: true, armadaAccessVersion: true } as const;
const mcpLaunchInput = z.union([
  ordinaryBoatLaunch.omit(mcpLaunchOmissions),
  ordinaryModalLaunch.omit(mcpLaunchOmissions),
]);
const mcpLaunchArguments = z.looseObject({}).meta({
  anyOf: mcpLaunchInput.options.map((variant) => {
    const { $schema: _dialect, ...schema } = z.toJSONSchema(variant, { io: "input" });
    return schema;
  }),
});

export const mcpLaunchContract = {
  title: "Launch an agent",
  description:
    "Forks a golden into a new sandbox, pulls its repos, runs its init commands, and starts the agent. " +
    "With `prompt` the agent starts working at once (status running). Without it the sandbox is left ready " +
    "and the conversation starts at the first `send`. The sandbox gets only your (or your org's) Armada " +
    "credentials for this agent, never the boat.dev account's. When the caller connected GitHub, git and gh in " +
    "the sandbox act as that person (8 hour token): see `github` in the answer. Setup can take a few minutes. " +
    "Personal sessions may use an org slug or UUID. For scoped tokens, omit `org` or use the scoped org UUID.",
  input: mcpLaunchArguments,
  output: {
    id: z.string(),
    provider: providerOutput,
    runtime: z.object({ kind: z.literal("armada"), epoch: z.string() }).optional(),
    runtimeTransport: z.literal("dialout").optional(),
    providerSandboxId: z.string(),
    boatId: compat("providerSandboxId"),
    golden: z.string(),
    externalRef: externalRefOutput,
    visibility: z.enum(["org", "private"]),
    harness: z.enum(HARNESSES),
    helper: z.unknown(),
    skills: skillReceipts,
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
        tokenExpiresAt: z.string().nullable(),
        message: z.string().nullable(),
      })
      .describe(
        "Whether git and gh in the sandbox act as the caller. Anything but connected means they are not signed in; message says how to fix it.",
      ),
  },
};

export function runMcpLaunch(context: ToolContext, input: unknown) {
  const { data } = context;
  return observeGoldenLaunch("mcp", async (timing) => {
    const parsed = mcpLaunchInput.safeParse(input);
    if (!parsed.success) throw new VaultError("invalid", "Invalid golden launch request. See the launch tool schema.");
    const args = parsed.data;
    resolveModelChoice(args.harness, { model: args.model, reasoningEffort: args.reasoningEffort });
    const actor = await launchActor(context, args.golden, args.org);
    const chosen: GoldenRecord = await goldenForLaunch(data.goldens, actor, args.golden, args.provider);
    resolveRepositoryDir(chosen, args.repo);
    timing.checkpoint("admission");
    const prepare = async () => {
      const account = await prepareGoldenLaunchAccount(
        actor,
        chosen,
        args,
        context.launchCredentials,
        context.launch ?? {},
      );
      timing.checkpoint("account_resolution");
      const provider = await context.provider(chosen);
      timing.checkpoint("provider_resolution");
      return { ...account, provider };
    };
    let prepared: ReturnType<typeof prepare> | undefined;
    const prepareOnce = () => (prepared ??= prepare());
    const dispatch = async (receiptId?: string) => {
      const { provider, credentials, options } = await prepareOnce();
      timing.checkpoint("receipt_admission");
      const result = await launchSandbox(
        provider,
        {
          ...(context.skillDefaults ? { skillDefaults: context.skillDefaults } : {}),
          goldens: data.goldens,
          sandboxes: data.sandboxes,
          credentials,
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
          ...(args.skipSkillDefaults === undefined ? {} : { skipSkillDefaults: args.skipSkillDefaults }),
          ...(args.skills === undefined ? {} : { skills: args.skills }),
          ...(args.helperCapabilities === undefined ? {} : { helperCapabilities: args.helperCapabilities }),
          ...(args.connections === undefined ? {} : { connections: args.connections }),
          ...(args.credentialId ? { credentialId: args.credentialId } : {}),
          ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
          ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
          ...(args.ttlSeconds === undefined ? {} : { ttlSeconds: args.ttlSeconds }),
          ...(args.stopWhenWorkMerged === undefined ? {} : { stopWhenWorkMerged: args.stopWhenWorkMerged }),
          ...(args.externalRef === undefined ? {} : { externalRef: args.externalRef }),
        },
        { ...options, ...(receiptId ? { newId: () => receiptId } : {}) },
      );
      timing.checkpoint("shared_launcher");
      timing.launched(result.sandbox);
      return {
        ...launchResponse(result),
        helper: result.helper,
        visibility: result.sandbox.visibility ?? result.golden.visibility,
      };
    };
    if (!context.ordinaryLaunchReceipts) {
      if (args.idempotencyKey) throw new ToolError("invalid", "Durable launch receipts are not configured.");
      return dispatch();
    }
    const { provider } = await prepareOnce();
    const authority = {
      target: {
        provider: chosen.provider,
        orgId: chosen.orgId,
        visibility: chosen.visibility,
        modal: chosen.modal,
      },
      management:
        (await provider.managementIdentity?.()) ??
        (() => {
          throw new ToolError("invalid", "Provider cannot pin management authority.");
        })(),
      backendId:
        (await provider.backendIdentity?.())?.id ??
        (() => {
          throw new ToolError("invalid", "Provider cannot pin allocation authority.");
        })(),
    };
    return context.ordinaryLaunchReceipts.run(
      actor,
      args.idempotencyKey ?? crypto.randomUUID(),
      { ...args, goldenId: chosen.id },
      dispatch,
      authority,
    );
  });
}

async function launchActor({ caller, data }: ToolContext, name: string, org: string | undefined) {
  const member = (orgId: string) => {
    const found = caller.orgs.find((item) => item.orgId === orgId);
    return found ? { userId: caller.userId, orgId: found.orgId, role: found.role } : null;
  };
  if (org !== undefined) {
    const ref = org.trim().toLowerCase();
    const orgId = UUID.test(ref)
      ? ref
      : caller.orgs.find(({ orgId }) => caller.orgNames?.[orgId]?.trim().toLowerCase() === ref)?.orgId;
    const chosen = orgId ? member(orgId) : null;
    if (!chosen) throw new ToolError("not_found", `You are not a member of org '${org}'.`);
    return chosen;
  }
  const [first] = caller.orgs;
  if (!first) throw new ToolError("not_found", "You are not a member of any org.");
  if (caller.orgs.length === 1) return member(first.orgId) ?? fail();
  const holders: string[] = [];
  for (const { orgId } of caller.orgs) if ((await data.goldens.findByName(orgId, name)).length > 0) holders.push(orgId);
  if (holders.length > 1) {
    throw new ToolError("invalid_request", `'${name}' is a golden in several of your orgs. Pass org (a slug or UUID).`);
  }
  return member(holders[0] ?? first.orgId) ?? fail();
}

function fail(): never {
  throw new ToolError("internal", INTERNAL_FAILURE_MESSAGE);
}
