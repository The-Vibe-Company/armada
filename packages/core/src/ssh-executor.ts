import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubHydrationError, type GitHubHydrationPhase, githubHydrationPhase } from "./api-failure.ts";
import type { GoldenBuildWarning } from "./golden-build-warning.ts";
import { GoldenError } from "./golden-config.ts";
import { type PRIVATE_SSH_FAILURES, PrivateSshError } from "./private-skill-error.ts";
import type { Provider } from "./provider.ts";

export { PRIVATE_SSH_FAILURES, PrivateSshError } from "./private-skill-error.ts";
export interface SshExecDeps {
  /** Opt in only for the private GitHub repair installer, never generic guest output. */
  githubHydration?: boolean;
  onWarning?: (warning: GoldenBuildWarning) => void;
  mkdtemp?: typeof mkdtemp;
  rm?: typeof rm;
  writeFile?: typeof writeFile;
  chmod?: typeof chmod;
  readPublicKey?: (path: string) => Promise<string>;
  spawn?: typeof spawn;
}
/** Token is first stdin line. The one quoted remote command reads it before running the script. */
export async function sshStdinCheckout(
  provider: Provider,
  input: { sandboxId: string; token: string; script: string; timeoutMs?: number },
  deps: SshExecDeps = {},
): Promise<void> {
  await sshExchange(provider, input, deps, false, input.timeoutMs);
}

/** Private fixed-path hydration; no auth value enters exec argv or command journals. */
export async function sshHydrateAuthState(
  provider: Provider,
  sandboxId: string,
  authJson: string,
  deps: SshExecDeps = {},
): Promise<void> {
  const path =
    provider.id === "boat"
      ? "/home/user/.codex/auth.json"
      : provider.id === "modal"
        ? "/home/user/.armada-runtime/codex/auth.json"
        : undefined;
  if (!path || Buffer.byteLength(authJson) > 65536) throw Error("Private native hydration is unavailable.");
  try {
    const value = JSON.parse(authJson);
    if (
      !value.tokens ||
      typeof value.tokens.refresh_token !== "string" ||
      typeof value.tokens.access_token !== "string" ||
      typeof value.tokens.account_id !== "string"
    )
      throw Error();
    const script = [
      "set +x",
      "node <<'ARMADA_PRIVATE_HYDRATE'",
      "const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');",
      "const target=" + JSON.stringify(path) + ";",
      "let fd,tmp;",
      "try {",
      " const text=JSON.parse(process.env.ARMADA_GIT_TOKEN).authJson; delete process.env.ARMADA_GIT_TOKEN;",
      " if(typeof text!=='string'||Buffer.byteLength(text)>65536)throw Error('invalid'); JSON.parse(text);",
      " const home=fs.lstatSync('/home/user'); if(home.isSymbolicLink()||!home.isDirectory())throw Error('unsafe');",
      " const parts=path.dirname(target).split('/').filter(Boolean);",
      " for(let n=1;n<=parts.length;n++){const dir='/'+parts.slice(0,n).join('/');",
      "  try{const st=fs.lstatSync(dir);if(st.isSymbolicLink()||!st.isDirectory())throw Error('unsafe');}",
      "  catch(e){if(e.code!=='ENOENT')throw e;fs.mkdirSync(dir,{mode:0o700});fs.chownSync(dir,home.uid,home.gid);}}",
      " try{const st=fs.lstatSync(target);if(st.isSymbolicLink()||!st.isFile())throw Error('unsafe');}catch(e){if(e.code!=='ENOENT')throw e;}",
      " tmp=path.join(path.dirname(target),'.armada-auth-'+crypto.randomUUID());",
      " fd=fs.openSync(tmp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);",
      " fs.writeFileSync(fd,text);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;",
      " fs.chownSync(tmp,home.uid,home.gid);fs.renameSync(tmp,target);tmp=undefined;",
      ...(provider.id === "boat"
        ? [
            " const marker=path.join(path.dirname(target),'.armada-managed-native'); const mf=fs.openSync(marker,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW,0o600); try{fs.writeFileSync(mf,'active');fs.ftruncateSync(mf,6);fs.fsyncSync(mf);fs.fchownSync(mf,home.uid,home.gid);}finally{fs.closeSync(mf);}",
          ]
        : []),
      " const dir=fs.openSync(path.dirname(target),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}",
      "}catch{process.exitCode=1;}finally{",
      " if(fd!==undefined)fs.closeSync(fd);if(tmp)try{fs.unlinkSync(tmp);}catch{}",
      " const pub=process.env.ARMADA_SSH_PUBLIC_KEY;if(pub)for(const home of ['/home/user','/root']){try{",
      "  const file=home+'/.ssh/authorized_keys',st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile())continue;",
      "  fs.writeFileSync(file,fs.readFileSync(file,'utf8').split('\\n').filter(line=>line.trim()!==pub.trim()).join('\\n'),{mode:0o600});",
      " }catch{}}}",
      "ARMADA_PRIVATE_HYDRATE",
    ].join("\n");
    await sshExchange(provider, { sandboxId, token: JSON.stringify({ authJson }), script }, deps, false, 30000);
  } catch {
    throw Error("Private native auth hydration failed.");
  }
}

