import { ProviderRoutingError } from "@armada/core";
import { launch, modalLaunchReceipt } from "@armada/core/contract";
import {
  type GoldenRecord,
  goldenForLaunch,
  requireRuntimeHarness,
  resolveModelChoice,
  resolveRepositoryDir,
  VaultError,
} from "@armada/core/server";
import * as z from "zod";
import { UUID } from "./control-input.ts";
import { INTERNAL_FAILURE_MESSAGE } from "./control-response.ts";
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

export const mcpLaunchContract = {
  title: "Launch an agent",
  description: launch.mcpDescription,
  input: mcpLaunchArguments,
  output: modalLaunchReceipt,
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
    if (!context.admitModalLaunch)
      throw new ProviderRoutingError(
        "provider_routing_unavailable",
        chosen.provider,
        "Golden launch admission is unavailable.",
      );
    return context.admitModalLaunch(
      actor,
      chosen,
      { ...data, ...(context.skillDefaults ? { skillDefaults: context.skillDefaults } : {}) },
      request,
      args.idempotencyKey === undefined ? undefined : { request: { key: args.idempotencyKey, payload } },
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
