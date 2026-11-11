# Logs help: baseline audit (#979)

Refs #979. This slice only improves discovery of existing log-reader behavior.
It does not change event delivery, flags, JSON fields, authentication or agents.
Orchestrators, routines and migrations are out of scope.

## Offline baseline

At main `9bee25cd`, `armada logs --help` prints the full 135-line,
11,993-byte CLI reference. Its logs usage omits `--since` and `--org`.
It does not explain tail's default/range, incompatible combinations, cursor
reuse, the JSON page stream, or an example of consuming pages in a pipe.
The reader already supports those options; no new capability is needed.
Additional source audit: --org is parsed (including saved selection) but omitted
from the logs/read request. The candidate forwards that existing field to the
server's existing authorization/organization policy; it adds no permission.

The coordinator baseline is pending while the candidate is prepared. Record CLI revision, provider,
human/session or token authentication, exit codes, page shapes and readability.
The worker holds no staging credentials. Existing #979 evidence is context,
not a claim that this new baseline has been run.

## Coordinator script (macOS/Linux, Python 3.9+)

Save the following as `logs-audit.py`. Pass a pinned executable CLI:
`python3 logs-audit.py --cli /absolute/path/armada --revision FULL_SHA`.
This default discovery/validation audit needs no credentials and never targets
production. Add `--sandbox UUID --org UUID` to read an existing staging sandbox;
set verified `ARMADA_URL` and matching `STAGING_AUDIT_CONFIRM`, plus a staging
token or existing personal staging session. It never sends, stops or deletes.
`--drain` explicitly opts into reading every available page, which can be large.

The script uses Python deadlines, not GNU timeout or util-linux script.
Evidence is private; redact log/account/repository data before posting it.
Do not share token values or a session file.

```python
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import urlsplit
import uuid

p = argparse.ArgumentParser()
p.add_argument("--cli", required=True)
p.add_argument("--revision", required=True)
p.add_argument("--sandbox", type=uuid.UUID)
p.add_argument("--org", type=uuid.UUID)
p.add_argument("--drain", action="store_true")
a = p.parse_args()
cli = str(Path(a.cli).resolve())
if not os.path.isfile(cli) or not os.access(cli, os.X_OK):
    p.error("--cli must be a pinned executable")
if len(a.revision) != 40 or any(c not in "0123456789abcdef" for c in a.revision):
    p.error("--revision must be the full SHA used to build that CLI")
env = dict(os.environ, NO_COLOR="1", TERM="dumb", ARMADA_NO_SKILL_HINT="1")
if a.sandbox:
    u = urlsplit(env.get("ARMADA_URL", ""))
    if (not a.org or u.scheme != "https" or not u.hostname or u.username or u.password
            or u.path not in ("", "/") or u.query or u.fragment
            or u.hostname.rstrip(".").lower() == "armada.thevibecompany.co"
            or env.get("STAGING_AUDIT_CONFIRM") != env.get("ARMADA_URL")):
        p.error("Live reads require --org and an explicitly confirmed staging origin")
elif a.drain:
    p.error("--drain needs --sandbox")
out = Path(tempfile.mkdtemp(prefix="armada-logs-audit-"))
os.chmod(out, 0o700)
print(json.dumps({"revision": a.revision, "evidence": str(out)}))
n = 0

def probe(label, args, child_env):
    global n
    n += 1
    try:
        r = subprocess.run([cli, *args], env=child_env, stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        code, stdout, stderr = r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired as e:
        code, stdout, stderr = 124, e.stdout or b"", e.stderr or b""
    (out / f"{n}.stdout").write_bytes(stdout)
    (out / f"{n}.stderr").write_bytes(stderr)
    row = {"n": n, "label": label, "exit": code,
           "stdout_bytes": len(stdout), "stderr_bytes": len(stderr)}
    with (out / "index.jsonl").open("a") as f:
        f.write(json.dumps(row) + "\n")
    print(json.dumps(row), flush=True)
    return stdout

with tempfile.TemporaryDirectory(prefix="armada-help-home-") as home:
    help_env = dict(env, HOME=home, XDG_CONFIG_HOME=home,
                    ARMADA_URL="https://staging.invalid")
    help_env.pop("ARMADA_TOKEN", None)
    probe("logs-help", ["logs", "--help"], help_env)
    probe("logs-short-help", ["logs", "-h"], help_env)
    fake_id = "00000000-0000-4000-8000-000000000000"
    for label, args in [
        ("tail-zero", ["--tail", "0"]),
        ("tail-too-large", ["--tail", "1001"]),
        ("tail-all-conflict", ["--tail", "2", "--all"]),
        ("tail-since-conflict", ["--tail", "2", "--since", "audit-cursor"]),
    ]:
        probe(label, ["logs", fake_id, *args, "--json"], help_env)
if a.sandbox:
    base = ["logs", str(a.sandbox), "--org", str(a.org)]
    probe("human-page", base, env)
    page = probe("json-page", base + ["--json"], env)
    probe("tail-two", base + ["--tail", "2", "--json"], env)
    probe("tail-default", base + ["--tail", "--json"], env)
    try:
        cursor = json.loads(page).get("cursor")
    except (ValueError, AttributeError):
        cursor = None
    if isinstance(cursor, str) and cursor:
        probe("resume-cursor", base + ["--since", cursor, "--json"], env)
    else:
        print("SKIP resume-cursor: no usable cursor in the returned page")
    if a.drain:
        probe("all-pages", base + ["--all", "--json"], env)
```

## Human observations to post with the index

From a real macOS/Linux terminal, inspect `armada logs --help` and `-h`:
can you locate cursor resume, tail constraints and the JSON pipe example?
For a staging sandbox, compare human output and
`armada logs ID --all --json | jq -c '.events[]'` (opt into large reads).
If appropriate, run `--follow` and press Ctrl-C: it should stop the local reader,
not interrupt the agent. Record if the agent was already settled instead.
Native terminal observations are manual; the script does not claim PTY proof.
Post the index and redacted nonzero stderr on #979; do not treat expected
exit-2 validation probes as service failures.
