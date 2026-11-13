import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each([
  "success",
  "disabled",
  "wrong-source",
  "runtime-failed",
  "old-diagnostics",
  "followup",
  "old-followup",
  "followup-lost",
  "checkpoint",
  "old-checkpoint",
  "bad-checkpoint",
  "checkpoint-lost",
] as const)("one-launch coordinator check is fail-closed (%s)", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "boat-smoke-"));
  try {
    const preload = join(root, "api.ts");
    await writeFile(
      preload,
      `let launches=0,stops=0,marker='',memory='',phase=1,now=0,checkpoints=0;
Date.now=()=>now;Bun.sleep=async(ms)=>{now+=Number(ms);};
process.on('exit',()=>{console.log('COUNTERS '+JSON.stringify({launches,stops}));console.log('CHECKPOINTS '+checkpoints);});
globalThis.fetch=async(url,options)=>{
 if(new Headers(options.headers).get('authorization')!=='Bearer '+process.env.ARMADA_TOKEN)throw Error('bad auth transport');
 const path=new URL(url).pathname,body=JSON.parse(options.body);
 if(path.endsWith('/launch/options'))return Response.json({boatRuntime:{enabled:${mode !== "disabled"},diagnosticsVersion:${mode === "old-diagnostics" ? 0 : 1},followupVersion:${mode === "old-followup" ? 0 : 1},checkpointVersion:${mode === "old-checkpoint" ? 0 : 1}}});
 if(path.endsWith('/sandbox/launch-runtime-v1')){if(++launches!==1)throw Error('allocation repeated');
  if(body.runtimeVersion!==1||body.boatRuntime!==true||body.harness!=='codex')throw Error('missing explicit opt-in');
  marker=body.prompt.match(/ARMADA_RUNTIME_[a-f0-9]+/)[0];memory=body.prompt.match(/ARMADA_MEMORY_[a-f0-9]+/)?.[0]??'';return Response.json({sandbox:{id:'worker',goldenId:'golden',boatRuntime:true},runtime:{kind:'armada',epoch:'1'},promptId:'prompt',conversationId:'conversation'});}
 if(path.endsWith('/sandbox/send')){if(body.id!=='worker'||body.conversation_id!=='conversation'||!body.request_id||body.prompt.includes(memory))throw Error('wrong continuation');if(${mode === "followup-lost"})throw Error('lost follow-up response');phase=2;return Response.json({promptId:'followup',conversationId:'conversation',requestId:body.request_id,runtime:{kind:'armada',epoch:'1'}});}
 if(path.endsWith('/logs/read') && ${mode === "runtime-failed"})return Response.json({source:'armada-runtime',events:[],runtimeFailure:{status:'failed',reason:'Armada runtime process failed.'}});
 if(path.endsWith('/sandbox/checkpoint-runtime-v1')){checkpoints++;if(${mode === "checkpoint-lost"})throw Error('lost checkpoint response');return Response.json({id:'worker',requestId:body.request_id,runtime:{kind:'armada',epoch:'1'},checkpoint:{state:'complete',watermark:4,acknowledgedSequence:${mode === "bad-checkpoint" ? 3 : 4}}});}
 if(path.endsWith('/logs/read')){const events=[{id:'answer',at:1,kind:'message',promptId:'prompt',partial:false,responseKind:'assistant',text:marker,tools:[]},{id:'terminal',at:2,kind:'prompt',promptId:'prompt',status:'finished',text:''}];if(phase===2)events.push({id:'answer2',at:3,kind:'message',promptId:'followup',partial:false,responseKind:'assistant',text:memory,tools:[]},{id:'terminal2',at:4,kind:'prompt',promptId:'followup',status:'finished',text:''});return Response.json({source:'${mode === "wrong-source" ? "native" : "armada-runtime"}',events,hasMore:false});}
 if(path.endsWith('/sandbox/stop')){stops++;return Response.json({status:'stopping'});}
 if(path.endsWith('/sandbox/list')){if(stops!==1)throw Error('no cleanup');return Response.json({sandboxes:[{id:'worker',status:'${mode === "runtime-failed" ? "failed" : "stopped"}',stoppedAt:'2026-11-13T02:00:00.000Z'}]});}
 throw Error('unexpected API path');};`,
    );
    const token = crypto.randomUUID();
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        "scripts/check-boat-runtime.ts",
        ...(["followup", "old-followup", "followup-lost"].includes(mode) ? ["--followup"] : []),
        ...(["checkpoint", "old-checkpoint", "bad-checkpoint", "checkpoint-lost"].includes(mode)
          ? ["--checkpoint"]
          : []),
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          ARMADA_RUNTIME_SMOKE: "one_real_boat_launch",
          ARMADA_URL: "https://staging.invalid",
          ARMADA_TOKEN: token,
          ARMADA_RUNTIME_GOLDEN: "fixture",
          ARMADA_RUNTIME_ORG: "org",
          ARMADA_RUNTIME_CREDENTIAL_ID: "account",
        },
      },
    );
    const code = await child.exited;
    const out = await new Response(child.stdout).text(),
      err = await new Response(child.stderr).text();
    expect(code === 0).toBe(["success", "followup", "checkpoint"].includes(mode));
    expect(out + err).not.toContain(token);
    expect(out).toContain(
      `COUNTERS ${JSON.stringify({ launches: ["disabled", "old-diagnostics", "old-followup", "old-checkpoint"].includes(mode) ? 0 : 1, stops: ["disabled", "old-diagnostics", "old-followup", "old-checkpoint"].includes(mode) ? 0 : 1 })}`,
    );
    if (["success", "followup", "checkpoint"].includes(mode)) expect(out).toContain('"source":"armada-runtime"');
    if (mode === "followup") expect(out).toContain('"followup":"verified"');
    if (["followup", "followup-lost"].includes(mode)) expect(out).toContain('"operation":"runtime_followup"');
    if (mode === "checkpoint") {
      expect(out).toContain('"checkpoint":"verified"');
      expect(out).toContain("Runtime checkpoint and stopped history verified");
      expect(out).toContain("CHECKPOINTS 2");
    }
    if (["bad-checkpoint", "checkpoint-lost"].includes(mode))
      expect(out).not.toContain("Runtime checkpoint and stopped history verified");
    if (mode === "runtime-failed") expect(out).toContain("Experimental runtime compute stopped;");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
