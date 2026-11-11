"""Offline owner-boundary safety contracts; no staging/network/compute is used."""
import contextlib
import importlib.util
import io
import json
import os
import signal
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("staging_check", Path(__file__).with_name("staging-check.py"))
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)
ID = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
ARGS = ["--provider", "boat", "--harness", "codex", "--golden", "fixture", "--golden-id", ID,
        "--account-id", OTHER, "--account-version", "1", "--model", "test-model", "--confirm-real-compute"]
ENV = {"STAGING_URL": "https://armada-staging.example.com", "STAGING_ORG": ID, "ARMADA_TOKEN": "owner-secret"}


class Safety(unittest.TestCase):
    def test_production_or_nonroot_origins_fail_before_network_and_never_echo_arguments(self):
        for address in ("https://armada.thevibecompany.co", "https://staging.example/a", "http://staging.example", "https://staging.example/?secret=hidden"):
            output = io.StringIO()
            with contextlib.redirect_stdout(output), mock.patch.object(check, "Run") as run:
                self.assertEqual(check.main(ARGS, dict(ENV, STAGING_URL=address)), 1)
            run.assert_not_called()
            self.assertNotIn(address, output.getvalue())
            self.assertNotIn("owner-secret", output.getvalue())
        with contextlib.redirect_stdout(io.StringIO()), mock.patch.object(check, "Run") as run:
            self.assertEqual(check.main(ARGS + ["--owner-secret-value"], ENV), 1)
            run.assert_not_called()

    def test_real_tool_results_are_distinct_from_assistant_pass_claims_and_wrong_turns(self):
        forged = {"id": "m", "kind": "message", "promptId": "p", "partial": False,
                  "text": 'PASS {"sandboxId":"' + ID + '"}', "tools": []}
        wrong = dict(forged, promptId="different", tools=[{"id": "t", "name": "mcp__armada_orchestrator__launch"}])
        self.assertEqual(check.scoped_tools([forged, wrong], "p"), [])
        call = {"id": "t", "name": "mcp__armada_orchestrator__launch", "input": {},
                "result": {"isError": False, "output": [{"type": "text", "text": json.dumps({"result": {"sandboxId": ID}})}]}}
        found = check.scoped_tools([dict(forged, tools=[call])], "p")
        self.assertEqual(check.decoded(found[0]["result"]["output"]), {"sandboxId": ID})
        # Real Modal Codex normalized shape: name=item.tool; server is not retained.
        native = dict(call, name="launch", result={"isError": False, "output": {"content": call["result"]["output"], "structuredContent": None, "_meta": None}})
        self.assertEqual(check.decoded(check.scoped_tools([dict(forged, tools=[native])], "p")[0]["result"]["output"]), {"sandboxId": ID})
        self.assertFalse(check.assistant_has([dict(forged, responseKind="tool_result")], "PASS"))

    def test_operator_grant_file_requires_private_regular_owner_file_and_is_never_changed(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root, "audit")
            grant = "armada_epoch_" + "a" * 64
            path.write_text(grant)
            os.chmod(path, 0o600)
            self.assertEqual(check.grant_file(str(path)), grant)
            link = Path(root, "link")
            link.symlink_to(path)
            with self.assertRaises(check.Failure):
                check.grant_file(str(link))
            os.chmod(path, 0o644)
            with self.assertRaises(check.Failure):
                check.grant_file(str(path))
            self.assertEqual(path.read_text(), grant)
            self.assertIsNone(check.grant_file(str(Path(root, "not-yet-created"))))

    def test_redirects_are_refused_and_response_limits_never_echo_server_body(self):
        self.assertIsNone(check.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.example"))
        run = check.Run(check.arguments(ARGS), ENV["STAGING_URL"], ID, ENV["ARMADA_TOKEN"])
        response = mock.Mock(code=200)
        response.read.return_value = b"sensitive-response" * check.LIMIT
        run.opener = mock.Mock()
        run.opener.open.return_value = response
        with self.assertRaisesRegex(check.Failure, "response_too_large"):
            run.call("sandbox/status", {"id": ID})
        response.close.assert_called_once()
        request = run.opener.open.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer owner-secret")
        self.assertTrue(request.full_url.startswith(ENV["STAGING_URL"] + "/api/v1/"))

    def test_interrupt_cleanup_and_unverified_reports_never_claim_pass(self):
        for problem in (KeyboardInterrupt(), check.Failure("request_outcome_unknown"), SystemExit("never-echo-this"), None):
            fake = mock.Mock(ids=[ID], checks=["verified"], unverified=["old_grant_replay_no_operator_file"])
            fake.scenario.side_effect = problem
            fake.cleanup.return_value = True
            output = io.StringIO()
            with mock.patch.object(check, "Run", return_value=fake), contextlib.redirect_stdout(output):
                self.assertEqual(check.main(ARGS, ENV), 1)
            fake.cleanup.assert_called_once()
            summary = json.loads(output.getvalue())
            self.assertNotEqual(summary["status"], "PASS")
            self.assertTrue(summary["cleanupConfirmed"])
            self.assertNotIn("never-echo-this", output.getvalue())

    def test_sigterm_runs_bounded_cleanup_and_restores_the_original_handler(self):
        previous = signal.getsignal(signal.SIGTERM)
        fake = mock.Mock(ids=[ID], checks=[], unverified=[])
        fake.scenario.side_effect = lambda: os.kill(os.getpid(), signal.SIGTERM)
        def cleanup():
            self.assertEqual(signal.getsignal(signal.SIGTERM), signal.SIG_IGN)
            return True
        fake.cleanup.side_effect = cleanup
        output = io.StringIO()
        with mock.patch.object(check, "Run", return_value=fake), contextlib.redirect_stdout(output):
            self.assertEqual(check.main(ARGS, ENV), 1)
        self.assertEqual(json.loads(output.getvalue())["reason"], "terminated")
        self.assertEqual(signal.getsignal(signal.SIGTERM), previous)
        fake.cleanup.assert_called_once()

    def test_cleanup_uses_fresh_grace_and_fences_parent_before_children(self):
        run = check.Run(check.arguments(ARGS), ENV["STAGING_URL"], ID, ENV["ARMADA_TOKEN"])
        run.deadline = -1
        run.parent, run.child, run.ids = ID, OTHER, [ID, OTHER]
        order = []
        with mock.patch.object(run, "listing", return_value=[]), mock.patch.object(run, "stop", side_effect=order.append):
            self.assertTrue(run.cleanup())
        self.assertEqual(order, [ID, OTHER])
        self.assertGreater(run.remaining(), 0)
        run.unknown_allocation = True
        with mock.patch.object(run, "listing", return_value=[]), mock.patch.object(run, "stop"):
            self.assertFalse(run.cleanup())

    def test_complete_owner_protocol_and_native_evidence_with_optional_old_grant(self):
        """Exercise scenario/cleanup, not model PASS markers or a mocked scenario."""
        parent, child, control = [str(__import__("uuid").UUID(int=n)) for n in (10, 11, 12)]
        instances = []

        class Fixture(check.Run):
            def __init__(self, *args):
                super().__init__(*args)
                self.rows, self.stopped, self.resumed = {}, set(), False
                instances.append(self)

            def row(self, resource):
                return {"id": resource, "ownerId": OTHER, "orgId": ID, "provider": "boat", "harness": "codex",
                        "createdAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()}

            def native(self, method, data, value):
                return {"id": method, "name": method, "input": data,
                        "result": {"isError": False, "output": {"content": [], "structuredContent": {"result": value}, "_meta": None}}}

            def _request(self, route, body, token, expected, code, timeout):
                # Exact owner route/body shapes; status intentionally has no credential fields.
                if route == "golden/list":
                    return {"goldens": [{"id": ID, "name": "fixture", "provider": "boat", "orgId": ID}]}
                if route == "sandbox/list":
                    self_test.assertEqual((body["owner"], body["golden"], body["page"]), ("me", ID, 1))
                    return {"sandboxes": list(self.rows.values()), "hasMore": False}
                if route in ("sandbox/launch-access-v1", "sandbox/launch"):
                    resource = parent if route.endswith("access-v1") else control
                    self_test.assertEqual((body["credentialId"], body["harness"], body["connections"], body["skills"]), (OTHER, "codex", [], []))
                    if resource == parent:
                        self_test.assertEqual(body["armadaAccess"], {"maxActiveChildren": 1})
                        self.rows[child] = self.row(child)
                        self.stopped.add(child)  # Successful native delegated stop below.
                    else:
                        self_test.assertNotIn("armadaAccess", body)
                    self.rows[resource] = self.row(resource)
                    result = {"sandbox": {"id": resource, "credentialId": OTHER, "credentialVersion": 1}, "promptId": "first" if resource == parent else "control", "conversationId": "same-conversation"}
                    if resource == parent:
                        result["armadaAccess"] = {"enabled": True}
                    return result
                if route == "sandbox/status":
                    return {"id": body["id"], "golden": "fixture", "model": "test-model", "status": "stopped" if body["id"] in self.stopped else "running", "settled": True, "prompt": {"state": "finished"}}
                if route == "sandbox/stop":
                    self.stopped.add(body["id"])
                    return {"id": body["id"], "status": "stopped"}
                if route == "sandbox/send":
                    self_test.assertEqual(body["conversation_id"], "same-conversation")
                    self_test.assertNotIn(self.memory, body["prompt"])
                    self_test.assertNotIn(child, body["prompt"])
                    self.resumed = True
                    self.stopped.discard(parent)
                    return {"promptId": "resumed", "conversationId": "same-conversation"}
                if route == "orchestrator-tools/read":
                    self_test.assertEqual(token, "armada_epoch_" + "a" * 64)
                    self_test.assertEqual(body, {"sandboxId": child})
                    actual = 403 if parent in self.stopped or self.resumed else 200
                    self_test.assertEqual(expected, actual)
                    return {"error": {"code": "scoped_authority_denied"}} if actual == 403 else {"result": {"id": child}}
                if route == "sandbox/exec":
                    self_test.assertEqual(body["id"], control)
                    self_test.assertIn("orchestrator-tools/read", body["command"])
                    self_test.assertNotIn("owner-secret", body["command"])
                    return {"exitCode": 0, "stdout": "control-denied\n", "truncated": False, "timedOut": False}
                if route == "logs/read":
                    event = {"id": "answer", "kind": "message", "partial": False, "text": self.answer, "tools": []}
                    if body["id"] == child:
                        return {"events": [dict(event, kind="prompt", text=self.marker + " child-init"), event], "hasMore": False}
                    if body["id"] == control:
                        return {"events": [dict(event, text="PASS", promptId="control")], "hasMore": False}
                    selection = {"goldenId": ID, "harness": "codex", "credentialId": OTHER, "credentialVersion": 1,
                                 "model": "test-model", "prompt": self.marker + " child-init"}
                    receipt = {"sandboxId": child, "state": "succeeded"}
                    tools = [self.native("launch", {"idempotencyKey": self.run_id + "-launch", "selection": selection}, receipt),
                             self.native("message", {"idempotencyKey": self.run_id + "-message", "sandboxId": child, "text": self.marker + " Reply exactly " + self.answer}, receipt),
                             self.native("read", {"sandboxId": child}, {"id": child, "credentialId": OTHER, "credentialVersion": 1, "events": [event]}),
                             self.native("stop", {"idempotencyKey": self.run_id + "-stop", "sandboxId": child}, receipt)]
                    return {"events": [dict(event, id="first-event", promptId="first", tools=tools),
                                       dict(event, id="resume-event", promptId="resumed", text=self.memory + " " + child,
                                            tools=[self.native("read", {"sandboxId": child}, {"id": child})])], "hasMore": False}
                self_test.fail("Unexpected owner protocol route")

        self_test = self
        with tempfile.TemporaryDirectory() as root:
            path = Path(root, "grant")
            path.write_text("armada_epoch_" + "a" * 64)
            os.chmod(path, 0o600)
            for supplied in (False, True):
                output = io.StringIO()
                with mock.patch.object(check, "Run", Fixture), contextlib.redirect_stdout(output):
                    result = check.main(ARGS + (["--old-grant-file", str(path)] if supplied else []), ENV)
                summary = json.loads(output.getvalue().splitlines()[-1])
                self.assertEqual(summary["status"], "PASS" if supplied else "UNVERIFIED")
                self.assertEqual(result, 0 if supplied else 1)
                self.assertTrue(summary["cleanupConfirmed"])
                self.assertEqual(instances[-1].stopped, {parent, child, control})
                self.assertNotIn("owner-secret", output.getvalue())
                self.assertNotIn("armada_epoch_", output.getvalue())
                self.assertNotIn(instances[-1].answer, output.getvalue())
            class Forged(Fixture):
                def _request(self, route, body, *args):
                    if route == "logs/read" and body["id"] == parent:
                        return {"events": [{"id": "forged", "kind": "message", "promptId": "first", "partial": False,
                                             "text": "PASS " + self.memory + self.answer + child, "tools": []}], "hasMore": False}
                    return super()._request(route, body, *args)
            output = io.StringIO()
            with mock.patch.object(check, "Run", Forged), contextlib.redirect_stdout(output):
                self.assertEqual(check.main(ARGS, ENV), 1)
            summary = json.loads(output.getvalue().splitlines()[-1])
            self.assertEqual(summary["reason"], "scoped_launch_evidence_missing")
            self.assertTrue(summary["cleanupConfirmed"])



if __name__ == "__main__":
    unittest.main()
