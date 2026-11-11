import { createHash, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import {
  type Provider,
  ProviderError,
  type TurnTokenUsage,
  USAGE_UNAVAILABLE_CODES,
  type UsageUnavailableCode,
  usageUnavailableReason,
} from "@armada/core";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const command = (operation: string, ...args: string[]) =>
  `python3 -I -c ${quote(NATIVE_USAGE_BOOTSTRAP)} ${[operation, ...args].map(quote).join(" ")}`;
export async function admitNativeUsage(provider: Provider, sandboxId: string, text: string): Promise<string | null> {
  const ticket = randomUUID();
  try {
    const r = await provider.exec({
      sandboxId,
      command: command("admit", ticket, sandboxId, createHash("sha256").update(text).digest("hex")),
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
  harness: "claude" | "codex" = "codex",
): Promise<TurnTokenUsage[]> {
  const unavailable = (code: UsageUnavailableCode): TurnTokenUsage[] => [
    {
      promptId,
      model: null,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      unavailableReason: usageUnavailableReason(code),
    },
  ];
  if (harness !== "codex") return unavailable("unsupported_harness");
  try {
    const r = await provider.exec({
      sandboxId,
      command: command("collect", promptId),
      timeoutSeconds: 10,
      onlyIfRunning: true,
    });
    if (r.detached || r.timedOut || r.exitCode !== 0 || r.truncated || r.stdout.length > 32768)
      return unavailable("reader_unavailable");
    const result: unknown = JSON.parse(r.stdout);
    if (!result || typeof result !== "object" || Array.isArray(result)) return unavailable("reader_unavailable");
    const { turns, reason } = result as { turns?: unknown; reason?: unknown };
    if (!Array.isArray(turns) || turns.length > 32) return unavailable("reader_unavailable");
    if (turns.length === 0)
      return unavailable(
        typeof reason === "string" && (USAGE_UNAVAILABLE_CODES as readonly string[]).includes(reason)
          ? (reason as UsageUnavailableCode)
          : "reader_unavailable",
      );
    const rows = turns.flatMap((row): TurnTokenUsage[] => {
      if (!row || typeof row !== "object") return [];
      const v = row as Record<string, unknown>;
      if (v.model !== null && (typeof v.model !== "string" || !/^[a-zA-Z0-9._:/-]{1,160}$/.test(v.model))) return [];
      const keys = ["inputTokens", "outputTokens", "cachedTokens", "cacheWriteTokens", "reasoningTokens"] as const;
      if (
        keys.every((k) => v[k] === null) ||
        keys.some((k) => v[k] !== null && !(typeof v[k] === "number" && Number.isSafeInteger(v[k]) && v[k] >= 0))
      )
        return [];
      return [
        {
          promptId,
          model: v.model as string | null,
          ...Object.fromEntries(keys.map((k) => [k, v[k]])),
        } as TurnTokenUsage,
      ];
    });
    return rows.length === turns.length ? rows : unavailable("reader_unavailable");
  } catch (error) {
    return unavailable(
      error instanceof ProviderError && error.code === "sandbox_not_ready" ? "compute_inactive" : "reader_unavailable",
    );
  }
}
/** Inert guest-local helper. Never exports transcript data or native filenames. */
export const NATIVE_USAGE_PYTHON = String.raw`
import os,sys,json,stat,re,time,fcntl,contextlib,hashlib
HOME=os.path.expanduser('~'); ROOT=HOME+'/.armada/native-usage'
ID=re.compile(r'^[a-zA-Z0-9_-]{1,128}$'); UUID=re.compile(r'^[a-fA-F0-9-]{36}$')
DIGEST=re.compile(r'^[a-f0-9]{64}$')
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

def snapshot(harness,session,turn,fresh):
    # File append order, not read time, establishes attribution. Never freeze a
    # plausible cumulative total at admission: it may be a delayed prior flush.
    if harness!='codex' or not ID.fullmatch(turn): raise ValueError('boundary')
    raw=read(locate(harness,session))
    if raw and not raw.endswith(b'\n'): raise ValueError('truncated')
    identity=False;active=None;last=None;closed=False;seen=False
    baseline=None;counts=None;models=set();finished=False;starts=0
    keys=['input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens','reasoning_output_tokens']
    for line in raw.splitlines():
        if len(line)>2*1024*1024: raise ValueError('line bound')
        item=json.loads(line)
        if not isinstance(item,dict): continue
        payload=item.get('payload',{})
        if not isinstance(payload,dict): continue
        if item.get('type')=='session_meta':
            if payload.get('id')!=session: raise ValueError('identity')
            identity=True
        if item.get('type')=='turn_context' and active==turn:
            candidate=payload.get('model')
            if isinstance(candidate,str): models.add(candidate)
        if item.get('type')!='event_msg': continue
        kind=payload.get('type')
        if kind=='task_started':
            if active is not None: raise ValueError('overlap')
            active=payload.get('turn_id');starts+=1
            if not isinstance(active,str): raise ValueError('boundary')
            if active==turn:
                if seen: raise ValueError('duplicate boundary')
                seen=True
                baseline=last if closed else ({k:0 for k in FIELDS} if fresh and starts==1 else None)
            closed=False;last=None
        elif kind=='token_count':
            info=payload.get('info')
            if active is not None and isinstance(info,dict) and isinstance(info.get('total_token_usage'),dict):
                total=info['total_token_usage']
                last=dict(zip(FIELDS,[counter(total.get(k)) for k in keys]))
                if active==turn: counts=last
        elif kind=='task_complete':
            if active is None or payload.get('turn_id')!=active: raise ValueError('boundary')
            if active==turn: finished=True
            active=None;closed=True
        elif kind=='turn_aborted':
            if active is None or payload.get('turn_id')!=active: raise ValueError('boundary')
            # An abort closes the sequence, not a complete usage snapshot. The
            # next turn has an unknown baseline; later closed turns can recover.
            active=None;closed=False;last=None
    if not identity or not seen or not finished or baseline is None or counts is None: raise ValueError('missing boundary')
    model=next(iter(models)) if len(models)==1 else ''
    if model and not re.fullmatch(r'[a-zA-Z0-9._:/-]{1,160}',model): raise ValueError('model')
    row={'model':model or None}
    for key in FIELDS:
        a=counts.get(key);b=baseline.get(key)
        row[key]=a-b if a is not None and b is not None and a>=b else None
    return [row] if any(row[k] is not None for k in FIELDS) else []

def prompt_digest(items):
    # Boat's native text input must match exactly. Unsupported/transformed
    # requests stay unknown; no raw prompt is stored or passed through exec.
    if not isinstance(items,list) or len(items)!=1: return None
    item=items[0]
    if not isinstance(item,dict) or item.get('type')!='text' or not isinstance(item.get('text'),str): return None
    return hashlib.sha256(item['text'].encode('utf-8')).hexdigest()

def retire_pending(pending,reason='admission_superseded'):
    ticket=pending['ticket'];digest=pending.get('digest')
    if not ID.fullmatch(ticket) or not isinstance(digest,str) or not DIGEST.fullmatch(digest): raise ValueError('legacy admission')
    entry=load(ticket+'.json');entry['invalid']=True;entry['collectionReason']=reason;save(ticket+'.json',entry)
    # A delayed callback can still arrive. Quarantine only its exact input,
    # never the whole sandbox, and never guess which identical request it is.
    save('blocked-'+digest+'.json',{})
    os.unlink(ROOT+'/pending.json')

@locked
def capture(harness,session,fresh,digest):
    init()
    # Old pre-fingerprint draft state cannot be disambiguated safely; a fresh
    # physical generation clears it. New admissions never write this global flag.
    if os.path.exists(ROOT+'/disabled.json'): return None
    try: pending=load('pending.json')
    except FileNotFoundError: return None
    ticket=pending['ticket']
    if time.time()-pending['at']>90:
        retire_pending(pending,'admission_expired');return None
    if not isinstance(digest,str) or pending.get('digest')!=digest:
        entry=load(ticket+'.json');entry['collectionReason']='native_input_unmatched';save(ticket+'.json',entry)
        return None
    if os.path.exists(ROOT+'/blocked-'+digest+'.json') or load(ticket+'.json').get('session'): return None
    previous='session-'+session+'.json'
    try:
        prior_ticket=load(previous)['ticket'];prior=load(prior_ticket+'.json')
        if not prior.get('terminal'):
            prior['invalid']=True;prior['collectionReason']='native_boundary_unverified';save(prior_ticket+'.json',prior)
            entry=load(ticket+'.json');entry['invalid']=True;entry['collectionReason']='native_boundary_unverified';save(ticket+'.json',entry)
    except FileNotFoundError: pass
    entry=load(ticket+'.json');entry.update(harness=harness,session=session,fresh=fresh)
    save(ticket+'.json',entry);save(previous,{'ticket':ticket});os.unlink(ROOT+'/pending.json')
    return ticket

@locked
def start(ticket,turn):
    if not ID.fullmatch(turn): raise ValueError('turn')
    entry=load(ticket+'.json')
    if entry.get('turn') not in (None,turn): entry['invalid']=True;entry['collectionReason']='native_boundary_unverified'
    entry['turn']=turn;save(ticket+'.json',entry)

def collection_result(prompt):
    def missing(reason): return {'turns':[],'reason':reason}
    if os.path.exists(ROOT+'/disabled.json'): return missing('legacy_disabled')
    try:
        ticket=load('prompt-'+prompt+'.json')['ticket']
        if not ID.fullmatch(ticket): return missing('unsafe_reader_state')
        entry=load(ticket+'.json')
    except FileNotFoundError: return missing('admission_missing')
    except (OSError,ValueError,KeyError,TypeError): return missing('unsafe_reader_state')
    if entry.get('invalid'): return missing(entry.get('collectionReason','native_boundary_unverified'))
    if not entry.get('session'): return missing(entry.get('collectionReason','native_start_unobserved'))
    if not entry.get('turn'): return missing('native_turn_unobserved')
    if not entry.get('terminal'): return missing('native_terminal_unobserved')
    if 'final' not in entry:
        try: entry['final']=snapshot(entry['harness'],entry['session'],entry['turn'],entry['fresh'])
        except FileNotFoundError: return missing('native_history_unavailable')
        except PermissionError: return missing('unsafe_reader_state')
        except OSError: return missing('unsafe_reader_state')
        except ValueError as error:
            return missing('unsafe_reader_state' if str(error)=='unsafe' else
              'native_history_unavailable' if str(error) in ('mapping','bound','size') else 'native_boundary_unverified')
        save(ticket+'.json',entry)
    return {'turns':entry['final'],'reason':None if entry['final'] else 'native_boundary_unverified'}

def collect(prompt): return collection_result(prompt)['turns']

@locked
def terminal(ticket,turn=None):
    entry=load(ticket+'.json')
    if turn is None or entry.get('turn')!=turn: entry['invalid']=True;entry['collectionReason']='native_boundary_unverified'
    entry['terminal']=True;save(ticket+'.json',entry)

def main():
    operation=sys.argv[1];args=sys.argv[2:]
    init()
    if operation=='admit':
        ticket,generation,digest=args
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
        if not ID.fullmatch(ticket) or not DIGEST.fullmatch(digest): raise ValueError('id')
        if os.path.exists(ROOT+'/disabled.json'): return
        if os.path.lexists(ROOT+'/pending.json'):
            retire_pending(load('pending.json'))
        if os.path.exists(ROOT+'/blocked-'+digest+'.json'): return
        save(ticket+'.json',{})
        save('pending.json',{'ticket':ticket,'at':time.time(),'digest':digest})
        print('admitted')
    elif operation=='bind':
        ticket,prompt=args
        if not ID.fullmatch(ticket) or not ID.fullmatch(prompt): raise ValueError('id')
        load(ticket+'.json');save('prompt-'+prompt+'.json',{'ticket':ticket})
    elif operation=='collect':
        prompt=args[0]
        if not ID.fullmatch(prompt): raise ValueError('id')
        print(json.dumps(collection_result(prompt)))
if __name__=='__main__':
    try:
        with lock(): main()
    except Exception:
        if len(sys.argv)>1 and sys.argv[1]=='collect': print(json.dumps({'turns':[],'reason':'unsafe_reader_state'}))
        else: sys.exit(1)
`;

/** Compression avoids Linux MAX_ARG_STRLEN through the nested shell installer. */
export const NATIVE_USAGE_BOOTSTRAP = `import base64,zlib;exec(zlib.decompress(base64.b64decode("${deflateSync(NATIVE_USAGE_PYTHON).toString("base64")}")))`;
