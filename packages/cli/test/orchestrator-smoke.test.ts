import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../../../scripts/orchestrator-smoke.ts", import.meta.url).pathname;
test("operator smoke refuses implicit allocation and checks native continuity through the CLI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "armada-smoke-"));
  try {
    const binary = join(dir, "armada");
    const state = join(dir, "state.json");
    await writeFile(
      binary,
      `#!/usr/bin/env bun
const path=process.env.SMOKE_STATE;
const file=Bun.file(path);
const s=await file.exists()?await file.json():{operations:[],state:"ready",revision:0,calls:[]};
const args=process.argv.slice(2),action=args[1];
s.calls.push(args);
const out={version:1};
if(action==="capabilities"){out.enabled=true;out.pairs=[{provider:"modal",harness:"codex",enabled:process.env.SMOKE_PAIR_OFF!=="1"}];}
else if(action==="detail")Object.assign(out,{orchestrator:{state:s.state,revision:s.revision,conversationId:s.changed?"wrong":"conversation",sandboxId:"sandbox",continuity:"native"},operations:s.operations});
else if(action==="events")Object.assign(out,{cursor:"cursor-1",hasMore:false,events:[{id:"message",kind:"agent",event:{kind:"message",text:s.marker}},{id:"prompt",kind:"agent",event:{kind:"prompt",status:"finished"}}]});
else {
 if(action==="send")s.marker=args[3].match(/SMOKE_[a-f0-9-]+/)[0];
 if(action==="stop")s.state="stopped";
 if(action==="resume"){s.state="ready";s.changed=process.env.SMOKE_BAD==="1";}
 const receipt={version:1,id:"op-"+s.operations.length,orchestratorId:"parent",kind:action,state:"succeeded",revision:++s.revision};
 s.operations.push(receipt);Object.assign(out,receipt);
}
await Bun.write(path,JSON.stringify(s));console.log(JSON.stringify(out));
`,
      { mode: 0o700 },
    );
    async function run(optIn: boolean, bad: boolean, pairOff = false) {
      const child = Bun.spawn(
        [process.execPath, script, "https://example.invalid", "org", "golden", "modal", "codex", "model", "account"],
        {
          env: {
            ...process.env,
            ARMADA_BIN: binary,
            ARMADA_TOKEN: "test-only-placeholder",
            ARMADA_ORCHESTRATOR_SMOKE: optIn ? "create_real_compute" : "",
            SMOKE_STATE: state,
            SMOKE_BAD: bad ? "1" : "0",
            SMOKE_PAIR_OFF: pairOff ? "1" : "0",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      return { receipt: JSON.parse(output), code };
    }
    expect((await run(false, false)).receipt.reason).toBe("explicit_compute_opt_in_required");
    expect(await Bun.file(state).exists()).toBe(false);
    expect((await run(true, false, true)).receipt.reason).toBe("selected_pair_disabled");
    const disabled = JSON.parse(await readFile(state, "utf8"));
    expect(disabled.calls.map((args: string[]) => args[1])).toEqual(["capabilities"]);
    await rm(state);
    expect((await run(true, false)).receipt.pass).toBe(true);
    const success = JSON.parse(await readFile(state, "utf8"));
    expect(
      success.calls
        .filter((args: string[]) => ["create", "send", "stop", "resume"].includes(args[1] ?? ""))
        .map((args: string[]) => args[1]),
    ).toEqual(["create", "send", "stop", "resume", "stop"]);
    const createArgs = success.calls.find((args: string[]) => args[1] === "create");
    expect(createArgs[createArgs.indexOf("--provider") + 1]).toBe("modal");
    expect(createArgs[createArgs.indexOf("--agent") + 1]).toBe("codex");
    expect(JSON.stringify(success.calls)).not.toContain("test-only-placeholder");
    await rm(state);
    const failure = await run(true, true);
    expect(failure.code).toBe(1);
    expect(failure.receipt.reason).toBe("native_continuity_not_verified");
    expect(failure.receipt.operations.map((operation: { step: string }) => operation.step)).toEqual([
      "create",
      "send",
      "stop",
      "resume",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
