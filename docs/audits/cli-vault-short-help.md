# Variables and secrets: short-help audit

Refs #979. This slice adds the conventional short spelling for existing help.
It changes no vault actions, API/JSON fields, permission rules or secret handling.
Provider, login and storage operations are not exercised by a help-only request.

## Audit before changes

At main f89e651ab8546eb43cdac3d48a7929c5c1c72b64, actual CLI discovery recorded
10 failing short-help forms across vars/secrets family and subcommands.
The same 10 long-help forms succeed. Three argument-compatibility probes
correctly return usage exit 2. This agrees with the earlier 68-probe family audit
posted on #979; it is not claimed as a coordinator-run staging audit.

The existing run.ts-boundary help contract fails before repair and passes after.
Compatibility coverage keeps --file -h as a filename, keeps malformed scope/version
values as errors, and does not turn text after -- into a help flag.
Existing metadata-only output and input redaction assertions remain intact.

## Required coordinator evidence — pending

The ticket amendment still requires a coordinator-owned command-family live
audit. The local results above and the client-only script below do **not**
complete that requirement. No exemption has been granted for this PR.
Before merge, the coordinator must attach the pinned staging results and
relevant human/TTY observations, or explicitly amend the ticket for this slice.
Workers must not obtain credentials or fabricate missing observations.

The coordinator determines which Boat/sign-in checks are genuinely inapplicable
to a pre-authentication help alias. This document does not waive them. Do not
publish real secret values or mutate existing credentials for evidence.

## Coordinator's client audit (macOS/Linux, Python 3.9+)

Save the following as vault-help-audit.py and run it against a pinned executable:

    python3 vault-help-audit.py --cli /absolute/path/armada --revision FULL_SHA

Baseline: 10 mismatches; candidate: zero. The tool exits 1 for mismatches (expected
on the baseline), records all results, and makes no mutations or provider calls.
It isolates HOME, clears authentication and uses an invalid origin deliberately:
help must work before login or value input. No GNU timeout/util-linux script is
needed. Raw evidence is private; post the index and relevant redacted errors.

The coordinator can repeat the same forms from a native terminal to check
readability/no-color behavior. The script itself does not authenticate, invoke
providers or write entries; any additional staging coverage must use separately
authorized disposable fixtures. Record provider/authentication applicability,
revision, exit codes, observed results, failures and coverage limits explicitly.
Coordinator observations remain separate from worker local evidence.

```python
"""Client-only vars/secrets help audit. Python3.9+, macOS/Linux; no credentials."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

p = argparse.ArgumentParser(description=__doc__)
p.add_argument("--cli", required=True, help="absolute path to pinned executable")
p.add_argument("--revision", required=True, help="full CLI source SHA")
a = p.parse_args()
cli = str(Path(a.cli).resolve())
if not os.path.isfile(cli) or not os.access(cli, os.X_OK):
    p.error("--cli must be an executable")
if len(a.revision) != 40 or any(c not in "0123456789abcdef" for c in a.revision):
    p.error("--revision must be the SHA used to build that executable")
out = Path(tempfile.mkdtemp(prefix="armada-vault-help-"))
os.chmod(out, 0o700)
print(json.dumps({"revision": a.revision, "evidence": str(out)}))
cases = []
for resource, actions in [
    ("vars", ["set", "list", "read"]),
    ("secrets", ["set", "list", "rotate", "revoke", "delete"]),
]:
    for prefix in [[resource], *[[resource, action] for action in actions]]:
        for option in ["--help", "-h"]:
            cases.append(([*prefix, option], 0))
cases.extend([
    (["vars", "list", "--", "-h"], 2),
    (["vars", "set", "AUDIT_NAME", "--scope", "-h"], 2),
    (["secrets", "revoke", "00000000-0000-4000-8000-000000000000",
      "--expected-version", "-h"], 2),
])
mismatches = 0
with tempfile.TemporaryDirectory(prefix="armada-help-home-") as home:
    env = dict(os.environ, HOME=home, XDG_CONFIG_HOME=home,
               ARMADA_URL="https://staging.invalid", ARMADA_TOKEN="",
               ARMADA_NO_SKILL_HINT="1", NO_COLOR="1", TERM="dumb")
    for n, (argv, expected) in enumerate(cases, 1):
        try:
            r = subprocess.run([cli, *argv], cwd=home, env=env,
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, timeout=30)
            code, stdout, stderr = r.returncode, r.stdout, r.stderr
        except subprocess.TimeoutExpired as e:
            code, stdout, stderr = 124, e.stdout or b"", e.stderr or b""
        (out / f"{n}.stdout").write_bytes(stdout)
        (out / f"{n}.stderr").write_bytes(stderr)
        row = {"n": n, "argv": argv, "exit": code, "expected": expected,
               "stdout_bytes": len(stdout), "stderr_bytes": len(stderr)}
        mismatches += code != expected
        with (out / "index.jsonl").open("a") as f:
            f.write(json.dumps(row) + "\n")
        print(json.dumps(row), flush=True)
print(json.dumps({"cases": len(cases), "mismatches": mismatches}))
raise SystemExit(1 if mismatches else 0)
```
