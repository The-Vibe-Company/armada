import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  type AgentEvent,
  dedupeEvents,
  type GoldenRecord,
  type PromptStatus,
  type Provider,
  parseGoldenConfig,
  promptOutcome,
} from "../src/index.ts";
import { prepareLaunchWorkspace } from "../src/launch-workspace.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT = `a${"1".repeat(62)}`;
const IDENTITY = {
  login: "octocat",
  id: 583231,
  name: "The Octocat",
  email: "583231+octocat@users.noreply.github.com",
};

describe("prompt outcome", () => {
  test("finished with a usage limit or an expired login is a failure, even though boat says finished", async () => {
    const limit = other_event("usage_limit", { message: "Weekly limit reached" });
    const expired = other_event("auth_expiry", {});
    const fine = events([prompt("finished")]);
    const ok = await promptOutcome(outcomeProvider("finished", fine), { sandboxId: "bx_1", promptId: "p1" });
    expect(ok).toEqual({ state: "finished" });

    const limited = await promptOutcome(outcomeProvider("finished", events([prompt("finished"), limit])), {
      sandboxId: "bx_1",
      promptId: "p1",
    });
    expect(limited).toEqual({ state: "failed", reason: "Weekly limit reached" });

    const login = await promptOutcome(outcomeProvider("finished", events([expired])), {
      sandboxId: "bx_1",
      promptId: "p1",
    });
    expect(login).toEqual({ state: "failed", reason: "The agent's login expired." });

    const otherTurn = await promptOutcome(
      outcomeProvider("finished", events([{ ...limit, promptId: "p2" } as AgentEvent])),
      { sandboxId: "bx_1", promptId: "p1" },
    );
    expect(otherTurn).toEqual({ state: "finished" });
  });

  test("the status comes from getPrompt, so a running turn is running whatever its events say", async () => {
    const provider = outcomeProvider("running", events([prompt("finished")]));
    expect(await promptOutcome(provider, { sandboxId: "bx_1", promptId: "p1" })).toEqual({ state: "running" });
    expect(
      await promptOutcome(outcomeProvider("failed", events([prompt("failed", "out of credit")])), {
        sandboxId: "bx_1",
        promptId: "p1",
      }),
    ).toEqual({ state: "failed", reason: "Agent failed. Check the agent configuration before retrying." });
    expect(
      await promptOutcome(outcomeProvider("failed", events([prompt("failed", "output_limit_exceeded")])), {
        sandboxId: "bx_1",
        promptId: "p1",
      }),
    ).toEqual({
      state: "failed",
      reason:
        "Model output limit reached. The model stopped before it finished this response. Send a message to continue.",
    });
    expect(
      await promptOutcome(outcomeProvider("interrupted", events([])), { sandboxId: "bx_1", promptId: "p1" }),
    ).toEqual({
      state: "interrupted",
    });
  });

  test("structured plan evidence never overrides auth/interruption or exposes malformed reset/vendor text", async () => {
    const limit = other_event("usage_limit", {
      code: "usage_limit_exceeded",
      resetsAt: "private-reset-body",
      message: "private-vendor-body",
    });
    for (const status of ["failed", "finished"] as const) {
      expect(
        await promptOutcome(outcomeProvider(status, events([prompt(status), limit])), {
          sandboxId: "s",
          promptId: "p1",
        }),
      ).toEqual({
        state: "failed",
        reason: "Plan limit reached. Try again after the limit resets.",
        limit: { code: "usage_limit_exceeded" },
      });
    }
    expect(
      await promptOutcome(outcomeProvider("failed", events([prompt("failed", "authentication_failed"), limit])), {
        sandboxId: "s",
        promptId: "p1",
      }),
    ).toEqual({
      state: "failed",
      reason: "Authentication failed. Reconnect the agent account, then send the prompt again.",
    });
    expect(
      await promptOutcome(outcomeProvider("interrupted", events([prompt("interrupted"), limit])), {
        sandboxId: "s",
        promptId: "p1",
      }),
    ).toEqual({ state: "interrupted" });
  });

  test("an event read twice keeps its newest body and its first position", () => {
    const first = message("m1", "Hel", true);
    const second = message("m2", "Done", false);
    const again = message("m1", "Hello", false);
    expect(dedupeEvents([first, second, again])).toEqual([again, second]);
  });
});

