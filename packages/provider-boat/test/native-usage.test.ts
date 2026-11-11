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
digest=hashlib.sha256(b'normal prompt').hexdigest()
session='12345678-1234-1234-1234-123456789012'
os.makedirs(HOME+'/.codex/sessions/2026/01/01')
path=HOME+'/.codex/sessions/2026/01/01/rollout-'+session+'.jsonl'
def write(total,mode='w',model='gpt-5',turn='t1'):
    rows=[{'type':'session_meta','payload':{'id':session}}, {'type':'event_msg','payload':{'type':'task_started','turn_id':turn}}, {'type':'turn_context','payload':{'model':model}}, {'type':'event_msg','payload':{'type':'token_count','info':{'total_token_usage':dict(zip(['input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens','reasoning_output_tokens'],total))}}}, {'type':'event_msg','payload':{'type':'task_complete','turn_id':turn}}]
    with open(path,mode) as f:
        for row in rows: f.write(json.dumps(row)+'\\n')
def admit(ticket,prompt):
    save(ticket+'.json',{});save('pending.json',{'ticket':ticket,'at':time.time(),'digest':digest});save('prompt-'+prompt+'.json',{'ticket':ticket})
`;
describe("Boat guest native usage", () => {
  test("multi-turn Codex cumulative counters yield deltas, retries do not add", () => {
    expect(
      guest(
        setup +
          `
