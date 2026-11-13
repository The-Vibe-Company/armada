import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Owning entrypoint contract: unsafe evidence must not pass, allocation is never
// repeated, and a known allocation gets one stop even after checkpoint failure.
test.each([
  "success",
  "disabled",
  "old-followup",
  "wrong-source",
  "wrong-prompt",
  "tool-result",
  "bad-checkpoint",
  "lost-launch",
  "lost-followup",
  "stale-epoch",
  "wrong-conversation",
  "reused-prompt",
  "wrong-request",
  "replayed-answer",
  "resume",
  "old-resume",
  "resume-bad-epoch",
  "resume-wrong-source",
  "resume-wrong-watermark",
  "resume-wrong-conversation",
  "resume-wrong-request",
  "resume-reused-prompt",
  "resume-not-resumed",
  "resume-lost",
  "resume-lost-stopped-history",
  "resume-lost-old-history",
  "resume-tool-result",
  "resume-bad-checkpoint",
  "resume-stop-unknown",
  "github",
  "github-resume",
  "github-old-preflight",
  "github-missing-tool",
  "github-no-acquisition",
  "github-stale-revision",
  "github-wrong-epoch",
  "github-resume-old-config",
  "github-resume-reused-revision",
  "github-echo-mask",
  "github-wrong-output",
  "github-wrapper",
])("Modal one-allocation check is fail-closed (%s)", async (mode) => {
  const github = mode.startsWith("github");
  const resume = mode.startsWith("resume") || mode === "old-resume" || mode.startsWith("github-resume");
  const root = await mkdtemp(join(tmpdir(), "modal-runtime-smoke-"));
  try {
    const preload = join(root, "api.ts");
    await writeFile(
      preload,
      `
let launches=0,stops=0,checkpoints=0,sends=0,resumes=0,answer='',memory='',now=0,firstCheckpoint='',githubRevision=0;
Date.now=()=>now;Bun.sleep=async(ms)=>{now+=Number(ms);};
process.on('exit',()=>console.log('COUNTERS '+JSON.stringify({launches,stops,checkpoints,sends,resumes})));
globalThis.fetch=async(url,options)=>{
 const path=new URL(url).pathname,body=JSON.parse(options.body);
 if(new Headers(options.headers).get('authorization')!=='Bearer '+process.env.ARMADA_TOKEN)throw Error('auth');
 if(path.endsWith('/launch/options'))return Response.json({modalRuntime:{version:1,enabled:${mode !== "disabled"},followupVersion:${mode === "old-followup" ? 0 : 1},resumeVersion:${mode === "old-resume" ? 0 : 1}}});
 if(path.endsWith('/golden/list'))return Response.json({goldens:[{id:'golden-id',name:'golden',provider:'modal',orgId:'org-id'}]});
 if(path.endsWith('/sandbox/github-preflight-v1')){if(body.org!=='org-id'||body.repository!=='example/web')throw Error('bad preflight');return Response.json({githubReady:true,provider:${mode === "github-old-preflight"}?undefined:'modal'});}
 if(path.endsWith('/github/refresh'))return Response.json({status:'connected',runtime:{kind:'armada',epoch:${mode === "github-wrong-epoch"}?'99':resumes?'2':'1'},revision:${mode === "github-resume-reused-revision"}?(githubRevision++,'1'):String(++githubRevision)});
 if(path.endsWith('/github/runtime-status')){
  const configured=!resumes||githubRevision>1||${mode === "github-resume-old-config"};
  return Response.json({configured,runtime:{kind:'armada',epoch:resumes?'2':'1'},revision:${mode === "github-stale-revision"}?'foreign':${mode === "github-resume-reused-revision"}?'1':String(githubRevision),credentialRequests:${mode === "github-no-acquisition"}?0:1});
 }
 if(path.endsWith('/sandbox/launch-modal-runtime-v1')){
  launches++;if(launches!==1||body.provider!=='modal'||body.runtimeTransport!=='dialout'||body.runtimeVersion!==1||body.harness!=='codex'||body.ttlSeconds!==900||body.skipSkillDefaults!==true||body.skills.length||body.connections.length)throw Error('unsafe launch');
  if(${mode === "lost-launch"})throw Error('private transport diagnostics must not surface');
  answer=body.prompt.match(/ARMADA_MODAL_[a-f0-9]+/)[0];memory=body.prompt.match(/ARMADA_MEMORY_[a-f0-9]+/)[0];
  return Response.json({sandbox:{id:'worker',provider:'modal',runtimeTransport:'dialout'},runtime:{kind:'armada',epoch:'1'},promptId:'prompt',conversationId:'conversation'});
 }
 if(path.endsWith('/sandbox/send')){
  if(++sends>(${github && resume}?2:1)||body.id!=='worker'||body.conversation_id!=='conversation'||!/^[a-f0-9-]{36}$/.test(body.request_id)||body.prompt.includes(memory))throw Error('unsafe followup');
  if(${mode === "lost-followup"})throw Error('private transport diagnostics must not surface');
  return Response.json({requestId:${mode === "wrong-request"}? 'wrong':body.request_id,runtime:{kind:'armada',epoch:${mode === "stale-epoch"}?'2':resumes?'2':'1'},promptId:${mode === "reused-prompt"}?'prompt':resumes?'github-resumed':'followup',conversationId:'${mode === "wrong-conversation" ? "foreign" : "conversation"}'});
 }
 if(path.endsWith('/logs/read')){
  const pair=(promptId,text,kind='assistant')=>[{id:'answer-'+promptId,at:1,promptId,kind:'message',partial:false,responseKind:kind,tools:[],text},{id:'finished-'+promptId,at:2,promptId,kind:'prompt',text:'',status:'finished'}];
  let events=[...pair(${mode === "wrong-prompt"}?'foreign':'prompt',answer,'${mode === "tool-result" ? "tool_result" : "assistant"}'),...(sends?pair('followup',memory):[]),...(resumes?pair('resumed',memory,'${mode === "resume-tool-result" ? "tool_result" : "assistant"}'):[])];
  if(${github} && sends && !${mode === "github-missing-tool"}){
    const toolPrompt=resumes&&sends>1?'github-resumed':'followup';
    events.push(...pair('github-resumed',memory).filter(()=>resumes&&sends>1));
    events.push({id:'gh-tool',at:3,kind:'message',promptId:toolPrompt,partial:false,text:'',tools:[{id:'gh',name:'commandExecution',input:{command:${JSON.stringify(mode === "github-wrapper" ? "/bin/bash -lc 'gh api repos/example/web --jq .full_name'" : "gh api repos/example/web --jq .full_name" + (mode === "github-echo-mask" ? " || echo example/web" : ""))}},result:{isError:false,output:'${mode === "github-wrong-output" ? "echo example/web" : "example/web"}'}}]});
  }
  if(sends&&${mode === "replayed-answer"})events=pair('prompt',memory);
  if((stops===1&&!resumes&&${mode === "resume-lost-stopped-history"})||(resumes&&${mode === "resume-lost-old-history"}))events=events.filter(event=>event.promptId==='resumed');
  return Response.json({source:'${mode === "wrong-source" ? "modal-native" : "armada-runtime"}',events});
 }
 if(path.endsWith('/sandbox/checkpoint-runtime-v1')){
  checkpoints++;if(body.id!=='worker'||body.runtimeVersion!==1||!body.request_id)throw Error('bad checkpoint input');
  if(checkpoints===1)firstCheckpoint=body.request_id;else if((!resumes&&body.request_id!==firstCheckpoint)||(resumes&&body.request_id===firstCheckpoint))throw Error('wrong checkpoint replay identity');
  return Response.json({requestId:body.request_id,runtime:{kind:'armada',epoch:resumes?'2':'1'},checkpoint:{state:'complete',watermark:resumes?6:4,acknowledgedSequence:${mode === "bad-checkpoint"}?1:resumes&&${mode === "resume-bad-checkpoint"}?5:resumes?6:4}});
 }
 if(path.endsWith('/sandbox/resume-runtime-v1')){
  if(++resumes!==1||stops!==1||body.id!=='worker'||body.conversation_id!=='conversation'||!body.request_id||body.runtimeVersion!==1||body.prompt.includes(memory))throw Error('unsafe resume');
  if(${mode === "resume-lost"})throw Error('private transport diagnostics must not surface');
  return Response.json({requestId:${mode === "resume-wrong-request"}?'wrong':body.request_id,resumed:${mode !== "resume-not-resumed"},runtime:{kind:'armada',epoch:'${mode === "resume-bad-epoch" ? "1" : "2"}'},sourceCheckpoint:{epoch:'${mode === "resume-wrong-source" ? "0" : "1"}',watermark:${mode === "resume-wrong-watermark" ? 3 : 4}},promptId:'${mode === "resume-reused-prompt" ? "followup" : "resumed"}',conversationId:'${mode === "resume-wrong-conversation" ? "foreign" : "conversation"}'});
 }
 if(path.endsWith('/sandbox/stop')){if(++stops>(${resume}?2:1)||body.id!=='worker')throw Error('repeated or foreign stop');if(stops===2&&${mode === "resume-stop-unknown"})throw Error('private transport diagnostics must not surface');return Response.json({});}
 if(path.endsWith('/sandbox/list'))return Response.json({sandboxes:[{id:'worker',status:'stopped'}]});
 throw Error('unexpected operation');
};`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        "scripts/check-modal-runtime.ts",
        ...(resume ? ["--resume"] : []),
        ...(github ? ["--github"] : []),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ARMADA_RUNTIME_SMOKE: "one_real_modal_launch",
          ARMADA_URL: "https://staging.example",
          ARMADA_TOKEN: "fixture-token",
          ARMADA_RUNTIME_ORG: "org",
          ARMADA_RUNTIME_GOLDEN: "golden",
          ARMADA_RUNTIME_CREDENTIAL_ID: "account",
          ...(github ? { ARMADA_RUNTIME_GITHUB_REPOSITORY: "example/web" } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(status === 0).toBe(["success", "resume", "github", "github-resume", "github-wrapper"].includes(mode));
    const counters = JSON.parse(stdout.match(/COUNTERS (.+)/)?.[1] ?? "null");
    expect(counters).toEqual(
      github
        ? {
            launches: mode === "github-old-preflight" ? 0 : 1,
            stops: mode === "github-old-preflight" ? 0 : resume ? 2 : 1,
            checkpoints: ["github", "github-wrapper"].includes(mode)
              ? 1
              : mode === "github-resume"
                ? 3
                : ["github-resume-old-config", "github-resume-reused-revision"].includes(mode)
                  ? 2
                  : 0,
            resumes: resume ? 1 : 0,
            sends:
              mode === "github-old-preflight" || mode === "github-wrong-epoch" ? 0 : mode === "github-resume" ? 2 : 1,
          }
        : {
            launches: ["disabled", "old-followup", "old-resume"].includes(mode) ? 0 : 1,
            stops: ["disabled", "old-followup", "old-resume", "lost-launch"].includes(mode)
              ? 0
              : resume && mode !== "resume-lost-stopped-history"
                ? 2
                : 1,
            checkpoints:
              resume && mode !== "old-resume"
                ? ["resume", "resume-bad-checkpoint", "resume-stop-unknown"].includes(mode)
                  ? 3
                  : 2
                : ["success", "bad-checkpoint"].includes(mode)
                  ? 1
                  : 0,
            resumes: resume && !["old-resume", "resume-lost-stopped-history"].includes(mode) ? 1 : 0,
            sends:
              resume && mode !== "old-resume"
                ? 1
                : [
                      "success",
                      "bad-checkpoint",
                      "lost-followup",
                      "stale-epoch",
                      "wrong-conversation",
                      "reused-prompt",
                      "wrong-request",
                      "replayed-answer",
                    ].includes(mode)
                  ? 1
                  : 0,
          },
    );
    expect(stdout + stderr).not.toContain("fixture-token");
    expect(stdout + stderr).not.toContain("private transport diagnostics");
    if (["success", "resume", "github", "github-resume", "github-wrapper"].includes(mode)) {
      expect(stdout).toContain('"answer":"verified"');
      expect(stdout).toContain('"checkpoint":"verified"');
      expect(stdout).toContain('"followup":"verified"');
      expect(stdout).toContain("compute stopped");
    } else if (!resume || mode === "old-resume") expect(stdout).not.toContain('"answer":"verified"');
    expect(stdout.includes('"resume":"verified"')).toBe(mode === "resume" || mode === "github-resume");
    if (github)
      expect(stdout.includes('"github":"verified"')).toBe(
        [
          "github",
          "github-wrapper",
          "github-resume",
          "github-resume-old-config",
          "github-resume-reused-revision",
        ].includes(mode),
      );
    expect(stdout.includes('"githubAfterResume":"verified"')).toBe(mode === "github-resume");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
