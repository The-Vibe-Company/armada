import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { Provider, TurnTokenUsage } from "@armada/core";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const command = (operation: string, ...args: string[]) =>
  `python3 -I -c ${quote(NATIVE_USAGE_BOOTSTRAP)} ${[operation, ...args].map(quote).join(" ")}`;
export async function admitNativeUsage(provider: Provider, sandboxId: string): Promise<string | null> {
  const ticket = randomUUID();
  try {
    const r = await provider.exec({
      sandboxId,
      command: command("admit", ticket, sandboxId),
      timeoutSeconds: 10,
      onlyIfRunning: true,
    });
    return !r.detached && r.exitCode === 0 && r.stdout.trim() === "admitted" ? ticket : null;
  } catch {
    return null;
  }
}
export async function bindNativeUsage(
  provider: Provider,
  sandboxId: string,
  ticket: string,
  promptId: string,
): Promise<void> {
  try {
    await provider.exec({
      sandboxId,
      command: command("bind", ticket, promptId),
      timeoutSeconds: 10,
      onlyIfRunning: true,
    });
  } catch {
    /* Optional telemetry. */
  }
}
export async function collectNativeUsage(
  provider: Provider,
  sandboxId: string,
  promptId: string,
): Promise<TurnTokenUsage[]> {
  try {
    const r = await provider.exec({
      sandboxId,
      command: command("collect", promptId),
      timeoutSeconds: 10,
      onlyIfRunning: true,
    });
    if (r.detached || r.exitCode !== 0 || r.truncated || r.stdout.length > 32768) return [];
    const rows: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(rows) || rows.length > 32) return [];
    return rows.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const v = row as Record<string, unknown>;
      if (v.model !== null && (typeof v.model !== "string" || !/^[a-zA-Z0-9._:/-]{1,160}$/.test(v.model))) return [];
      const keys = ["inputTokens", "outputTokens", "cachedTokens", "cacheWriteTokens", "reasoningTokens"] as const;
      if (keys.some((k) => v[k] !== null && !(typeof v[k] === "number" && Number.isSafeInteger(v[k]) && v[k] >= 0)))
        return [];
      return [
        {
          promptId,
          model: v.model as string | null,
          ...Object.fromEntries(keys.map((k) => [k, v[k]])),
        } as TurnTokenUsage,
      ];
    });
  } catch {
    return [];
  }
}
/** Inert guest-local helper. Never exports transcript data or native filenames. */
export const NATIVE_USAGE_PYTHON = String.raw`
import os,sys,json,stat,re,time,fcntl,contextlib
HOME=os.path.expanduser('~'); ROOT=HOME+'/.armada/native-usage'
ID=re.compile(r'^[a-zA-Z0-9_-]{1,128}$'); UUID=re.compile(r'^[a-fA-F0-9-]{36}$')
FIELDS=['inputTokens','outputTokens','cachedTokens','cacheWriteTokens','reasoningTokens']
MAX=32*1024*1024

def safe(path,directory=False):
    current='/'
    for part in os.path.abspath(path).split('/')[1:]:
        current=os.path.join(current,part); info=os.lstat(current)
        if stat.S_ISLNK(info.st_mode): raise ValueError('unsafe')
    if directory and not stat.S_ISDIR(info.st_mode): raise ValueError('unsafe')
    if not directory and (not stat.S_ISREG(info.st_mode) or info.st_nlink!=1): raise ValueError('unsafe')
    return info

def read(path,limit=MAX):
    parts=os.path.abspath(path).split('/')[1:]
    parent=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent);os.close(parent);parent=child
        fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
    finally: os.close(parent)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>limit: raise ValueError('size')
        raw=os.read(fd,limit+1)
        if len(raw)>limit: raise ValueError('size')
        return raw
    finally: os.close(fd)

def load(name): return json.loads(read(ROOT+'/'+name,65536))
def save(name,value):
    path=ROOT+'/'+name
    if os.path.lexists(path): safe(path)
    tmp=ROOT+'/.tmp-'+str(os.getpid())+'-'+str(time.time_ns())
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try: os.write(fd,json.dumps(value,separators=(',',':')).encode())
    finally: os.close(fd)
    os.replace(tmp,path)

def init():
    for path in (HOME+'/.armada',ROOT):
        if not os.path.lexists(path): os.mkdir(path,0o700)
        info=safe(path,True)
        if info.st_uid!=os.getuid() or info.st_mode & 0o077: raise ValueError('permissions')

@contextlib.contextmanager
def lock():
    init()
    fd=os.open(ROOT+'/lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=os.getuid(): raise ValueError('lock')
        fcntl.flock(fd,fcntl.LOCK_EX);yield
    finally: os.close(fd)
def locked(fn):
    def run(*args):
        with lock(): return fn(*args)
    return run

def counter(v): return v if type(v)==int and 0<=v<=9007199254740991 else None

def locate(harness,session):
    if not UUID.fullmatch(session): raise ValueError('identity')
    root=HOME+('/.claude/projects' if harness=='claude' else '/.codex/sessions');safe(root,True)
    found=[]; visited=0; entries=0
    for directory,dirs,files in os.walk(root,followlinks=False):
        safe(directory,True);visited+=1;entries+=len(dirs)+len(files)
        if visited>512 or entries>4096: raise ValueError('bound')
        for name in files:
            if name.endswith('.jsonl') and (name==session+'.jsonl' or (harness=='codex' and name.endswith('-'+session+'.jsonl'))): found.append(os.path.join(directory,name))
    if len(found)!=1: raise ValueError('mapping')
    return found[0]

def snapshot(harness,session):
    raw=read(locate(harness,session))
    if raw and not raw.endswith(b'\n'): raise ValueError('truncated')
    models={}; identity=False; model=None; totals=None; observed=set()
    for line in raw.splitlines():
        if len(line)>2*1024*1024: raise ValueError('line bound')
        item=json.loads(line)
        if not isinstance(item,dict): continue
        payload=item.get('payload',{})
        if harness=='claude':
            if item.get('sessionId')==session: identity=True
            if item.get('type')=='cost-state' and isinstance(item.get('modelUsage'),dict): models=item['modelUsage']
        else:
            if item.get('type')=='session_meta' and isinstance(payload,dict) and payload.get('id')==session: identity=True
            if item.get('type')=='turn_context' and isinstance(payload,dict):
                candidate=payload.get('model')
                if isinstance(candidate,str): observed.add(candidate)
            if item.get('type')=='event_msg' and isinstance(payload,dict) and payload.get('type')=='token_count':
                info=payload.get('info')
                if isinstance(info,dict) and isinstance(info.get('total_token_usage'),dict): totals=info['total_token_usage']
    if not identity: raise ValueError('identity')
    if harness=='codex':
        if totals is None: raise ValueError('missing')
        model=next(iter(observed)) if len(observed)==1 else ''
        models={model:dict(zip(FIELDS,[totals.get(k) for k in ['input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens','reasoning_output_tokens']]))}
    result={}
    for model,usage in models.items():
        if model != '' and (not isinstance(model,str) or not re.fullmatch(r'[a-zA-Z0-9._:/-]{1,160}',model)): raise ValueError('model')
        if not isinstance(usage,dict): raise ValueError('usage')
        keys=FIELDS if harness=='codex' else ['inputTokens','outputTokens','cacheReadInputTokens','cacheCreationInputTokens','thinkingTokens']
        result[model]=dict(zip(FIELDS,[counter(usage.get(key)) for key in keys]))
    if not result or len(result)>32: raise ValueError('missing')
    return result

def freeze(ticket):
    entry=load(ticket+'.json')
    if 'final' not in entry and entry.get('session'):
        try: entry['final']=snapshot(entry['harness'],entry['session'])
        except Exception: entry['invalid']=True
        save(ticket+'.json',entry)

@locked
def capture(harness,session,fresh):
    init()
    if os.path.exists(ROOT+'/disabled.json'): return None
    try: pending=load('pending.json')
    except FileNotFoundError: return None
    ticket=pending['ticket']
    if time.time()-pending['at']>90 or load(ticket+'.json').get('session'): return None
    previous='session-'+session+'.json'
    overlap=False
    try:
        prior_ticket=load(previous)['ticket'];prior=load(prior_ticket+'.json')
        if not prior.get('terminal'):
            prior['invalid']=True;save(prior_ticket+'.json',prior);overlap=True
        else: freeze(prior_ticket)
    except FileNotFoundError: pass
    baseline={} if fresh and not overlap else None
    if not fresh and not overlap:
        try: baseline=snapshot(harness,session)
        except Exception: pass
    entry=load(ticket+'.json');entry.update(harness=harness,session=session,baseline=baseline)
    save(ticket+'.json',entry);save(previous,{'ticket':ticket});os.unlink(ROOT+'/pending.json')
    return ticket

def collect(prompt):
    ticket=load('prompt-'+prompt+'.json')['ticket'];entry=load(ticket+'.json')
    if entry.get('invalid') or not entry.get('session') or entry.get('baseline') is None or not entry.get('terminal'): return []
    current=entry.get('final')
    if current is None:
        try: current=snapshot(entry['harness'],entry['session'])
        except Exception: return []
    baseline=entry['baseline'];rows=[]
    for model,counts in current.items():
        before=(next(iter(baseline.values())) if entry['harness']=='codex' and baseline else baseline.get(model,{k:0 for k in FIELDS}));row={'model':model or None}
        for key in FIELDS:
            a=counts.get(key);b=before.get(key);row[key]=a-b if a is not None and b is not None and a>=b else None
        if any(row[k] is not None for k in FIELDS): rows.append(row)
    return rows

@locked
def terminal(ticket):
    entry=load(ticket+'.json');entry['terminal']=True;save(ticket+'.json',entry)
    # A read retries delayed flush until the next admitted turn freezes this snapshot.

def main():
    operation=sys.argv[1];args=sys.argv[2:]
    if operation!='claude': init()
    if operation=='admit':
        ticket,generation=args
        if not ID.fullmatch(generation): raise ValueError('generation')
        try: old=load('generation.json')['id']
        except FileNotFoundError: old=None
        if old!=generation:
            names=os.listdir(ROOT)
            if len(names)>2048: raise ValueError('bound')
            for name in names:
                if name=='lock': continue
                safe(ROOT+'/'+name);os.unlink(ROOT+'/'+name)
            save('generation.json',{'id':generation})
        if not ID.fullmatch(ticket): raise ValueError('id')
        if os.path.exists(ROOT+'/disabled.json'): return
        if os.path.lexists(ROOT+'/pending.json'):
            pending=load('pending.json');entry=load(pending['ticket']+'.json');entry['invalid']=True;save(pending['ticket']+'.json',entry)
            save('disabled.json',{'reason':'ambiguous_admission'});return
        fd=os.open(ROOT+'/pending.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try: os.write(fd,json.dumps({'ticket':ticket,'at':time.time()}).encode())
        finally: os.close(fd)
        save(ticket+'.json',{});print('admitted')
    elif operation=='bind':
        ticket,prompt=args
        if not ID.fullmatch(ticket) or not ID.fullmatch(prompt): raise ValueError('id')
        load(ticket+'.json');save('prompt-'+prompt+'.json',{'ticket':ticket})
    elif operation=='collect':
        prompt=args[0]
        if not ID.fullmatch(prompt): raise ValueError('id')
        print(json.dumps(collect(prompt)))
    elif operation=='claude':
        import subprocess,uuid
        native=args[0];argv=args[1:];session=None;fresh=True;identities=0
        for i,arg in enumerate(argv):
            if arg in ('--resume','-r','--session-id'):
                identities+=1
                if i+1<len(argv) and UUID.fullmatch(argv[i+1]): session=argv[i+1];fresh=arg=='--session-id'
                else: fresh=False
            elif arg.startswith('--resume=') or arg.startswith('--session-id='): identities+=1;session=arg.split('=',1)[1];fresh=arg.startswith('--session-id=')
            elif arg in ('--continue','-c'): fresh=False
        injected=session is None and fresh
        if injected: session=str(uuid.uuid4())
        ticket=None
        if identities<=1 and session and UUID.fullmatch(session):
            try: ticket=capture('claude',session,fresh)
            except Exception: pass
        if ticket and injected: argv=['--session-id',session]+argv
        import signal,threading
        streaming=any(arg=='--input-format=stream-json' or (arg=='--input-format' and i+1<len(argv) and argv[i+1]=='stream-json') for i,arg in enumerate(argv))
        child=subprocess.Popen([native]+argv,stdin=subprocess.PIPE if streaming else None,stdout=subprocess.PIPE if streaming else None)
        def forward(sig,frame):
            try: child.send_signal(sig)
            except ProcessLookupError: pass
        for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP): signal.signal(sig,forward)
        first=True
        def incoming():
            nonlocal ticket,first
            try:
                for line in os.fdopen(os.dup(0),"rb",buffering=0):
                    try:
                        frame=json.loads(line)
                        if isinstance(frame,dict) and frame.get('type')=='user':
                            if first: first=False
                            elif session: ticket=capture('claude',session,False)
                    except Exception: pass
                    child.stdin.write(line);child.stdin.flush()
            except (OSError,BrokenPipeError): pass
            finally:
                try: child.stdin.close()
                except OSError: pass
        def outgoing():
            for line in child.stdout:
                try:
                    frame=json.loads(line)
                    if ticket and isinstance(frame,dict) and frame.get('type')=='result':
                        if frame.get('session_id')==session: terminal(ticket)
                        else:
                            entry=load(ticket+'.json');entry['invalid']=True;save(ticket+'.json',entry)
                except Exception: pass
                sys.stdout.buffer.write(line);sys.stdout.buffer.flush()
        if streaming:
            threading.Thread(target=incoming,daemon=True).start()
            receiver=threading.Thread(target=outgoing,daemon=True);receiver.start()
        code=child.wait()
        if streaming: receiver.join()
        if ticket:
            try: terminal(ticket)
            except Exception: pass
        sys.exit(code if code>=0 else 128-code)

if __name__=='__main__':
    try:
        if len(sys.argv)>1 and sys.argv[1]=='claude': main()
        else:
            with lock(): main()
    except Exception:
        if len(sys.argv)>1 and sys.argv[1]=='collect': print('[]')
        else: sys.exit(1)
`;

/** Compression avoids Linux MAX_ARG_STRLEN through the nested shell installer. */
export const NATIVE_USAGE_BOOTSTRAP = `import base64,zlib;exec(zlib.decompress(base64.b64decode("${deflateSync(NATIVE_USAGE_PYTHON).toString("base64")}")))`;
