import { HOST_CAPABILITIES, ProviderRoutingError } from "@armada/core";
import { launch, launchEnvelope, modalLaunchReceipt } from "@armada/core/contract";
import {
  type GoldenRecord,
  goldenForLaunch,
  LaunchError,
  launchSandbox,
  requireRuntimeHarness,
  resolveModelChoice,
  resolveRepositoryDir,
  VaultError,
} from "@armada/core/server";
import * as z from "zod";
import { UUID } from "./control-input.ts";
import { INTERNAL_FAILURE_MESSAGE } from "./control-response.ts";
import { prepareGoldenLaunchAccount } from "./launch-account-admission.ts";
import { goldenLaunchResponse, publicLaunchReceipt } from "./launch-response-schemas.ts";
import { observeGoldenLaunch } from "./request-timing.ts";
import { ToolError } from "./tool-error.ts";
import type { ToolContext } from "./tools.ts";

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

const launchOutput = z.union([modalLaunchReceipt, launchEnvelope]);
const mcpLaunchOutput = z
  .looseObject({})
  .superRefine((value, ctx) => {
    if (!launchOutput.safeParse(value).success) ctx.addIssue({ code: "custom", message: "Invalid launch receipt" });
  })
  .meta({
    anyOf: launchOutput.options.map((variant) => {
      const { $schema: _dialect, ...schema } = z.toJSONSchema(variant);
      return schema;
    }),
  });

export const mcpLaunchContract = {
  title: "Launch an agent",
  description: launch.mcpDescription,
  input: mcpLaunchArguments,
  output: mcpLaunchOutput,
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
    requireRuntimeHarness(chosen.provider, args.harness);
    resolveRepositoryDir(chosen, args.repo);
    timing.checkpoint("admission");
    const request = {
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
    };
    const payload = { ...args, goldenId: chosen.id };
    if (HOST_CAPABILITIES[chosen.provider].goldenLaunchAdmission) {
      if (!context.admitModalLaunch)
        throw new ProviderRoutingError(
          "provider_routing_unavailable",
          chosen.provider,
          "Modal launch admission is unavailable.",
        );
      return context.admitModalLaunch(
        actor,
        chosen,
        { ...data, ...(context.skillDefaults ? { skillDefaults: context.skillDefaults } : {}) },
        request,
        args.idempotencyKey === undefined ? undefined : { request: { key: args.idempotencyKey, payload } },
      );
    }
    const prepare = async () => {
      const account = await prepareGoldenLaunchAccount(
        actor,
        chosen,
        args,
        context.launchCredentials,
        context.launch ?? {},
      );
      timing.checkpoint("account_resolution");
      const provider = account.placement
        ? await account.placement.provider(actor, chosen)
        : await context.provider(chosen);
      if (provider.id !== chosen.provider)
        throw new ToolError("invalid", "Runtime placement must retain the golden provider.");
      timing.checkpoint("provider_resolution");
      return { ...account, provider };
    };
    let prepared: ReturnType<typeof prepare> | undefined;
    const prepareOnce = () => (prepared ??= prepare());
    const dispatch = async (receiptId?: string) => {
      const { provider, credentials, options, placement } = await prepareOnce();
      const connections = placement?.connections ?? context.connections;
      timing.checkpoint("receipt_admission");
      const result = await launchSandbox(
        provider,
        {
          ...(context.skillDefaults ? { skillDefaults: context.skillDefaults } : {}),
          goldens: data.goldens,
          sandboxes: data.sandboxes,
          credentials,
          ...(connections ? { connections } : {}),
        },
        actor,
        request,
        { ...options, ...(receiptId ? { newId: () => receiptId } : {}) },
      );
      timing.checkpoint("shared_launcher");
      timing.launched(result.sandbox);
      return goldenLaunchResponse(result);
    };
    if (!context.ordinaryLaunchReceipts) {
      if (args.idempotencyKey) throw new ToolError("invalid", "Durable launch receipts are not configured.");
      return dispatch();
    }
    const receipts = context.ordinaryLaunchReceipts;
    const key = args.idempotencyKey ?? crypto.randomUUID();
    const saved = args.idempotencyKey ? await receipts.replay(actor, key, payload) : undefined;
    const receipt = saved ? saved.response : await admit();
    const envelope = launchEnvelope.safeParse(receipt);
    if (!envelope.success)
      throw new LaunchError(
        "outcome_unknown",
        "The saved launch receipt cannot be returned. Inspect the original sandbox through list. Do not use a new key.",
      );
    return publicLaunchReceipt(envelope.data);

    async function admit() {
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
      return receipts.run(actor, key, payload, dispatch, authority);
    }
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
