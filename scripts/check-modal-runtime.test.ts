import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Owning entrypoint contract: unsafe evidence must not pass, allocation is never
// repeated, and a known allocation gets one stop even after checkpoint failure.
test.each([
  "success",
  "opencode",
  "opencode-resume",
  "opencode-github",
  "opencode-github-resume",
  "opencode-variables",
  "opencode-variables-resume",
  "opencode-usage-variables-skills-github-resume",
  "opencode-github-display-only",
  "opencode-github-wrong-output",
  "opencode-variables-old-prompt",
  "opencode-variables-echo-mask",
  "opencode-variables-bad-exit",
  "opencode-variables-truncated",
  "opencode-shell-old",
  "opencode-usage",
  "opencode-skills-resume",
  "opencode-old-version",
  "opencode-tools-blocked",
  "opencode-claude-conflict",
  "claude",
  "claude-resume",
  "claude-old-version",
  "claude-variables-skills-mcp-github-resume",
  "claude-mcp-wrong-server",
  "claude-mcp-no-result",
  "claude-mcp-wrong-result-id",
  "claude-mcp-error-result",
  "claude-variables-old-prompt",
  "claude-github-wrong-output",
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
  "mcp",
  "mcp-resume",
  "mcp-github-resume",
  "mcp-old-version",
  "mcp-preflight-denied",
  "mcp-invalid-json",
  "mcp-wrong-server",
  "mcp-wrong-tool",
  "mcp-wrong-args",
  "mcp-no-result",
  "mcp-error-result",
  "mcp-wrong-output",
  "mcp-old-prompt",
  "mcp-resume-replay",
  "skills",
  "skills-empty",
  "skills-old-version",
  "skills-missing-launch",
  "skills-wrong-golden",
  "skills-status-mismatch",
  "skills-resume",
  "skills-resume-status-mismatch",
  "skills-resume-stop-status-mismatch",
  "skills-mcp-github-resume",
  "variables",
  "variables-resume",
  "variables-skills-mcp-github-resume",
  "variables-wrapper",
  "variables-old-version",
  "variables-wrong-template",
  "variables-wrong-golden",
  "variables-wrong-account",
  "variables-wrong-keys",
  "variables-missing-vars",
  "variables-secrets",
  "variables-no-tool",
  "variables-missing-env",
  "variables-wrong-hash",
  "variables-echo-mask",
  "variables-old-prompt",
  "variables-receipt-mismatch",
  "variables-resume-replay",
  "usage",
  "usage-unknown",
  "usage-late",
  "usage-extra-observation",
  "usage-forged-guest-money",
  "usage-old-version",
  "usage-missing-facts",
  "usage-wrong-totals",
  "usage-wrong-model",
  "usage-wrong-account",
  "usage-no-admission",
  "usage-forged-cost",
  "usage-zero-missing",
  "usage-stopped-drift",
  "usage-resume-repricing",
  "usage-resume-stopped-drift",
  "usage-variables-skills-mcp-github-resume",
])("Modal one-allocation check is fail-closed (%s)", async (scenario) => {
  const opencode = scenario.startsWith("opencode");
  const claude = scenario.startsWith("claude") || scenario === "opencode-claude-conflict";
  const shellOld = scenario === "opencode-shell-old";
  const mode =
    scenario === "opencode-github-display-only"
      ? "github-missing-tool"
      : ["opencode-variables-bad-exit", "opencode-variables-truncated"].includes(scenario)
        ? "variables-wrong-hash"
        : shellOld
          ? "old-followup"
          : scenario === "opencode" || scenario === "claude"
            ? "success"
            : ["opencode-old-version", "opencode-claude-conflict", "claude-old-version"].includes(scenario)
              ? "old-followup"
              : scenario === "opencode-tools-blocked"
                ? "mcp-old-version"
                : scenario === "claude-mcp-wrong-result-id"
                  ? "mcp-no-result"
                  : opencode
                    ? scenario.slice("opencode-".length)
                    : claude
                      ? scenario.slice("claude-".length)
                      : scenario;
  const github = mode.includes("github");
  const mcp = mode.includes("mcp");
  const skills = mode.includes("skills");
  const variables = mode.includes("variables");
  const usage = mode.startsWith("usage");
  const templateId = "22222222-2222-4222-8222-222222222222";
  const accountId = variables ? "33333333-3333-4333-8333-333333333333" : "account";
  const variableValues = { APP_REGION: "readable-canary\n$(not-a-command)", EMPTY_VALUE: "" };
  const variableDigest = createHash("sha256").update(JSON.stringify(variableValues)).digest("hex");
  const mcpId = "11111111-1111-4111-8111-111111111111";
  const mcpServer = `armada_${mcpId.replaceAll("-", "_")}`;
  const resume = mode.includes("resume");
  const root = await mkdtemp(join(tmpdir(), "modal-runtime-smoke-"));
  try {
    const preload = join(root, "api.ts");
    await writeFile(
      preload,
      `
let launches=0,stops=0,checkpoints=0,sends=0,resumes=0,answer='',memory='',now=0,firstCheckpoint='',githubRevision=0,goldenReads=0,defaultReads=0,skillStatuses=0,variableCommand='',actualVariableOutput='',usagePages=0;
const variableValues=${JSON.stringify(variableValues)};
const variableDigest='${variableDigest}';
const templateDefinition={provider:'modal',harness:'${opencode ? "opencode" : claude ? "claude" : "codex"}',goldenId:'${mode === "variables-wrong-golden" ? "foreign" : "golden-id"}',model:'${usage ? "gpt-6.1-sol" : "fixture-model"}',reasoningEffort:'high',modelAccount:{id:'${mode === "variables-wrong-account" ? "foreign" : accountId}',version:1},variables:${mode === "variables-missing-vars"}?[]:[{key:'APP_REGION',variableId:'region',version:1},{key:'${mode === "variables-wrong-keys" ? "APP_REGION" : "EMPTY_VALUE"}',variableId:'empty',version:1}],secrets:${mode === "variables-secrets"}?[{key:'APP_TOKEN',secretId:'foreign',version:1}]:[],skills:[],connections:${mcp}?['${mcpId}']:[]};
const receipts=['personal/notes@3.0.0','catalog/other@1.0.0'].map(reference=>({reference,version:reference.split('@')[1],skillId:'11111111-1111-4111-8111-111111111111',checksum:'sha256:'+'a'.repeat(64),origin:'https://skillpack.app/v1'}));
const usageIds=()=>['prompt',...(sends?['followup']:[]),...(resumes?['resumed']:[]),...(resumes&&sends>1?['github-resumed']:[]),...(${mode === "usage-extra-observation"}?['background']:[])];
const usageData=()=>({model:'gpt-6.1-sol',inputTokens:100,outputTokens:20,cachedTokens:10,cacheWriteTokens:${["usage-unknown", "usage-zero-missing"].includes(mode)}?null:0,reasoningTokens:null,...(${mode === "usage-forged-guest-money"}?{usd:'999',pricing:{usd:'999'}}:{})});
const projectedUsage=()=>{
 const raw=usageData(),ids=usageIds(),missing=${mode === "usage-unknown"};
 const counts={inputTokens:100,outputTokens:20,cachedTokens:10,cacheWriteTokens:${mode === "usage-zero-missing"}?0:raw.cacheWriteTokens,reasoningTokens:null};
 const quote={schemaVersion:1,basis:'estimated',credentialId:'${mode === "usage-wrong-account" ? "foreign" : accountId}',credentialVersion:1,capturedAt:'2026-11-13T00:00:00Z',snapshot:{schemaVersion:1,provider:'openai',model:raw.model,source:'connection',revision:'1',connectionId:'${accountId}',unsupported:false,rates:{input:${mode === "usage-resume-repricing"}&&resumes?'200':'2',output:'5',cacheRead:'1',cacheWrite:null,reasoning:null}},inputs:{...counts,cacheWriteTtl:null},usd:missing?null:'0.00029',unknown:missing?'tokens':null};
 return {turnCount:ids.length,computeSeconds:1,turns:ids.map(promptId=>({...counts,promptId,model:'${mode === "usage-wrong-model" ? "foreign" : "gpt-6.1-sol"}',pricing:${mode === "usage-no-admission"}?null:quote})),tokenTotals:{inputTokens:100*ids.length+(${mode === "usage-wrong-totals"}||(stops>0&&${mode === "usage-stopped-drift"})||(stops===2&&${mode === "usage-resume-stopped-drift"})?1:0),outputTokens:20*ids.length,cachedTokens:10*ids.length,cacheWriteTokens:missing?null:0,reasoningTokens:null,incomplete:true},cost:{currency:'USD',basis:'estimated',usd:missing?null:${mode === "usage-forged-cost"}?'999':['0','0.00029','0.00058','0.00087','0.00116','0.00145'][ids.length],unknown:missing?'tokens':null,unpricedTurns:missing?ids.length:0}};
};
Date.now=()=>now;Bun.sleep=async(ms)=>{now+=Number(ms);};
process.on('exit',()=>{console.log('COUNTERS '+JSON.stringify({launches,stops,checkpoints,sends,resumes}));console.log('SKILLS '+JSON.stringify({defaultReads,skillStatuses,goldenReads}));});
globalThis.fetch=async(url,options)=>{
 const path=new URL(url).pathname,body=JSON.parse(options.body);
 if(new Headers(options.headers).get('authorization')!=='Bearer '+process.env.ARMADA_TOKEN)throw Error('auth');
 if(path.endsWith('/launch/options'))return Response.json({modalRuntime:{version:1,enabled:${mode !== "disabled"},followupVersion:${mode === "old-followup" && !claude && !opencode ? 0 : 1},claudeVersion:${scenario === "claude-old-version" ? 0 : 1},opencodeVersion:${scenario === "opencode-old-version" ? 0 : 1},opencodeShellProofVersion:${shellOld ? 0 : 1},resumeVersion:${mode === "old-resume" ? 0 : 1},mcpVersion:${mode === "mcp-old-version" ? 1 : 2},skillsVersion:${mode === "skills-old-version" ? 0 : 1},variablesVersion:${mode === "variables-old-version" ? 0 : 1},usageVersion:${mode === "usage-old-version" ? 0 : 1}}});
 if(path.endsWith('/golden/list')){if(++goldenReads!==1)throw Error('golden resolved twice');return Response.json({goldens:[{id:'golden-id',name:'golden',provider:'modal',orgId:'org-id'}]});}
 if(path.endsWith('/templates/get')){if(body.org!=='org-id'||body.id!=='${templateId}'||Object.hasOwn(body,'revision'))throw Error('wrong template lookup');return Response.json({item:{id:'${mode === "variables-wrong-template" ? "foreign" : templateId}',status:'active',orgId:'org-id'},revision:{id:'44444444-4444-4444-8444-444444444444',revision:2,definition:templateDefinition}});}
 if(path.endsWith('/sandbox/mcp-preflight-v1')){if(body.org!=='org-id'||body.runtimeVersion!==1||JSON.stringify(body.connections)!==JSON.stringify(['${mcpId}']))throw Error('wrong MCP preflight');return Response.json({mcpReady:${mode !== "mcp-preflight-denied"}});}
 if(path.endsWith('/skills/defaults/get')){defaultReads++;if(body.org!=='org-id'||(body.scope==='golden'?body.goldenId!=='golden-id':Object.hasOwn(body,'goldenId')))throw Error('wrong defaults scope');return Response.json({skills:${mode === "skills-empty"}?[]:({golden:['catalog/notes@1.0.0','catalog/other@1.0.0'],org:['notes@2.0.0'],personal:['personal/notes@3.0.0']}[body.scope])});}
 if(path.endsWith('/sandbox/status')){skillStatuses++;return Response.json({...(${usage}?{usage:projectedUsage()}:{}),skills:${mode === "skills-status-mismatch"}||(resumes&&stops===1&&${mode === "skills-resume-status-mismatch"})||(stops===2&&${mode === "skills-resume-stop-status-mismatch"})?receipts.slice(1):receipts});}
 if(path.endsWith('/sandbox/github-preflight-v1')){if(body.org!=='org-id'||body.repository!=='example/web')throw Error('bad preflight');return Response.json({githubReady:true,provider:${mode === "github-old-preflight"}?undefined:'modal'});}
 if(path.endsWith('/github/refresh'))return Response.json({status:'connected',runtime:{kind:'armada',epoch:${mode === "github-wrong-epoch"}?'99':resumes?'2':'1'},revision:${mode === "github-resume-reused-revision"}?(githubRevision++,'1'):String(++githubRevision)});
 if(path.endsWith('/github/runtime-status')){
  const configured=!resumes||githubRevision>1||${mode === "github-resume-old-config"};
  return Response.json({configured,runtime:{kind:'armada',epoch:resumes?'2':'1'},revision:${mode === "github-stale-revision"}?'foreign':${mode === "github-resume-reused-revision"}?'1':String(githubRevision),credentialRequests:${mode === "github-no-acquisition"}?0:1});
 }
 if(path.endsWith('/sandbox/launch-modal-runtime-v1')){
  launches++;if(launches!==1||body.provider!=='modal'||body.runtimeTransport!=='dialout'||body.runtimeVersion!==1||body.harness!=='${opencode ? "opencode" : claude ? "claude" : "codex"}'||body.ttlSeconds!==900||(${skills}?(defaultReads!==3||Object.hasOwn(body,'skipSkillDefaults')||Object.hasOwn(body,'skills')):(body.skipSkillDefaults!==true||body.skills.length)))throw Error('unsafe launch');
  if(${variables}) {
    if(body.id!=='${templateId}'||body.revision!==2||!body.requestKey||body.org!=='org-id'||['golden','credentialId','model','connections'].some(key=>Object.hasOwn(body,key)))throw Error('ambiguous template launch');
    variableCommand=body.prompt.match(/(node -e '.*?') successfully/)[1];
    const env={...process.env,...variableValues};if(${mode === "variables-missing-env"})delete env.EMPTY_VALUE;
    const program=variableCommand.slice("node -e '".length,-1);
    const executed=Bun.spawnSync([process.execPath,'-e',program],{env});
    if(executed.exitCode!==0)throw Error('readable program failed');actualVariableOutput=executed.stdout.toString();
    if(body.prompt.includes(variableDigest)||Object.values(variableValues).some(value=>value&&body.prompt.includes(value)))throw Error('readable data leaked into prompt');
  } else if(JSON.stringify(body.connections)!==JSON.stringify(${mcp}?['${mcpId}']:[]))throw Error('unsafe direct connections');
  if(${mcp}&&(!body.prompt.includes('${mcpServer}')||!body.prompt.includes('read_counter')))throw Error('MCP instruction missing');
  if(${mode === "lost-launch"})throw Error('private transport diagnostics must not surface');
  answer=body.prompt.match(/ARMADA_MODAL_[a-f0-9]+/)[0];memory=body.prompt.match(/ARMADA_MEMORY_[a-f0-9]+/)[0];
  if(${variables})return Response.json({state:'succeeded',id:'worker',provider:'modal',runtime:{kind:'armada',epoch:'1'},promptId:'prompt',conversationId:'conversation',manifest:{templateId:'${templateId}',requestKey:body.requestKey,revision:2,revisionId:'44444444-4444-4444-8444-444444444444',golden:{id:'golden-id',orgId:'org-id',provider:'modal'},account:${mode === "variables-receipt-mismatch"}?{id:'foreign',version:1}:templateDefinition.modelAccount,definition:templateDefinition,variables:variableValues,skillReceipts:receipts}});
  return Response.json({sandbox:{id:'worker',provider:'modal',runtimeTransport:'dialout',goldenId:'${mode === "skills-wrong-golden" ? "foreign" : "golden-id"}',...(${skills && mode !== "skills-missing-launch"}?{skills:receipts}:{})},runtime:{kind:'armada',epoch:'1'},promptId:'prompt',conversationId:'conversation'});
 }
 if(path.endsWith('/sandbox/send')){
  if(++sends>(${github && resume}?2:1)||body.id!=='worker'||body.conversation_id!=='conversation'||!/^[a-f0-9-]{36}$/.test(body.request_id)||body.prompt.includes(memory))throw Error('unsafe followup');
  if(${mcp}&&(!body.prompt.includes('${mcpServer}')||!body.prompt.includes('read_counter')))throw Error('MCP instruction missing');
  if(${variables}&&(!body.prompt.includes(variableCommand)||body.prompt.includes(variableDigest)||Object.values(variableValues).some(value=>value&&body.prompt.includes(value))))throw Error('invalid readable followup instruction');
  if(${mode === "lost-followup"})throw Error('private transport diagnostics must not surface');
  return Response.json({requestId:${mode === "wrong-request"}? 'wrong':body.request_id,runtime:{kind:'armada',epoch:${mode === "stale-epoch"}?'2':resumes?'2':'1'},promptId:${mode === "reused-prompt"}?'prompt':resumes?'github-resumed':'followup',conversationId:'${mode === "wrong-conversation" ? "foreign" : "conversation"}'});
 }
 if(path.endsWith('/logs/read')){
  const pair=(promptId,text,kind='assistant')=>[{id:'answer-'+promptId,at:1,promptId,kind:'message',partial:false,responseKind:kind,tools:[],text},{id:'finished-'+promptId,at:2,promptId,kind:'prompt',text:'',status:'finished'}];
  let events=[...pair(${mode === "wrong-prompt"}?'foreign':'prompt',answer,'${mode === "tool-result" ? "tool_result" : "assistant"}'),...(sends?pair('followup',memory):[]),...(resumes?pair('resumed',memory,'${mode === "resume-tool-result" ? "tool_result" : "assistant"}'):[])];
  if(${github} && sends && !${mode === "github-missing-tool" && scenario !== "opencode-github-display-only"}){
    const toolPrompt=resumes&&sends>1?'github-resumed':'followup';
    events.push(...pair('github-resumed',memory).filter(()=>resumes&&sends>1));
    events.push({id:'gh-tool',at:3,kind:'message',promptId:toolPrompt,partial:false,text:'',tools:[{id:'gh',name:'commandExecution',input:{command:${JSON.stringify(mode === "github-wrapper" ? "/bin/bash -lc 'gh api repos/example/web --jq .full_name'" : "gh api repos/example/web --jq .full_name" + (mode === "github-echo-mask" ? " || echo example/web" : ""))}},result:{isError:false,output:'${mode === "github-wrong-output" ? "echo example/web" : "example/web"}'}}]});
  }
  if(${mcp}) {
    const promptIds=[...new Set(events.filter(event=>event.kind==='message').map(event=>event.promptId))];
    for(const promptId of promptIds) {
      if(resumes&&promptId==='resumed'&&${mode === "mcp-resume-replay"})continue;
      events.push({id:'mcp-'+promptId,at:3,promptId:${mode === "mcp-old-prompt"}?'foreign':promptId,kind:'message',partial:false,text:'',tools:[{id:'mcp',server:'${mode === "mcp-wrong-server" ? "foreign" : mcpServer}',name:'${mode === "mcp-wrong-tool" ? "foreign" : "read_counter"}',input:{label:'fixture',nested:{a:1,b:${mode === "mcp-wrong-args" ? 3 : 2}}},...(${mode === "mcp-no-result" && scenario !== "claude-mcp-wrong-result-id"}?{}:{result:{isError:${mode === "mcp-error-result"},output:'${mode === "mcp-wrong-output" ? "foreign" : "independent result"}'}})}]});
    }
  }
  if(${variables}&&!${mode === "variables-no-tool"}) {
    const quote=value=>String.fromCharCode(39)+value.split(String.fromCharCode(39)).join(String.fromCharCode(39,92,39,39))+String.fromCharCode(39);
    for(const promptId of [...new Set(events.filter(event=>event.kind==='message').map(event=>event.promptId))]) {
      if(resumes&&promptId==='resumed'&&${mode === "variables-resume-replay"})continue;
      const output=${mode === "variables-wrong-hash" && !["opencode-variables-bad-exit", "opencode-variables-truncated"].includes(scenario)}?'0'.repeat(64):actualVariableOutput;
      const command=${mode === "variables-wrapper"}?'bash -lc '+quote(variableCommand):variableCommand+(${mode === "variables-echo-mask"}?' || echo '+variableDigest:'');
      events.push({id:'env-'+promptId,at:3,promptId:${mode === "variables-old-prompt"}?'foreign':promptId,kind:'message',partial:false,text:'',tools:[{id:'env',name:'commandExecution',input:{command},result:{isError:false,output}}]});
    }
  }
  if(${usage}&&!${mode === "usage-missing-facts"}){
    usagePages++;
    if(!${mode === "usage-late"}||usagePages>1)for(const promptId of usageIds())events.push({id:'usage-'+promptId,at:4,promptId,kind:'other',type:'armada/turnUsage',data:usageData()});
  }
  if(sends&&${mode === "replayed-answer"})events=pair('prompt',memory);
  if((stops===1&&!resumes&&${mode === "resume-lost-stopped-history"})||(resumes&&${mode === "resume-lost-old-history"}))events=events.filter(event=>event.promptId==='resumed');
  if(${opencode}&&!${scenario === "opencode-github-display-only"}) {
    for(const event of [...events])for(const tool of event.tools??[]) {
      if(tool.name!=='commandExecution'||!tool.result)continue;
      events.push({id:event.id+'-native',at:4,promptId:event.promptId,kind:'other',type:'armada/opencodeShell',data:{
        version:1,nativeMessageId:'native-'+event.promptId,callId:tool.id,tool:'bash',command:tool.input.command,
        output:tool.result.output,exitCode:${scenario === "opencode-variables-bad-exit"}?1:0,truncated:${scenario === "opencode-variables-truncated"},
      }});
    }
  }
  if(${claude}) {
    events=events.flatMap(event=>{
      if(event.kind!=='message'||!event.tools.length)return [event];
      const calls=event.tools.map(tool=>({id:tool.id,name:tool.server?'mcp__'+tool.server+'__'+tool.name:tool.name==='commandExecution'?'Bash':tool.name,input:tool.input}));
      const results=event.tools.filter(tool=>tool.result).map(tool=>({...event,id:event.id+'-result',responseKind:'tool_result',tools:[{id:${scenario === "claude-mcp-wrong-result-id"}?'unrelated':tool.id,name:'tool_result',result:{...tool.result,output:typeof tool.result.output==='string'?[{type:'text',text:tool.result.output}]:tool.result.output}}]}));
      return [{...event,responseKind:'assistant',tools:calls},...results];
    });
    // Uses and results really arrive on separate archive pages.
    if(!body.cursor)return Response.json({source:'armada-runtime',cursor:'claude-results',events:events.filter(event=>event.kind==='message'&&event.responseKind==='assistant'&&event.tools.length)});
    events=events.filter(event=>!(event.kind==='message'&&event.responseKind==='assistant'&&event.tools.length));
  }
  return Response.json({source:'${mode === "wrong-source" ? "modal-native" : "armada-runtime"}',events});
 }
 if(path.endsWith('/sandbox/checkpoint-runtime-v1')){
  checkpoints++;if(body.id!=='worker'||body.runtimeVersion!==1||!body.request_id)throw Error('bad checkpoint input');
  if(checkpoints===1)firstCheckpoint=body.request_id;else if((!resumes&&body.request_id!==firstCheckpoint)||(resumes&&body.request_id===firstCheckpoint))throw Error('wrong checkpoint replay identity');
  return Response.json({requestId:body.request_id,runtime:{kind:'armada',epoch:resumes?'2':'1'},checkpoint:{state:'complete',watermark:resumes?6:4,acknowledgedSequence:${mode === "bad-checkpoint"}?1:resumes&&${mode === "resume-bad-checkpoint"}?5:resumes?6:4}});
 }
 if(path.endsWith('/sandbox/resume-runtime-v1')){
  if(++resumes!==1||stops!==1||body.id!=='worker'||body.conversation_id!=='conversation'||!body.request_id||body.runtimeVersion!==1||body.prompt.includes(memory))throw Error('unsafe resume');
  if(${mcp}&&(!body.prompt.includes('${mcpServer}')||!body.prompt.includes('read_counter')))throw Error('MCP resume instruction missing');
  if(${variables}&&(!body.prompt.includes(variableCommand)||body.prompt.includes(variableDigest)||Object.values(variableValues).some(value=>value&&body.prompt.includes(value))))throw Error('invalid readable resumed instruction');
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
        ...(claude ? ["--claude"] : []),
        ...(opencode ? ["--opencode"] : []),
        ...(github || shellOld ? ["--github"] : []),
        ...(mcp ? ["--mcp"] : []),
        ...(skills ? ["--skills"] : []),
        ...(variables ? ["--variables"] : []),
        ...(usage ? ["--usage"] : []),
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
          ARMADA_RUNTIME_CREDENTIAL_ID: accountId,
          ...(variables ? { ARMADA_RUNTIME_TEMPLATE_ID: templateId } : {}),
          ...(github ? { ARMADA_RUNTIME_GITHUB_REPOSITORY: "example/web" } : {}),
          ...(mcp
            ? {
                ARMADA_RUNTIME_MCP_CONNECTION_ID: mcpId,
                ARMADA_RUNTIME_MCP_TOOL: "read_counter",
                ARMADA_RUNTIME_MCP_EXPECT: "independent result",
                ARMADA_RUNTIME_MCP_ARGS_JSON:
                  mode === "mcp-invalid-json" ? "[" : JSON.stringify({ nested: { b: 2, a: 1 }, label: "fixture" }),
              }
            : {}),
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
    if (scenario === "opencode-tools-blocked")
      expect(stderr).toContain("OpenCode MCP tool-proof smoke is not yet admitted");
    if (shellOld) expect(stderr).toContain("OpenCode native shell proof v1 is unavailable");
    if (scenario === "opencode-old-version") expect(stderr).toContain("Modal enrolled OpenCode v1 is unavailable");
    if (scenario === "opencode-claude-conflict") expect(stderr).toContain("Select only one harness");
    expect(status === 0, stderr).toBe(
      [
        "success",
        "resume",
        "github",
        "github-resume",
        "github-wrapper",
        "mcp",
        "mcp-resume",
        "mcp-github-resume",
        "skills",
        "skills-resume",
        "skills-mcp-github-resume",
        "variables",
        "variables-resume",
        "variables-skills-mcp-github-resume",
        "variables-wrapper",
        "usage",
        "usage-unknown",
        "usage-late",
        "usage-extra-observation",
        "usage-forged-guest-money",
        "usage-variables-skills-mcp-github-resume",
        "usage-variables-skills-github-resume",
      ].includes(mode),
    );
    const counters = JSON.parse(stdout.match(/COUNTERS (.+)/)?.[1] ?? "null");
    expect(counters).toEqual(
      usage
        ? (() => {
            const preflight = mode === "usage-old-version";
            const initialPass = [
              "usage",
              "usage-unknown",
              "usage-late",
              "usage-extra-observation",
              "usage-forged-guest-money",
              "usage-stopped-drift",
              "usage-resume-repricing",
              "usage-resume-stopped-drift",
              "usage-variables-skills-mcp-github-resume",
              "usage-variables-skills-github-resume",
            ].includes(mode);
            return {
              launches: preflight ? 0 : 1,
              stops: preflight ? 0 : resume ? 2 : 1,
              checkpoints: initialPass ? (mode === "usage-resume-repricing" ? 2 : resume ? 3 : 1) : 0,
              resumes: resume ? 1 : 0,
              sends: initialPass ? (github ? 2 : 1) : 0,
            };
          })()
        : variables
          ? (() => {
              const preflight = [
                "variables-old-version",
                "variables-wrong-template",
                "variables-wrong-golden",
                "variables-wrong-account",
                "variables-wrong-keys",
                "variables-missing-vars",
                "variables-secrets",
              ].includes(mode);
              const initialPass = [
                "variables",
                "variables-wrapper",
                "variables-resume",
                "variables-skills-mcp-github-resume",
                "variables-resume-replay",
              ].includes(mode);
              return {
                launches: preflight ? 0 : 1,
                stops: preflight ? 0 : resume ? 2 : 1,
                checkpoints: initialPass ? (mode === "variables-resume-replay" ? 2 : resume ? 3 : 1) : 0,
                resumes: resume ? 1 : 0,
                sends: initialPass ? (github ? 2 : 1) : 0,
              };
            })()
          : skills
            ? (() => {
                const preflight = ["skills-empty", "skills-old-version"].includes(mode);
                const initialPass = [
                  "skills",
                  "skills-resume",
                  "skills-resume-status-mismatch",
                  "skills-resume-stop-status-mismatch",
                  "skills-mcp-github-resume",
                ].includes(mode);
                return {
                  launches: preflight ? 0 : 1,
                  stops: preflight ? 0 : resume ? 2 : 1,
                  checkpoints: initialPass ? (mode === "skills-resume-status-mismatch" ? 2 : resume ? 3 : 1) : 0,
                  resumes: resume ? 1 : 0,
                  sends: initialPass ? (github ? 2 : 1) : 0,
                };
              })()
            : mcp
              ? (() => {
                  const preflight = ["mcp-old-version", "mcp-preflight-denied", "mcp-invalid-json"].includes(mode);
                  const initialPass = [
                    "mcp",
                    "mcp-resume",
                    "mcp-github-resume",
                    "mcp-resume-replay",
                    "skills-mcp-github-resume",
                  ].includes(mode);
                  return {
                    launches: preflight ? 0 : 1,
                    stops: preflight ? 0 : resume ? 2 : 1,
                    checkpoints: initialPass ? (mode === "mcp-resume-replay" ? 2 : resume ? 3 : 1) : 0,
                    resumes: resume ? 1 : 0,
                    sends: initialPass ? (github ? 2 : 1) : 0,
                  };
                })()
              : github
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
                      mode === "github-old-preflight" || mode === "github-wrong-epoch"
                        ? 0
                        : mode === "github-resume"
                          ? 2
                          : 1,
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
    if (
      [
        "success",
        "resume",
        "github",
        "github-resume",
        "github-wrapper",
        "mcp",
        "mcp-resume",
        "mcp-github-resume",
        "skills",
        "skills-resume",
        "skills-mcp-github-resume",
        "variables",
        "variables-resume",
        "variables-skills-mcp-github-resume",
        "usage-variables-skills-mcp-github-resume",
        "usage-variables-skills-github-resume",
        "variables-wrapper",
        "usage",
        "usage-unknown",
        "usage-late",
        "usage-extra-observation",
        "usage-forged-guest-money",
      ].includes(mode)
    ) {
      expect(stdout).toContain('"answer":"verified"');
      expect(stdout).toContain('"checkpoint":"verified"');
      expect(stdout).toContain('"followup":"verified"');
      expect(stdout).toContain("compute stopped");
    } else if ((!resume || mode === "old-resume") && mode !== "usage-stopped-drift")
      expect(stdout).not.toContain('"answer":"verified"');
    expect(stdout.includes('"resume":"verified"')).toBe(
      [
        "resume",
        "github-resume",
        "mcp-resume",
        "mcp-github-resume",
        "skills-resume",
        "skills-mcp-github-resume",
        "variables-resume",
        "variables-skills-mcp-github-resume",
        "usage-variables-skills-mcp-github-resume",
        "usage-variables-skills-github-resume",
      ].includes(mode),
    );
    if (github)
      expect(stdout.includes('"github":"verified"')).toBe(
        [
          "github",
          "github-wrapper",
          "github-resume",
          "github-resume-old-config",
          "github-resume-reused-revision",
          "mcp-github-resume",
          "skills-mcp-github-resume",
          "variables-skills-mcp-github-resume",
          "usage-variables-skills-mcp-github-resume",
          "usage-variables-skills-github-resume",
        ].includes(mode),
      );
    expect(stdout.includes('"githubAfterResume":"verified"')).toBe(
      [
        "github-resume",
        "mcp-github-resume",
        "skills-mcp-github-resume",
        "variables-skills-mcp-github-resume",
        "usage-variables-skills-mcp-github-resume",
        "usage-variables-skills-github-resume",
      ].includes(mode),
    );
    if (usage) {
      const initialPass = [
        "usage",
        "usage-unknown",
        "usage-late",
        "usage-extra-observation",
        "usage-forged-guest-money",
        "usage-stopped-drift",
        "usage-resume-repricing",
        "usage-resume-stopped-drift",
        "usage-variables-skills-mcp-github-resume",
        "usage-variables-skills-github-resume",
      ].includes(mode);
      expect(stdout.includes('"usage":"verified"')).toBe(initialPass);
      expect(stdout.includes('"usageAfterResume":"verified"')).toBe(
        ["usage-variables-skills-mcp-github-resume", "usage-variables-skills-github-resume"].includes(mode),
      );
      if (mode === "usage-unknown") expect(stdout).toContain('"status":"unknown"');
      if (mode === "usage-missing-facts" || mode === "usage-old-version")
        expect(JSON.parse(stdout.match(/SKILLS (.+)/)?.[1] ?? "null").skillStatuses).toBe(0);
    }
    if (variables) {
      expect(stdout + stderr).not.toContain(variableDigest);
      expect(stdout + stderr).not.toContain(variableValues.APP_REGION);
      expect(stdout.includes('"variables":"verified"')).toBe(
        [
          "variables",
          "variables-wrapper",
          "variables-resume",
          "variables-skills-mcp-github-resume",
          "usage-variables-skills-mcp-github-resume",
          "usage-variables-skills-github-resume",
          "variables-resume-replay",
        ].includes(mode),
      );
      expect(stdout.includes('"variablesAfterResume":"verified"')).toBe(
        [
          "variables-resume",
          "variables-skills-mcp-github-resume",
          "usage-variables-skills-mcp-github-resume",
          "usage-variables-skills-github-resume",
        ].includes(mode),
      );
    }
    if (skills) {
      const observed = JSON.parse(stdout.match(/SKILLS (.+)/)?.[1] ?? "null");
      expect(observed.defaultReads).toBe(mode === "skills-old-version" ? 0 : 3);
      expect(observed.goldenReads).toBe(mode === "skills-old-version" ? 0 : 1);
      expect(observed.skillStatuses).toBe(
        ["skills-empty", "skills-old-version"].includes(mode)
          ? 0
          : mode === "skills-wrong-golden"
            ? 1
            : usage
              ? 14
              : resume
                ? 4
                : 2,
      );
      expect(stdout.includes('"skills":"verified"')).toBe(
        [
          "skills",
          "skills-resume",
          "skills-resume-status-mismatch",
          "skills-resume-stop-status-mismatch",
          "skills-mcp-github-resume",
          "variables-skills-mcp-github-resume",
          "usage-variables-skills-mcp-github-resume",
          "usage-variables-skills-github-resume",
        ].includes(mode),
      );
      expect(stdout.includes('"skillsAfterResume":"verified"')).toBe(
        [
          "skills-resume",
          "skills-mcp-github-resume",
          "variables-skills-mcp-github-resume",
          "usage-variables-skills-mcp-github-resume",
          "usage-variables-skills-github-resume",
        ].includes(mode),
      );
      if (mode === "skills-empty") expect(stderr).toContain("No default skills configured");
    }
    if (mcp) {
      expect(stdout.includes('"mcp":"verified"')).toBe(
        [
          "mcp",
          "mcp-resume",
          "mcp-github-resume",
          "mcp-resume-replay",
          "skills-mcp-github-resume",
          "variables-skills-mcp-github-resume",
          "usage-variables-skills-mcp-github-resume",
          "usage-variables-skills-github-resume",
        ].includes(mode),
      );
      expect(stdout.includes('"mcpAfterResume":"verified"')).toBe(
        [
          "mcp-resume",
          "mcp-github-resume",
          "skills-mcp-github-resume",
          "variables-skills-mcp-github-resume",
          "usage-variables-skills-mcp-github-resume",
          "usage-variables-skills-github-resume",
        ].includes(mode),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
