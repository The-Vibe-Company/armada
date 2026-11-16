import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("managed gh resolves positional repository shapes without Git or network", () => {
  const source = readFileSync(new URL("../src/github-tools.ts", import.meta.url), "utf8");
  const helpers = source.slice(
    source.indexOf("def repository(value):"),
    source.indexOf("def safe(line,stream=False):"),
  );
  const start = source.indexOf("        args=sys.argv[4:]");
  const end = source.indexOf("    else: raise ValueError()\n    stage='broker_request'", start);
  const selection = source.slice(start, end).replace("args=sys.argv[4:]", "args=arguments");
  const script = [
    "import re,os,json,sys,types,contextlib,io",
    "subprocess=types.SimpleNamespace(run=lambda *a,**k: types.SimpleNamespace(returncode=1))",
    "GIT_EXECUTABLE='unused'",
    "repositories=['acme/project']",
    "class Connection:",
    "    def __init__(self,*args): pass",
    "    def request(self,*args): pass",
    "    def getresponse(self): return types.SimpleNamespace(status=200,read=lambda n: json.dumps({'repositories':repositories}).encode())",
    "    def close(self): pass",
    helpers,
    "def select(arguments):",
    selection.replaceAll("\\n", "\n"),
    "        return repo",
    "cases=[(['repo','clone','acme/project'],'acme/project'),(['repo','view','acme/project'],'acme/project'),(['repo','view','--json','nameWithOwner','acme/project'],'acme/project'),(['repo','fork','acme/project'],'acme/project'),(['pr','view','https://github.com/acme/project/pull/12'],'acme/project'),(['issue','view','https://github.com/acme/project/issues/12'],'acme/project'),(['api','repos/acme/project/pulls'],'acme/project')]",
    "for args,wanted in cases: assert select(args)==wanted,args",
    "out=io.StringIO()",
    "with contextlib.redirect_stdout(out):",
    "    try: select(['auth','status'])",
    "    except SystemExit as e: assert e.code==0",
    "assert 'acme/project' in out.getvalue()",
    "try: select(['pr','list'])",
    "except ValueError: pass",
    "else: raise AssertionError('missing repo accepted')",
    "repositories=[]",
    "with contextlib.redirect_stderr(io.StringIO()) as err:",
    "    try: select(['auth','status'])",
    "    except SystemExit as e: assert e.code==1",
    "assert '--repo' in err.getvalue()",
    "for args in [['repo','view','acme/other','-R','acme/project'],['api','repos/acme/project/../other'],['repo','delete','acme/project']]:",
    "    try: select(args)",
    "    except ValueError: continue",
    "    raise AssertionError(args)",
  ].join("\n");
  const result = Bun.spawnSync(["python3", "-I", "-c", script], {
    env: { PATH: process.env.PATH ?? "" },
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