/** Boat native bridge admission; pause lets it close its private writer before capture. */
export async function sshNativeAuthAdmission(
  provider: Pick<Provider, "id" | "sshKey">,
  sandboxId: string,
  active: boolean,
  deps: SshExecDeps = {},
) {
  if (provider.id !== "boat") throw Error("Native admission requires Boat.");
  const script = `set +x
node <<'ARMADA_NATIVE_ADMISSION'
const fs=require('node:fs');
try {
 const base='/home/user/.codex', owner=fs.lstatSync('/home/user').uid;
 const dir=fs.lstatSync(base);
 if(dir.isSymbolicLink()||!dir.isDirectory()||dir.uid!==owner)throw Error();
 const marker=base+'/.armada-managed-native';
 const st=fs.lstatSync(marker);
 if(st.isSymbolicLink()||!st.isFile()||st.uid!==owner||(st.mode&0o077)||st.nlink!==1)throw Error();
 const lock=base+'/.armada-native-writer.lock';
 try{const st=fs.lstatSync(lock);if(st.isSymbolicLink()||!st.isFile()||st.uid!==owner||(st.mode&0o077)||st.nlink!==1)throw Error();}catch(e){if(e.code!=='ENOENT')throw e;}
 const fd=fs.openSync(marker,fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW);
 try{fs.writeFileSync(fd,${JSON.stringify(active ? "active" : "paused")});fs.ftruncateSync(fd,6);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 if(${JSON.stringify(!active)}){
  const record=base+'/.armada-native-writer.json';
  let saved;
  try{
   const st=fs.lstatSync(record);
   if(st.isSymbolicLink()||!st.isFile()||st.uid!==owner||(st.mode&0o077)||st.nlink!==1||st.size>4096)throw Error();
   saved=JSON.parse(fs.readFileSync(record,'utf8'));
  }catch(e){if(e.code!=='ENOENT')throw e;}
  if(saved && saved.boot===fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()){
   if(!Number.isSafeInteger(saved.pid)||saved.pid<=1||typeof saved.start!=='string')throw Error();
   const lockStat=fs.statSync(lock); let members=0, held=false;
   for(const name of fs.readdirSync('/proc')){
    if(!/^[0-9]+$/.test(name))continue;
    try{
     const entry='/proc/'+name;
     const raw=fs.readFileSync(entry+'/stat','utf8'), fields=raw.slice(raw.lastIndexOf(')')+2).split(' ');
     if(Number(fields[2])!==saved.pid||['Z','X'].includes(fields[0]))continue;
     if(fs.statSync(entry).uid!==owner||(Number(name)===saved.pid&&fields[19]!==saved.start))throw Error();
     members++;
     for(const descriptor of fs.readdirSync(entry+'/fd')){try{
      const st=fs.statSync(entry+'/fd/'+descriptor);
      if(st.dev===lockStat.dev&&st.ino===lockStat.ino)held=true;
     }catch(e){if(!['ENOENT','ESRCH'].includes(e.code))throw e;}}
    }catch(e){if(!['ENOENT','ESRCH'].includes(e.code))throw e;}
   }
   if(members){if(!held)throw Error();process.kill(-saved.pid,'SIGKILL');}
  }
 }
}catch{process.exitCode=1;}finally{
 const pub=process.env.ARMADA_SSH_PUBLIC_KEY;
 if(pub)for(const home of ['/home/user','/root']){try{
 const file=home+'/.ssh/authorized_keys',st=fs.lstatSync(file);
 if(st.isSymbolicLink()||!st.isFile())continue;
 fs.writeFileSync(file,fs.readFileSync(file,'utf8').split('\\n').filter(line=>line.trim()!==pub.trim()).join('\\n'),{mode:0o600});
 }catch{}}
}
ARMADA_NATIVE_ADMISSION
`;
  try {
    await sshExchange(provider, { sandboxId, token: "", script }, deps, false, 30000);
  } catch {
    throw Error("Private native admission failed.");
  }
}

