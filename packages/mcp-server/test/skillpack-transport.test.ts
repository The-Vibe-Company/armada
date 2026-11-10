import { expect, test } from "bun:test";
import { installSkill, type Provider } from "@armada/core/server";
import { catalogLock, catalogReceipt, catalogReference } from "./fixtures/skillpack-catalog.ts";

test("trusted install transport retains shared receipt validation and sanitized failures", async () => {
  const provider = {
    exec: () => {
      throw new Error("Unexpected default transport");
    },
  } as unknown as Provider;
  const run = (stdout: string) =>
    installSkill(
      provider,
      "sandbox",
      "/home/user/repo",
      "codex",
      catalogReference,
      async ({ installCommand, receiptCommand }) => {
        expect(installCommand).toStartWith("skillpack install ");
        expect(installCommand).not.toContain("cat ");
        expect(receiptCommand).toBe("cat '/home/user/repo/.companion/skills.lock.json'");
        return { detached: false, exitCode: 0, stdout, stderr: "", timedOut: false, truncated: false };
      },
    );
  expect(await run(catalogLock("codex"))).toEqual(catalogReceipt);
  await expect(run(catalogLock("claude-code"))).rejects.toThrow("Skillpack installation failed:");
  await expect(
    installSkill(provider, "sandbox", "/home/user/repo", "codex", catalogReference, async () => {
      throw new Error("guest-detail-must-not-escape");
    }),
  ).rejects.toThrow("Skillpack installation failed: native CLI, public pin or verified receipt unavailable.");
});
