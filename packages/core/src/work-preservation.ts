import { constants, createDecipheriv, createHash, generateKeyPairSync, pbkdf2Sync, privateDecrypt } from "node:crypto";
import type { Provider } from "./provider.ts";

const FAILURE_REASONS = [
  "timeout",
  "unavailable",
  "size_limit",
  "missing_git",
  "missing_python3",
  "missing_openssl",
  "collector_exit",
  "collector_signal",
  "collector_failed",
  "output_invalid",
  "output_truncated",
  "decrypt",
] as const;
type CaptureFailure = (typeof FAILURE_REASONS)[number];

export type WorkPreservation =
  | { status: "clean" }
  | { status: "preserved"; archive: string }
  | { status: "failed"; reason: CaptureFailure };

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;

// Fixed command: neither credentials nor repository contents are interpolated into argv.
// The response is private recovery material, NOT an exec receipt suitable for logs or clients.
const CAPTURE = String.raw`for tool in python3 git openssl; do
    command -v "$tool" >/dev/null 2>&1 || { printf '{"status":"failed","reason":"missing_%s"}\n' "$tool"; exit 0; }
done
python3 - <<'ARMADA_RECOVERY'
import base64, hashlib, io, json, os, resource, subprocess, sys, tarfile, tempfile
LIMIT = 2 * 1024 * 1024
resource.setrlimit(resource.RLIMIT_FSIZE, (LIMIT+64, LIMIT+64))
class TooLarge(Exception): pass
class CollectorExit(Exception): pass
def git(root, *args, output=None):
    # File-backed stdout plus RLIMIT_FSIZE bounds status/path-list output too.
    with tempfile.TemporaryFile() as captured:
        sink = output if output is not None else captured
        p = subprocess.run(['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, *args], stdout=sink, stderr=subprocess.DEVNULL, timeout=8)
        if sink.tell() >= LIMIT: raise TooLarge()
        if p.returncode != 0:
            if p.returncode == -25 or (args[0:2] == ('bundle', 'create') and os.path.exists(args[2]) and os.path.getsize(args[2]) >= LIMIT): raise TooLarge()
            raise CollectorExit('collector_signal' if p.returncode < 0 else 'collector_exit')
        if output is not None: return None
        captured.seek(0)
        return captured.read(LIMIT)

def fingerprint(root):
    if git(root, 'ls-files', '--unmerged', '-z'): raise RuntimeError()
    state = hashlib.sha256()
    current = subprocess.run(['git','-C',root,'rev-parse','--verify','HEAD'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=8)
    head = current.stdout.decode().strip() if current.returncode == 0 else None
    state.update((head or '').encode())
    for args in [('diff','--no-ext-diff','--no-textconv','--cached','--binary'), ('diff','--no-ext-diff','--no-textconv','--binary')]:
        state.update(git(root,*args))
    paths = git(root,'ls-files','--others','--exclude-standard','-z')
    state.update(paths)
    for raw in paths.split(b'\0'):
        if not raw: continue
        path = os.path.join(root,os.fsdecode(raw))
        state.update(str(os.lstat(path).st_mode).encode()+b'\0')
        content = hashlib.sha256()
        if os.path.islink(path): content.update(os.fsencode(os.readlink(path)))
        else:
            if not os.path.isfile(path): raise RuntimeError()
            if os.path.getsize(path)>LIMIT: raise TooLarge()
            with open(path,'rb') as source:
                total=0
                while True:
                    block=source.read(65536)
                    if not block: break
                    total+=len(block)
                    if total>LIMIT: raise TooLarge()
                    content.update(block)
        state.update(content.digest())
    return (head,state.digest())
try:
    tmp = '/tmp/armada-recovery-ARMADA_TOKEN'
    os.mkdir(tmp, 0o700)
    # Independent, detached janitor bounds plaintext retention after lost responses.
    subprocess.Popen([sys.executable, '-c', 'import shutil,sys,time; time.sleep(120); shutil.rmtree(sys.argv[1],ignore_errors=True)', tmp], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    if True:
        repos = []
        home = os.path.expanduser('~')
        for root, dirs, files in os.walk(home, followlinks=False):
            dirs[:] = [d for d in dirs if not d.startswith('.') and d != 'node_modules' and not os.path.join(root,d).startswith(tmp)]
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
                    before = fingerprint(root)
                    if before[0] != head: raise RuntimeError()
                    has_bundle = bool(head and git(root, 'rev-list', '--max-count=1', 'HEAD', '--branches', '--tags', '--not', '--remotes').strip())
                    manifest.append({'path':root, 'directory':prefix, 'head':head, 'bundle':has_bundle})
                    if has_bundle:
                        bundle = os.path.join(tmp, 'bundle')
                        git(root, 'bundle', 'create', bundle, 'HEAD', '--branches', '--tags', '--not', '--remotes')
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
                    if fingerprint(root) != before: raise RuntimeError()
                data = json.dumps({'version':2,'repositories':manifest}).encode()
                info = tarfile.TarInfo('manifest.json'); info.size=len(data)
                tar.addfile(info, io.BytesIO(data))
            if os.path.getsize(archive)>LIMIT: raise TooLarge()
            # Provider command receipts may persist stdout. Encrypt recovery material
            # before any stdout, wrapping the one-time password to the server key.
            public = os.path.join(tmp, 'public.pem')
            with open(public,'w') as out: out.write('''ARMADA_PUBLIC_KEY''')
            password = os.urandom(32).hex().encode()
            sealed = os.path.join(tmp, 'sealed')
            subprocess.run(['openssl','enc','-aes-256-cbc','-pbkdf2','-iter','10000','-md','sha256','-salt','-in',archive,'-out',sealed,'-pass','stdin'], input=password+b'\n', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3, check=True)
            key = subprocess.run(['openssl','pkeyutl','-encrypt','-pubin','-inkey',public,'-pkeyopt','rsa_padding_mode:oaep','-pkeyopt','rsa_oaep_md:sha256'], input=password, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3, check=True).stdout
            os.replace(sealed,archive)
            with open(archive,'rb') as source: digest=hashlib.sha256(source.read()).hexdigest()
            print(json.dumps({'status':'preserved','bytes':os.path.getsize(archive),'sha256':digest,'key':base64.b64encode(key).decode()}))
except (TooLarge, OSError) as error:
    print(json.dumps({'status':'failed','reason':'size_limit' if isinstance(error,TooLarge) or getattr(error,'errno',None)==27 else 'collector_failed'}))
except CollectorExit as error:
    print(json.dumps({'status':'failed','reason':str(error)}))
except subprocess.CalledProcessError as error:
    print(json.dumps({'status':'failed','reason':'collector_signal' if error.returncode < 0 else 'collector_exit'}))
except subprocess.TimeoutExpired:
    print(json.dumps({'status':'failed','reason':'timeout'}))
except Exception:
    print(json.dumps({'status':'failed','reason':'collector_failed'}))
ARMADA_RECOVERY`;

