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
  "resume",
  "old-resume",
  "resume-lost",
  "bad-resume",
  "github",
  "old-github",
  "github-preflight-denied",
  "github-no-tool",
  "github-no-audit",
  "github-resume",
  "github-resume-no-tool",
  "github-resume-no-audit",
  "github-resume-stale-status",
  "github-resume-lost-refresh",
  "github-resume-lost-history",
] as const)("one-launch coordinator check is fail-closed (%s)", async (mode) => {
  const combined = mode.startsWith("github-resume");
  const root = await mkdtemp(join(tmpdir(), "boat-smoke-"));
  try {
    const preload = join(root, "api.ts");
    await writeFile(
      preload,
      `let launches=0,stops=0,marker='',memory='',phase=1,now=0,checkpoints=0,resumes=0,githubConfigurations=0;
Date.now=()=>now;Bun.sleep=async(ms)=>{now+=Number(ms);};
process.on('exit',()=>{console.log('COUNTERS '+JSON.stringify({launches,stops}));console.log('CHECKPOINTS '+checkpoints);console.log('RESUMES '+resumes);console.log('GITHUB_CONFIGURATIONS '+githubConfigurations);});
globalThis.fetch=async(url,options)=>{
 if(new Headers(options.headers).get('authorization')!=='Bearer '+process.env.ARMADA_TOKEN)throw Error('bad auth transport');
 const path=new URL(url).pathname,body=JSON.parse(options.body);
 if(path.endsWith('/launch/options'))return Response.json({boatRuntime:{enabled:${mode !== "disabled"},diagnosticsVersion:${mode === "old-diagnostics" ? 0 : 1},followupVersion:${mode === "old-followup" ? 0 : 1},checkpointVersion:${mode === "old-checkpoint" ? 0 : 1},resumeVersion:${mode === "old-resume" ? 0 : 1},githubVersion:${mode === "old-github" ? 0 : 1}}});
 if(path.endsWith('/sandbox/github-preflight-v1')){if(body.repository!=='example/web'||body.runtimeVersion!==1)throw Error('wrong GitHub preflight');return Response.json({githubReady:${mode !== "github-preflight-denied"}});}
 if(path.endsWith('/github/refresh')){githubConfigurations++;if(phase>=3 && ${mode === "github-resume-lost-refresh"})throw Error('lost new epoch configuration');return Response.json({status:'connected',revision:phase>=3?'4':'3',runtime:{kind:'armada',epoch:phase>=3?'2':'1'}});}
 if(path.endsWith('/github/runtime-status'))return Response.json({configured:phase===3 ? ${mode === "github-resume-stale-status"} : true,revision:phase>=3?'4':'3',credentialRequests:${mode === "github-no-audit" ? 0 : 1}*(phase>=3 && ${mode === "github-resume-no-audit"} ? 0 : 1),runtime:{kind:'armada',epoch:phase>=3?'2':'1'}});
 if(path.endsWith('/sandbox/launch-runtime-v1')){if(++launches!==1)throw Error('allocation repeated');
  if(body.runtimeVersion!==1||body.boatRuntime!==true||body.harness!=='codex')throw Error('missing explicit opt-in');
  marker=body.prompt.match(/ARMADA_RUNTIME_[a-f0-9]+/)[0];memory=body.prompt.match(/ARMADA_MEMORY_[a-f0-9]+/)?.[0]??'';return Response.json({sandbox:{id:'worker',goldenId:'golden',boatRuntime:true},runtime:{kind:'armada',epoch:'1'},promptId:'prompt',conversationId:'conversation'});}
 if(path.endsWith('/sandbox/send')){if(body.id!=='worker'||body.conversation_id!=='conversation'||!body.request_id||body.prompt.includes(memory))throw Error('wrong continuation');if(${mode === "followup-lost"})throw Error('lost follow-up response');if(phase>=3){if(githubConfigurations!==2)throw Error('no new epoch setup');phase=4;return Response.json({promptId:'github-resumed',conversationId:'conversation',requestId:body.request_id,runtime:{kind:'armada',epoch:'2'}});}phase=2;return Response.json({promptId:'followup',conversationId:'conversation',requestId:body.request_id,runtime:{kind:'armada',epoch:'1'}});}
 if(path.endsWith('/logs/read') && ${mode === "runtime-failed"})return Response.json({source:'armada-runtime',events:[],runtimeFailure:{status:'failed',reason:'Armada runtime process failed.'}});
 if(path.endsWith('/sandbox/resume-runtime-v1')){if(++resumes!==1||stops!==1||body.id!=='worker'||body.conversation_id!=='conversation'||!body.request_id||body.runtimeVersion!==1||body.prompt.includes(memory))throw Error('wrong resume or repeated activation');if(${mode === "resume-lost"})throw Error('lost resume');phase=3;return Response.json({id:'worker',requestId:body.request_id,resumed:true,runtime:{kind:'armada',epoch:'${mode === "bad-resume" ? "1" : "2"}'},sourceCheckpoint:{epoch:'1',watermark:4},promptId:'resumed',conversationId:'conversation'});}
 if(path.endsWith('/sandbox/checkpoint-runtime-v1')){checkpoints++;if(${mode === "checkpoint-lost"})throw Error('lost checkpoint response');return Response.json({id:'worker',requestId:body.request_id,runtime:{kind:'armada',epoch:phase>=3?'2':'1'},checkpoint:{state:'complete',watermark:phase===4?8:phase===3?6:4,acknowledgedSequence:${mode === "bad-checkpoint" ? 3 : 4}+(phase===4?4:phase===3?2:0)}});}
 if(path.endsWith('/logs/read')){const events=[{id:'answer',at:1,kind:'message',promptId:'prompt',partial:false,responseKind:'assistant',text:marker,tools:[]},{id:'terminal',at:2,kind:'prompt',promptId:'prompt',status:'finished',text:''}];if(phase>=2)events.push({id:'answer2',at:3,kind:'message',promptId:'followup',partial:false,responseKind:'assistant',text:memory,tools:[]},{id:'terminal2',at:4,kind:'prompt',promptId:'followup',status:'finished',text:''});if(phase>=2&&${["github", "github-no-audit"].includes(mode) || combined})events.push({id:'github-tool',at:3,kind:'message',promptId:'followup',partial:false,text:'',tools:[{id:'cmd',name:'commandExecution',input:{command:'gh api repos/example/web --jq .full_name'},result:{isError:false,output:'example/web\\n'}}]});if(phase>=3)events.push({id:'answer3',at:5,kind:'message',promptId:'resumed',partial:false,responseKind:'assistant',text:memory,tools:[]},{id:'terminal3',at:6,kind:'prompt',promptId:'resumed',status:'finished',text:''});if(phase===4 && !(stops===2 && ${mode === "github-resume-lost-history"})){events.push({id:'answer4',at:7,kind:'message',promptId:'github-resumed',partial:false,responseKind:'assistant',text:memory,tools:[]},{id:'terminal4',at:8,kind:'prompt',promptId:'github-resumed',status:'finished',text:''});if(${mode !== "github-resume-no-tool"})events.push({id:'github-tool4',at:7,kind:'message',promptId:'github-resumed',partial:false,text:'',tools:[{id:'cmd4',name:'commandExecution',input:{command:'gh api repos/example/web --jq .full_name'},result:{isError:false,output:'example/web'}}]});}return Response.json({source:'${mode === "wrong-source" ? "native" : "armada-runtime"}',events,hasMore:false});}
 if(path.endsWith('/sandbox/stop')){stops++;return Response.json({status:'stopping'});}
 if(path.endsWith('/sandbox/list')){if(stops<1||stops>2)throw Error('no cleanup');return Response.json({sandboxes:[{id:'worker',status:'${mode === "runtime-failed" ? "failed" : "stopped"}',stoppedAt:'2026-11-13T02:00:00.000Z'}]});}
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
        ...(["github", "old-github", "github-preflight-denied", "github-no-tool", "github-no-audit"].includes(mode) ||
        combined
          ? ["--github"]
          : []),
        ...(["resume", "old-resume", "resume-lost", "bad-resume"].includes(mode) || combined ? ["--resume"] : []),
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          ARMADA_RUNTIME_SMOKE: "one_real_boat_launch",
          ARMADA_URL: "https://staging.invalid",
          ARMADA_TOKEN: token,
          ARMADA_RUNTIME_GITHUB_REPOSITORY: "example/web",
          ARMADA_RUNTIME_GOLDEN: "fixture",
          ARMADA_RUNTIME_ORG: "org",
          ARMADA_RUNTIME_CREDENTIAL_ID: "account",
        },
      },
    );
    const code = await child.exited;
    const out = await new Response(child.stdout).text(),
      err = await new Response(child.stderr).text();
    expect(code === 0).toBe(["success", "followup", "checkpoint", "resume", "github", "github-resume"].includes(mode));
    expect(out + err).not.toContain(token);
    expect(out).toContain(
      `COUNTERS ${JSON.stringify({ launches: ["disabled", "old-diagnostics", "old-followup", "old-checkpoint", "old-resume", "old-github", "github-preflight-denied"].includes(mode) ? 0 : 1, stops: ["disabled", "old-diagnostics", "old-followup", "old-checkpoint", "old-resume", "old-github", "github-preflight-denied"].includes(mode) ? 0 : ["resume", "resume-lost", "bad-resume"].includes(mode) || combined ? 2 : 1 })}`,
    );
    if (["success", "followup", "checkpoint", "resume", "github", "github-resume"].includes(mode))
      expect(out).toContain('"source":"armada-runtime"');
    if (mode === "github") expect(out).toContain('"github":"verified"');
    if (["github-no-tool", "github-no-audit"].includes(mode)) expect(out).not.toContain('"github":"verified"');
    if (mode === "followup") expect(out).toContain('"followup":"verified"');
    if (["followup", "followup-lost"].includes(mode)) expect(out).toContain('"operation":"runtime_followup"');
    if (mode === "checkpoint") {
      expect(out).toContain('"checkpoint":"verified"');
      expect(out).toContain("Runtime checkpoint and stopped history verified");
      expect(out).toContain("CHECKPOINTS 2");
    }
    if (["bad-checkpoint", "checkpoint-lost"].includes(mode))
      expect(out).not.toContain("Runtime checkpoint and stopped history verified");
    if (mode === "resume") {
      expect(out).toContain('"resume":"verified"');
      expect(out).toContain("Runtime resume and stopped history verified.");
      expect(out).toContain("RESUMES 1");
      expect(out).toContain("CHECKPOINTS 4");
    }
    if (["resume-lost", "bad-resume"].includes(mode)) {
      expect(out).not.toContain("Runtime resume and stopped history verified.");
      expect(out).toContain("RESUMES 1");
    }
    if (combined) {
      expect(out).toContain("RESUMES 1");
      expect(out).toContain(`GITHUB_CONFIGURATIONS ${mode === "github-resume-stale-status" ? 1 : 2}`);
      if (mode === "github-resume") {
        expect(out).toContain('"githubAfterResume":"verified"');
        expect(out).toContain('"epoch":"2","revision":"4","promptId":"github-resumed"');
        expect(out).toContain("CHECKPOINTS 4");
        expect(out).toContain("Runtime resume and stopped history verified.");
      } else {
        expect(out).not.toContain('"githubAfterResume":"verified"');
        expect(out).not.toContain("Runtime resume and stopped history verified.");
      }
    }
    if (mode === "old-resume") expect(out).toContain("RESUMES 0");
    if (mode === "runtime-failed") expect(out).toContain("Experimental runtime compute stopped;");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
