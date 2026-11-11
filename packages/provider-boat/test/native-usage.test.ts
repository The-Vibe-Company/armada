import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_USAGE_PYTHON } from "../src/native-usage.ts";

/** Exercises real guest admission and parsing, no harness/model or network. */
function guest(scenario: string): unknown {
  const home = mkdtempSync(join(tmpdir(), "armada-usage-"));
  try {
    const script = `import os,json,sys\nns={'__name__':'test'}\nexec(${JSON.stringify(NATIVE_USAGE_PYTHON)},ns)\nglobals().update(ns)\n${scenario}`;
    const result = Bun.spawnSync(["python3", "-c", script], { env: { ...process.env, HOME: home } });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return JSON.parse(result.stdout.toString());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
const setup = `
init()
session='12345678-1234-1234-1234-123456789012'
os.makedirs(HOME+'/.codex/sessions/2026/01/01')
path=HOME+'/.codex/sessions/2026/01/01/rollout-'+session+'.jsonl'
def write(total,mode='w',model='gpt-5'):
    rows=[{'type':'session_meta','payload':{'id':session}}, {'type':'turn_context','payload':{'model':model}}, {'type':'event_msg','payload':{'type':'token_count','info':{'total_token_usage':dict(zip(['input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens','reasoning_output_tokens'],total))}}}]
    with open(path,mode) as f:
        for row in rows: f.write(json.dumps(row)+'\\n')
def admit(ticket,prompt):
    save(ticket+'.json',{});save('pending.json',{'ticket':ticket,'at':time.time()});save('prompt-'+prompt+'.json',{'ticket':ticket})
`;
describe("Boat guest native usage", () => {
  test("multi-turn Codex cumulative counters yield deltas, retries do not add", () => {
    expect(
      guest(
        setup +
          `
admit('one','p1');capture('codex',session,True)
write([100,20,40,10,5]);terminal('one')
a=collect('p1');retry=collect('p1')
admit('two','p2');capture('codex',session,False)
write([150,35,60,17,8]);terminal('two')
print(json.dumps([a,retry,collect('p1'),collect('p2')]))
`,
      ),
    ).toEqual([
      [
        {
          model: "gpt-5",
          inputTokens: 100,
          outputTokens: 20,
          cachedTokens: 40,
          cacheWriteTokens: 10,
          reasoningTokens: 5,
        },
      ],
      [
        {
          model: "gpt-5",
          inputTokens: 100,
          outputTokens: 20,
          cachedTokens: 40,
          cacheWriteTokens: 10,
          reasoningTokens: 5,
        },
      ],
      [
        {
          model: "gpt-5",
          inputTokens: 100,
          outputTokens: 20,
          cachedTokens: 40,
          cacheWriteTokens: 10,
          reasoningTokens: 5,
        },
      ],
      [
        {
          model: "gpt-5",
          inputTokens: 50,
          outputTokens: 15,
          cachedTokens: 20,
          cacheWriteTokens: 7,
          reasoningTokens: 3,
        },
      ],
    ]);
  });
  test("delayed flush retries, failed boundary freeze never reads next-turn counters", () => {
    expect(
      guest(
        setup +
          `
admit('one','p1');capture('codex',session,True);terminal('one')
missing=collect('p1')
write([100,20,40,10,5]);late=collect('p1')
with open(path,'a') as f: f.write('{')
truncated=collect('p1')
admit('two','p2');capture('codex',session,False)
write([999,999,999,999,999]);terminal('two')
print(json.dumps([missing,len(late),truncated,collect('p1'),collect('p2')]))
`,
      ),
    ).toEqual([[], 1, [], [], []]);
  });
  test("missing resume baseline, symlink, mismatched session identity fail closed", () => {
    expect(
      guest(
        setup +
          `
admit('one','p1');capture('codex',session,False)
write([100,20,40,10,5]);terminal('one');resume=collect('p1')
admit('two','p2');capture('codex',session,True);terminal('two')
os.rename(path,path+'.other');os.symlink(path+'.other',path)
linked=collect('p2');os.unlink(path)
with open(path,'w') as f: f.write(json.dumps({'type':'session_meta','payload':{'id':'wrong'}})+'\\n')
print(json.dumps([resume,linked,collect('p2')]))
`,
      ),
    ).toEqual([[], [], []]);
  });
  test("Claude takes final per-model cost-state, not duplicate frames or transcript", () => {
    expect(
      guest(`
init();session='12345678-1234-1234-1234-123456789012'
os.makedirs(HOME+'/.claude/projects/project');path=HOME+'/.claude/projects/project/'+session+'.jsonl'
save('one.json',{});save('pending.json',{'ticket':'one','at':time.time()});save('prompt-p1.json',{'ticket':'one'})
capture('claude',session,True)
with open(path,'w') as f:
    f.write(json.dumps({'type':'assistant','sessionId':session,'message':{'content':'PRIVATE MUST NOT ESCAPE'}})+'\\n')
    for i in (1,1,2): f.write(json.dumps({'type':'cost-state','modelUsage':{'claude-sonnet-5':{'inputTokens':i,'outputTokens':11,'cacheReadInputTokens':18996,'cacheCreationInputTokens':17578,'thinkingTokens':0}}})+'\\n')
terminal('one');print(json.dumps(collect('p1')))
`),
    ).toEqual([
      {
        model: "claude-sonnet-5",
        inputTokens: 2,
        outputTokens: 11,
        cachedTokens: 18996,
        cacheWriteTokens: 17578,
        reasoningTokens: 0,
      },
    ]);
  });
  test("persistent Claude stream bridge binds each native result to its admitted turn", () => {
    expect(
      guest(`
import subprocess
init();native=HOME+'/fake-claude'
source=r"""#!/usr/bin/python3
import sys,json,os
session=sys.argv[sys.argv.index('--session-id')+1]
root=os.path.expanduser('~')+'/.claude/projects/project';os.makedirs(root)
path=root+'/'+session+'.jsonl'
count=0
for line in sys.stdin:
    frame=json.loads(line);count+=1
    with open(path,'a') as f:
        f.write(json.dumps({'type':'assistant','sessionId':session})+'\\n')
        f.write(json.dumps({'type':'cost-state','modelUsage':{'claude-sonnet-5':{'inputTokens':count*5,'outputTokens':count*2,'cacheReadInputTokens':0,'cacheCreationInputTokens':0,'thinkingTokens':0}}})+'\\n')
    print(json.dumps({'type':'result','session_id':session,'fixture':count}),flush=True)
"""
with open(native,'w') as f: f.write(source)
os.chmod(native,0o700)
save('one.json',{});save('pending.json',{'ticket':'one','at':time.time()});save('prompt-p1.json',{'ticket':'one'})
bridge=subprocess.Popen(['python3','-c',${JSON.stringify(NATIVE_USAGE_PYTHON)},'claude',native,'--input-format','stream-json'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
bridge.stdin.write(json.dumps({'type':'user','message':{'content':'private'}})+'\\n');bridge.stdin.flush()
first=json.loads(bridge.stdout.readline());a=collect('p1')
save('two.json',{});save('pending.json',{'ticket':'two','at':time.time()});save('prompt-p2.json',{'ticket':'two'})
bridge.stdin.write(json.dumps({'type':'user','message':{'content':'private'}})+'\\n');bridge.stdin.flush()
second=json.loads(bridge.stdout.readline());b=collect('p2')
bridge.stdin.close();code=bridge.wait(timeout=5)
print(json.dumps([first['fixture'],second['fixture'],code,a,b]))
`),
    ).toEqual([
      1,
      2,
      0,
      [
        {
          model: "claude-sonnet-5",
          inputTokens: 5,
          outputTokens: 2,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      ],
      [
        {
          model: "claude-sonnet-5",
          inputTokens: 5,
          outputTokens: 2,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      ],
    ]);
  });
  test("ambiguous concurrent admissions invalidate mapping, fresh fork resets inherited tickets", () => {
    expect(
      guest(
        setup +
          `
import contextlib,io
def launch(ticket,generation):
    sys.argv=['usage','admit',ticket,generation]
    with contextlib.redirect_stdout(io.StringIO()): main()
launch('one','sandbox1');save('prompt-p1.json',{'ticket':'one'})
launch('two','sandbox1')
capture('codex',session,True);write([100,20,40,10,5]);terminal('one')
ambiguous=collect('p1');disabled=os.path.exists(ROOT+'/disabled.json')
launch('three','sandbox2')
new_ticket=load('pending.json')['ticket'];reset=not os.path.exists(ROOT+'/one.json')
print(json.dumps([ambiguous,disabled,new_ticket,reset]))
`,
      ),
    ).toEqual([[], true, "three", true]);
  });
});