function golden(visibility: "org" | "private"): GoldenRecord {
  return {
    id: "golden-1",
    orgId: ORG,
    name: "web",
    visibility,
    ownerId: OWNER,
    provider: "boat",
    providerSnapshotId: SNAPSHOT,
    providerSandboxId: "bx_builder",
    modal: null,
    config: parseGoldenConfig({
      repos: [
        { url: "https://github.com/example/web.git", branch: "main" },
        { url: "https://github.com/example/api.git", branch: "dev" },
      ],
      init: ["pnpm i"],
    }),
    createdAt: "2026-11-08T12:00:00.000Z",
  };
}

function prompt(status: PromptStatus, reason?: string): AgentEvent {
  return {
    id: `prompt-${status}`,
    at: 1,
    promptId: "p1",
    kind: "prompt",
    text: "go",
    status,
    ...(reason ? { reason } : {}),
  };
}

function message(id: string, text: string, partial: boolean): AgentEvent {
  return { id, at: 2, promptId: "p1", kind: "message", text, partial, tools: [] };
}

function other_event(type: string, data: unknown): AgentEvent {
  return { id: `e-${type}`, at: 3, promptId: "p1", kind: "other", type, data };
}

function events(list: AgentEvent[]): AgentEvent[][] {
  return [list.slice(0, 1), list.slice(1)].filter((page) => page.length > 0);
}

function outcomeProvider(status: PromptStatus, pages: AgentEvent[][]): Provider {
  return {
    async getPrompt() {
      return { promptId: "p1", status, done: status !== "running" && status !== "queued" };
    },
    async events({ cursor, direction }: { cursor?: string; direction?: string }) {
      if (direction === "backward") {
        const index = cursor ? Number(cursor) : pages.length - 1;
        return { events: pages[index] ?? [], olderCursor: String(index - 1), hasMore: index > 0 };
      }
      const index = cursor ? Number(cursor) : 0;
      const page = pages[index] ?? [];
      const more = index + 1 < pages.length;
      return { events: page, cursor: String(index + 1), hasMore: more };
    },
  } as unknown as Provider;
}

test.each(["boat", "modal", "docker"])(
  "shared %s refresh preserves helper authority and warns only on completed fetch network failure",
  async (id) => {
    const g = golden("org");
    g.config.repos = g.config.repos.slice(0, 1);
    g.config.init = ["echo ready"];
    const commands: string[] = [];
    const warnings = await prepareLaunchWorkspace(
      {
        id,
        exec: async (request) => {
          commands.push(request.command);
          expect(request.command).not.toContain("credential.helper=");
          return {
            detached: false,
            exitCode: request.command.includes("git fetch") ? 75 : 0,
            stdout: "",
            stderr: request.command.includes("git fetch")
              ? "fatal: Could not resolve host opaque-provider-data\nARMADA_REPOSITORY_FETCH_FAILED\n"
              : "",
            timedOut: false,
            truncated: false,
          };
        },
      },
      "physical",
      "logical",
      g,
      ["opaque-provider-data"],
      () => {},
    );
    expect(warnings).toEqual([expect.stringContaining("repository web")]);
    expect(warnings.join(" ")).toContain("snapshot checkout");
    expect(warnings.join(" ")).not.toContain("opaque-provider-data");
    expect(commands.at(-1)).toBe("echo ready");
  },
);

