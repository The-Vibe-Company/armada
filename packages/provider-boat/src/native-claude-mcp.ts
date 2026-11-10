/** Claude's long-lived stream-json session needs acknowledged dynamic MCP
 * controls; changing ~/.claude.json alone does not update a live Query.
 * The bridge consumes only its own control responses and never recreates the
 * conversation. Non-stream invocations read their config at process startup. */
export const claudeMcpBridge = String.raw`
import json, os, signal, stat, subprocess, sys, threading, uuid

args=sys.argv[2:]
stream=any(v=="--input-format=stream-json" or v=="--input-format" and i+1<len(args) and args[i+1]=="stream-json" for i,v in enumerate(args))
if not stream: os.execv(sys.argv[1],[sys.argv[1]]+args)
child=subprocess.Popen([sys.argv[1]]+args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=None,start_new_session=True)
pending={}
known=set()
last=None
active=False

def fresh():
    home=os.path.expanduser("~")
    directory=os.path.join(home,".armada")
    manifest=os.path.join(directory,"mcp-owned.json")
    if not os.path.lexists(manifest):
        # Empty native installs remove the manifest. Only a process that has
        # already observed managed config may retire its known dynamic servers;
        # preserve independent authority from the last validated snapshot.
        return None if last is None else {n:v for n,v in last.items() if n=="armada_orchestrator"}
    config=os.path.join(home,".claude.json")
    for path in (directory,manifest,config):
        s=os.lstat(path)
        if stat.S_ISLNK(s.st_mode) or s.st_uid!=os.getuid() or path!=directory and (not stat.S_ISREG(s.st_mode) or s.st_mode & 0o077):
            raise ValueError("unsafe_mcp")
    with open(manifest) as f: names=json.load(f)
    if not isinstance(names,list) or any(not isinstance(n,str) or not n.startswith("armada_") for n in names): raise ValueError("invalid_mcp")
    with open(config) as f: servers=json.load(f).get("mcpServers",{})
    selected={n:servers[n] for n in names if n in servers}
    if len(selected)!=len(names): raise ValueError("missing_mcp")
    # Private authority has independent ownership; never remove or toggle it.
    if "armada_orchestrator" in servers: selected["armada_orchestrator"]=servers["armada_orchestrator"]
    return selected

def receive():
    global active
    for line in child.stdout:
        try: m=json.loads(line)
        except Exception: m=None
        if isinstance(m,dict) and m.get("type")=="control_response":
            response=m.get("response",{})
            waiter=pending.get(response.get("request_id"))
            if waiter is not None:
                waiter[1].append(response)
                waiter[0].set()
                continue
        if isinstance(m,dict) and m.get("type")=="result": active=False
        sys.stdout.buffer.write(line);sys.stdout.buffer.flush()

thread=threading.Thread(target=receive,daemon=True);thread.start()
def stop_native(sig):
    try: os.killpg(child.pid,sig)
    except ProcessLookupError: pass
    try: child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try: os.killpg(child.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        child.wait()
def forward_signal(sig, frame):
    stop_native(sig)
    sys.exit(128+sig)
for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP): signal.signal(sig,forward_signal)
def control(request):
    request_id="armada-mcp-"+uuid.uuid4().hex
    event,result=threading.Event(),[]
    pending[request_id]=(event,result)
    child.stdin.write((json.dumps({"type":"control_request","request_id":request_id,"request":request})+"\n").encode())
    child.stdin.flush()
    if not event.wait(30) or len(result)!=1 or result[0].get("subtype")!="success": raise ValueError("refresh_refused")
    response=result[0].get("response",{})
    if isinstance(response,dict) and response.get("errors"): raise ValueError("refresh_refused")
    del pending[request_id]

try:
    for line in sys.stdin.buffer:
        try: message=json.loads(line)
        except Exception: message=None
        if isinstance(message,dict) and message.get("type")=="user":
            current=fresh()
            if current is not None:
                if active: raise ValueError("turn_running")
                if current!=last:
                    for name in known-set(current):
                        control({"subtype":"mcp_toggle","serverName":name,"enabled":False})
                    control({"subtype":"mcp_set_servers","servers":current})
                    # Re-add before enabling: removed dynamic targets no longer
                    # exist, and Claude refuses toggles naming an unknown server.
                    for name in set(current)-{"armada_orchestrator"}:
                        control({"subtype":"mcp_toggle","serverName":name,"enabled":True})
                    known = set(current)-{"armada_orchestrator"}
                    last=current
            active=True
        child.stdin.write(line);child.stdin.flush()
    child.stdin.close()
    child.wait()
    stop_native(signal.SIGKILL)
    thread.join()
    sys.exit(child.returncode)
except Exception:
    print("Native MCP configuration refresh failed; no turn was submitted.",file=sys.stderr)
    stop_native(signal.SIGTERM)
    sys.exit(1)
`;