/** Private server-only capture. No caller-selected path, command, or public exec journal. */
export async function sshPrivateAuthState(
  provider: Provider,
  sandboxId: string,
  deps: SshExecDeps = {},
  quiesced = false,
  expectedSharedCapability?: string,
): Promise<string> {
  const path =
    provider.id === "boat"
      ? "/home/user/.codex/auth.json"
      : provider.id === "modal"
        ? "/home/user/.armada-runtime/codex/auth.json"
        : undefined;
  if (!path) throw Error("Private native auth transport is unavailable.");
  const script = `set +x
umask 077
${quiesced ? "flock -x -w 30 /home/user/.codex/.armada-native-writer.lock " : ""}node <<'ARMADA_PRIVATE_AUTH'
const fs = require('node:fs');
const path = ${JSON.stringify(path)};
function readPrivate(file) {
 let fd;
 try {
  const parts=file.split('/').filter(Boolean);
  for(let n=1;n<parts.length;n++) {
   const stat=fs.lstatSync('/'+parts.slice(0,n).join('/'));
   if(stat.isSymbolicLink() || !stat.isDirectory()) throw Error('unsafe');
  }
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const stat=fs.fstatSync(fd);
  if(!stat.isFile() || stat.uid!==fs.lstatSync('/home/user').uid || stat.nlink!==1 || stat.size>65536 || (stat.mode&0o077)) throw Error('unsafe');
  const bytes=Buffer.alloc(65537),length=fs.readSync(fd,bytes,0,bytes.length,0);
  if(length>65536) throw Error('oversized');
  return bytes.subarray(0,length).toString('utf8');
 } finally { if(fd!==undefined) fs.closeSync(fd); }
}
try {
 let text;
 try { text=readPrivate(path); }
 catch(error) {
  const expected=process.env.ARMADA_GIT_TOKEN;
  if(${provider.id === "boat" ? "true" : "false"} && expected && error.code==='ENOENT' &&
     JSON.parse(readPrivate('/home/user/.armada/model-access.json')).capability===expected)
  {
   let managed=false;
   try { fs.lstatSync('/home/user/.codex/.armada-managed-native'); managed=true; }
   catch(e) { if(e.code!=='ENOENT') throw e; }
   process.stdout.write(managed ? 'pending' : 'null');
  }
  else throw error;
 }
 if(text!==undefined) {
  const value=JSON.parse(text);
  if(!value.tokens || typeof value.tokens.refresh_token!=='string' ||
     typeof value.tokens.access_token!=='string' || typeof value.tokens.account_id!=='string') throw Error('invalid');
  process.stdout.write(text);
 }
} catch { process.exitCode=1; }
finally {
  const pub=process.env.ARMADA_SSH_PUBLIC_KEY;
  if(pub) for(const home of ['/home/user','/root']) {
    try {
      const file=home+'/.ssh/authorized_keys', stat=fs.lstatSync(file);
      if(stat.isSymbolicLink() || !stat.isFile()) continue;
      const lines=fs.readFileSync(file,'utf8').split('\\n');
      fs.writeFileSync(file,lines.filter(line=>line.trim()!==pub.trim()).join('\\n'),{mode:0o600});
    } catch {}
  }
}
ARMADA_PRIVATE_AUTH
`;
  try {
    return await sshExchange(provider, { sandboxId, token: expectedSharedCapability ?? "", script }, deps, true);
  } catch {
    throw Error("Private native auth exchange failed.");
  }
}

