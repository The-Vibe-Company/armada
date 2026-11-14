import { expect, test } from "bun:test";
import type { Provider } from "@armada/core";
import { createRuntimeAgent } from "../src/runtime-agent.ts";
import { createRuntimeProvider } from "../src/runtime-provider.ts";
import { createRuntimeServing } from "../src/runtime-serving.ts";
import { callSharedTool } from "../src/tool-api.ts";
import { runtimeFixture } from "./runtime-fixture.ts";
import { ENCRYPTION_KEY } from "./support.ts";

for (const placement of ["boat", "modal"] as const)
  test(`${placement} control tools reach the enrolled runtime, preserve turn identity and redact bounded exec output without native hooks`, async () => {
    const f = await runtimeFixture(undefined, placement);
    try {
      const agent = createRuntimeAgent(f.bridge, {
        harness: "codex",
        ownerId: f.people.owner,
        sandboxId: f.row.id,
        providerSandboxId: "physical",
        cwd: f.root,
        defaults: { model: "gpt-5.4", reasoningEffort: "high" },
      });
      const provider = createRuntimeProvider({ id: placement } as Provider, "physical", agent, {
        ...agent,
        steer: (request) => agent.steer({ ...request, conversationId: f.first.conversationId }),
      });
      const context = {
        ...f.context,
        provider: async () => provider,
        exposedSecrets: async () => ["PRIVATE_SENTINEL"],
      };
      const output = await callSharedTool(context, "exec", {
        id: f.row.id,
        command: "printf PRIVATE_SENTINEL; printf problem >&2; exit 7",
        cwd: f.root,
      });
      expect(output).toMatchObject({ exitCode: 7, stderr: "problem", timedOut: false });
      expect(JSON.stringify(output)).not.toContain("PRIVATE_SENTINEL");
      const clipped = await callSharedTool(context, "exec", {
        id: f.row.id,
        command: "printf '%70000s' x",
        cwd: f.root,
      });
      expect(clipped).toMatchObject({ truncated: true });
      await expect(callSharedTool(context, "steer", { id: f.row.id, text: "late" })).rejects.toMatchObject({
        code: "no_running_turn",
      });
      let finish!: (status: "interrupted") => void;
      f.hold(
        new Promise((resolve) => {
          finish = resolve;
        }),
        () => finish("interrupted"),
      );
      const turn = await agent.prompt({
        sandboxId: "physical",
        harness: "codex",
        conversationId: f.first.conversationId,
        text: "working",
      });
      expect(await callSharedTool(context, "steer", { id: f.row.id, text: "redirect" })).toMatchObject({
        promptId: turn.promptId,
        conversationId: turn.conversationId,
        delivery: "restart",
      });
      expect(await callSharedTool(context, "interrupt", { id: f.row.id })).toMatchObject({ interrupted: true });
      expect(await agent.getPrompt({ sandboxId: "physical", promptId: turn.promptId })).toMatchObject({
        status: "interrupted",
        done: true,
      });
      const serving = await createRuntimeServing(f.sql, ENCRYPTION_KEY)(
        { id: placement } as Provider,
        {
          id: f.row.id,
          ...(placement === "boat" ? { boatRuntime: true } : { runtimeTransport: "dialout" as const }),
          provider: placement,
          orgId: f.row.orgId,
          visibility: f.row.visibility ?? "org",
          modal: null,
        },
        { userId: f.people.owner },
      );
      await f.db.query("update credentials set status='revoked' where id=$1", [f.account.id]);
      await expect(serving.steer({ sandboxId: "physical", text: "unauthorized restart" })).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(agent.exec({ sandboxId: "other", command: "true" })).rejects.toMatchObject({
        code: "invalid_request",
      });
      await expect(
        callSharedTool({ ...context, caller: { ...f.caller, userId: f.people.member } }, "exec", {
          id: f.row.id,
          command: "true",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      await f.close();
    }
  });
