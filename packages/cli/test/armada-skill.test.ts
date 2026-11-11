import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

// The public skill is an independent consumer of the CLI, not a copied flag inventory.
// A renamed command/flag or invalid example must fail before reaching the fake API.
test("every terminal example in the Armada skill reaches CLI help or the API boundary", async () => {
  const skill = await readFile(new URL("../../../skills/armada/SKILL.md", import.meta.url), "utf8");
  const examples = [...skill.matchAll(/^armada (.+)$/gm)];
  expect(examples.length).toBeGreaterThan(0);
  for (const [, line] of examples) {
    // Redirection is shell syntax; do not write recovery data while validating CLI arguments.
    const command = line?.replace(/ > RECOVERY_FILE$/, "");
    const argv = (command?.match(/"[^"]*"|\S+/g) ?? []).map((word) => word.replace(/^"|"$/g, ""));
    const id = "11111111-1111-4111-8111-111111111111";
    const resolved = argv.map((word) => (["SANDBOX", "ORG", "TEMPLATE"].includes(word) ? id : word));
    let reachedApi = false;
    let output = "";
    const io = {
      out: (s: string) => {
        output += s;
      },
      err: (s: string) => {
        output += s;
      },
    };
    const auth = {
      ...io,
      env: { ARMADA_TOKEN: "fixture", ARMADA_URL: "https://armada.test" },
      session: memorySessionStore(),
      preferences: { read: async () => id, write: async () => {} },
      now: () => new Date(0),
      open: () => {
        reachedApi = true;
        throw new Error("Example must not open a browser");
      },
      fetch: async () => {
        reachedApi = true;
        return Response.json({ error: { code: "unauthorized", message: "Fixture boundary" } }, { status: 401 });
      },
    };
    const code = await run(resolved, io, {
      auth,
      readFile: async () => "fixture",
    });
    expect(
      reachedApi ||
        (code === 0 &&
          (resolved.includes("--help") || resolved.includes("--version") || resolved.join(" ") === "org current")),
      `${line}: ${output}`,
    ).toBe(true);
  }
});
