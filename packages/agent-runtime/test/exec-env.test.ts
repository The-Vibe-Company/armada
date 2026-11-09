import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubEnv, gitSetupCommand } from "@armada/core";
import {
  AUTH_HEADER,
  type Driver,
  Journal,
  Runner,
  type RunnerExecutionOptions,
  validateExecEnvironment,
} from "../src/index.ts";
import { readNativeCodexAuth } from "../src/native-auth.ts";

const gitCredential = "runtime-git-fixture-private-material";
const grant = {
  token: "exec-fixture-private-runner-grant",
  sandboxId: "s",
  generation: "1",
  expiresAt: Date.now() + 60000,
};
const unused: Driver = {
  start() {
    throw Error("model_must_not_start");
  },
  async close() {},
};
function call(runner: Runner, op: string, extra: Record<string, unknown> = {}) {
  return runner.handle(
    new Request("https://runner", {
      method: "POST",
      headers: { [AUTH_HEADER]: grant.token },
      body: JSON.stringify({ version: 1, requestId: crypto.randomUUID(), sandboxId: "s", op, ...extra }),
    }),
  );
}
// Production core command and actual shell/Git credential helper, with only synthetic credentials.
test.skipIf(process.platform !== "linux")(
  "private exec env authenticates the real core Git helper without model keys, argv credentials or durable token bytes",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "armada-exec-github-")),
      home = join(root, "home");
    await mkdir(home);
    const path = join(root, "journal.sqlite");
    const journal = new Journal(path, (s) => s);
    const execution: RunnerExecutionOptions = {
      execEnv: { ...githubEnv(gitCredential), HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig") },
    };
    const runner = new Runner(
      journal,
      grant,
      { claude: unused, codex: unused },
      undefined,
      undefined,
      undefined,
      execution,
    );
    try {
      let response = await call(runner, "exec", {
        input: {
          sandboxId: "s",
          cwd: home,
          command: `export GIT_CONFIG_GLOBAL='${join(home, "gitconfig")}'\n${gitSetupCommand({ id: 123, login: "fixture", name: "Runtime Fixture", email: "runtime@example.invalid" })}`,
        },
      });
      let body = (await response.json()) as { result: { exitCode: number; stdout: string; stderr: string } };
      expect(body.result.exitCode).toBe(0);
      const command = `set -e
 test -n "\${GH_TOKEN:-}"
 test "$GH_TOKEN" = "$GITHUB_TOKEN"
 test "$HOME" = '${home}'
 test "$GIT_CONFIG_GLOBAL" = '${join(home, "gitconfig")}'
 test -z "\${OPENAI_API_KEY+x}"; test -z "\${ANTHROPIC_API_KEY+x}"; test -z "\${CLAUDE_CODE_OAUTH_TOKEN+x}"
 test -z "\${ARMADA_RUNNER_GRANT+x}"; test -z "\${MODAL_TOKEN_SECRET+x}"; test -z "\${SUPABASE_SERVICE_ROLE_KEY+x}"
 args=$(tr '\\0' ' ' </proc/$$/cmdline)
 case "$args" in *"$GH_TOKEN"*) exit 32;; esac
 credential=$(printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill)
 case "$credential" in *"password=$GH_TOKEN"*) printf 'git-helper-ok\\n';; *) exit 33;; esac
 printf '%s\\n' "$credential"
 printf '%s\\n' "$GH_TOKEN" >&2`;
      response = await call(runner, "exec", { input: { sandboxId: "s", cwd: home, command } });
      body = (await response.json()) as typeof body;
      expect(body.result.exitCode).toBe(0);
      expect(body.result.stdout).toContain("git-helper-ok");
      expect(body.result.stdout).not.toContain(gitCredential);
      expect(body.result.stderr).not.toContain(gitCredential);
      expect(body.result.stdout).toContain("[REDACTED]");
      const gitconfig = await readFile(join(home, "gitconfig"), "utf8");
      expect(gitconfig).not.toContain(gitCredential);
      expect(gitconfig).toContain("$GH_TOKEN");
      expect((await call(runner, "checkpoint")).status).toBe(200);
      const resumedGrant = { ...grant, generation: "2" };
      const withoutAuth = new Runner(
        journal,
        resumedGrant,
        { claude: unused, codex: unused },
        undefined,
        undefined,
        undefined,
        { execEnv: { HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig") } },
      );
      const noAuth = await call(withoutAuth, "exec", {
        input: {
          sandboxId: "s",
          cwd: home,
          command: `test -z "\${GH_TOKEN+x}" && test -z "\${GITHUB_TOKEN+x}" && printf auth-not-inherited`,
        },
      });
      expect(((await noAuth.json()) as { result: { stdout: string } }).result.stdout).toBe("auth-not-inherited");
      const reissued = new Runner(
        journal,
        resumedGrant,
        { claude: unused, codex: unused },
        undefined,
        undefined,
        undefined,
        execution,
      );
      const fresh = await call(reissued, "exec", { input: { sandboxId: "s", cwd: home, command } });
      expect(((await fresh.json()) as typeof body).result.exitCode).toBe(0);
      journal.flush();
      for (const name of await readdir(root))
        if (name.startsWith("journal.sqlite"))
          expect((await readFile(join(root, name))).includes(Buffer.from(gitCredential))).toBe(false);
    } finally {
      journal.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("exec bootstrap rejects model/provider/unknown variables and credential-free builders reject Git credentials and model prompts", async () => {
  for (const env of [
    { OPENAI_API_KEY: "fixture-model-key" },
    { ANTHROPIC_API_KEY: "fixture-model-key" },
    { CLAUDE_CODE_OAUTH_TOKEN: "fixture-model-key" },
    { MODAL_TOKEN_SECRET: "fixture-provider-key" },
    { SUPABASE_SERVICE_ROLE_KEY: "fixture-database-key" },
    { UNRELATED: "fixture" },
    { GH_TOKEN: "bad\nvalue" },
    { GIT_CONFIG_GLOBAL: "relative" },
    { GIT_TERMINAL_PROMPT: "1" },
  ])
    expect(() => validateExecEnvironment(env)).toThrow("invalid_exec_environment");
  expect(() => validateExecEnvironment(githubEnv(gitCredential), true)).toThrow("builder_credentials_forbidden");
  const root = await mkdtemp(join(tmpdir(), "armada-exec-builder-"));
  const journal = new Journal(join(root, "journal.sqlite"), (s) => s);
  try {
    const builder = new Runner(journal, grant, { claude: unused, codex: unused }, undefined, undefined, undefined, {
      credentialFreeBuilder: true,
    });
    const response = await call(builder, "prompt", {
      input: { sandboxId: "s", harness: "claude", text: "must not run" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "builder_model_prompts_forbidden" });
    expect(
      (
        await call(builder, "configureMcp", {
          configuration: { revision: "r1", servers: { remote: { type: "http", url: "https://example.invalid/mcp" } } },
        })
      ).status,
    ).toBe(409);
    expect(journal.prompts()).toHaveLength(0);
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "exec close redacts newly rotated native auth before response and durable persistence",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "armada-rotated-auth-"));
    await mkdir(join(root, "codex"), { mode: 0o700 });
    const journal = new Journal(join(root, "journal.sqlite"), (text) => text);
    const runner = new Runner(journal, grant, { claude: unused, codex: unused }, undefined, undefined, undefined, {
      execEnv: { HOME: root },
      refreshNativeSecrets: () => {
        readNativeCodexAuth(root, (values) => journal.registerSecrets(values));
      },
    });
    try {
      const state =
        '{"tokens":{"access_token":"synthetic-new-access","refresh_token":"synthetic-new-refresh","account_id":"native"}}';
      const response = await call(runner, "exec", {
        input: {
          sandboxId: "s",
          cwd: root,
          command: `umask 077; printf '%s' '${state}' > codex/auth.json; node -p 'JSON.parse(require("fs").readFileSync("codex/auth.json","utf8")).tokens.refresh_token'`,
        },
      });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).not.toContain("synthetic-new-refresh");
      expect(body).not.toContain("synthetic-new-access");
      expect(JSON.stringify(journal.db.query("select body from processes").all())).not.toContain(
        "synthetic-new-refresh",
      );
    } finally {
      journal.db.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