// 32 KiB raw -> 43,692 base64 bytes, below Modal's 65,536-byte stdout cap.
const CHUNK_BYTES = 32 * 1024;

function privateCommand(token: string, body: string): string {
  // Token is server-generated hex, never caller input or a credential.
  return `python3 - <<'ARMADA_RECOVERY'\nimport base64, os, shutil\np='/tmp/armada-recovery-${token}'\n${body}\nARMADA_RECOVERY`;
}

class CaptureError extends Error {
  constructor(readonly reason: CaptureFailure) {
    super(reason);
  }
}

function checkedOutput(result: Awaited<ReturnType<Provider["exec"]>>): string {
  if (result.detached) throw new CaptureError("collector_exit");
  if (result.timedOut) throw new CaptureError("timeout");
  if (result.truncated) throw new CaptureError("output_truncated");
  if (result.exitCode !== 0)
    throw new CaptureError(
      result.exitCode !== null && (result.exitCode < 0 || result.exitCode >= 128)
        ? "collector_signal"
        : "collector_exit",
    );
  return result.stdout;
}

/** Local-only capture: valid and expired GitHub authorization take the same path.
 * The caller must encrypt the returned archive before persistence, and never log it.
 * Every response fits the runtime stdout cap. Timeout includes capture and all chunks.
 */
