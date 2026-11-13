import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Execute the real coordinator helper offline: its new mode must prove the normal
// route, not accidentally succeed via the already accepted private preview.
test("normal Docker smoke starts the retained host and uses only normal sandbox routes", () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      `
import contextlib, io, json, os, runpy, sys, types
from unittest.mock import patch
calls, ssh = [], []
sandbox, prompt, conversation = None, "native-prompt", "native-conversation"
class Opener:
    def open(self, request, timeout):
        global sandbox
        path = request.full_url.split("/api/v1/", 1)[1]
        body = json.loads(request.data)
        calls.append((path, body))
        assert request.headers["Authorization"] == "Bearer offline-only"
        assert body["org"] == "org"
        if path == "launch/options":
            value = {"providers": [{"id": "docker", "capabilities": {"launch": True}}]}
        elif path == "sandbox/launch":
            sandbox = body["requestId"]
            assert timeout == 600
            assert body["hostId"] == "retained-host"
            assert body["provider"] == "docker" and body["harness"] == "codex"
            assert body["visibility"] == "private" and "DOCKER_OK" in body["prompt"]
            assert "credentialVersion" not in body
            value = {"sandbox": {"id": sandbox, "provider": "docker"}, "promptId": prompt, "conversationId": conversation}
        elif path == "sandbox/list":
            value = {"sandboxes": [{"id": sandbox, "provider": "docker"}]}
        elif path == "logs/read":
            value = {"cursor": "next", "hasMore": False, "events": [
                {"kind": "message", "promptId": prompt, "text": "DOCKER_OK"},
                {"kind": "prompt", "promptId": prompt, "status": "finished"}]}
        elif path == "sandbox/detail":
            value = {"provider": "docker", "golden": None, "usage": {"turns": [
                {"promptId": prompt, "inputTokens": 10, "outputTokens": 2}]}}
        elif path in ("sandbox/stop", "sandbox/delete"):
            assert body["id"] == sandbox
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
output = io.StringIO()
with patch.dict(os.environ, {"ARMADA_TOKEN": "offline-only"}), patch.object(sys, "argv", argv), \\
     patch("urllib.request.build_opener", return_value=Opener()), patch("subprocess.run", side_effect=command), \\
     patch("time.sleep", side_effect=AssertionError("No wall-clock waits")), contextlib.redirect_stdout(output):
    runpy.run_path(argv[0], run_name="__main__")
assert len(ssh) == 1 and " run --state-dir " in ssh[0][0][-1]
assert "nohup setsid" in ssh[0][0][-1] and "daemon.lock" in ssh[0][0][-1]
assert [path for path, _ in calls] == ["launch/options", "sandbox/launch", "sandbox/list", "logs/read", "sandbox/detail", "sandbox/stop", "sandbox/delete"]
assert "PASS: normal Docker launch route created" in output.getvalue()
assert "offline-only" not in output.getvalue()
`,
    ],
    { cwd: import.meta.dir + "/..", encoding: "utf8" },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
