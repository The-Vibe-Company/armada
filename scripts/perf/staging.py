#!/usr/bin/env python3
"""Python 3.9+, macOS/Linux. Run from repo root after bun install --frozen-lockfile.
STAGING_URL=https://... STAGING_ORG=UUID ARMADA_TOKEN=... python3 scripts/perf/staging.py
Requires a snapshotted golden and working model credential/default for selected pair.
One selected provider x harness disposable launch (billable), no retries of launch/send. Only read operations
are sampled repeatedly. No response bodies, child output or tokens are printed.
"""
import argparse
import json
import math
import os
import platform
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--samples", type=int, default=20)
parser.add_argument("--golden", help="Existing golden for the selected provider; otherwise first snapshotted name")
parser.add_argument("--provider", choices=["modal", "boat"], default="modal")
parser.add_argument("--harness", choices=["codex", "claude"], default="codex")
parser.add_argument("--cli", help="Compiled armada executable; default: Bun source CLI")
args = parser.parse_args()
if not 5 <= args.samples <= 100:
    parser.error("--samples must be 5..100")
root = Path(__file__).resolve().parents[2]
url = urllib.parse.urlsplit(os.environ.get("STAGING_URL", ""))
org = os.environ.get("STAGING_ORG", "")
token = os.environ.get("ARMADA_TOKEN", "")
if url.scheme != "https" or not url.netloc or url.username or url.password or url.query or url.fragment:
    parser.error("STAGING_URL must be an HTTPS origin without credentials/query/fragment")
if (url.hostname or "").rstrip(".").lower() in {
    "armada.thevibecompany.co", "armada.thevibecompany.com",
    "armada-mcp-production.up.railway.app",
}:
    parser.error("Refusing known production origin; use the staging deployment")
if not org or not token:
    parser.error("STAGING_ORG and ARMADA_TOKEN are required")
origin = urllib.parse.urlunsplit((url.scheme, url.netloc, "", "", ""))
report = {
    "provider": args.provider, "harness": args.harness,
    "schema": 2, "python": platform.python_version(), "host": platform.platform(),
    "samples": args.samples, "api": [], "cli": [], "phases": [],
    "limits": [
        "Client wall time, not server-only time; payload bytes are decoded HTTP body bytes.",
        "Server-Timing reports instrumented server wall phases only; nested phases overlap and must not be summed.",
        "Missing server phases are unavailable, not zero. SQL trip counts remain unmeasured.",
        "One selected provider/harness lifecycle sample is not a p50/p95 distribution.",
        "No dashboard paint/navigation, phone or long-session open measurement in this script.",
        "No user-facing before/after claim until run consistently against both revisions.",
    ],
}
sandbox_id = None


