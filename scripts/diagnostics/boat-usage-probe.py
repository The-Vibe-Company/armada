"""Read-only Boat triage: booleans/counts only; no env, argv, prompts or paths exported."""
import base64, glob, json, os, re, stat, time, zlib
LIMIT=256*1024

def read(path,limit=LIMIT):
    # Pin every directory component; a changing guest path cannot redirect this
    # diagnostic into an unrelated file through a symlink.
    parts=os.path.abspath(path).split('/')[1:]
    parent=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
            os.close(parent);parent=child
        fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
    finally: os.close(parent)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>limit: raise ValueError()
        data=os.read(fd,limit+1)
        if len(data)>limit: raise ValueError()
        return data
    finally: os.close(fd)

def source(arg):
    prefix=b'import base64,zlib;exec(zlib.decompress(base64.b64decode("';suffix=b'")))'
    if not arg.startswith(prefix): return arg
    if len(arg)>128*1024 or not arg.endswith(suffix): return b''
    try:
        decoder=zlib.decompressobj()
        code=decoder.decompress(base64.b64decode(arg[len(prefix):-len(suffix)],validate=True),LIMIT+1)
        return code if len(code)<=LIMIT and decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail else b''
    except Exception: return b''

def ancestry(pid):
    usage=digest=False
    complete=False
    for _ in range(16):
        try:
            exe=os.path.basename(os.readlink('/proc/%d/exe'%pid))
            if exe.startswith('python'):
                for arg in read('/proc/%d/cmdline'%pid).split(b'\0')[1:]:
                    code=source(arg)
                    usage|=b'usage["capture"]' in code
                    digest|=b'usage["prompt_digest"]' in code
            pid=int(read('/proc/%d/stat'%pid).rsplit(b')',1)[1].split()[1])
            if pid<=1:
                complete=True;break
        except Exception: break
    return {'usageBridge':usage,'digestCapture':digest,'inspectionComplete':complete}

out={'probeUid':os.getuid(),'native':[],'stateReadable':False}
processes=glob.glob('/proc/[0-9]*')
out['procScanTruncated']=len(processes)>8192
for directory in processes[:8192]:
    try:
        pid=int(directory.rsplit('/',1)[1])
        if os.path.basename(os.readlink(directory+'/exe'))!='codex': continue
        args=read(directory+'/cmdline').split(b'\0')
        if b'app-server' not in args: continue
        out['native'].append({'sameUid':os.stat(directory).st_uid==os.getuid(),
          'globalOptionsBeforeAppServer':args.index(b'app-server')>1,**ancestry(pid)})
    except Exception: continue
parent=os.path.expanduser('~/.armada');root=parent+'/native-usage'
for name,path in [('armadaMode',parent),('usageMode',root)]:
    try:
        info=os.lstat(path)
        out[name]=oct(stat.S_IMODE(info.st_mode))
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid(): raise ValueError()
    except Exception: out[name]='missing_or_unsafe'
try:
    if 'missing_or_unsafe' in (out['armadaMode'],out['usageMode']): raise ValueError()
    names=os.listdir(root)
    if len(names)>2048: raise ValueError()
    out['stateReadable']=True
    out['disabled']='disabled.json' in names
    out['mappings']=sum(n.startswith('prompt-') and n.endswith('.json') for n in names)
    out['quarantines']=sum(n.startswith('blocked-') and n.endswith('.json') for n in names)
    out['tickets']=[]
    tickets=[n for n in names if re.fullmatch(r'[a-f0-9-]{36}\.json',n)]
    out['ticketCount']=len(tickets)
    out['ticketSummariesTruncated']=len(tickets)>16
    for name in tickets[:16]:
        if True:
            entry=json.loads(read(root+'/'+name,65536))
            out['tickets'].append({**{k:bool(entry.get(k)) for k in ('session','turn','terminal','invalid','fresh')},
              'finalCached':'final' in entry,'finalRows':len(entry['final']) if isinstance(entry.get('final'),list) else 0})
    out['pending']='pending.json' in names
    if out['pending']:
        pending=json.loads(read(root+'/pending.json',65536))
        out['pendingExpired']=isinstance(pending.get('at'),(int,float)) and time.time()-pending['at']>90
except Exception: out['stateReadFailed']=True
try:
    wrapper=read('/usr/local/bin/codex.armada-wrapper')
    match=re.search(rb'base64.b64decode\("([A-Za-z0-9+/=]+)"\)',wrapper)
    if match:
        decoder=zlib.decompressobj()
        code=decoder.decompress(base64.b64decode(match[1],validate=True),LIMIT+1)
        valid=len(code)<=LIMIT and decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail
        out['installedUsageBridge']=valid and b'usage["capture"]' in code
        out['installedDigestCapture']=valid and b'usage["prompt_digest"]' in code
    else: out['installedWrapperFormatUnknown']=True
except Exception: out['installedWrapperReadFailed']=True
print(json.dumps(out,sort_keys=True))