admit('one','p1');capture('codex',session,True,digest);start('one','t1')
write([100,20,40,10,5]);terminal('one','t1')
a=collect('p1');retry=collect('p1')
admit('two','p2');capture('codex',session,False,digest);start('two','t2')
write([150,35,60,17,8],mode='a',turn='t2');terminal('two','t2')
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
  test("a valid stale flush is never frozen at admission or attributed to the next turn", () => {
    expect(
      guest(
        setup +
          `
admit('one','p1');capture('codex',session,True,digest);start('one','t1')
write([50,10,0,0,0])
# Remove the native completion marker, leaving valid but stale cumulative usage.
lines=open(path).readlines()
with open(path,'w') as f: f.writelines(lines[:-1])
terminal('one','t1');early=collect('p1')
admit('two','p2');capture('codex',session,False,digest);start('two','t2')
stale=collect('p1')
# The delayed t1 flush and its native completion arrive AFTER t2 admission.
with open(path,'a') as f:
    f.write(json.dumps({'type':'event_msg','payload':{'type':'token_count','info':{'total_token_usage':{'input_tokens':100,'output_tokens':20,'cached_input_tokens':0}}}})+'\\n')
    f.write(json.dumps({'type':'event_msg','payload':{'type':'task_complete','turn_id':'t1'}})+'\\n')
write([150,30,0,0,0],mode='a',turn='t2');terminal('two','t2')
a=collect('p1');b=collect('p2')
print(json.dumps([early,stale,a[0]['inputTokens'],b[0]['inputTokens'],collect('p1')==a,collect('p2')==b]))
`,
      ),
    ).toEqual([[], [], 100, 50, true, true]);
  });
  test("missing resume baseline, symlink, mismatched session identity fail closed", () => {
    expect(
      guest(
        setup +
          `
admit('one','p1');capture('codex',session,False,digest);start('one','t1')
write([100,20,40,10,5]);terminal('one','t1');resume=collect('p1')
admit('two','p2');capture('codex',session,False,digest);start('two','t2')
write([150,30,40,10,5],mode='a',turn='t2');terminal('two','t2')
os.rename(path,path+'.other');os.symlink(path+'.other',path)
linked=collect('p2');os.unlink(path)
os.rename(path+'.other',path);valid=len(collect('p2'))
entry=load('two.json');entry.pop('final');save('two.json',entry)
with open(path,'w') as f: f.write(json.dumps({'type':'session_meta','payload':{'id':'wrong'}})+'\\n')
print(json.dumps([resume,linked,valid,collect('p2')]))
`,
      ),
    ).toEqual([[], [], 1, []]);
  });
  test("an interrupted native turn leaves counters unknown without poisoning later closed turns", () => {
    expect(
      guest(
        setup +
          `
admit('one','p1');capture('codex',session,True,digest);start('one','t1')
write([100,20,0,0,0]);terminal('one','t1')
admit('two','p2');capture('codex',session,False,digest);start('two','t2')
write([150,30,0,0,0],mode='a',turn='t2')
lines=open(path).readlines()
with open(path,'w') as f: f.writelines(lines[:-1])
with open(path,'a') as f: f.write(json.dumps({'type':'event_msg','payload':{'type':'turn_aborted','turn_id':'t2'}})+'\\n')
terminal('two','t2')
admit('three','p3');capture('codex',session,False,digest);start('three','t3')
write([200,40,0,0,0],mode='a',turn='t3');terminal('three','t3')
admit('four','p4');capture('codex',session,False,digest);start('four','t4')
write([250,50,0,0,0],mode='a',turn='t4');terminal('four','t4')
print(json.dumps([collect('p1')[0]['inputTokens'],collect('p2'),collect('p3'),collect('p4')[0]['inputTokens']]))
`,
      ),
    ).toEqual([100, [], [], 50]);
  });
  test("Claude cumulative files without a proven native boundary remain unknown", () => {
    expect(
      guest(`
init();session='12345678-1234-1234-1234-123456789012'
save('one.json',{'session':session,'harness':'claude','fresh':True,'turn':'t1','terminal':True})
save('prompt-p1.json',{'ticket':'one'})
print(json.dumps(collect('p1')))
`),
    ).toEqual([]);
  });
  test("expired and rejected admissions recover without letting late callbacks claim newer prompts", () => {
    expect(
      guest(
        setup +
          `
import contextlib,io
def launch(ticket,text):
    fingerprint=hashlib.sha256(text.encode()).hexdigest()
    sys.argv=['usage','admit',ticket,'sandbox1',fingerprint]
    with contextlib.redirect_stdout(io.StringIO()) as out: main()
    if out.getvalue().strip()=='admitted': save('prompt-'+ticket+'.json',{'ticket':ticket})
    return fingerprint,out.getvalue().strip()
old,_=launch('old','abandoned')
pending=load('pending.json');pending['at']-=91;save('pending.json',pending)
expired=capture('codex',session,True,old)
current,admitted=launch('current','new prompt')
late=capture('codex',session,True,old)
matched=capture('codex',session,True,prompt_digest([{'type':'text','text':'new prompt'}]));start('current','t1')
write([100,20,0,0,0]);terminal('current','t1')
a=collect('current')
# An unclaimed rejected dispatch need not expire before a different input recovers.
rejected,_=launch('rejected','rejected input')
next_digest,again=launch('next','another prompt')
unsupported=capture('codex',session,False,prompt_digest([{'type':'image','url':'fixture'}]))
wrong=capture('codex',session,False,rejected)
right=capture('codex',session,False,next_digest);start('next','t2')
write([150,30,0,0,0],mode='a',turn='t2');terminal('next','t2')
print(json.dumps([expired,admitted,late,matched,a[0]['inputTokens'],collect('old'),again,wrong,right,collect('next')[0]['inputTokens'],collect('rejected'),unsupported]))
`,
      ),
    ).toEqual([null, "admitted", null, "current", 100, [], "admitted", null, "next", 50, [], null]);
  });
  test("identical ambiguous inputs stay unknown while later distinct admissions and fresh forks recover", () => {
    expect(
      guest(
        setup +
          `
import contextlib,io
def launch(ticket,generation,value=digest):
    sys.argv=['usage','admit',ticket,generation,value]
    with contextlib.redirect_stdout(io.StringIO()) as out: main()
    return out.getvalue().strip()
launch('one','sandbox1');save('prompt-p1.json',{'ticket':'one'})
ambiguous=launch('two','sandbox1')
late=capture('codex',session,True,digest)
retry=launch('three','sandbox1')
other=hashlib.sha256(b'different input').hexdigest()
recovered=launch('four','sandbox1',other)
# A fresh physical sandbox resets inherited quarantines as well as tickets.
fork=launch('five','sandbox2')
reset=not os.path.exists(ROOT+'/one.json')
print(json.dumps([collect('p1') if os.path.exists(ROOT+'/prompt-p1.json') else [],ambiguous,late,retry,recovered,fork,load('pending.json')['ticket'],reset]))
`,
      ),
    ).toEqual([[], "", null, "", "admitted", "admitted", "five", true]);
  });
});