export async function preserveWork(provider: Pick<Provider, "exec">, sandboxId: string): Promise<WorkPreservation> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const token = crypto.randomUUID().replaceAll("-", "");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  let stage: CaptureFailure = "unavailable";
  async function collect(): Promise<WorkPreservation> {
    const result = await provider.exec({
      sandboxId,
      command: CAPTURE.replaceAll("ARMADA_TOKEN", token).replace("ARMADA_PUBLIC_KEY", publicKey),
      timeoutSeconds: 12,
      onlyIfRunning: true,
    });
    if (!result.detached && result.timedOut) return { status: "failed", reason: "timeout" };
    stage = "output_invalid";
    const value: unknown = JSON.parse(checkedOutput(result));
    if (typeof value !== "object" || value === null || !("status" in value)) throw new Error();
    if (value.status === "clean") return { status: "clean" };
    if (value.status === "preserved" && "bytes" in value && "sha256" in value && "key" in value) {
      const size = value.bytes;
      if (
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        size > MAX_ARCHIVE_BYTES + 32 ||
        typeof value.key !== "string" ||
        !/^[A-Za-z0-9+/]{342}==$/.test(value.key) ||
        typeof value.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.sha256)
      )
        throw new Error();
      const chunks: Buffer[] = [];
      const count = Math.ceil(size / CHUNK_BYTES);
      for (let start = 0; start < count; start += 8) {
        if (expired) return { status: "failed", reason: "timeout" };
        const batch = await Promise.all(
          Array.from({ length: Math.min(8, count - start) }, async (_, offset) => {
            const index = start + offset;
            const command = privateCommand(
              token,
              `with open(p+'/recovery.tar','rb') as f:\n    f.seek(${index * CHUNK_BYTES})\n    print(base64.b64encode(f.read(${CHUNK_BYTES})).decode())`,
            );
            const output = checkedOutput(
              await provider.exec({ sandboxId, command, timeoutSeconds: 2, onlyIfRunning: true }),
            ).trim();
            if (output.length > 44_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) throw new Error();
            const decoded = Buffer.from(output, "base64");
            if (decoded.length !== Math.min(CHUNK_BYTES, size - index * CHUNK_BYTES)) throw new Error();
            return decoded;
          }),
        );
        chunks.push(...batch);
      }
      const archive = Buffer.concat(chunks);
      if (createHash("sha256").update(archive).digest("hex") !== value.sha256) throw new Error();
      stage = "decrypt";
      const password = privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        Buffer.from(value.key, "base64"),
      );
      if (!/^[0-9a-f]{64}$/.test(password.toString()) || archive.subarray(0, 8).toString() !== "Salted__")
        throw new Error();
      const derived = pbkdf2Sync(password, archive.subarray(8, 16), 10000, 48, "sha256");
      const decipher = createDecipheriv("aes-256-cbc", derived.subarray(0, 32), derived.subarray(32));
      const plaintext = Buffer.concat([decipher.update(archive.subarray(16)), decipher.final()]);
      if (plaintext.length > MAX_ARCHIVE_BYTES) throw new Error();
      return { status: "preserved", archive: plaintext.toString("base64") };
    }
    if (value.status === "failed" && "reason" in value && FAILURE_REASONS.includes(value.reason as CaptureFailure))
      return { status: "failed", reason: value.reason as CaptureFailure };
    throw new Error();
  }
  try {
    return await Promise.race([
      collect(),
      new Promise<WorkPreservation>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve({ status: "failed", reason: "timeout" });
        }, 15_000);
      }),
    ]);
  } catch (error) {
    return { status: "failed", reason: error instanceof CaptureError ? error.reason : stage };
  } finally {
    expired = true;
    clearTimeout(timer);
    // Only the sandbox-local janitor performs cleanup: a later provider exec could
    // otherwise auto-resume the machine after its caller has stopped it.
  }
}
