import { expect, test } from "bun:test";
import { installSkill, type Provider } from "../src/server.ts";
import { catalogLock, catalogReceipt, catalogReference } from "./support/skillpack-catalog.ts";

test("public install uses provider exec with shared receipt validation and sanitized failures", async () => {
  let output = "";
  let fail = false;
  let exitCode = 0;
  const provider = {
    exec: async ({ command }: { command: string }) => {
      expect(command).toContain("skillpack install ");
      expect(command).toEndWith("&& cat '/home/user/repo/.companion/skills.lock.json'");
      if (fail) throw new Error("guest-detail-must-not-escape");
      return { detached: false, exitCode, stdout: output, stderr: "", timedOut: false, truncated: false };
    },
  } as unknown as Provider;
  const run = (stdout: string) => {
    output = stdout;
    return installSkill(provider, "sandbox", "/home/user/repo", "codex", catalogReference);
  };
  expect(await run(catalogLock("codex"))).toEqual(catalogReceipt);
  await expect(run(catalogLock("claude-code"))).rejects.toThrow("Skillpack installation failed:");
  exitCode = 127;
  await expect(run("")).rejects.toThrow("skillpack_cli_unavailable. Rebuild the golden with armada golden update");
  exitCode = 0;
  fail = true;
  await expect(run("")).rejects.toThrow("skillpack_transport_failed");
});
