"""Native MCP receipt correlation used by the coordinator-only Docker smoke."""
import unittest
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("docker_smoke", Path(__file__).with_name("smoke-docker-lifecycle.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
successful_mcp_tool = module.successful_mcp_tool


class McpReceiptTest(unittest.TestCase):
    def test_each_harness_requires_its_selected_tool_and_matching_successful_completion(self):
        connection = "11111111-1111-4111-8111-111111111111"
        server = "armada_" + connection.replace("-", "_")
        for harness, invocation in (
            ("codex", {"id": "call", "name": "read-doc", "server": server}),
            ("claude", {"id": "call", "name": "mcp__" + server + "__read-doc"}),
            ("opencode", {"id": "call", "name": server + "_read-doc"}),
        ):
            with self.subTest(harness=harness):
                known = set()
                def check(items):
                    return successful_mcp_tool(items, known, harness, connection, "read-doc")
                self.assertFalse(check([{"id": "foreign", "name": "tool_result", "result": {"isError": False}}]))
                self.assertFalse(check([invocation]))
                self.assertFalse(check([{"id": "call", "name": "tool_result", "result": {"isError": True}}]))
                self.assertTrue(check([{"id": "call", "name": "tool_result", "result": {"isError": False}}]))
                self.assertTrue(check([{**invocation, "result": {"isError": False}}]))

    def test_bare_name_from_another_server_or_missing_identity_does_not_prove_mcp(self):
        for harness in ("codex", "claude", "opencode"):
            self.assertFalse(successful_mcp_tool([
                {"id": "wrong", "name": "read", "server": "different", "result": {"isError": False}},
                {"name": "read", "result": {"isError": False}},
            ], set(), harness, "connection", "read"))


class NormalLaunchReceiptTest(unittest.TestCase):
    def test_admission_is_followed_by_status_observation_without_relaunch(self):
        from unittest.mock import Mock, patch
        sandbox = "00000000-0000-4000-8000-000000000001"
        request = {"idempotencyKey": "original-launch-key", "externalRef": "original-launch-key", "prompt": "original prompt"}
        pending = {"id": sandbox, "status": "starting", "provider": "docker", "externalRef": request["externalRef"]}
        running = {**pending, "status": "running", "prompt": {"promptId": "prompt", "conversationId": "conversation"}}
        api = Mock(side_effect=[{"sandbox": {"id": sandbox, "status": "starting"}}, pending, running])
        admissions = []
        with patch.object(module.time, "monotonic", return_value=0), patch.object(module.time, "sleep"):
            self.assertEqual(module.normal_launch_receipt(api, request, 10, admissions.append), running)
        self.assertEqual([call.args[0] for call in api.call_args_list], ["sandbox/launch", "sandbox/status", "sandbox/status"])
        self.assertEqual(admissions, [sandbox])


class PlacementCleanupTest(unittest.TestCase):
    def test_unknown_template_launch_retains_context_and_prints_the_original_replay_key(self):
        from contextlib import redirect_stdout
        from io import StringIO
        from types import SimpleNamespace
        args = SimpleNamespace(timeout=1, image="worker@sha256:" + "a" * 64, credential="account",
                               credential_version=2, model=None, mcp=None, skills=[], routine=False)
        calls, launch_keys = [], []
        def api(path, body, normal=False):
            self.assertTrue(normal)
            calls.append(path)
            if path == "templates/create":
                return {"item": {"id": "retained-template"}, "revision": {"revision": 1}}
            if path == "templates/launch":
                launch_keys.append(body["requestKey"])
                raise RuntimeError("response unknown after server dispatch")
            if path == "templates/delete":
                return {}
            self.fail("Unexpected mutation: " + path)
        output = StringIO()
        with redirect_stdout(output), self.assertRaisesRegex(RuntimeError, "response unknown"):
            module.placement_smoke(api, args, "host", "codex")
        self.assertEqual(calls, ["templates/create", "templates/launch"])
        self.assertEqual(len(launch_keys), 1)
        self.assertIn("PLACEMENT_UNRESOLVED_TEMPLATE_ID=retained-template", output.getvalue())
        self.assertIn("PLACEMENT_UNRESOLVED_TEMPLATE_REQUEST_KEY=" + launch_keys[0], output.getvalue())

    def test_native_failure_cleans_the_actual_template_child_without_sending_a_replacement(self):
        from types import SimpleNamespace
        args = SimpleNamespace(timeout=1, image="worker@sha256:" + "a" * 64, credential="account",
                               credential_version=2, model=None, mcp=None, skills=[], routine=False)
        calls = []
        def api(path, body, normal=False, method="POST"):
            self.assertTrue(normal)
            calls.append((path, body))
            if path == "templates/create":
                return {"item": {"id": "template"}, "revision": {"revision": 1}}
            if path == "templates/launch":
                return {"state": "succeeded", "id": "actual-child", "promptId": "initial"}
            if path == "sandbox/status":
                return {"provider": "docker", "hostId": "host", "prompt": {"promptId": "initial"}}
            if path == "logs/read":
                return {"events": [{"kind": "prompt", "promptId": "initial", "status": "failed"}]}
            if path == "sandbox/stop":
                self.assertEqual(body["id"], "actual-child")
                return {"status": "stopped"}
            if path == "sandboxes/actual-child":
                self.assertEqual(method, "DELETE")
                self.assertIn("requestId", body)
                return {"status": "deleted"}
            if path == "templates/delete":
                self.assertEqual(body, {"id": "template", "expectedRevision": 1})
                return {}
            self.fail("Unexpected mutation: " + path)
        with self.assertRaisesRegex(RuntimeError, "Placement native prompt failed"):
            module.placement_smoke(api, args, "host", "codex")
        self.assertEqual([path for path, _ in calls][-3:],
                         ["sandbox/stop", "sandboxes/actual-child", "templates/delete"])
        self.assertEqual(sum(path == "templates/launch" for path, _ in calls), 1)


if __name__ == "__main__":
    unittest.main()
