import { expect, test } from "bun:test";
import { ARMADA_URL, DEMO_TOML, FakeLinear, fakeArmada, NOW, recordedFetch } from "../../core/test/support.ts";
import { type Io, run } from "../src/cli.ts";
import { detectCoordinator } from "../src/presence.ts";

function terminal(env: Io["env"]): Io {
  return {
    cwd: "/work/widgets",
    env,
    machineName: "synthetic-machine",
    ttyName: "tty/one",
    readFile: async (path) => (path.endsWith("armada.toml") ? DEMO_TOML : null),
    stdout: () => {},
    stderr: () => {},
    ghToken: () => null,
    now: () => NOW,
  };
}

test("harness detection uses only exposed facts, with Conductor taking precedence", () => {
  expect(detectCoordinator(terminal({}))).toMatchObject({
    harness: "terminal",
    handle: "synthetic-machine/tty/one",
    model: null,
  });
  expect(detectCoordinator(terminal({ CODEX_THREAD_ID: "thread", CODEX_MODEL: "code-model" }))).toMatchObject({
    harness: "codex",
    model: "code-model",
  });
  expect(
    detectCoordinator(terminal({ CLAUDECODE: "1", CLAUDE_MODEL: "claude-model", CODEX_THREAD_ID: "thread" })),
  ).toMatchObject({ harness: "claude-code", model: "claude-model" });
  expect(
    detectCoordinator(
      terminal({
        CONDUCTOR_WORKSPACE_ID: "workspace",
        CONDUCTOR_SESSION_ID: "session",
        CONDUCTOR_MODEL: "cloud-model",
        CLAUDECODE: "1",
      }),
    ),
  ).toMatchObject({ harness: "conductor-cloud", handle: "workspace/session", model: "cloud-model" });
  expect(
    detectCoordinator(terminal({ CONDUCTOR_WORKSPACE_ID: "workspace", SECRET_MODEL_KEY: "never-recorded" })),
  ).toMatchObject({ handle: "workspace", model: null });
});

test.each([
  { command: ["status", "--json"] },
  { command: ["inbox", "--json"] },
  { command: ["watch", "--json"] },
  { command: ["merge", "9", "--dry-run"] },
  { command: ["brief", "DEMO-7", "--json"] },
])("$command records coordinator command facts", async ({ command }) => {
  const key = "synthetic-key";
  const armada = fakeArmada({ keys: { [key]: "coordinator" } });
  const net = recordedFetch();
  const io = terminal({
    LINEAR_API_KEY: "synthetic",
    GITHUB_TOKEN: "synthetic",
    ARMADA_API_URL: ARMADA_URL,
    ARMADA_API_KEY: key,
    CODEX_THREAD_ID: "thread",
    CODEX_MODEL: "code-model",
  });
  io.fetch = (url, init) => (url.startsWith(ARMADA_URL) ? armada.fetch(url, init) : net.fetch(url, init));
  io.linearWriter = () => new FakeLinear();
  await run([...command], io);
  expect(armada.calls.some((call) => call.path === "fleet/coordinator")).toBe(true);
  expect(await armada.store.getCoordinatorPresence("widgets")).toMatchObject({
    harness: "codex",
    model: "code-model",
    handle: "synthetic-machine/tty/one",
    startedAt: NOW.toISOString(),
  });
});
