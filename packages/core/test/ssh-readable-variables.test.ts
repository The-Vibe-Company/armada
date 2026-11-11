import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "../src/provider.ts";
import * as transport from "../src/ssh-executor.ts";
import { sshReadableVariables } from "../src/ssh-readable-variables.ts";

// Execute the actual SSH bootstrap/installer, redirecting only OS filesystem paths and
// subprocess boundaries. No root, network, production path flags, or fake hydration logic.
const HARNESS = `import os,sys,json,subprocess,tempfile,io,stat
from types import SimpleNamespace
from unittest.mock import patch
p=json.load(sys.stdin)
root=p["root"]
def path(value):
 if isinstance(value,str) and value.startswith("/run/armada-readable-variables"): return root+value
 return value
original_mkdir=os.mkdir
original_lstat=os.lstat
original_replace=os.replace
original_mkstemp=tempfile.mkstemp
def lstat(value):
 s=original_lstat(path(value))
 return SimpleNamespace(st_mode=s.st_mode,st_uid=0)
def install(command,input,**options):
 # This is the real fixed installer passed by the production SSH bootstrap.
 with patch("sys.stdin",io.StringIO(input.decode())),patch("os.mkdir",lambda value,mode=0o777:original_mkdir(path(value),mode)),patch("os.lstat",lstat),patch("tempfile.mkstemp",lambda **kw:original_mkstemp(dir=path(kw["dir"]))),patch("os.replace",lambda a,b:original_replace(path(a),path(b))):
  exec(compile(command[-1],"production-readable-installer","exec"),{"__name__":"__main__"})
 return SimpleNamespace(returncode=0)
os.makedirs(root+"/run",exist_ok=True)
script=p["script"].split("import os,sys,subprocess",1)[1].rsplit("ARMADA_READABLE_BOOTSTRAP",1)[0]
script="import os,sys,subprocess"+script
with patch.dict(os.environ,{"ARMADA_GIT_TOKEN":p["token"]},clear=True),patch("os.getuid",lambda:0),patch("subprocess.run",install):
 try: exec(compile(script,"production-readable-bootstrap","exec"),{"__name__":"__main__"})
 except SystemExit as result:
  if result.code: raise
`;

test("Boat fixed bootstrap successfully restores the same readable file after /run loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-readable-ssh-"));
  const variables = { APP_REGION: "frozen\n$(not-shell)", APP_EMPTY: "" };
  let delivered = 0;
  const ssh = spyOn(transport, "sshStdinCheckout").mockImplementation(async (_provider, input) => {
    expect(input.script).not.toContain("not-shell");
    const executed = spawnSync("/usr/bin/python3", ["-I", "-c", HARNESS], {
      input: JSON.stringify({ root, script: input.script, token: input.token }),
      encoding: "utf8",
      timeout: 10000,
    });
    expect(executed.stderr).toBe("");
    expect(executed.status).toBe(0);
    delivered++;
  });
  try {
    const provider = { id: "boat" } as Provider;
    const file = join(root, "run/armada-readable-variables/codex.json");
    await sshReadableVariables(provider, "sandbox", "codex", variables);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(variables);
    await rm(join(root, "run"), { recursive: true });
    await sshReadableVariables(provider, "sandbox", "codex", variables);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(variables);
    expect(delivered).toBe(2);
  } finally {
    ssh.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
