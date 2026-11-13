import { expect, test } from "bun:test";
import type { RunnerRequest } from "@armada/agent-runtime";
import { createRuntimeAgent } from "../src/runtime-agent.ts";

test("skill handoff fences both RPCs to the enrolled epoch and refuses an older guest before disclosing the key", async () => {
  let supported = false;
  const calls: RunnerRequest[] = [],
    key = `cmp_pat_${"a".repeat(48)}`;
  let reference = "notes@1.2.3";
  let malformed = false;
  const agent = createRuntimeAgent(
    {
      async call(_owner, command, options) {
        expect(options?.expectedEpoch).toBe("7");
        calls.push(command);
        return {
          status: 200,
          epoch: "7",
          requestId: command.requestId,
          body: {
            version: 1,
            requestId: command.requestId,
            result:
              command.op === "health"
                ? { ready: true, generation: "7", ...(supported ? { skillsVersion: 1 } : {}) }
                : {
                    receipts: [
                      malformed
                        ? null
                        : {
                            reference,
                            version: "1.2.3",
                            skillId: "a".repeat(36),
                            checksum: `sha256:${"b".repeat(64)}`,
                            origin: "https://skillpack.app/v1",
                            workspaceId: reference.includes("/") ? key : "11111111-1111-4111-8111-111111111111",
                            ignoredDiagnostic: key,
                          },
                    ],
                  },
          },
        };
      },
    },
    {
      harness: "codex",
      ownerId: "owner",
      sandboxId: "logical",
      providerSandboxId: "physical",
      cwd: "/home/user",
      defaults: { model: "gpt-5.4", reasoningEffort: "high" },
    },
  );
  await expect(agent.installSkills([reference], key, "7")).rejects.toMatchObject({
    reason: "skillpack_transport_failed",
  });
  expect(calls.map((c) => c.op)).toEqual(["health"]);
  expect(JSON.stringify(calls)).not.toContain(key);
  supported = true;
  const receipts = await agent.installSkills([reference], key, "7");
  expect(calls.at(-1)).toMatchObject({
    op: "installSkills",
    input: { harness: "codex", references: [reference], key, cwd: "/home/user" },
  });
  expect(receipts).toHaveLength(1);
  expect(JSON.stringify(receipts)).not.toContain(key);
  reference = "catalog/notes@1.2.3";
  const publicReceipts = await agent.installSkills([reference], null, "7");
  expect(JSON.stringify(publicReceipts)).not.toContain(key);
  expect(publicReceipts[0]?.workspaceId).toBeUndefined();
  malformed = true;
  await expect(agent.installSkills([reference], key, "7")).rejects.toMatchObject({
    reason: "skillpack_receipt_invalid",
  });
});
