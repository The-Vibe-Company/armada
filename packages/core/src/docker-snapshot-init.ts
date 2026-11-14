/** Trusted root controller asset. Project code is a no-new-privileges UID1000 child;
 * Linux subreaping + pidfds quiesce even setsid/double-fork descendants before scan.
 */
export const SNAPSHOT_INIT_SUPERVISOR = `import ctypes,os,signal,subprocess,sys
libc=ctypes.CDLL(None,use_errno=True)
if os.geteuid()!=0 or libc.prctl(36,1,0,0,0)!=0:
    raise RuntimeError('snapshot supervision unavailable')
root=os.getpid()
def info(pid):
    try:
        with open('/proc/'+str(pid)+'/stat') as stream:
            fields=stream.read().rsplit(')',1)[1].split()
        return int(fields[1]),fields[19]
    except (OSError,ValueError,IndexError): return None
def descendants():
    records={}
    for name in os.listdir('/proc'):
        if name.isdigit():
            value=info(int(name))
            if value: records[int(name)]=value
    owned={root}
    while True:
        added={pid for pid,(parent,_) in records.items() if parent in owned and pid not in owned}
        if not added: break
        owned.update(added)
    return {pid:records[pid] for pid in owned if pid!=root and pid in records}
def quiesce():
    while True:
        try:
            pid,_=os.waitpid(-1,os.WNOHANG)
            if pid: continue
        except ChildProcessError: return
        for pid,(_,birth) in descendants().items():
            fd=None
            try:
                fd=os.pidfd_open(pid,0)
                current=info(pid)
                if current and current[1]==birth: signal.pidfd_send_signal(fd,signal.SIGKILL,None,0)
            except ProcessLookupError: pass
            finally:
                if fd is not None: os.close(fd)
        try: os.waitpid(-1,0)
        except ChildProcessError: return

def demote():
    os.setgroups([])
    os.setgid(1000)
    os.setuid(1000)
    if libc.prctl(38,1,0,0,0)!=0: raise RuntimeError('privilege restriction unavailable')
status=125
try:
    home=os.environ.get('HOME','/home/user')
    child=subprocess.Popen(['/bin/bash','--noprofile','--norc',sys.argv[1]],cwd=home,
      env={'HOME':home,'PATH':'/usr/local/bin:/usr/bin:/bin','GIT_TERMINAL_PROMPT':'0'},
      stdin=subprocess.DEVNULL,preexec_fn=demote)
    status=child.wait()
finally:
    quiesce()
sys.exit(status if 0<=status<=125 else 1)
`;
