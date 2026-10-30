import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AuthEvent } from "@armada/plugin-api";
import { claudeRuntime } from "../src/index.ts";

test("Claude uses its configured binary and auth commands and reports the subscription", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-status-"));
  const prior = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const missing = claudeRuntime({ binary: join(dir, "absent") });
    assert.ok(missing.status);
    assert.equal((await missing.status()).state, "missing");
    const binary = join(dir, "claude");
    await writeFile(
      binary,
      `#!/usr/bin/env node\nimport {existsSync,writeFileSync,unlinkSync} from 'node:fs';const path=process.env.CLAUDE_CONFIG_DIR+'/signed-in';\nif(process.argv[2]==='--version') console.log('2.1.0 (Claude Code)');else if(process.argv[3]==='status') console.log(JSON.stringify({loggedIn:existsSync(path),email:'mira@example.test',subscriptionType:'claude_max_20x_subscription'}));else if(process.argv[3]==='logout') unlinkSync(path);else if(process.argv.includes('--help')) console.log('auth login');else if(process.argv[3]==='login'){console.log('Visit https://claude.example.test/login');writeFileSync(path,'yes');}else process.exit(1);`,
    );
    await chmod(binary, 0o700);
    const runtime = claudeRuntime({ binary });
    assert.ok(runtime.status);
    assert.ok(runtime.connect);
    assert.ok(runtime.disconnect);
    assert.deepEqual(await runtime.status(), { installed: true, version: "2.1.0", state: "disconnected" });
    const events: AuthEvent[] = [];
    await runtime.connect({ notify: (event) => events.push(event), prompt: async () => "unused" });
    assert.ok(events.some((event) => event.type === "terminal"));
    assert.deepEqual((await runtime.status()).account, { label: "mira@example.test", plan: "Claude Max 20x" });
    await runtime.disconnect();
    assert.equal((await runtime.status()).state, "disconnected");
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  }
});
