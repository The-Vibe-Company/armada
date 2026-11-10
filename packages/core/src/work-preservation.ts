import type { Provider } from "./provider.ts";

export type WorkPreservation =
  | { status: "clean" }
  | { status: "preserved"; archive: string }
  | { status: "failed"; reason: "timeout" | "unavailable" | "size_limit" | "capture_failed" };

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;

// Fixed command: neither credentials nor repository contents are interpolated into argv.
// The response is private recovery material, NOT an exec receipt suitable for logs or clients.
const CAPTURE = String.raw`python3 - <<'ARMADA_RECOVERY'
import base64, io, json, os, resource, subprocess, tarfile, tempfile
LIMIT = 2 * 1024 * 1024
resource.setrlimit(resource.RLIMIT_FSIZE, (LIMIT, LIMIT))
class TooLarge(Exception): pass
def git(root, *args, output=None):
    # File-backed stdout plus RLIMIT_FSIZE bounds status/path-list output too.
    with tempfile.TemporaryFile() as captured:
        sink = output if output is not None else captured
        p = subprocess.run(['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, *args], stdout=sink, stderr=subprocess.DEVNULL, timeout=8)
        if sink.tell() >= LIMIT: raise TooLarge()
        if p.returncode != 0: raise RuntimeError()
        if output is not None: return None
        captured.seek(0)
        return captured.read(LIMIT)

try:
    with tempfile.TemporaryDirectory(prefix='armada-recovery-') as tmp:
        repos = []
        home = os.path.expanduser('~')
        for root, dirs, files in os.walk(home, followlinks=False):
            dirs[:] = [d for d in dirs if d not in ('.cache', 'node_modules', '.git') and not os.path.join(root,d).startswith(tmp)]
            if '.git' not in files and not os.path.isdir(os.path.join(root, '.git')): continue
            dirty = git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
            head = subprocess.run(['git','-C',root,'rev-parse','--verify','HEAD'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=8)
            commits = head.returncode == 0 and git(root, 'rev-list', '--max-count=1', 'HEAD', '--not', '--remotes').strip()
            if dirty or commits: repos.append((root, head.stdout.decode().strip() if head.returncode == 0 else None))
        if not repos:
            print(json.dumps({'status':'clean'}))
        else:
            archive = os.path.join(tmp, 'recovery.tar')
            with tarfile.open(archive, 'w') as tar:
                manifest = []
                for i, (root, head) in enumerate(repos):
                    prefix = 'repo-' + str(i)
                    manifest.append({'path':root, 'directory':prefix, 'head':head})
                    if head:
                        bundle = os.path.join(tmp, 'bundle')
                        git(root, 'bundle', 'create', bundle, '--all', 'HEAD')
                        tar.add(bundle, arcname=prefix+'/commits.bundle')
                        os.unlink(bundle)
                    for name, args in [('index.patch', ('diff','--no-ext-diff','--no-textconv','--cached','--binary')), ('worktree.patch', ('diff','--no-ext-diff','--no-textconv','--binary'))]:
                        patch = os.path.join(tmp, 'patch')
                        with open(patch,'wb') as out: git(root, *args, output=out)
                        tar.add(patch, arcname=prefix+'/'+name)
                    for raw in git(root,'ls-files','--others','--exclude-standard','-z').split(b'\0'):
                        if not raw: continue
                        path = os.fsdecode(raw)
                        if os.path.isabs(path) or '..' in path.split('/'): raise RuntimeError()
                        source = os.path.join(root,path)
                        if os.path.isfile(source) and not os.path.islink(source) and os.path.getsize(source)>LIMIT: raise TooLarge()
                        tar.add(source, arcname=prefix+'/untracked/'+path, recursive=False)
                        if tar.fileobj.tell()>LIMIT: raise TooLarge()
                data = json.dumps({'version':1,'repositories':manifest}).encode()
                info = tarfile.TarInfo('manifest.json'); info.size=len(data)
                tar.addfile(info, io.BytesIO(data))
            if os.path.getsize(archive)>LIMIT: raise TooLarge()
            with open(archive,'rb') as source: encoded=base64.b64encode(source.read()).decode()
            print(json.dumps({'status':'preserved','archive':encoded}))
except (TooLarge, OSError) as error:
    print(json.dumps({'status':'failed','reason':'size_limit' if isinstance(error,TooLarge) or getattr(error,'errno',None)==27 else 'capture_failed'}))
except subprocess.TimeoutExpired:
    print(json.dumps({'status':'failed','reason':'timeout'}))
except Exception:
    print(json.dumps({'status':'failed','reason':'capture_failed'}))
ARMADA_RECOVERY`;

/** Local-only capture: valid and expired GitHub authorization take the same path.
 * The caller must encrypt the returned archive before persistence, and never log it.
 * Timeout races only collection, so a late provider response cannot publish a receipt.
 */
export async function preserveWork(provider: Pick<Provider, "exec">, sandboxId: string): Promise<WorkPreservation> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      provider.exec({ sandboxId, command: CAPTURE, timeoutSeconds: 12 }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 15_000);
      }),
    ]);
    if (result === null || (!result.detached && result.timedOut)) return { status: "failed", reason: "timeout" };
    if (result.detached || result.exitCode !== 0 || result.truncated)
      return { status: "failed", reason: "unavailable" };
    if (result.stdout.length > MAX_ARCHIVE_BYTES * 1.4 + 1000) return { status: "failed", reason: "size_limit" };
    const value: unknown = JSON.parse(result.stdout);
    if (typeof value !== "object" || value === null || !("status" in value)) throw new Error();
    if (value.status === "clean") return { status: "clean" };
    if (value.status === "preserved" && "archive" in value && typeof value.archive === "string") {
      const archive = value.archive;
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(archive) || Buffer.from(archive, "base64").length > MAX_ARCHIVE_BYTES)
        throw new Error();
      return { status: "preserved", archive };
    }
    if (
      value.status === "failed" &&
      "reason" in value &&
      ["timeout", "size_limit", "capture_failed"].includes(String(value.reason))
    )
      return { status: "failed", reason: value.reason as "timeout" | "size_limit" | "capture_failed" };
    throw new Error();
  } catch {
    return { status: "failed", reason: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}
