import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AuthEvent } from "@armada/plugin-api";
import { opencodeRuntime } from "../src/index.ts";

test("OpenCode's auth list determines connection and piped login forwards input and output safely", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-status-"));
  try {
    const missing = opencodeRuntime({ binary: join(dir, "absent") });
    assert.ok(missing.status);
    assert.equal((await missing.status()).state, "missing");
    const binary = join(dir, "opencode");
    const marker = join(dir, "auth");
    await writeFile(
      binary,
      `#!/usr/bin/env node\nimport {existsSync,writeFileSync} from 'node:fs';const marker=${JSON.stringify(marker)};if(process.argv[2]==='--version') console.log('1.4.0');else if(process.argv[3]==='list') console.log(existsSync(marker)?'1 credential':'0 credentials');else if(process.argv[3]==='login'){process.stdout.write('Enter API key: ');process.stdin.once('data',value=>{console.log('api_key='+String(value).trim()+' mira@example.test');writeFileSync(marker,'yes');process.exit(0);});}else process.exit(1);`,
    );
    await chmod(binary, 0o700);
    const runtime = opencodeRuntime({ binary });
    assert.ok(runtime.status);
    assert.ok(runtime.connect);
    assert.deepEqual(await runtime.status(), { installed: true, version: "1.4.0", state: "disconnected" });
    const events: AuthEvent[] = [];
    const token = `private-${crypto.randomUUID()}`;
    await runtime.connect({
      notify: (event) => events.push(event),
      prompt: async (prompt) => {
        assert.equal(prompt.type, "secret");
        return token;
      },
    });
    assert.ok(events.some((event) => event.type === "terminal" && event.output.includes("[redacted]")));
    assert.ok(!JSON.stringify(events).includes(token));
    assert.ok(!JSON.stringify(events).includes("mira@example.test"));
    assert.equal((await runtime.status()).state, "connected");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("native OpenCode selection frames become app choices and password prompts under pipe I/O", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-select-"));
  const prior = process.env.ARMADA_OPENCODE_TEST_STATE;
  process.env.ARMADA_OPENCODE_TEST_STATE = join(dir, "auth");
  try {
    const { fileURLToPath } = await import("node:url");
    const { readFile } = await import("node:fs/promises");
    const runtime = opencodeRuntime({ binary: fileURLToPath(new URL("./select-login.mjs", import.meta.url)) });
    assert.ok(runtime.connect);
    const token = crypto.randomUUID();
    const prompts: string[] = [];
    await runtime.connect({
      signal: t.signal,
      notify() {},
      prompt: async (prompt) => {
        prompts.push(prompt.type);
        if (prompt.type === "select") {
          const wanted = prompt.options.find((option) => /OpenAI|API key/.test(option.label));
          assert.ok(wanted);
          return wanted.id;
        }
        assert.equal(prompt.type, "secret");
        return token;
      },
    });
    assert.deepEqual(prompts, ["select", "select", "secret"]);
    assert.equal(await readFile(join(dir, "auth"), "utf8"), token);
  } finally {
    if (prior === undefined) delete process.env.ARMADA_OPENCODE_TEST_STATE;
    else process.env.ARMADA_OPENCODE_TEST_STATE = prior;
    await rm(dir, { recursive: true, force: true });
  }
});
