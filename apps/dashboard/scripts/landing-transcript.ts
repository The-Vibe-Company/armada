// The landing's terminal session (#564), printed by the Armada CLI's own code:
// `run()` from packages/cli, against a recorded Armada API. Only the server's
// answers below are written by hand; every line the terminal shows is what the
// CLI prints for them. `bun apps/dashboard/scripts/landing-transcript.ts` writes
// src/components/landing/transcript.ts; test/landing.test.ts holds the two equal.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../../packages/cli/src/run.ts";
import { memorySessionStore } from "../../../packages/cli/src/session.ts";
import type { TerminalCommand } from "../src/components/landing/terminal-types.ts";

const SANDBOX = "6f1c2a9e-4b7d-4e2a-9c51-3d8e0f7a2b14";
const repo = (name: string) => ({ url: `https://github.com/acme/${name}.git`, branch: "main", dir: name });
const golden = (name: string, provider: "boat" | "modal", repos: string[]) => ({
  id: `golden-${name}`,
  orgId: "org-acme",
  name,
  visibility: "org",
  ownerId: "owner-lea",
  provider,
  providerSandboxId: null,
  providerSnapshotId: `snapshot-${name}`,
  modal: null,
  config: { repos: repos.map(repo), init: ["bun install"] },
  createdAt: "2026-11-02T09:00:00.000Z",
});

/** What the Armada API answers, by route. */
const API: Record<string, unknown> = {
  "/api/v1/golden/list": {
    goldens: [golden("widgets", "boat", ["widgets", "widgets-api"]), golden("gadgets", "modal", ["gadgets"])],
  },
  "/api/v1/sandbox/launch": {
    sandbox: {
      id: SANDBOX,
      provider: "boat",
      providerSandboxId: "bx_7k2m9q",
      goldenId: "golden-widgets",
      orgId: "org-acme",
      ownerId: "owner-lea",
      harness: "codex",
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
      visibility: "org",
      status: "running",
      conversationIds: ["conversation-1"],
      createdAt: "2026-11-09T09:30:00.000Z",
      stoppedAt: null,
      deletedAt: null,
    },
    golden: golden("widgets", "boat", ["widgets", "widgets-api"]),
    github: { status: "connected", login: "lea-acme", message: null, tokenExpiresAt: "2026-11-09T17:30:00.000Z" },
    ttlSeconds: 14_400,
    expiresAt: "2026-11-09T13:30:00.000Z",
    conversationId: "conversation-1",
    promptId: "prompt-1",
  },
  "/api/v1/logs/read": {
    events: [
      "Fix the flaky checkout test in widgets",
      "The checkout test reads the clock twice; it fails when a second ticks between the two reads.",
      "I pass one fixed time through the test instead. 214 tests pass, ten runs in a row.",
      "Pushed fix/checkout-clock and opened pull request #52.",
    ].map((text, k) => ({
      id: `event-${k + 1}`,
      at: `2026-11-09T09:3${k}:00.000Z`,
      ...(k === 0
        ? { kind: "prompt", text, status: "finished" }
        : { kind: "message", text, partial: false, tools: [] }),
    })),
    cursor: "event-4",
    hasMore: false,
    settled: true,
  },
};

const SESSION = [
  ["golden", "list"],
  ["launch", "widgets", "--agent", "codex", "Fix the flaky checkout test in widgets", "--ttl", "4h"],
  ["logs", SANDBOX],
];

const quote = (word: string) => (/\s/.test(word) ? `"${word}"` : word);

/** Each command of the session and what the CLI printed for it. */
export async function landingTranscript(): Promise<TerminalCommand[]> {
  const session: TerminalCommand[] = [];
  for (const argv of SESSION) {
    let out = "";
    let err = "";
    const code = await run(
      argv,
      { out: (text) => (out += text), err: (text) => (err += text) },
      {
        auth: {
          out: () => undefined,
          err: () => undefined,
          env: {
            ARMADA_TOKEN: "armada_sk_landingtranscriptlandingtranscriptland12",
            ARMADA_URL: "https://armada.test",
          },
          fetch: async (input, init) => {
            const request = input instanceof Request ? input : new Request(String(input), init);
            const answer = API[new URL(request.url).pathname];
            return answer === undefined ? new Response("not found", { status: 404 }) : Response.json(answer);
          },
          now: () => new Date("2026-11-09T09:30:00.000Z"),
          open: () => undefined,
          session: memorySessionStore(),
        },
      },
    );
    if (code !== 0) throw new Error(`armada ${argv.join(" ")} exited ${code}: ${err}`);
    session.push({ command: `armada ${argv.map(quote).join(" ")}`, output: out.trimEnd() });
  }
  return session;
}

if (import.meta.main) {
  const transcript = await landingTranscript();
  const file = join(import.meta.dir, "../src/components/landing/transcript.ts");
  writeFileSync(
    file,
    `// Written by \`bun apps/dashboard/scripts/landing-transcript.ts\` from the Armada CLI's own code: do not edit.\nimport type { TerminalCommand } from "./terminal-types";\n\nexport const TRANSCRIPT: TerminalCommand[] = ${JSON.stringify(transcript, null, 2)};\n`,
  );
  // In the repository's own style, so a rerun leaves `bun run lint` clean and changes the file only when the CLI does.
  const format = Bun.spawnSync(["bunx", "biome", "format", "--write", file], {
    cwd: join(import.meta.dir, "../../.."),
  });
  if (format.exitCode !== 0) throw new Error(`biome format failed: ${format.stderr.toString()}`);
}
