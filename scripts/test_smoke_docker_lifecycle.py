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


if __name__ == "__main__":
    unittest.main()