/** Private Skillpack transport: key and script use SSH stdin, never provider exec or argv. */
export async function sshPrivateSkillCommand(
  provider: Provider,
  input: { sandboxId: string; key: string; script: string },
  deps: SshExecDeps = {},
): Promise<string> {
  try {
    return await sshExchange(
      provider,
      { sandboxId: input.sandboxId, token: input.key, script: input.script },
      deps,
      true,
      600_000,
      true,
    );
  } catch (error) {
    if (error instanceof PrivateSshError) throw error;
    throw new PrivateSshError("skillpack_ssh_local_storage_failed");
  }
}

async function sshExchange(
  provider: Pick<Provider, "sshKey">,
  input: { sandboxId: string; token: string; script: string },
  deps: SshExecDeps,
  capture: boolean,
  timeoutMs = capture ? 30_000 : 600_000,
  privateTransport = false,
): Promise<string> {
  const fs = {
    mkdtemp: deps.mkdtemp ?? mkdtemp,
    rm: deps.rm ?? rm,
    writeFile: deps.writeFile ?? writeFile,
    chmod: deps.chmod ?? chmod,
  };
  const run = deps.spawn ?? spawn;
  const dir = await fs.mkdtemp(join(tmpdir(), "armada-ssh-"));
  const key = join(dir, "key"),
    known = join(dir, "known_hosts");
  let step: "keygen" | "local_storage" | "authorization" | "connection" | "remote" = "keygen";
  try {
    await command(run, "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], "", false, timeoutMs);
    step = "local_storage";
    await fs.chmod(key, 0o600);
    const pub = await (deps.readPublicKey ?? ((p: string) => Bun.file(p).text()))(`${key}.pub`);
    step = "authorization";
    const c = await provider.sshKey({ sandboxId: input.sandboxId, key: pub.trim() });
    step = "connection";
    const username = c.username === undefined ? "user" : c.username;
    if (username !== "user" && username !== "root") throw new GoldenError("setup_failed", "Invalid SSH username.");
    const ep = parseEndpoint(c.sshEndpoint);
    const knownText = knownLine(ep.host, ep.port, c.hostKey);
    step = "local_storage";
    await fs.writeFile(known, knownText, { mode: 0o600 });
    // ssh joins its command argv with spaces before the remote shell parses it. Keep this one
    // shell-quoted argument so semicolons cannot escape bash -c and turn `set +x` into a command.
    // The checkout script itself carries the cleanup trap; do not exec, which would discard it.
    const remote = shellQuote(
      "set +x; IFS= read -r ARMADA_GIT_TOKEN; IFS= read -r ARMADA_SSH_PUBLIC_KEY; export ARMADA_GIT_TOKEN ARMADA_SSH_PUBLIC_KEY; " +
        (username === "root" ? "export HOME=/home/user; cd /home/user || exit 96; " : "") +
        "bash -s; status=$?; unset ARMADA_GIT_TOKEN ARMADA_SSH_PUBLIC_KEY; history -c 2>/dev/null || true; exit $status",
    );
    step = "remote";
    return await command(
      run,
      "ssh",
      [
        "-i",
        key,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=30",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=4",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${known}`,
        "-o",
        "LogLevel=ERROR",
        "-p",
        ep.port,
        `${username}@${ep.host}`,
        "bash",
        "-c",
        remote,
      ],
      `${input.token}\n${pub.trim()}\n${input.script}`,
      capture,
      timeoutMs,
      deps.onWarning,
      privateTransport,
      input.sandboxId,
      deps.githubHydration === true,
    );
  } catch (error) {
    if (!privateTransport || error instanceof PrivateSshError) throw error;
    throw new PrivateSshError(
      step === "local_storage"
        ? "skillpack_ssh_local_storage_failed"
        : step === "keygen"
          ? "skillpack_ssh_keygen_failed"
          : step === "authorization"
            ? "skillpack_ssh_authorization_failed"
            : step === "connection"
              ? "skillpack_ssh_connection_invalid"
              : "skillpack_ssh_remote_failed",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
function parseEndpoint(v: string) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(v) || /^([^:]+):(\d+)$/.exec(v);
  if (!m || Number(m[2] ?? 0) < 1 || Number(m[2] ?? 0) > 65535) throw new Error("Invalid SSH endpoint.");
  const host = m[1];
  const port = m[2];
  if (!host || !port) throw new Error("Invalid SSH endpoint.");
  return { host, port };
}
function knownLine(host: string, port: string, key: string) {
  if (/^\S+\s+(ssh-|ecdsa-|sk-)/.test(key)) return key.endsWith("\n") ? key : `${key}\n`;
  if (!/^(ssh-|ecdsa-|sk-)/.test(key)) throw new Error("Invalid SSH host key.");
  return `[${host}]:${port} ${key}\n`;
}
function command(
  spawnImpl: typeof spawn,
  file: string,
  args: string[],
  stdin: string,
  capture = false,
  timeoutMs = capture ? 30_000 : 600_000,
  onWarning?: (warning: GoldenBuildWarning) => void,
  privateTransport = false,
  sandboxId?: string,
  githubHydration = false,
) {
  return new Promise<string>((resolve, reject) => {
    // Typed as the base ChildProcess, not the stdio-narrowed overload: which @types/node overload
    // that resolves to (and whether it still carries EventEmitter's own members) depends on the
    // exact @types/node version a workspace package without its own pin happens to get hoisted.
    const c: ChildProcess = spawnImpl(file, args, { stdio: ["pipe", capture ? "pipe" : "ignore", "pipe"] });
    let pending = "";
    let phase = "ssh";
    let hydrationPhase: GitHubHydrationPhase | undefined;
    let exitCode: string | undefined;
    let timedOut = false;
    let privateReason: (typeof PRIVATE_SSH_FAILURES)[number] | undefined;
    const output: Buffer[] = [];
    let bytes = 0,
      overflow = false;
    c.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65536) {
        overflow = true;
        output.length = 0;
        c.kill("SIGKILL");
      } else if (!overflow) output.push(Buffer.from(chunk));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      c.kill("SIGKILL");
    }, timeoutMs);
    c.stderr?.on("data", (d) => {
      if (capture && !privateTransport) return;
      // Stream only fixed protocol records; discard all tool stderr, including arbitrary secrets.
      pending += String(d);
      const lines = pending.split("\n");
      pending = (lines.pop() ?? "").slice(-256);
      for (const line of lines) {
        if (privateTransport) {
          const remote =
            /^ARMADA_PRIVATE_FAILURE (node_missing|flock_missing|home_unavailable|key_cleanup_failed)$/.exec(line);
          if (remote)
            privateReason = (
              {
                node_missing: "skillpack_ssh_node_missing",
                flock_missing: "skillpack_ssh_flock_missing",
                home_unavailable: "skillpack_ssh_home_unavailable",
                key_cleanup_failed: "skillpack_ssh_key_cleanup_failed",
              } as const
            )[remote[1] as "node_missing" | "flock_missing" | "home_unavailable" | "key_cleanup_failed"];
          else if (!privateReason) {
            if (
              line.includes("Host key verification failed") ||
              line.includes("REMOTE HOST IDENTIFICATION HAS CHANGED")
            )
              privateReason = "skillpack_ssh_host_key_rejected";
            else if (line.includes("Permission denied (publickey"))
              privateReason = "skillpack_ssh_authentication_failed";
            else if (/kex_exchange_identification|Connection closed by/.test(line))
              privateReason = "skillpack_ssh_connection_failed";
            else if (
              /Connection refused|Connection timed out|Could not resolve hostname|Network is unreachable|Connection reset by peer/.test(
                line,
              )
            )
              privateReason = "skillpack_ssh_unreachable";
          }
          continue; // Never forward private SSH stderr, even build-looking records.
        }
        const match =
          /^ARMADA_BUILD_FAILURE (checkout|bun|chromium|harness|skillpack|init|ownership|credential_cleanup|inline_scan) ([0-9]{1,3})$/.exec(
            line,
          );
        if (match) {
          phase = match[1]!;
          exitCode = match[2];
        }
        const github = githubHydration
          ? /^ARMADA_GITHUB_FAILURE (privilege|payload|directories|lock|executables|install|token_write|sudo|bootstrap)$/.exec(
              line,
            )
          : null;
        if (github) hydrationPhase = githubHydrationPhase(github[1]);
        const warning = /^ARMADA_BUILD_WARNING skillpack (download_unavailable|user_local_only)$/.exec(line);
        if (warning)
          onWarning?.(
            warning[1] === "download_unavailable" ? "skillpack_download_unavailable" : "skillpack_user_local_only",
          );
        if (warning)
          console.warn(
            JSON.stringify({
              event: "golden_skillpack_warning",
              reason: warning[1],
              action:
                warning[1] === "user_local_only"
                  ? "use_user_local_cli"
                  : "allow_github_egress_and_rebuild_before_using_skills",
            }),
          );
      }
    });
    c.on("error", () => {
      clearTimeout(timer);
      reject(
        privateTransport
          ? new PrivateSshError("skillpack_ssh_remote_failed")
          : new GoldenError("build_failed", `${file} could not start. Check server SSH tooling.`),
      );
    });
    c.stdin?.on?.("error", () => {
      /* Close/error owns the sanitized failure. */
    });
    c.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code === 0 && !overflow) resolve(Buffer.concat(output).toString("utf8"));
      else {
        if (privateTransport) {
          reject(
            new PrivateSshError(
              timedOut
                ? "skillpack_ssh_timeout"
                : overflow
                  ? "skillpack_ssh_output_invalid"
                  : (privateReason ??
                    (code === 255 ? "skillpack_ssh_connection_failed" : "skillpack_ssh_remote_failed")),
            ),
          );
          return;
        }
        const reason = timedOut ? "timeout" : `exit_${exitCode ?? code ?? "signal"}`;
        if (!capture) console.error(JSON.stringify({ event: "golden_ssh_failed", phase, code: reason }));
        if (hydrationPhase) {
          console.error(JSON.stringify({ event: "github_hydration_failed", sandboxId, phase: hydrationPhase }));
          reject(new GitHubHydrationError(hydrationPhase));
          return;
        }
        reject(
          new GoldenError(
            "build_failed",
            phase === "skillpack" && exitCode === "98"
              ? "skillpack_integrity_failed: native archive checksum or self-test failed; do not use this build."
              : `Golden build failed during ${phase} (${reason}). Check builder connectivity, permissions and package availability; retry after correction. The previous golden is retained.`,
            {
              ...(phase === "skillpack" && exitCode === "98"
                ? { safeReason: "skillpack_integrity_failed" as const }
                : {}),
            },
          ),
        );
      }
    });
    c.stdin?.end(stdin);
  });
}
/** Single-quotes a shell word: close the quote, an escaped literal quote, reopen it. */
export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
