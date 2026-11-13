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
  "mcp",
  "mcp-resume",
  "old-mcp",
  "mcp-preflight-denied",
  "mcp-invalid-json",
  "mcp-no-default",
  "mcp-wrong-server",
  "mcp-wrong-args",
  "mcp-no-result",
  "mcp-resume-no-tool",
  "mcp-github-resume",
  "mcp-skills-resume",
  "skills",
  "skills-empty",
  "skills-status",
  "skills-golden",
  "skills-resume",
  "claude-resume",
  "invalid-harness",
  "usage",
  "usage-resume",
  "usage-unknown",
  "usage-no-admission",
  "usage-wrong-counters",
  "usage-resume-repriced",
  "usage-no-event",
  "workspace",
  "workspace-resume",
  "workspace-missing",
  "workspace-late",
  "workspace-resume-rerun",
  "old-workspace",
] as const)("one-launch coordinator check is fail-closed (%s)", async (mode) => {
  const workspace = mode.startsWith("workspace") || mode === "old-workspace";
  const workspaceResume = workspace && mode.includes("resume");
  const claude = mode === "claude-resume";
  const usage = mode.startsWith("usage");
  const usageResume = usage && mode.includes("resume");
  const skills = mode.startsWith("skills") || mode === "mcp-skills-resume";
  const skillResume = mode === "skills-resume";
  const combined = mode.startsWith("github-resume");
  const mcp = mode.startsWith("mcp") || mode === "old-mcp";
  const mcpResume = mcp && mode.includes("resume");
  const triple = mode === "mcp-github-resume";
  const mcpId = "11111111-1111-4111-8111-111111111111";
  const mcpServer = `armada_${mcpId.replaceAll("-", "_")}`;
  const root = await mkdtemp(join(tmpdir(), "boat-smoke-"));
  try {
    const preload = join(root, "api.ts");
    await writeFile(
      preload,
      `let launches=0,stops=0,marker='',memory='',phase=1,now=0,checkpoints=0,resumes=0,githubConfigurations=0,mcpConfigurations=0,sends=0,defaultReads=0,skillStatuses=0;
const receipts=["notes@2.0.0","catalog/other@1.0.0"].map(reference=>({reference,version:reference.split("@")[1],skillId:"11111111-1111-4111-8111-111111111111",checksum:"sha256:"+"a".repeat(64),origin:"https://skillpack.app/v1"}));
const usagePrompts=()=>['prompt',...(phase>=2?['followup']:[]),...(phase>=3?['resumed']:[]),...(phase>=4?['github-resumed']:[])];
const usageData=()=>({model:'gpt-6.1-sol',inputTokens:100,outputTokens:20,cachedTokens:10,cacheWriteTokens:${mode === "usage-unknown"}?null:0,reasoningTokens:null});
function projectedUsage(){const ids=usagePrompts(),raw=usageData(),inputs={inputTokens:raw.inputTokens,outputTokens:20,cachedTokens:10,cacheWriteTokens:raw.cacheWriteTokens,reasoningTokens:null,cacheWriteTtl:null};
const quote={schemaVersion:1,basis:'estimated',credentialId:'account',credentialVersion:1,capturedAt:'2026-11-13T00:00:00Z',snapshot:{schemaVersion:1,provider:'openai',model:raw.model,source:'connection',revision:'1',connectionId:'account',unsupported:false,rates:{input:${mode === "usage-resume-repriced"}&&phase>=3?'200':'2',output:'5',cacheRead:'1',cacheWrite:null,reasoning:null}},inputs,usd:${mode === "usage-unknown"}?null:'0.00029',unknown:${mode === "usage-unknown"}?'tokens':null};
return {turnCount:ids.length,computeSeconds:1,turns:ids.map(promptId=>({...raw,inputTokens:${mode === "usage-wrong-counters"}?101:100,promptId,pricing:${mode === "usage-no-admission"}?null:quote})),tokenTotals:{inputTokens:100*ids.length,outputTokens:20*ids.length,cachedTokens:10*ids.length,cacheWriteTokens:raw.cacheWriteTokens,reasoningTokens:null,incomplete:true},cost:{currency:'USD',usd:quote.usd===null?null:['0','0.00029','0.00058','0.00087','0.00116'][ids.length],basis:'estimated',unknown:quote.unknown,unpricedTurns:quote.usd===null?ids.length:0}};}
Date.now=()=>now;Bun.sleep=async(ms)=>{now+=Number(ms);};
process.on('exit',()=>{console.log('COUNTERS '+JSON.stringify({launches,stops}));console.log('CHECKPOINTS '+checkpoints);console.log('RESUMES '+resumes);console.log('GITHUB_CONFIGURATIONS '+githubConfigurations);console.log('MCP_CONFIGURATIONS '+mcpConfigurations);console.log('SENDS '+sends);console.log('DEFAULT_READS '+defaultReads);console.log('SKILL_STATUSES '+skillStatuses);});
globalThis.fetch=async(url,options)=>{
 if(new Headers(options.headers).get('authorization')!=='Bearer '+process.env.ARMADA_TOKEN)throw Error('bad auth transport');
 const path=new URL(url).pathname,body=JSON.parse(options.body);
 if(path.endsWith('/launch/options'))return Response.json({boatRuntime:{enabled:${mode !== "disabled"},diagnosticsVersion:${mode === "old-diagnostics" ? 0 : 1},followupVersion:${mode === "old-followup" ? 0 : 1},checkpointVersion:${mode === "old-checkpoint" ? 0 : 1},resumeVersion:${mode === "old-resume" ? 0 : 1},githubVersion:${mode === "old-github" ? 0 : 1},mcpVersion:${mode === "old-mcp" ? 1 : 2},skillsVersion:1,workspaceVersion:${mode === "old-workspace" ? 0 : 1}}});
 if(path.endsWith('/golden/list'))return Response.json({goldens:[{id:'wrong',name:'fixture',orgId:'org',provider:'modal'},{id:'golden',name:'fixture',orgId:'org',provider:'boat',config:{repos:[{}],init:['setup']}}]});
 if(path.endsWith('/skills/defaults/get')){defaultReads++;if(body.org!=='org'||(body.scope==='golden'?body.goldenId!=='golden':Object.hasOwn(body,'goldenId')))throw Error('wrong defaults scope');return Response.json({skills:${mode === "skills-empty"}?[]:({golden:['catalog/notes@1.0.0','catalog/other@1.0.0'],org:['notes@2.0.0'],personal:[]}[body.scope])});}
 if(path.endsWith('/sandbox/status')){skillStatuses++;return Response.json({skills:${mode === "skills-status"}?receipts.slice(1):receipts,...(${usage}?{usage:projectedUsage()}:{})});}
 if(path.endsWith('/sandbox/github-preflight-v1')){if(body.repository!=='example/web'||body.runtimeVersion!==1)throw Error('wrong GitHub preflight');return Response.json({githubReady:${mode !== "github-preflight-denied"}});}
 if(path.endsWith('/sandbox/mcp-preflight-v1'))return Response.json({mcpReady:${mode !== "mcp-preflight-denied"}});
 if(path.endsWith('/mcp/list'))return Response.json({connections:[{id:'${mcpId}',defaultForLaunch:${mode !== "mcp-no-default"}}]});
 if(path.endsWith('/github/refresh')){githubConfigurations++;if(phase>=3 && ${mode === "github-resume-lost-refresh"})throw Error('lost new epoch configuration');return Response.json({status:'connected',revision:phase>=3?'4':'3',runtime:{kind:'armada',epoch:phase>=3?'2':'1'}});}
 if(path.endsWith('/github/runtime-status'))return Response.json({configured:phase===3 ? ${mode !== "github-resume-stale-status"} : true,revision:phase>=3?'4':'3',credentialRequests:${mode === "github-no-audit" ? 0 : 1}*(phase>=3 && ${mode === "github-resume-no-audit"} ? 0 : 1),runtime:{kind:'armada',epoch:phase>=3?'2':'1'}});
 if(path.endsWith('/sandbox/launch-runtime-v1')){if(++launches!==1)throw Error('allocation repeated');if(${mcp}){if(Object.hasOwn(body,'connections'))throw Error('MCP defaults were bypassed');mcpConfigurations=1;}
  if(body.runtimeVersion!==1||body.boatRuntime!==true||body.harness!==${JSON.stringify(claude ? "claude" : "codex")})throw Error('missing explicit opt-in');
  if(${skills}&&(defaultReads!==3||Object.hasOwn(body,'skills')||Object.hasOwn(body,'skipSkillDefaults')))throw Error('defaults bypassed');
  marker=body.prompt.match(/ARMADA_RUNTIME_[a-f0-9]+/)[0];memory=body.prompt.match(/ARMADA_MEMORY_[a-f0-9]+/)?.[0]??'';return Response.json({sandbox:{id:'worker',goldenId:'${mode === "skills-golden" ? "wrong" : "golden"}',boatRuntime:true,...(${skills}?{skills:receipts}:{})},runtime:{kind:'armada',epoch:'1'},promptId:'prompt',conversationId:'conversation'});}
 if(path.endsWith('/sandbox/send')){sends++;if(body.id!=='worker'||body.conversation_id!=='conversation'||!body.request_id||body.prompt.includes(memory))throw Error('wrong continuation');if(${mode === "followup-lost"})throw Error('lost follow-up response');if(phase>=3){if(${combined || triple} && githubConfigurations!==2)throw Error('no new epoch GitHub setup');if(${mcp} && mcpConfigurations!==2)throw Error('no new epoch automatic MCP setup');phase=4;return Response.json({promptId:'github-resumed',conversationId:'conversation',requestId:body.request_id,runtime:{kind:'armada',epoch:'2'}});}phase=2;return Response.json({promptId:'followup',conversationId:'conversation',requestId:body.request_id,runtime:{kind:'armada',epoch:'1'}});}
 if(path.endsWith('/logs/read') && ${mode === "runtime-failed"})return Response.json({source:'armada-runtime',events:[],runtimeFailure:{status:'failed',reason:'Armada runtime process failed.'}});
 if(path.endsWith('/sandbox/resume-runtime-v1')){if(++resumes!==1||stops!==1||body.id!=='worker'||body.conversation_id!=='conversation'||!body.request_id||body.runtimeVersion!==1||body.prompt.includes(memory))throw Error('wrong resume or repeated activation');if(${mode === "resume-lost"})throw Error('lost resume');phase=3;if(${mcp})mcpConfigurations=2;return Response.json({id:'worker',requestId:body.request_id,resumed:true,runtime:{kind:'armada',epoch:'${mode === "bad-resume" ? "1" : "2"}'},sourceCheckpoint:{epoch:'1',watermark:4},promptId:'resumed',conversationId:'conversation'});}
 if(path.endsWith('/sandbox/checkpoint-runtime-v1')){checkpoints++;if(${mode === "checkpoint-lost"})throw Error('lost checkpoint response');return Response.json({id:'worker',requestId:body.request_id,runtime:{kind:'armada',epoch:phase>=3?'2':'1'},checkpoint:{state:'complete',watermark:phase===4?8:phase===3?6:4,acknowledgedSequence:${mode === "bad-checkpoint" ? 3 : 4}+(phase===4?4:phase===3?2:0)}});}
 if(path.endsWith('/logs/read')){const events=[{id:'answer',at:1,kind:'message',promptId:'prompt',partial:false,responseKind:'assistant',text:marker,tools:[]},{id:'terminal',at:2,kind:'prompt',promptId:'prompt',status:'finished',text:''}];if(phase>=2)events.push({id:'answer2',at:3,kind:'message',promptId:'followup',partial:false,responseKind:'assistant',text:memory,tools:[]},{id:'terminal2',at:4,kind:'prompt',promptId:'followup',status:'finished',text:''});if(phase>=2&&${["github", "github-no-audit"].includes(mode) || combined || triple})events.push({id:'github-tool',at:3,kind:'message',promptId:'followup',partial:false,text:'',tools:[{id:'cmd',name:'commandExecution',input:{command:'gh api repos/example/web --jq .full_name'},result:{isError:false,output:'example/web\\n'}}]});if(${mcp})events.push({id:'mcp-initial',at:1,kind:'message',promptId:'prompt',partial:false,text:'',tools:[{id:'mcp0',server:'${mode === "mcp-wrong-server" ? "another_server" : mcpServer}',name:'read_counter',input:{probe:'${mode === "mcp-wrong-args" ? "wrong" : "safe"}'},result:{isError:false,output:'${mode === "mcp-no-result" ? "wrong" : "expected MCP value"}'}}]});if(phase>=3 && ${mcp && mode !== "mcp-resume-no-tool"})events.push({id:'mcp-resumed',at:5,kind:'message',promptId:'resumed',partial:false,text:'',tools:[{id:'mcp3',server:'${mcpServer}',name:'read_counter',input:{probe:'safe'},result:{isError:false,output:'expected MCP value'}}]});if(phase>=2 && ${mcp})events.push({id:'mcp-tool',at:3,kind:'message',promptId:'followup',partial:false,text:'',tools:[{id:'mcp',server:'${mode === "mcp-wrong-server" ? "another_server" : mcpServer}',name:'read_counter',input:{probe:'${mode === "mcp-wrong-args" ? "wrong" : "safe"}'},result:{isError:false,output:'${mode === "mcp-no-result" ? "wrong" : "expected MCP value"}'}}]});if(phase===4 && ${mcp && mode !== "mcp-resume-no-tool"})events.push({id:'mcp-tool4',at:7,kind:'message',promptId:'github-resumed',partial:false,text:'',tools:[{id:'mcp4',server:'${mcpServer}',name:'read_counter',input:{probe:'safe'},result:{isError:false,output:'expected MCP value'}}]});if(phase>=3)events.push({id:'answer3',at:5,kind:'message',promptId:'resumed',partial:false,responseKind:'assistant',text:memory,tools:[]},{id:'terminal3',at:6,kind:'prompt',promptId:'resumed',status:'finished',text:''});if(phase===4 && !(stops===2 && ${mode === "github-resume-lost-history"})){events.push({id:'answer4',at:7,kind:'message',promptId:'github-resumed',partial:false,responseKind:'assistant',text:memory,tools:[]},{id:'terminal4',at:8,kind:'prompt',promptId:'github-resumed',status:'finished',text:''});if(${mode !== "github-resume-no-tool"})events.push({id:'github-tool4',at:7,kind:'message',promptId:'github-resumed',partial:false,text:'',tools:[{id:'cmd4',name:'commandExecution',input:{command:'gh api repos/example/web --jq .full_name'},result:{isError:false,output:'example/web'}}]});}if(${usage}&&${mode !== "usage-no-event"})for(const promptId of usagePrompts())events.push({id:'usage-'+promptId,at:10,kind:'other',type:'armada/turnUsage',promptId,data:usageData()});if(${workspace}){const work=${mode === "workspace-missing"}?[]:['repository','init'].flatMap(phase=>['running','finished'].map(status=>({id:'workspace-'+phase+'-'+status,at:0,kind:'other',type:'armada/workspaceStep',data:{phase,index:0,attempt:0,status}})));if(${mode === "workspace-resume-rerun"}&&phase>=3)work.push({id:'repeated-workspace',at:0,kind:'other',type:'armada/workspaceStep',data:{phase:'init',index:0,attempt:0,status:'finished'}});if(${mode === "workspace-late"})events.push(...work);else events.unshift(...work);}return Response.json({source:'${mode === "wrong-source" ? "native" : "armada-runtime"}',events,hasMore:false});}
 if(path.endsWith('/sandbox/stop')){stops++;return Response.json({status:'stopping'});}
 if(path.endsWith('/sandbox/list')){if(stops<1||stops>2)throw Error('no cleanup');return Response.json({sandboxes:[{id:'worker',status:'${mode === "runtime-failed" ? "failed" : "stopped"}',stoppedAt:'2026-11-13T02:00:00.000Z'}]});}
 throw Error('unexpected API path');};`,
    );
    const token = crypto.randomUUID();
    const privateArgument = crypto.randomUUID();
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        "scripts/check-boat-runtime.ts",
        ...(mcp ? ["--mcp"] : []),
        ...(skills ? ["--skills"] : []),
        ...(usage ? ["--usage"] : []),
        ...(workspace ? ["--workspace"] : []),
        ...(["followup", "old-followup", "followup-lost"].includes(mode) ? ["--followup"] : []),
        ...(["checkpoint", "old-checkpoint", "bad-checkpoint", "checkpoint-lost"].includes(mode)
          ? ["--checkpoint"]
          : []),
        ...(["github", "old-github", "github-preflight-denied", "github-no-tool", "github-no-audit"].includes(mode) ||
        combined ||
        triple
          ? ["--github"]
          : []),
        ...(["claude-resume", "resume", "old-resume", "resume-lost", "bad-resume"].includes(mode) ||
        combined ||
        mcpResume ||
        skillResume ||
        usageResume ||
        workspaceResume
          ? ["--resume"]
          : []),
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          ARMADA_RUNTIME_HARNESS: claude ? "claude" : mode === "invalid-harness" ? "opencode" : "codex",
          ARMADA_RUNTIME_SMOKE: "one_real_boat_launch",
          ARMADA_URL: "https://staging.invalid",
          ARMADA_TOKEN: token,
          ARMADA_RUNTIME_MCP_CONNECTION_ID: mcpId,
          ARMADA_RUNTIME_MCP_TOOL: "read_counter",
          ARMADA_RUNTIME_MCP_ARGS_JSON: mode === "mcp-invalid-json" ? `{${privateArgument}` : '{"probe":"safe"}',
          ARMADA_RUNTIME_MCP_EXPECT: "expected MCP value",
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
    expect(code === 0).toBe(
      [
        "claude-resume",
        "success",
        "followup",
        "checkpoint",
        "resume",
        "github",
        "github-resume",
        "mcp",
        "mcp-resume",
        "mcp-github-resume",
        "mcp-skills-resume",
        "skills",
        "skills-resume",
        "usage",
        "usage-resume",
        "usage-unknown",
        "workspace",
        "workspace-resume",
      ].includes(mode),
    );
    expect(out + err).not.toContain(token);
    expect(out + err).not.toContain(privateArgument);
    if (mode === "mcp-invalid-json")
      expect(out + err).toContain("MCP args must be valid non-secret JSON; no launch attempted.");
    expect(out).toContain(
      `COUNTERS ${JSON.stringify({ launches: ["invalid-harness", "disabled", "old-diagnostics", "old-followup", "old-checkpoint", "old-resume", "old-github", "github-preflight-denied", "old-mcp", "mcp-preflight-denied", "mcp-invalid-json", "mcp-no-default", "skills-empty", "old-workspace"].includes(mode) ? 0 : 1, stops: ["invalid-harness", "disabled", "old-diagnostics", "old-followup", "old-checkpoint", "old-resume", "old-github", "github-preflight-denied", "old-mcp", "mcp-preflight-denied", "mcp-invalid-json", "mcp-no-default", "skills-empty", "old-workspace"].includes(mode) ? 0 : ["claude-resume", "resume", "resume-lost", "bad-resume"].includes(mode) || combined || mcpResume || skillResume || usageResume || workspaceResume ? 2 : 1 })}`,
    );
    if (
      [
        "claude-resume",
        "success",
        "followup",
        "checkpoint",
        "resume",
        "github",
        "github-resume",
        "mcp",
        "mcp-resume",
        "mcp-github-resume",
        "mcp-skills-resume",
        "skills",
        "skills-resume",
        "usage",
        "usage-resume",
        "usage-unknown",
        "workspace",
        "workspace-resume",
      ].includes(mode)
    )
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
    if (mode === "resume" || claude) {
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
    if (mcp) {
      const ok = ["mcp", "mcp-resume", "mcp-github-resume", "mcp-skills-resume"].includes(mode);
      if (ok) expect(out).toContain('"mcp":"verified"');
      if (mcpResume) {
        expect(out).toContain("MCP_CONFIGURATIONS 2");
        if (ok) {
          expect(out).toContain('"mcpAfterResume":"verified"');
          expect(out).toContain("CHECKPOINTS 4");
        } else expect(out).not.toContain('"mcpAfterResume":"verified"');
      }
      if (triple) expect(out).toContain('"githubAfterResume":"verified"');
    }
    if (["mcp-resume", "mcp-skills-resume"].includes(mode)) expect(out).toContain("SENDS 1");
    if (mode === "mcp-skills-resume") {
      expect(out).toContain('"skillsAfterResume":"verified"');
      expect(out).toContain("DEFAULT_READS 3");
      expect(out).toContain("SKILL_STATUSES 4");
    }
    if (triple) expect(out).toContain("SENDS 2");
    if (workspace) {
      if (["workspace", "workspace-resume"].includes(mode)) expect(out).toContain('"workspace":"verified"');
      if (mode === "workspace-resume") expect(out).toContain('"workspaceAfterResume":"preserved_without_rerun"');
      if (mode === "workspace-resume-rerun")
        expect(out).not.toContain('"workspaceAfterResume":"preserved_without_rerun"');
      if (["workspace-late", "workspace-missing"].includes(mode)) expect(out).not.toContain('"workspace":"verified"');
    }
    if (usage) {
      if (["usage", "usage-resume", "usage-unknown"].includes(mode)) expect(out).toContain('"usage":"verified"');
      if (mode === "usage-resume") {
        expect(out).toContain('"usageAfterResume":"verified"');
        expect(out).toContain('"costAfterResume":"priced"');
      }
      if (mode === "usage-unknown") {
        expect(out).toContain('"status":"unknown"');
        expect(out).toContain('"unknown":"tokens"');
      }
      if (["usage-no-admission", "usage-wrong-counters", "usage-no-event"].includes(mode))
        expect(out).not.toContain('"usage":"verified"');
      if (mode === "usage-resume-repriced") expect(out).not.toContain('"usageAfterResume":"verified"');
    }
    if (skills) {
      expect(out).toContain("DEFAULT_READS 3");
      if (mode === "skills-empty") expect(out + err).toContain("No default skills configured");
      if (mode === "skills") {
        expect(out).toContain('"skills":"verified"');
        expect(out).toContain("SKILL_STATUSES 2");
      }
      if (skillResume) {
        expect(out).toContain('"skillsAfterResume":"verified"');
        expect(out).toContain("SKILL_STATUSES 4");
        expect(out).toContain("RESUMES 1");
      }
      if (["skills-status", "skills-golden"].includes(mode)) expect(out).not.toContain('"skills":"verified"');
    }
    if (mode === "old-resume") expect(out).toContain("RESUMES 0");
    if (mode === "runtime-failed") expect(out).toContain("Experimental runtime compute stopped;");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
