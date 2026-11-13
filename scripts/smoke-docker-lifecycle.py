#!/usr/bin/env python3
"""Coordinator-only staging smoke. No secrets in argv, files or output."""
import argparse
import json
import os
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", required=True)
    parser.add_argument("--org", required=True)
    parser.add_argument("--credential", required=True)
    parser.add_argument("--credential-version", type=int, default=1)
    parser.add_argument("--ssh", required=True, help="Existing SSH config name or user@host")
    parser.add_argument("--image", required=True, help="Pulled Linux x64 glibc image@sha256 digest")
    parser.add_argument("--model")
    parser.add_argument("--host-id", help="Reuse an existing host registration")
    parser.add_argument("--start-host", action="store_true", help="Start that stopped host daemon; never remove its lock")
    parser.add_argument("--follow-up", action="store_true", help="Prove a second prompt recalls the same conversation")
    parser.add_argument("--timeout", type=int, default=600, help="Seconds per bounded stage")
    args = parser.parse_args()
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

    def api(path, body):
        request = urllib.request.Request(server + "/api/v1/docker/" + path,
            data=json.dumps({"org": args.org, **body}).encode(), method="POST",
            headers={"authorization": "Bearer " + token, "content-type": "application/json"})
        try:
            with opener.open(request, timeout=30) as response:
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
              "credentialId": args.credential, "credentialVersion": args.credential_version}
    if args.model:
        launch["model"] = args.model
    cleanup_needed = True
    try:
        api("sandboxes/launch", launch)
        wait_for("job", {"sandboxId": sandbox_id, "requestId": sandbox_id}, "completed")
        bootstrap_id = str(uuid.uuid4())
        print("BOOTSTRAP_ID=" + bootstrap_id, flush=True)
        api("sandboxes/bootstrap", {"sandboxId": sandbox_id, "requestId": bootstrap_id})
        wait_for("ready", {"sandboxId": sandbox_id, "requestId": str(uuid.uuid4())}, "ready")
        cursor = "0"

        def turn(text, expected_answer, conversation=None):
            nonlocal cursor
            prompt_id = str(uuid.uuid4())
            print("PROMPT_REQUEST_ID=" + prompt_id, flush=True)
            body = {"sandboxId": sandbox_id, "requestId": prompt_id, "text": text}
            if conversation is not None:
                body["conversationId"] = conversation
            admission = wait_for("prompt", body, "admitted")
            receipt = admission["receipt"]
            if conversation is not None and receipt["conversationId"] != conversation:
                raise RuntimeError("Follow-up changed conversation identity")
            native_prompt = receipt["promptId"]
            deadline = time.monotonic() + args.timeout
            answer, finished = False, False
            while True:
                page = api("sandboxes/journal", {"sandboxId": sandbox_id, "cursor": cursor})
                cursor = page["cursor"]
                for item in page["events"]:
                    event = item["event"]
                    if event.get("promptId") != native_prompt:
                        continue
                    if event.get("kind") == "message" and expected_answer in event.get("text", ""):
                        answer = True
                    if event.get("kind") == "prompt":
                        if event.get("status") in ("failed", "interrupted"):
                            raise RuntimeError("Codex turn failed/interrupted; inspect retained journal")
                        finished |= event.get("status") == "finished"
                turns = (page.get("usage") or {}).get("turns", [])
                usage = next((t for t in turns if t.get("promptId") == native_prompt
                              and isinstance(t.get("inputTokens"), int)
                              and isinstance(t.get("outputTokens"), int)), None)
                if answer and finished and usage:
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
        marker = "DOCKER_MEMORY_" + uuid.uuid4().hex
        first = (f"Remember this marker for my next message: {marker}. " if args.follow_up else "")
        conversation = turn(first + "Reply with exactly DOCKER_OK. Do not run tools or modify files.", "DOCKER_OK")
        if args.follow_up:
            turn("Reply with exactly the marker I gave you in my previous message. Do not run tools or modify files.",
                 marker, conversation)
    finally:
        if cleanup_needed:
            # Never delete an unconfirmed running allocation. Offline cleanup remains honest/pending.
            try:
                for operation in ("stop", "delete"):
                    request_id = str(uuid.uuid4())
                    print(operation.upper() + "_ID=" + request_id, flush=True)
                    api("sandboxes/" + operation, {"sandboxId": sandbox_id, "requestId": request_id})
                    wait_for("job", {"sandboxId": sandbox_id, "requestId": request_id}, "completed")
            except RuntimeError:
                print("Cleanup unconfirmed; retain IDs, reconnect host and reconcile stop/delete.", file=sys.stderr)
                raise
    print("PASS: same-conversation follow-up recalled marker; both turns reported tokens; stop/delete ACKed."
          if args.follow_up else "PASS: one runtime-journal answer with reported tokens; stop/delete ACKed.")
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
