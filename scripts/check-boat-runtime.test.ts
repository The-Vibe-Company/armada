import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each(["success", "disabled", "wrong-source", "runtime-failed", "old-diagnostics"] as const)(
  "one-launch coordinator check is fail-closed (%s)",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "boat-smoke-"));
    try {
      const preload = join(root, "api.ts");
      await writeFile(
        preload,
        `let launches=0,stops=0,marker='',now=0;
Date.now=()=>now;Bun.sleep=async(ms)=>{now+=Number(ms);};
process.on('exit',()=>console.log('COUNTERS '+JSON.stringify({launches,stops})));
globalThis.fetch=async(url,options)=>{
 if(new Headers(options.headers).get('authorization')!=='Bearer '+process.env.ARMADA_TOKEN)throw Error('bad auth transport');
 const path=new URL(url).pathname,body=JSON.parse(options.body);
 if(path.endsWith('/launch/options'))return Response.json({boatRuntime:{enabled:${mode !== "disabled"},diagnosticsVersion:${mode === "old-diagnostics" ? 0 : 1}}});
 if(path.endsWith('/sandbox/launch-runtime-v1')){if(++launches!==1)throw Error('allocation repeated');
  if(body.runtimeVersion!==1||body.boatRuntime!==true||body.harness!=='codex')throw Error('missing explicit opt-in');
  marker=body.prompt.match(/ARMADA_RUNTIME_[a-f0-9]+/)[0];return Response.json({sandbox:{id:'worker',goldenId:'golden',boatRuntime:true},runtime:{kind:'armada',epoch:'1'},promptId:'prompt'});}
 if(path.endsWith('/logs/read') && ${mode === "runtime-failed"})return Response.json({source:'armada-runtime',events:[],runtimeFailure:{status:'failed',reason:'Armada runtime process failed.'}});
 if(path.endsWith('/logs/read'))return Response.json({source:'${mode === "wrong-source" ? "native" : "armada-runtime"}',events:[{id:'answer',at:1,kind:'message',promptId:'prompt',partial:false,responseKind:'assistant',text:marker,tools:[]},{id:'terminal',at:2,kind:'prompt',promptId:'prompt',status:'finished',text:''}],hasMore:false});
 if(path.endsWith('/sandbox/stop')){stops++;return Response.json({status:'stopping'});}
 if(path.endsWith('/sandbox/list')){if(stops!==1)throw Error('no cleanup');return Response.json({sandboxes:[{id:'worker',status:'${mode === "runtime-failed" ? "failed" : "stopped"}',stoppedAt:'2026-11-13T02:00:00.000Z'}]});}
 throw Error('unexpected API path');};`,
      );
      const token = crypto.randomUUID();
      const child = Bun.spawn([process.execPath, "--preload", preload, "scripts/check-boat-runtime.ts"], {
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
      });
      const code = await child.exited;
      const out = await new Response(child.stdout).text(),
        err = await new Response(child.stderr).text();
      expect(code === 0).toBe(mode === "success");
      expect(out + err).not.toContain(token);
      expect(out).toContain(
        `COUNTERS ${JSON.stringify({ launches: ["disabled", "old-diagnostics"].includes(mode) ? 0 : 1, stops: ["disabled", "old-diagnostics"].includes(mode) ? 0 : 1 })}`,
      );
      if (mode === "success") expect(out).toContain('"source":"armada-runtime"');
      if (mode === "runtime-failed") expect(out).toContain("Experimental runtime compute stopped;");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
