import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AuthEvent } from "@armada/plugin-api";
import { codexRuntime } from "../src/index.ts";

test("Codex reports missing/install/auth plan and connects through its configured CLI", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-status-"));
  const prior = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const missing = codexRuntime({ binary: join(home, "absent") });
    assert.equal((await missing.status!()).state, "missing");
    const binary = join(home, "codex");
    const authorizationCode = randomBytes(24).toString("hex");
    const urlKey = randomBytes(24).toString("hex");
    const claims = Buffer.from(
      JSON.stringify({ email: "mira@example.test", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }),
    ).toString("base64url");
    await writeFile(
      binary,
      `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nif(process.argv[2]==='--version') console.log('codex-cli 0.99.0');\nelse if(process.argv[2]==='logout') writeFileSync(process.env.CODEX_HOME+'/auth.json','{}');\nelse if(process.argv[2]==='login' && process.argv[3]!=='status'){console.log('Open https://auth.example.test/login?state=csrf-marker&nonce=nonce-marker&code=${authorizationCode}&api_key=${urlKey}#access_token=${urlKey}');writeFileSync(process.env.CODEX_HOME+'/auth.json',JSON.stringify({tokens:{id_token:'x.${claims}.x'}}));}\nelse process.exit(1);\n`,
    );
    await chmod(binary, 0o700);
    const runtime = codexRuntime({ binary });
    assert.deepEqual(await runtime.status!(), { installed: true, version: "0.99.0", state: "disconnected" });
    const events: AuthEvent[] = [];
    await runtime.connect!({ notify: (event) => events.push(event), prompt: async () => "unused" });
    assert.ok(events.some((event) => event.type === "terminal" && event.output.includes("Open")));
    const authUrl = events.find((event) => event.type === "auth_url");
    assert.ok(authUrl?.type === "auth_url");
    const url = new URL(authUrl.url);
    assert.equal(url.searchParams.get("state"), "csrf-marker");
    assert.equal(url.searchParams.get("nonce"), "nonce-marker");
    assert.ok(!JSON.stringify(events).includes(authorizationCode));
    assert.ok(!JSON.stringify(events).includes(urlKey));
    const status = await runtime.status!();
    assert.equal(status.state, "connected");
    assert.deepEqual(status.account, { label: "mira@example.test", plan: "ChatGPT Pro" });
    await runtime.disconnect!();
    assert.equal((await runtime.status!()).state, "disconnected");
  } finally {
    if (prior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior;
    await rm(home, { recursive: true, force: true });
  }
});

test("cancelling a piped Codex login stops its child and reports no credential-bearing error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-cancel-"));
  try {
    const binary = join(dir, "codex");
    await writeFile(
      binary,
      "#!/usr/bin/env node\nprocess.on('SIGTERM',()=>process.exit(1));console.log('Waiting for browser');setInterval(()=>{},1000);\n",
    );
    await chmod(binary, 0o700);
    const controller = new AbortController();
    const runtime = codexRuntime({ binary });
    await assert.rejects(
      runtime.connect!({ signal: controller.signal, notify: () => controller.abort(), prompt: async () => "unused" }),
      /Provider sign-in did not complete/,
    );
    assert.equal(controller.signal.aborted, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
