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
    def test_pending_launch_replays_the_same_request_until_its_original_receipt(self):
        from unittest.mock import patch
        request = {"requestId": "sandbox", "prompt": "original prompt"}
        pending = {"sandbox": {"id": "sandbox", "provider": "docker", "status": "starting"}, "runtime": None}
        complete = {"sandbox": {"id": "sandbox", "provider": "docker", "status": "running"},
                    "runtime": {"kind": "armada", "epoch": "1"},
                    "promptId": "original-prompt", "conversationId": "original-conversation"}
        calls, replies = [], iter([pending, complete])
        def api(path, body, normal=False):
            calls.append((path, body, normal))
            return next(replies)
        with patch.object(module.time, "monotonic", return_value=0), patch.object(module.time, "sleep") as sleep:
            self.assertEqual(module.normal_launch_receipt(api, request, 10), complete)
        self.assertEqual(calls, [("sandbox/launch", request, True)] * 2)
        self.assertTrue(all(body is request for _, body, _ in calls))
        sleep.assert_called_once_with(2)

    def test_failed_preparation_reports_the_plain_reason_without_another_launch(self):
        from unittest.mock import Mock
        api = Mock(return_value={"sandbox": {"id": "sandbox", "provider": "docker", "status": "failed",
                                             "statusReason": "Repository checkout failed or timed out."}})
        with self.assertRaisesRegex(RuntimeError, "Repository checkout failed or timed out"):
            module.normal_launch_receipt(api, {"requestId": "sandbox"}, 10)
        api.assert_called_once()

    def test_pending_preparation_has_a_bounded_deadline(self):
        from unittest.mock import Mock, patch
        api = Mock(return_value={"sandbox": {"id": "sandbox", "provider": "docker", "status": "starting"},
                                "runtime": None})
        with patch.object(module.time, "monotonic", side_effect=[0, 10]), patch.object(module.time, "sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, "preparation timed out; retain sandbox/request ID"):
                module.normal_launch_receipt(api, {"requestId": "sandbox"}, 10)
        api.assert_called_once()
        sleep.assert_not_called()


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
        def api(path, body, normal=False):
            self.assertTrue(normal)
            calls.append((path, body))
            if path == "templates/create":
                return {"item": {"id": "template"}, "revision": {"revision": 1}}
            if path == "templates/launch":
                return {"state": "succeeded", "id": "actual-child", "promptId": "initial"}
            if path == "sandbox/detail":
                return {"provider": "docker", "hostId": "host", "prompt": {"promptId": "initial"}}
            if path == "logs/read":
                return {"events": [{"kind": "prompt", "promptId": "initial", "status": "failed"}]}
            if path in ("sandbox/stop", "sandbox/delete"):
                self.assertEqual(body["id"], "actual-child")
                return {"status": "stopped" if path.endswith("stop") else "deleted"}
            if path == "templates/delete":
                self.assertEqual(body, {"id": "template", "expectedRevision": 1})
                return {}
            self.fail("Unexpected mutation: " + path)
        with self.assertRaisesRegex(RuntimeError, "Placement native prompt failed"):
            module.placement_smoke(api, args, "host", "codex")
        self.assertEqual([path for path, _ in calls][-3:],
                         ["sandbox/stop", "sandbox/delete", "templates/delete"])
        self.assertEqual(sum(path == "templates/launch" for path, _ in calls), 1)


if __name__ == "__main__":
    unittest.main()