class Failure(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward the bearer to another origin.


opener = urllib.request.build_opener(NoRedirect())


# Fixed allowlist: do not print arbitrary server headers (or reflected secret strings).
SERVER_PHASES = {
    "launch_authorize", "launch_provider", "launch_lookup", "launch_defaults",
    "launch_connections", "launch_credentials", "launch_claim", "launch_admission",
    "launch_fork", "launch_register", "launch_bind", "launch_ready", "launch_hydrate",
    "launch_github", "launch_pull", "launch_init", "launch_cwd", "launch_skills",
    "launch_mcp", "launch_before_start", "launch_probe", "launch_prompt",
    "auth", "dispatch", "provider", "stored_provider", "sandbox_read",
    "logs_target", "events", "state", "prompt",
    "send_credentials", "send_state", "send_turn_auth", "send_submit",
}


def server_phases(header):
    durations = {}
    for entry in header.split(","):
        match = re.fullmatch(r"\s*([a-z_]+);dur=([0-9]+(?:\.[0-9]+)?)\s*", entry)
        if match and match.group(1) in SERVER_PHASES:
            value = float(match.group(2))
            if math.isfinite(value):
                durations[match.group(1)] = value
    return durations


def api(route, body=None, method="POST", timeout=60):
    path = "/api/v1/" + route
    data = None if body is None else json.dumps({"org": org, **body}).encode()
    req = urllib.request.Request(origin + path, data=data, method=method, headers={
        "Authorization": "Bearer " + token, "Content-Type": "application/json",
        "Accept": "application/json", "Accept-Encoding": "identity",
    })
    start = time.monotonic()
    try:
        with opener.open(req, timeout=timeout) as response:
            raw = response.read()
            status = response.status
            server = server_phases(response.headers.get("Server-Timing", ""))
    except urllib.error.HTTPError as error:
        # Do not print errors/bodies: they may contain prompts or credentials.
        raise Failure("HTTP " + str(error.code) + " on " + route) from None
    except Exception:
        raise Failure("Transport failure on " + route + "; write outcome may be unknown") from None
    elapsed = (time.monotonic() - start) * 1000
    try:
        value = json.loads(raw)
    except Exception:
        raise Failure("Invalid JSON on " + route) from None
    return value, elapsed, len(raw), status, server


def stats(values):
    ordered = sorted(values)
    return {"p50": ordered[math.ceil(len(ordered) * .5) - 1],
            "p95": ordered[math.ceil(len(ordered) * .95) - 1]}


def sample(route, body):
    times, sizes, phases = [], [], {}
    for _ in range(args.samples):
        _, elapsed, size, _, server = api(route, body)
        times.append(elapsed)
        sizes.append(size)
        for name, duration in server.items():
            phases.setdefault(name, []).append(duration)
    report["api"].append({"route": route, "method": "POST", "samples": len(times),
                          "ms": stats(times), "bytes": stats(sizes), "sqlTrips": None,
                          "serverMs": {name: {"samples": len(values), **stats(values)}
                                       for name, values in phases.items()}})


def phase(name, route, body, timeout=600):
    value, elapsed, size, _, server = api(route, body, timeout=timeout)
    report["phases"].append({"phase": name, "ms": elapsed, "bytes": size, "serverMs": server})
    return value


def cli(command):
    base = [args.cli] if args.cli else ["bun", str(root / "packages/cli/src/main.ts")]
    env = {**os.environ, "ARMADA_URL": origin}
    times = []
    for _ in range(args.samples):
        start = time.monotonic()
        try:
            result = subprocess.run(base + command, cwd=root, env=env,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    timeout=60, check=False)
        except Exception:
            raise Failure("CLI unavailable or timed out") from None
        if result.returncode:
            raise Failure("CLI command failed (output suppressed)") from None
        times.append((time.monotonic() - start) * 1000)
    report["cli"].append({"command": command[0], "mode": "binary" if args.cli else "source",
                          "samples": len(times), "ms": stats(times)})


def interrupted(signum, frame):
    raise Failure("Interrupted; entering cleanup")


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
exit_code = 0
try:
    for command in [["--version"], ["--help"], ["list", "--org", org, "--json"],
                    ["golden", "list", "--org", org, "--json"]]:
        cli(command)
    goldens, _, _, _, _ = api("golden/list", {})
    candidates = sorted(
        (g for g in goldens["goldens"] if g.get("provider") == args.provider
         and g.get("providerSnapshotId") and (not args.golden or g["name"] == args.golden)),
        key=lambda g: g["name"],
    )
    if not candidates:
        raise Failure("No snapshotted golden available for selected provider")
    sample("golden/list", {})
    sample("sandbox/list", {"limit": 25, "page": 1})
    # Idle launch exposes launch-to-ready separately from prompt admission/output.
    launched = phase("launch_to_ready_including_auth_fork_init", "sandbox/launch", {
        "golden": candidates[0]["name"], "provider": args.provider, "harness": args.harness,
        "ttlSeconds": 600, "connections": [],
    })
    sandbox_id = launched.get("sandbox", {}).get("id")
    if not isinstance(sandbox_id, str) or not sandbox_id:
        raise Failure("Launch response missing sandbox ID; do not retry launch, inspect staging")
    # ID only, useful for recovery if the process is killed during cleanup.
    print(json.dumps({"disposableSandboxId": sandbox_id}).replace(token, "[REDACTED]"), file=sys.stderr, flush=True)
    sample("sandbox/detail", {"id": sandbox_id})
    sample("logs/read", {"id": sandbox_id, "limit": 100})
    cli(["detail", sandbox_id, "--org", org, "--json"])
    prompt_start = time.monotonic()
    phase("prompt_admission", "sandbox/send", {
        "id": sandbox_id,
        "prompt": "Performance probe: reply with exactly PERF_OK. Do not run tools, change files, or access the network.",
    })
    cursor = None
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        body = {"id": sandbox_id, "limit": 100}
        if cursor:
            body["cursor"] = cursor
        page, _, _, _, _ = api("logs/read", body)
        if any(e.get("kind") == "message" and e.get("text") for e in page.get("events", [])):
            report["phases"].append({"phase": "prompt_to_first_text_observed",
                                     "ms": (time.monotonic() - prompt_start) * 1000,
                                     "pollIntervalMs": 500})
            break
        cursor = page.get("cursor") or cursor
        time.sleep(.5)
    else:
        raise Failure("First output not observed within 180 seconds")
except Failure as error:
    report["error"] = str(error)
    exit_code = 1
except BaseException:
    report["error"] = "Unexpected failure (details suppressed)"
    exit_code = 1
finally:
    if sandbox_id:
        # Cleanup only the ID returned by this run. Never select other users' resources.
        # Stop may still be checkpointing; bounded repeated stop/delete converge safely.
        cleaned = False
        for attempt in range(3):
            try:
                phase("cleanup_stop", "sandbox/stop", {"id": sandbox_id})
                _, elapsed, size, _, server = api(
                    "sandboxes/" + urllib.parse.quote(sandbox_id, safe="") +
                    "?org=" + urllib.parse.quote(org, safe=""), method="DELETE", timeout=600)
                report["phases"].append({"phase": "cleanup_delete", "ms": elapsed, "bytes": size, "serverMs": server})
                cleaned = True
                break
            except BaseException:
                time.sleep(2)
        report["cleanup"] = {"deleted": cleaned, "sandboxId": sandbox_id}
        if not cleaned:
            report["cleanup"]["action"] = "Manually stop/delete this exact sandbox; do not rerun launch"
            exit_code = 1
    else:
        report["cleanup"] = {"allocatedIdReceived": False,
                             "note": "If launch transport failed, inspect staging for an unacknowledged allocation; do not retry launch."}
    # Defense in depth: never emit an environment token, even if it equals a returned ID.
    print(json.dumps(report, indent=2).replace(token, "[REDACTED]"))
sys.exit(exit_code)
