import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Execute the real coordinator helper offline: its new mode must prove the normal
// route, not accidentally succeed via the already accepted private preview.
test.each([
  "launch",
  "resume",
  "cost",
  "bad-cost",
  "claude",
  "opencode",
  "repository",
  "repository-no-proof",
  "github",
  "github-no-proof",
  "github-no-broker",
  "variable",
  "variable-no-proof",
  "variable-whitespace",
])("normal Docker smoke uses normal routes (%s)", (mode) => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      `
import contextlib, io, json, os, runpy, sys, types
from unittest.mock import patch
calls, ssh = [], []
sandbox, prompt, conversation = None, "native-prompt", "native-conversation"
marker, answer, sends, stops = None, "DOCKER_OK", 0, 0
mode = sys.argv[1]
lifecycle = mode not in ("launch", "repository", "repository-no-proof")
prices = []
class Opener:
    def open(self, request, timeout):
        global sandbox, prompt, marker, answer, sends, stops
        path = request.full_url.split("/api/v1/", 1)[1]
        body = json.loads(request.data)
        calls.append((path, body))
        assert request.headers["Authorization"] == "Bearer offline-only"
        assert body["org"] == "org"
        if path == "launch/options":
            value = {"providers": [{"id": "docker", "harnesses": ["codex", "claude", "opencode"], "capabilities": {"launch": True}}]}
        elif path == "sandbox/launch":
            sandbox = body["requestId"]
            assert timeout == 600
            assert body["hostId"] == "retained-host"
            assert body["provider"] == "docker" and body["harness"] == (mode if mode in ("claude", "opencode") else "codex")
            assert body["visibility"] == "private" and "DOCKER_OK" in body["prompt"]
            assert "credentialVersion" not in body
            if mode.startswith("variable"):
                assert body["variables"] == [{"key": "APP_REGION", "variableId": "11111111-1111-4111-8111-111111111111", "version": 1}]
                assert "printenv APP_REGION" in body["prompt"] and "offline-region" not in body["prompt"]
            if mode.startswith(("repository", "github")):
                assert body["repos"] == [{"url": "https://github.com/example/project.git", "branch": "feature/work", "dir": "project"}]
                assert "git -C /home/user/project log -1" in body["prompt"]
            marker = body["prompt"].split("marker for my next message: ")[1].split(".")[0] if lifecycle else None
            value = {"sandbox": {"id": sandbox, "provider": "docker"}, "promptId": prompt, "conversationId": conversation}
        elif path == "sandbox/send":
            assert lifecycle and body["conversation_id"] == conversation
            assert marker not in body["prompt"]
            sends += 1
            prompt, answer = "prompt-" + str(sends), marker
            value = {"promptId": prompt, "conversationId": conversation}
        elif path == "github/refresh":
            assert mode.startswith("github")
            value = {"status": "connected", "revision": "2"}
        elif path == "github/runtime-status":
            value = {"configured": True, "credentialRequests": 0 if mode == "github-no-broker" else 1}
        elif path == "sandbox/resume":
            assert lifecycle and stops == 1
            value = {"status": "ready"}
        elif path == "sandbox/list":
            value = {"sandboxes": [{"id": sandbox, "provider": "docker"}]}
        elif path == "logs/read":
            value = {"source": "armada-runtime", "cursor": "next", "hasMore": False, "events": [
                {"kind": "message", "promptId": prompt, "text": answer, "tools":
                 [{"name": "commandExecution", "input": {"command": "git -C /home/user/project log -1 --format=%H"},
                   "result": {"isError": False, "output": "a" * 40}}] if mode == "repository" else
                 [{"name": "commandExecution", "input": {"command": "git -C /home/user/project log -1 --format=%H"},
                   "result": {"isError": False, "output": "a" * 40}}] +
                 ([{"name": "commandExecution", "input": {"command": "gh api repos/example/project --jq .full_name"},
                   "result": {"isError": False, "output": "example/project"}}] if mode != "github-no-proof" else []) if mode.startswith("github") else
                 [{"name": "commandExecution", "input": {"command": "printenv APP_REGION"}, "result": {"isError": False, "output": "offline-region\\n"}}] if mode in ("variable", "variable-whitespace") else []},
                {"kind": "prompt", "promptId": prompt, "status": "finished"}]}
        elif path == "sandbox/detail":
            if not any(t["promptId"] == prompt for t in prices):
                prices.append({"promptId": prompt, "model": "test-model", "inputTokens": 10,
                               "outputTokens": 2, "pricing": {"usd": "0.01", "unknown": None}})
            value = {"provider": "docker", "golden": None, "hostId": "retained-host", "conversationIds": [conversation], "usage": {"turns": prices, "turnCount": len(prices),
                "cost": {"currency": "USD", "usd": "9" if mode == "bad-cost" else str(len(prices) / 100),
                         "unknown": None, "unpricedTurns": 0}}}
        elif path in ("sandbox/stop", "sandbox/delete"):
            assert body["id"] == sandbox
            stops += path.endswith("stop")
            value = {"status": "stopped" if path.endswith("stop") else "deleted"}
        else:
            raise AssertionError("Private or unexpected route: " + path)
        return contextlib.closing(io.BytesIO(json.dumps(value).encode()))
def command(argv, **kwargs):
    ssh.append((argv, kwargs))
    assert "ARMADA_TOKEN" not in kwargs["env"]
    return types.SimpleNamespace(returncode=0)
argv = ["scripts/smoke-docker-lifecycle.py", "--server", "https://staging.example", "--org", "org",
        "--credential", "account", "--ssh", "host-alias", "--image", "image@sha256:digest",
        "--host-id", "retained-host", "--start-host", "--normal-launch"]
if mode.startswith(("repository", "github")):
    argv += ["--repository", "example/project", "--branch", "feature/work"]
if mode.startswith("github"):
    argv.append("--github")
if mode.startswith("variable"):
    argv += ["--variable", "APP_REGION:11111111-1111-4111-8111-111111111111:1"]
if lifecycle:
    argv.append("--normal-lifecycle")
if mode in ("cost", "bad-cost"):
    argv.append("--cost")
if mode in ("claude", "opencode"):
    argv.append("--" + mode)
output = io.StringIO()
with patch.dict(os.environ, {"ARMADA_TOKEN": "offline-only", "ARMADA_DOCKER_VARIABLE_EXPECTED": " offline-region\\n" if mode == "variable-whitespace" else "offline-region"}), patch.object(sys, "argv", argv), \\
     patch("urllib.request.build_opener", return_value=Opener()), patch("subprocess.run", side_effect=command), \\
     patch("time.sleep", side_effect=AssertionError("No wall-clock waits")), contextlib.redirect_stdout(output):
    try:
        runpy.run_path(argv[0], run_name="__main__")
    except SystemExit as error:
        assert mode in ("bad-cost", "repository-no-proof", "github-no-proof", "github-no-broker", "variable-no-proof", "variable-whitespace") and error.code == 1
        assert stops == 1
        sys.exit(0)
    assert mode not in ("bad-cost", "repository-no-proof", "github-no-proof", "github-no-broker", "variable-no-proof", "variable-whitespace"), "Missing proof was accepted"
assert len(ssh) == 1 and " run --state-dir " in ssh[0][0][-1]
assert "nohup setsid" in ssh[0][0][-1] and "daemon.lock" in ssh[0][0][-1]
assert (not lifecycle or (sends == 2 and stops == 2))
assert lifecycle or [path for path, _ in calls] == ["launch/options", "sandbox/launch", "sandbox/list", "logs/read", "sandbox/detail", "sandbox/stop", "sandbox/delete"]
assert "PASS: normal Docker launch route created" in output.getvalue()
assert "offline-only" not in output.getvalue()
`,
      mode,
    ],
    { cwd: import.meta.dir + "/..", encoding: "utf8" },
  );
  expect(result.stderr).toBe(
    mode === "bad-cost"
      ? "Docker cost proof failed: expected stable priced turns and exact session total\n"
      : mode === "repository-no-proof"
        ? "Repository proof missing: successful git log -1 command result required\n"
        : mode === "github-no-proof"
          ? "GitHub proof missing: successful gh API command result required\n"
          : mode === "github-no-broker"
            ? "GitHub proof requires current-epoch broker credential delivery\n"
            : mode === "variable-no-proof" || mode === "variable-whitespace"
              ? "Variable proof missing: successful printenv result required\n"
              : "",
  );
  expect(result.status).toBe(0);
});
