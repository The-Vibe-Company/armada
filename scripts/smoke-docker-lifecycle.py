#!/usr/bin/env python3
"""Coordinator-only staging smoke. No secrets in argv, files or output."""
import argparse
from decimal import Decimal, InvalidOperation, getcontext
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid



def successful_mcp_tool(tools, matching_calls, harness, connection, name):
    """Correlate native tool identities and successful completions, including split Claude frames."""
    server = "armada_" + connection.replace("-", "_")
    qualified = "mcp__" + server + "__" + name if harness == "claude" else server + "_" + re.sub(r"[^a-zA-Z0-9_-]", "_", name)
    success = False
    for tool in tools:
        call_id = tool.get("id")
        if not isinstance(call_id, str) or not call_id:
            continue
        identified = (tool.get("name") == name and tool.get("server") == server) if harness == "codex" else tool.get("name") == qualified
        if identified:
            matching_calls.add(call_id)
        if (call_id in matching_calls and isinstance(tool.get("result"), dict)
                and tool["result"].get("isError") is False):
            success = True
    return success


def main():
    getcontext().prec = 80  # Exact addition of fixed-scale server USD amounts.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", required=True)
    parser.add_argument("--org", required=True)
    parser.add_argument("--credential", required=True)
    parser.add_argument("--credential-version", type=int)
    parser.add_argument("--ssh", required=True, help="Existing SSH config name or user@host")
    parser.add_argument("--image", required=True, help="Pulled Linux x64 glibc image@sha256 digest")
    parser.add_argument("--mcp", help="MCP connection UUID to deliver through the scoped runtime gateway")
    parser.add_argument("--mcp-tool", help="Safe read-only tool name on --mcp; its successful native tool result is required")
    parser.add_argument("--skills", action="append", default=[], help="Exact Skillpack pin to install and verify (repeatable)")
    parser.add_argument("--skill-defaults", action="store_true", help="Require at least one receipt from existing personal/org defaults; does not modify defaults")
    parser.add_argument("--model")
    parser.add_argument("--host-id", help="Reuse an existing host registration")
    parser.add_argument("--start-host", action="store_true", help="Start that stopped host daemon; never remove its lock")
    parser.add_argument("--follow-up", action="store_true", help="Prove a second prompt recalls the same conversation")
    parser.add_argument("--normal-controls", action="store_true", help="Read status/logs and stop/delete through normal sandbox API")
    parser.add_argument("--normal-launch", action="store_true", help="Launch and run the first prompt through the normal API; implies --normal-controls")
    parser.add_argument("--normal-lifecycle", action="store_true", help="Prove normal follow-up and same-host stop/resume with retained history; implies --normal-launch")
    parser.add_argument("--cost", action="store_true", help="Prove exact per-turn and total USD before/after resume; implies --normal-lifecycle")
    harnesses = parser.add_mutually_exclusive_group()
    harnesses.add_argument("--claude", action="store_true", help="Prove Claude launch/follow-up/stop/resume via normal routes")
    harnesses.add_argument("--opencode", action="store_true", help="Prove OpenCode with the supplied custom OpenAI-compatible connection via normal routes")
    parser.add_argument("--timeout", type=int, default=600, help="Seconds per bounded stage")
    args = parser.parse_args()
    if args.mcp or args.skills or args.skill_defaults:
        args.normal_launch = True
    if bool(args.mcp) != bool(args.mcp_tool):
        parser.error("--mcp and --mcp-tool must be supplied together")
    if args.mcp:
        try:
            args.mcp = str(uuid.UUID(args.mcp))
        except ValueError:
            parser.error("--mcp requires a connection UUID")
    harness = "claude" if args.claude else "opencode" if args.opencode else "codex"
    if args.cost or args.claude or args.opencode:
        args.normal_lifecycle = True
    if args.normal_lifecycle:
        args.normal_launch = True
        args.follow_up = True
    if args.normal_launch:
        args.normal_controls = True
    if args.start_host and not args.host_id:
        parser.error("--start-host requires --host-id")
    origin = urllib.parse.urlsplit(args.server)
    if (origin.scheme != "https" or not origin.netloc or origin.username or origin.password
            or origin.path not in ("", "/") or origin.query or origin.fragment
            or args.ssh.startswith("-") or not 1 <= args.timeout <= 1800):
        parser.error("HTTPS origin, SSH target and bounded timeout required")
    token = os.environ.get("ARMADA_TOKEN", "")
    if not token or any(c.isspace() for c in token):
        parser.error("Set ARMADA_TOKEN privately in the environment (org admin)")
    server = urllib.parse.urlunsplit((origin.scheme, origin.netloc, "", "", ""))

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    opener = urllib.request.build_opener(NoRedirect)

    def api(path, body, normal=False):
        request = urllib.request.Request(server + ("/api/v1/" if normal else "/api/v1/docker/") + path,
            data=json.dumps({"org": args.org, **body}).encode(), method="POST",
            headers={"authorization": "Bearer " + token, "content-type": "application/json"})
        try:
            with opener.open(request, timeout=600 if normal and path == "sandbox/launch" else 120 if normal and path in ("sandbox/stop", "sandbox/delete", "sandbox/resume") else 30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            # Do not print response bodies, request headers or private capabilities.
            raise RuntimeError(f"{path}: HTTP {error.code}; retain printed IDs for reconciliation") from None
        except (OSError, ValueError):
            raise RuntimeError(f"{path}: response unknown; retain printed IDs for reconciliation") from None

    def wait_for(operation, body, expected):
        deadline = time.monotonic() + args.timeout
        while True:
            value = api("sandboxes/" + operation, body)
            if value and value.get("state") == expected:
                return value
            if value and value.get("state") == "failed":
                raise RuntimeError(f"{operation}: host job failed")
            if time.monotonic() >= deadline:
                raise RuntimeError(f"{operation}: timeout; outcome still unknown")
            time.sleep(2)

    def ssh(command, private_input=None):
        # Do not forward the user's API bearer via an SSH SendEnv configuration.
        env = {k: v for k, v in os.environ.items() if k != "ARMADA_TOKEN"}
        result = subprocess.run(["ssh", "--", args.ssh, command], input=private_input,
                                env=env, check=False, timeout=60)
        if result.returncode:
            raise RuntimeError("SSH host setup failed; inspect private host state")

    host_id = args.host_id
    if not host_id:
        registration = api("hosts/register-token", {})
        host_id = registration["hostId"]
        print("HOST_ID=" + host_id, flush=True)
        ssh('"$HOME/.local/bin/armada-docker-host" register --server ' + shlex.quote(server)
            + ' --state-dir "$HOME/.local/state/armada-docker-smoke"',
            (registration["registrationToken"] + "\n").encode())
        del registration
    else:
        print("HOST_ID=" + host_id, flush=True)
    if not args.host_id or args.start_host:
        # A live or stale lock requires operator inspection, never automatic deletion.
        ssh('set -eu; umask 077; state="$HOME/.local/state/armada-docker-smoke"; '
            'test -f "$state/state.json"; test ! -e "$state/daemon.lock"; test ! -L "$state/daemon.lock"; '
            'nohup setsid "$HOME/.local/bin/armada-docker-host" run --state-dir "$state" '
            '>"$state/daemon.log" 2>&1 </dev/null & echo $! >"$state/smoke.pid"')
    sandbox_id = str(uuid.uuid4())  # Persist this printed identity across unknown HTTP outcomes.
    print("SANDBOX_ID=" + sandbox_id, flush=True)
    launch = {"requestId": sandbox_id, "hostId": host_id, "image": args.image,
              "credentialId": args.credential}
    if args.credential_version is not None or not args.normal_launch:
        launch["credentialVersion"] = args.credential_version if args.credential_version is not None else 1
    if args.model:
        launch["model"] = args.model
    if args.mcp:
        launch["connections"] = [args.mcp]
    if args.skills:
        launch["skills"] = args.skills
    marker = "DOCKER_MEMORY_" + uuid.uuid4().hex
    first = (f"Remember this marker for my next message: {marker}. " if args.follow_up else "")
    cleanup_needed = True
    try:
        launch_receipt = None
        if args.normal_launch:
            options = api("launch/options", {}, normal=True)
            docker = next((p for p in options.get("providers", []) if p.get("id") == "docker"), {})
            if docker.get("capabilities", {}).get("launch") is not True:
                raise RuntimeError("Normal Docker launch is not enabled; check server opt-ins and installed runtime manifest")
            if harness not in docker.get("harnesses", []):
                raise RuntimeError("Requested Docker harness is not advertised by launch/options")
            launch.update({"provider": "docker", "harness": harness, "visibility": "private",
                           "prompt": first + "Reply with exactly DOCKER_OK. Do not run tools or modify files."})
            launched = api("sandbox/launch", launch, normal=True)
            if (launched.get("sandbox", {}).get("id") != sandbox_id
                    or launched.get("sandbox", {}).get("provider") != "docker"
                    or not launched.get("promptId") or not launched.get("conversationId")):
                raise RuntimeError("Normal launch outcome unknown; retain sandbox/request ID")
            launch_receipt = {"promptId": launched["promptId"], "conversationId": launched["conversationId"]}
            if args.skills or args.skill_defaults:
                receipts = launched.get("sandbox", {}).get("skills", [])
                if (not receipts or not set(args.skills).issubset({r.get("reference") for r in receipts})
                        or any(not isinstance(r.get("checksum"), str) or not r["checksum"].startswith("sha256:")
                               or len(r["checksum"]) != 71 or r.get("origin") != "https://skillpack.app/v1" for r in receipts)):
                    raise RuntimeError("Verified Skillpack receipts were not returned before the first prompt")
                print("PASS: explicit/default skills returned verified receipts before first prompt.")
            listed = api("sandbox/list", {"owner": "me", "limit": 100}, normal=True)
            if not any(row.get("id") == sandbox_id and row.get("provider") == "docker"
                       for row in listed.get("sandboxes", [])):
                raise RuntimeError("Normal launch did not appear in the normal sandbox list")
        else:
            api("sandboxes/launch", launch)
            wait_for("job", {"sandboxId": sandbox_id, "requestId": sandbox_id}, "completed")
            bootstrap_id = str(uuid.uuid4())
            print("BOOTSTRAP_ID=" + bootstrap_id, flush=True)
            api("sandboxes/bootstrap", {"sandboxId": sandbox_id, "requestId": bootstrap_id})
            wait_for("ready", {"sandboxId": sandbox_id, "requestId": str(uuid.uuid4())}, "ready")
        cursor = None if args.normal_controls else "0"

        priced_turns = {}

        def check_cost(usage, prompt_id):
            try:
                turns = usage["turns"]
                cost = usage["cost"]
                total = Decimal(cost["usd"])
                if (cost["currency"] != "USD" or cost["unknown"] is not None
                        or cost["unpricedTurns"] != 0 or not total.is_finite() or total < 0
                        or usage["turnCount"] != len({t["promptId"] for t in turns})):
                    raise ValueError()
                current = {}
                summed = Decimal(0)
                for t in turns:
                    price = t["pricing"]
                    amount = Decimal(price["usd"])
                    if price["unknown"] is not None or not amount.is_finite() or amount < 0:
                        raise ValueError()
                    identity = (t["promptId"], t["model"])
                    if identity in current:
                        raise ValueError()
                    current[identity] = price
                    summed += amount
                if summed != total or not any(k[0] == prompt_id for k in current):
                    raise ValueError()
                if any(current.get(k) != v for k, v in priced_turns.items()):
                    raise ValueError()
                priced_turns.update(current)
            except (KeyError, TypeError, ValueError, InvalidOperation):
                raise RuntimeError("Docker cost proof failed: expected stable priced turns and exact session total") from None

        def turn(text, expected_answer, conversation=None, receipt=None, require_mcp=False):
            nonlocal cursor
            if receipt is None:
                prompt_id = str(uuid.uuid4())
                print("PROMPT_REQUEST_ID=" + prompt_id, flush=True)
                body = {"sandboxId": sandbox_id, "requestId": prompt_id, "text": text}
                if conversation is not None:
                    body["conversationId"] = conversation
                if args.normal_controls:
                    receipt = api("sandbox/send", {"id": sandbox_id, "request_id": prompt_id,
                                  "prompt": text, **({"conversation_id": conversation} if conversation else {})}, normal=True)
                else:
                    admission = wait_for("prompt", body, "admitted")
                    receipt = admission["receipt"]
            if conversation is not None and receipt["conversationId"] != conversation:
                raise RuntimeError("Follow-up changed conversation identity")
            native_prompt = receipt["promptId"]
            deadline = time.monotonic() + args.timeout
            answer, finished, used_mcp = False, False, False
            matching_mcp_calls = set()
            while True:
                if args.normal_controls:
                    page = api("logs/read", {"id": sandbox_id, **({"cursor": cursor} if cursor else {})}, normal=True)
                    summary = api("sandbox/detail", {"id": sandbox_id}, normal=True)
                    if summary.get("provider") != "docker" or summary.get("golden") is not None:
                        raise RuntimeError("Normal Docker status did not match its contract")
                    page["usage"] = summary.get("usage")
                else:
                    page = api("sandboxes/journal", {"sandboxId": sandbox_id, "cursor": cursor})
                cursor = page["cursor"]
                for item in page["events"]:
                    event = item if args.normal_controls else item["event"]
                    if require_mcp and event.get("promptId") == native_prompt:
                        used_mcp = successful_mcp_tool(event.get("tools", []), matching_mcp_calls,
                                                       harness, args.mcp, args.mcp_tool) or used_mcp
                    if event.get("promptId") != native_prompt:
                        continue
                    if event.get("kind") == "message" and expected_answer in event.get("text", ""):
                        answer = True
                    if event.get("kind") == "prompt":
                        if event.get("status") in ("failed", "interrupted"):
                            raise RuntimeError("Agent turn failed/interrupted; inspect retained journal")
                        finished |= event.get("status") == "finished"
                turns = (page.get("usage") or {}).get("turns", [])
                usage = next((t for t in turns if t.get("promptId") == native_prompt
                              and isinstance(t.get("inputTokens"), int)
                              and isinstance(t.get("outputTokens"), int)), None)
                if answer and finished and usage and (not require_mcp or used_mcp):
                    if args.cost:
                        check_cost(page["usage"], native_prompt)
                    print(json.dumps({"answer": expected_answer, "promptId": native_prompt,
                                      "conversationId": receipt["conversationId"],
                                      "inputTokens": usage["inputTokens"], "outputTokens": usage["outputTokens"]}),
                          flush=True)
                    return receipt["conversationId"]
                if time.monotonic() >= deadline:
                    raise RuntimeError("Journal answer/finished/reported-token proof incomplete; inspect retained journal")
                if not page["hasMore"]:
                    time.sleep(2)

        # Only the first prompt contains the public random marker. Recall proves thread continuity.
        conversation = turn(first + "Reply with exactly DOCKER_OK. Do not run tools or modify files.", "DOCKER_OK", receipt=launch_receipt)
        if args.mcp:
            turn("Call the selected MCP tool " + args.mcp_tool + " once using safe read-only arguments, then reply exactly DOCKER_MCP_OK.",
                 "DOCKER_MCP_OK", conversation, require_mcp=True)
            print("PASS: selected MCP gateway tool delivered a successful native tool result.")
        if args.follow_up:
            turn("Reply with exactly the marker I gave you in my previous message. Do not run tools or modify files.",
                 marker, conversation)
        if args.normal_lifecycle:
            stopped = api("sandbox/stop", {"id": sandbox_id, "request_id": str(uuid.uuid4())}, normal=True)
            if stopped.get("status") != "stopped":
                raise RuntimeError("Normal stop was not confirmed")
            resumed = api("sandbox/resume", {"id": sandbox_id, "request_id": str(uuid.uuid4())}, normal=True)
            if resumed.get("status") != "ready":
                raise RuntimeError("Normal resume readiness was not confirmed")
            summary = api("sandbox/detail", {"id": sandbox_id}, normal=True)
            if summary.get("hostId") != host_id or conversation not in summary.get("conversationIds", []):
                raise RuntimeError("Resume changed host or conversation identity")
            turn("Reply with exactly the marker I asked you to remember. Do not run tools or modify files.", marker, conversation)
    finally:
        if cleanup_needed:
            # Never delete an unconfirmed running allocation. Offline cleanup remains honest/pending.
            try:
                for operation in ("stop", "delete"):
                    request_id = str(uuid.uuid4())
                    print(operation.upper() + "_ID=" + request_id, flush=True)
                    if args.normal_controls:
                        reply = api("sandbox/" + operation, {"id": sandbox_id, "request_id": request_id}, normal=True)
                        expected = ("stopped", "failed", "deleted") if operation == "stop" else ("deleted",)
                        if reply.get("status") not in expected:
                            raise RuntimeError("Normal Docker cleanup ACK was not confirmed")
                    else:
                        api("sandboxes/" + operation, {"sandboxId": sandbox_id, "requestId": request_id})
                        wait_for("job", {"sandboxId": sandbox_id, "requestId": request_id}, "completed")
            except RuntimeError:
                print("Cleanup unconfirmed; retain IDs, reconnect host and reconcile stop/delete.", file=sys.stderr)
                raise
    print("PASS: same-conversation follow-up recalled marker; both turns reported tokens; stop/delete ACKed."
          if args.follow_up else "PASS: one runtime-journal answer with reported tokens; stop/delete ACKed.")
    if args.normal_controls:
        print("PASS: normal Docker status/logs and stop/delete routes confirmed.")
    if args.normal_launch:
        print("PASS: normal Docker launch route created, bootstrapped and admitted one prompt; list/status/logs/answer/stop/delete confirmed.")
    if args.cost:
        print("PASS: exact per-turn/session USD and immutable prior quotes survived follow-up and resume.")
    if args.claude or args.opencode:
        print("PASS: " + harness + " normal launch/follow-up/stop/resume confirmed.")
    print("Host remains registered/running for inspection. See docs/docker-host-daemon.md for uninstall.")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        # Only our fixed diagnostics with public operation names/status codes.
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except (subprocess.TimeoutExpired, ValueError, KeyError, TypeError):
        print("Docker smoke failed: malformed response or SSH timeout; retain printed IDs.", file=sys.stderr)
        sys.exit(1)