test.each(["auth", "merge-network", "timeout", "init"])(
  "refresh policy blocks %s failure without exposing credential diagnostics",
  async (mode) => {
    const g = golden("org");
    g.config.repos = g.config.repos.slice(0, 1);
    g.config.init = ["echo ready"];
    const failure = prepareLaunchWorkspace(
      {
        id: "boat",
        exec: async (request) => {
          const repository = request.command.includes("git fetch");
          const fails = mode === "init" ? !repository : repository;
          return {
            detached: false,
            exitCode: fails ? 1 : 0,
            stdout: "",
            stderr: !fails
              ? ""
              : mode === "auth"
                ? "fatal: could not read Username for https://github.com: terminal prompts disabled opaque-private-token"
                : mode === "merge-network"
                  ? "RPC failed\nARMADA_REPOSITORY_FETCH_FAILED\n"
                  : "ARMADA_REPOSITORY_FETCH_FAILED\nCould not resolve host",
            timedOut: fails && mode === "timeout",
            truncated: false,
          };
        },
      },
      "physical",
      "logical",
      g,
      ["opaque-private-token"],
      () => {},
    );
    if (mode === "auth")
      await expect(failure).rejects.toMatchObject({
        code: "no_credentials",
        message: expect.stringContaining("Repository web needs a GitHub connection"),
      });
    else await expect(failure).rejects.toMatchObject({ code: "init_failed" });
  },
);

test("generated refresh never merges after a failed fetch and preserves its completed failure marker", async () => {
  const { pullCommand } = await import("../src/index.ts");
  const spec = pullCommand(golden("org").config.repos[0]!);
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      `env() { [ "$1" = GIT_TERMINAL_PROMPT=0 ] || return 92; shift; "$@"; }
    git() { printf '%s\\n' "$1"; if [ "$1" = fetch ]; then printf 'Could not resolve host\\n' >&2; return 128; fi; return 0; }
    ${spec.command}`,
    ],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(75);
  expect(result.stdout.trim()).toBe("fetch");
  expect(result.stderr).toContain("ARMADA_REPOSITORY_FETCH_FAILED");
  expect(spec.command).not.toContain("credential.helper=");
});

test("generated refresh uses the installed caller helper without writing its token to commands or config", async () => {
  const { gitSetupCommand, pullCommand } = await import("../src/index.ts");
  const secret = "ghu_fixture_only";
  const spec = pullCommand(golden("org").config.repos[0]!);
  // Model only Git's helper selection protocol, never invoke real Git, a network,
  // or an ambient credential store. The executed helper is generated by setupGitHub.
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      `set -eu
    helper=''
    env() { [ "$1" = GIT_TERMINAL_PROMPT=0 ] || return 92; shift; "$@"; }
    git() {
      while [ "$1" = -c ]; do if [ "$2" = credential.helper= ]; then helper=''; fi; shift 2; done
      case "$1" in
        config) printf 'config:%s:%s:%s\\n' "$3" "$4" "\${5-}"; if [ "$2" = --global ] && [ "$3" = --add ] && [ "$4" = credential.https://github.com.helper ]; then helper="$5"; fi ;;
        pull|fetch)
          [ -n "$helper" ] || return 128
          local credential
          credential=$(printf 'protocol=https\\nhost=github.com\\nwwwauth[]=Basic realm=GitHub\\n\\n' | sh -c "\${helper#!} get") || return 128
          case "$credential" in *"password=$GH_TOKEN"*) printf 'fetch-authorized\\n' ;; *) return 128 ;; esac ;;
        merge) printf 'merge-authorized\\n' ;;
        *) return 93 ;;
      esac
    }
    ${gitSetupCommand({ ...IDENTITY, name: 'The "Octo\'cat"' })}
    ${spec.command}
    printf '%s\\n' "$helper"`,
    ],
    { env: { PATH: process.env.PATH ?? "", GH_TOKEN: secret }, encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('config:user.name:The "Octo\'cat":\n');
  expect(result.stdout).toContain("config:user.email:583231+octocat@users.noreply.github.com:\n");
  expect(result.stdout).toContain("config:--replace-all:url.https://github.com/.insteadOf:git@github.com:\n");
  expect(result.stdout).toContain("config:--add:url.https://github.com/.insteadOf:ssh://git@github.com/\n");
  expect(result.stdout).toContain("fetch-authorized");
  expect(result.stdout).toContain("merge-authorized");
  expect(spec.command + result.stdout + result.stderr).not.toContain(secret);
});
