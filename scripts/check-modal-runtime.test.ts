import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Owning entrypoint contract: unsafe evidence must not pass, allocation is never
// repeated, and a known allocation gets one stop even after checkpoint failure.
test.each(["success", "disabled", "wrong-source", "wrong-prompt", "tool-result", "bad-checkpoint", "lost-launch"])(
  "Modal one-allocation check is fail-closed (%s)",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "modal-runtime-smoke-"));
    try {
      const preload = join(root, "api.ts");
      await writeFile(
        preload,
        `
let launches=0,stops=0,checkpoints=0,answer='',now=0;
Date.now=()=>now;Bun.sleep=async(ms)=>{now+=Number(ms);};
process.on('exit',()=>console.log('COUNTERS '+JSON.stringify({launches,stops,checkpoints})));
globalThis.fetch=async(url,options)=>{
 const path=new URL(url).pathname,body=JSON.parse(options.body);
 if(new Headers(options.headers).get('authorization')!=='Bearer '+process.env.ARMADA_TOKEN)throw Error('auth');
 if(path.endsWith('/launch/options'))return Response.json({modalRuntime:{version:1,enabled:${mode !== "disabled"}}});
 if(path.endsWith('/sandbox/launch-modal-runtime-v1')){
  launches++;if(launches!==1||body.provider!=='modal'||body.runtimeTransport!=='dialout'||body.runtimeVersion!==1||body.harness!=='codex'||body.ttlSeconds!==900||body.skipSkillDefaults!==true||body.skills.length||body.connections.length)throw Error('unsafe launch');
  if(${mode === "lost-launch"})throw Error('private transport diagnostics must not surface');
  answer=body.prompt.match(/ARMADA_MODAL_[a-f0-9]+/)[0];
  return Response.json({sandbox:{id:'worker',provider:'modal',runtimeTransport:'dialout'},runtime:{kind:'armada',epoch:'1'},promptId:'prompt'});
 }
 if(path.endsWith('/logs/read'))return Response.json({source:'${mode === "wrong-source" ? "modal-native" : "armada-runtime"}',events:[{id:'answer',at:1,promptId:'${mode === "wrong-prompt" ? "foreign" : "prompt"}',kind:'message',partial:false,responseKind:'${mode === "tool-result" ? "tool_result" : "assistant"}',tools:[],text:answer},{id:'finished',at:2,promptId:'prompt',kind:'prompt',text:'',status:'finished'}]});
 if(path.endsWith('/sandbox/checkpoint-runtime-v1')){checkpoints++;if(body.id!=='worker'||body.runtimeVersion!==1||!body.request_id)throw Error('bad checkpoint input');return Response.json({requestId:body.request_id,runtime:{kind:'armada',epoch:'1'},checkpoint:{state:'complete',watermark:2,acknowledgedSequence:${mode === "bad-checkpoint" ? 1 : 2}}});}
 if(path.endsWith('/sandbox/stop')){if(++stops!==1||body.id!=='worker')throw Error('repeated or foreign stop');return Response.json({});}
 if(path.endsWith('/sandbox/list'))return Response.json({sandboxes:[{id:'worker',status:'stopped'}]});
 throw Error('unexpected operation');
};`,
      );
      const child = Bun.spawn([process.execPath, "--preload", preload, "scripts/check-modal-runtime.ts"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ARMADA_RUNTIME_SMOKE: "one_real_modal_launch",
          ARMADA_URL: "https://staging.example",
          ARMADA_TOKEN: "fixture-token",
          ARMADA_RUNTIME_ORG: "org",
          ARMADA_RUNTIME_GOLDEN: "golden",
          ARMADA_RUNTIME_CREDENTIAL_ID: "account",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(status === 0).toBe(mode === "success");
      const counters = JSON.parse(stdout.match(/COUNTERS (.+)/)?.[1] ?? "null");
      expect(counters).toEqual({
        launches: mode === "disabled" ? 0 : 1,
        stops: ["disabled", "lost-launch"].includes(mode) ? 0 : 1,
        checkpoints: ["success", "bad-checkpoint"].includes(mode) ? 1 : 0,
      });
      expect(stdout + stderr).not.toContain("fixture-token");
      expect(stdout + stderr).not.toContain("private transport diagnostics");
      if (mode === "success") {
        expect(stdout).toContain('"answer":"verified"');
        expect(stdout).toContain('"checkpoint":"verified"');
        expect(stdout).toContain("compute stopped");
      } else expect(stdout).not.toContain('"answer":"verified"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
