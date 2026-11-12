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
        start = dict(call)
        start.pop("result")
        result_only = {"id": call["id"], "result": call["result"]}
        frames = [dict(forged, tools=[start]), dict(forged, responseKind="tool_result", tools=[result_only])]
        self.assertEqual(check.scoped_tools(frames, "p")[0]["result"], call["result"])
        with self.assertRaises(check.Failure):
            check.scoped_tools([dict(forged, responseKind="tool_result", tools=[dict(result_only, id="orphan")])], "p")
        metadata = [{"id": "reasoning", "kind": "other", "promptId": "p", "type": "item/started", "data": {"item": {"type": "reasoning"}}},
                    {"id": "usage", "kind": "other", "promptId": "p", "type": "thread/tokenUsage/updated", "data": {}}]
        self.assertEqual(check.scoped_tools(metadata + frames, "p")[0]["result"], call["result"])


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
        cases = [(200, {"ok": True}, None, None),
                 (400, {"error": {"code": "invalid_config", "reason": "helper_missing", "message": "private body"}}, "invalid_config", "helper_missing"),
                 (503, {"error": {"code": "dependency_unavailable", "details": {"reason": "helper_missing"}}}, "dependency_unavailable", "helper_missing"),
                 (403, {"error": {"code": "owner-secret", "reason": "grant-secret", "message": "private body"}}, "unknown_code", "unknown_reason"),
                 (302, {"message": "private body"}, None, None),
                 (500, b"private malformed response", None, None)]
        for status, body, code, reason in cases:
            run = check.Run(check.arguments(ARGS), ENV["STAGING_URL"], ID, ENV["ARMADA_TOKEN"])
            response = io.BytesIO(body if isinstance(body, bytes) else json.dumps(body).encode())
            response.code = status
            run.opener = mock.Mock()
            run.opener.open.return_value = response
            output = io.StringIO()
            with self.subTest(status=status), contextlib.redirect_stdout(output):
                if status == 200:
                    run.call("sandbox/launch-access-v1", {})
                else:
                    with self.assertRaises(check.Failure):
                        run.call("sandbox/launch-access-v1", {})
            trace = json.loads(output.getvalue())
            self.assertEqual(set(trace), {"step", "route", "status", "code", "reason"})
            self.assertEqual(trace, {"step": "parent_launch", "route": "sandbox/launch-access-v1", "status": status, "code": code, "reason": reason})
            self.assertTrue(response.closed)
            for private in ("private body", "owner-secret", "grant-secret", ENV["STAGING_URL"]):
                self.assertNotIn(private, output.getvalue())
            if status != 200:
                self.assertEqual(run.failed_step, "parent_launch")
        for token, active_grant in (("invalid_config", None), ("owner-secret", "helper_missing")):
            run = check.Run(check.arguments(ARGS), ENV["STAGING_URL"], ID, token)
            response = io.BytesIO(json.dumps({"error": {"code": "invalid_config", "reason": "helper_missing"}}).encode())
            response.code = 400
            run.opener = mock.Mock()
            run.opener.open.return_value = response
            output = io.StringIO()
            with contextlib.redirect_stdout(output), self.assertRaises(check.Failure):
                run.call("sandbox/launch", {}, token=active_grant)
            trace = json.loads(output.getvalue())
            self.assertEqual(trace["step"], "control_launch")
            self.assertIsNone(trace["code"] if token == "invalid_config" else trace["reason"])
        for problem, reason in ((OSError("private body owner-secret"), "request_outcome_unknown"),
                                (TimeoutError("private body owner-secret"), "request_timeout"),
                                (check.Failure("request_deadline_exceeded"), "request_deadline_exceeded")):
            run = check.Run(check.arguments(ARGS), ENV["STAGING_URL"], ID, ENV["ARMADA_TOKEN"])
            run.opener = mock.Mock()
            run.opener.open.side_effect = problem
            output = io.StringIO()
            with contextlib.redirect_stdout(output), self.assertRaises(check.Failure):
                run.call("sandbox/status", {"id": ID})
            self.assertEqual(json.loads(output.getvalue())["reason"], reason)
            self.assertNotIn("private body", output.getvalue())
        response = io.BytesIO(b"x" * (check.LIMIT + 1))
        response.code = 200
        run.opener.open.side_effect = None
        run.opener.open.return_value = response
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(check.Failure, "response_too_large"):
            run.call("sandbox/status", {"id": ID})
        request = run.opener.open.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer owner-secret")

        class BrokenOutput(io.StringIO):
            def write(self, _value):
                raise BrokenPipeError("must not escape")
        run = check.Run(check.arguments(ARGS), ENV["STAGING_URL"], ID, ENV["ARMADA_TOKEN"])
        def answer(body, status=200):
            response = io.BytesIO(json.dumps(body).encode())
            response.code = status
            return response
        run.opener = mock.Mock()
        run.opener.open.side_effect = [answer({"ok": True}), answer({"status": "running"}),
                                      answer({"id": ID, "status": "stopped"}), answer({"status": "stopped"}),
                                      answer({"sandboxes": [], "hasMore": False})]
        run.parent, run.ids = ID, [ID]
        stderr = io.StringIO()
        with contextlib.redirect_stdout(BrokenOutput()), contextlib.redirect_stderr(stderr):
            self.assertEqual(run.call("sandbox/status", {"id": ID}), {"ok": True})
            self.assertTrue(run.cleanup())
        self.assertEqual(stderr.getvalue(), "")
        self.assertIn("/api/v1/sandbox/stop", [call.args[0].full_url.replace(ENV["STAGING_URL"], "") for call in run.opener.open.call_args_list])
        run.opener.open.side_effect = None
        run.opener.open.return_value = answer({"error": {"code": "invalid_config"}}, 400)
        with contextlib.redirect_stdout(BrokenOutput()), self.assertRaisesRegex(check.Failure, "api_refused_or_unexpected"):
            run.call("sandbox/launch-access-v1", {})

    def test_interrupt_cleanup_and_unverified_reports_never_claim_pass(self):
        for problem in (KeyboardInterrupt(), check.Failure("request_outcome_unknown"), SystemExit("never-echo-this"), None):
            fake = mock.Mock(ids=[ID], phase="preflight", failed_step=None, api_step="preflight", checks=["verified"], unverified=["old_grant_replay_no_operator_file"])
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
        fake = mock.Mock(ids=[ID], phase="preflight", failed_step=None, api_step="preflight", checks=[], unverified=[])
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

    def test_cleanup_fences_parent_before_discovering_a_child_created_during_stop(self):
        run = check.Run(check.arguments(ARGS), ENV["STAGING_URL"], ID, ENV["ARMADA_TOKEN"])
        run.deadline = -1
        run.parent, run.ids = ID, [ID]
        order = []
        def stop(resource):
            order.append(resource)
        def listing():
            order.append("inventory")
            return [{"id": OTHER, "ownerId": OTHER, "orgId": ID, "provider": "boat", "harness": "codex",
                     "createdAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()}] if ID in order else []
        with mock.patch.object(run, "listing", side_effect=listing), mock.patch.object(run, "stop", side_effect=stop), mock.patch.object(run, "logs", return_value=[{"kind": "prompt", "text": run.child_init}]), mock.patch.object(run, "tool", return_value={"golden": "fixture", "model": "test-model"}):
            self.assertTrue(run.cleanup())
        self.assertIn(OTHER, order)
        self.assertLess(order.index(ID), order.index("inventory"))
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
                self.requests = []
                instances.append(self)

            def row(self, resource):
                return {"id": resource, "ownerId": OTHER, "orgId": ID, "provider": "boat", "harness": "codex",
                        "createdAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()}

            def native(self, method, data, value):
                return {"id": method, "name": method, "input": data,
                        "result": {"isError": False, "output": {"content": [], "structuredContent": {"result": value}, "_meta": None}}}

            def _request(self, route, body, token, expected, code, timeout):
                # Exact owner route/body shapes; status intentionally has no credential fields.
                self.requests.append((route, dict(body)))
                if route == "golden/list":
                    return {"goldens": [{"id": ID, "name": "fixture", "provider": "boat", "orgId": ID,
                                         "config": {"repos": [{"dir": "armada", "url": "https://github.com/example/repo.git"}]}}]}
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
                        return {"events": [dict(event, id="init-prompt", kind="prompt", text=self.child_init, status="finished"), event], "hasMore": False}
                    if body["id"] == control:
                        denied = self.native("read", {"sandboxId": child}, {"status": 401, "error": {"code": "invalid_epoch_authority"}})
                        denied["result"]["isError"] = True
                        return {"events": [dict(event, text="PASS", promptId="control", tools=[denied])], "hasMore": False}
                    selection = {"goldenId": ID, "harness": "codex", "credentialId": OTHER, "credentialVersion": 1,
                                 "model": "test-model", "prompt": self.marker + " child-init: Reply exactly CHILD_READY without tools, then finish."}
                    if self.args.repo:
                        selection["repo"] = self.args.repo
                    receipt = {"sandboxId": child, "state": "succeeded"}
                    tools = [self.native("launch", {"idempotencyKey": self.run_id + "-launch", "selection": selection}, receipt),
                             dict(self.native("read", {"sandboxId": child}, {"id": child, "events": [{"id": "initial", "kind": "prompt", "text": self.child_init, "status": "finished"}]}), id="read-init"),
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
            class RefusedParent(Fixture):
                def _request(self, route, body, *args):
                    if route == "sandbox/launch-access-v1":
                        response = io.BytesIO(json.dumps({"error": {"code": "dependency_unavailable", "message": "private server body"}}).encode())
                        response.code = 503
                        self.opener = mock.Mock()
                        self.opener.open.return_value = response
                        return Fixture.__bases__[0]._request(self, route, body, *args)
                    return super()._request(route, body, *args)
            output = io.StringIO()
            with mock.patch.object(check, "Run", RefusedParent), contextlib.redirect_stdout(output):
                self.assertEqual(check.main(ARGS, ENV), 1)
            lines = [json.loads(line) for line in output.getvalue().splitlines()]
            summary = lines[-1]
            self.assertEqual(summary["step"], "parent_launch")
            self.assertEqual(summary["resources"], [])
            self.assertEqual(summary["checks"], [])
            self.assertEqual(summary["cause"], "api_refused_or_unexpected")
            self.assertIn({"step": "parent_launch", "route": "sandbox/launch-access-v1", "status": 503,
                           "code": "dependency_unavailable", "reason": None}, lines)
            self.assertNotIn("private server body", output.getvalue())

            for selector, expected in (("/home/user/armada", "armada"), ("armada", "armada"), ("example/repo", "example/repo")):
                output = io.StringIO()
                with mock.patch.object(check, "Run", Fixture), contextlib.redirect_stdout(output):
                    self.assertEqual(check.main(ARGS + ["--repo", selector], ENV), 1)
                summary = json.loads(output.getvalue().splitlines()[-1])
                self.assertEqual(summary["status"], "UNVERIFIED")
                bodies = [body for route, body in instances[-1].requests if route in ("sandbox/launch-access-v1", "sandbox/launch")]
                self.assertEqual([body["repo"] for body in bodies], [expected, expected])
                child_selection, _ = json.JSONDecoder().raw_decode(bodies[0]["prompt"].split("selection ", 1)[1])
                self.assertEqual(child_selection["repo"], expected)
            for selector in ("/home/user/not-configured", "/tmp/armada", "/home/user/armada/", "/home/user/../armada"):
                output = io.StringIO()
                with mock.patch.object(check, "Run", Fixture), contextlib.redirect_stdout(output):
                    self.assertEqual(check.main(ARGS + ["--repo", selector], ENV), 1)
                summary = json.loads(output.getvalue().splitlines()[-1])
                self.assertEqual(summary["reason"], "repository_path_not_configured")
                self.assertFalse(any(route in ("sandbox/launch-access-v1", "sandbox/launch") for route, _ in instances[-1].requests))
                self.assertFalse(instances[-1].unknown_allocation)
                self.assertFalse(instances[-1].delegated_uncertain)

            for phase, action, raw in (("first", "commandExecution", False), ("resumed", "fileWrite", False),
                                       ("resumed", "fileChange", True), ("control", "webSearch", True),
                                       ("first", "dynamicToolCall", True), ("control", "unknownTool", False),
                                       ("first", "message", False)):
                class SideEffect(Fixture):
                    def _request(self, route, body, *args):
                        value = super()._request(route, body, *args)
                        target = control if phase == "control" else parent
                        if route == "logs/read" and body["id"] == target:
                            # Valid memory nonce, same conversation and successful scoped reads remain.
                            if raw:
                                value["events"].append({"id": "side-effect", "kind": "other", "promptId": phase,
                                                        "type": "item/completed", "data": {"item": {"type": action}}})
                            else:
                                event = next(event for event in value["events"] if event.get("promptId") == phase)
                                if action == "message":
                                    extra = self.native("message", {"idempotencyKey": "persist-memory", "sandboxId": child,
                                                                    "text": "remember nonce " + self.memory},
                                                        {"sandboxId": child, "state": "succeeded"})
                                    event["tools"].append(dict(extra, id="side-effect"))
                                else:
                                    event["tools"].append({"id": "side-effect", "name": action,
                                                           "input": {"command": "write/read nonce from a file"},
                                                           "result": {"isError": False, "output": self.memory}})
                        return value
                with self.subTest("memory proof rejects unapproved native action", phase=phase, action=action):
                    output = io.StringIO()
                    with mock.patch.object(check, "Run", SideEffect), contextlib.redirect_stdout(output):
                        self.assertEqual(check.main(ARGS + ["--old-grant-file", str(path)], ENV), 1)
                    summary = json.loads(output.getvalue().splitlines()[-1])
                    self.assertEqual(summary["status"], "FAILED")
                    self.assertFalse(summary["cleanupConfirmed"])
                    self.assertEqual(summary["cause"], "unapproved_native_action")
                    self.assertEqual(summary["phase"], {"first": "delegated_child_roundtrip", "resumed": "stop_resume_memory", "control": "no_option_control"}[phase])

            class InitialStillRunning(Fixture):
                def _request(self, route, body, *args):
                    value = super()._request(route, body, *args)
                    if route == "logs/read" and body["id"] == parent:
                        value["events"][0]["tools"][1]["result"]["output"]["structuredContent"]["result"]["events"][0]["status"] = "running"
                    return value
            with self.subTest("initial child read must explicitly finish before challenge message"):
                output = io.StringIO()
                with mock.patch.object(check, "Run", InitialStillRunning), contextlib.redirect_stdout(output):
                    self.assertEqual(check.main(ARGS, ENV), 1)
                summary = json.loads(output.getvalue().splitlines()[-1])
                self.assertFalse(summary["cleanupConfirmed"])
                self.assertEqual(summary["cause"], "child_initial_turn_not_confirmed_before_message")

            for unsupported in (False, True):
                class MissingResumeRead(Fixture):
                    def _request(self, route, body, *args):
                        value = super()._request(route, body, *args)
                        if route == "logs/read" and body["id"] == parent:
                            value["events"][1]["tools"] = [{"id": "unknown", "name": "unsupported-native-shape"}] if unsupported else []
                        return value
                with self.subTest("missing or unsupported resumed native evidence", unsupported=unsupported):
                    output = io.StringIO()
                    with mock.patch.object(check, "Run", MissingResumeRead), contextlib.redirect_stdout(output):
                        self.assertEqual(check.main(ARGS, ENV), 1)
                    summary = json.loads(output.getvalue().splitlines()[-1])
                    self.assertFalse(summary["cleanupConfirmed"])
                    self.assertEqual(summary["reason"], "cleanup_not_confirmed")
                    self.assertEqual(instances[-1].stopped, {parent, child})

            class NoNativeControlProof(Fixture):
                def _request(self, route, body, *args):
                    if route == "logs/read" and body["id"] == control:
                        return {"events": [{"id": "control-text", "kind": "message", "promptId": "control", "partial": False,
                                             "text": "PASS; tool unavailable", "tools": []}], "hasMore": False}
                    return super()._request(route, body, *args)
            with self.subTest("anonymous denial without native proof"):
                output = io.StringIO()
                with mock.patch.object(check, "Run", NoNativeControlProof), contextlib.redirect_stdout(output):
                    self.assertEqual(check.main(ARGS + ["--old-grant-file", str(path)], ENV), 1)
                summary = json.loads(output.getvalue().splitlines()[-1])
                self.assertEqual(summary["status"], "FAILED")
                self.assertEqual(summary["reason"], "cleanup_not_confirmed")
                self.assertIn("control_native_authority_unverified", summary["unverified"])
                self.assertFalse(summary["cleanupConfirmed"])
                self.assertEqual(instances[-1].stopped, {parent, child, control})

            class ForeignScopeDenial(Fixture):
                def _request(self, route, body, *args):
                    value = super()._request(route, body, *args)
                    if route == "logs/read" and body["id"] == control:
                        value["events"][0]["tools"][0]["result"]["output"]["structuredContent"]["result"] = {
                            "status": 403, "error": {"code": "scoped_authority_denied"}}
                    return value
            with self.subTest("foreign child denial is not absence of native authentication"):
                output = io.StringIO()
                with mock.patch.object(check, "Run", ForeignScopeDenial), contextlib.redirect_stdout(output):
                    self.assertEqual(check.main(ARGS + ["--old-grant-file", str(path)], ENV), 1)
                summary = json.loads(output.getvalue().splitlines()[-1])
                self.assertEqual(summary["status"], "FAILED")
                self.assertEqual(summary["reason"], "cleanup_not_confirmed")
                self.assertIn("control_native_authority_unverified", summary["unverified"])
                self.assertFalse(summary["cleanupConfirmed"])
                self.assertEqual(instances[-1].stopped, {parent, child, control})

            foreign = str(__import__("uuid").UUID(int=13))
            class ForeignReceipt(Fixture):
                def _request(self, route, body, *args):
                    value = super()._request(route, body, *args)
                    if route == "sandbox/launch-access-v1":
                        self.rows[foreign] = dict(self.row(foreign), ownerId=str(__import__("uuid").UUID(int=14)))
                    if route == "logs/read" and body["id"] == parent:
                        value["events"][0]["tools"][0]["result"]["output"]["structuredContent"]["result"]["sandboxId"] = foreign
                    if route == "logs/read" and body["id"] == foreign:
                        return {"events": [{"id": "foreign-prompt", "kind": "prompt", "text": self.child_init}], "hasMore": False}
                    return value
            with self.subTest("untrusted native ID never authorizes cleanup of a foreign resource"):
                output = io.StringIO()
                with mock.patch.object(check, "Run", ForeignReceipt), contextlib.redirect_stdout(output):
                    self.assertEqual(check.main(ARGS, ENV), 1)
                summary = json.loads(output.getvalue().splitlines()[-1])
                self.assertNotIn(foreign, instances[-1].stopped)
                self.assertNotIn(foreign, summary["resources"])
                self.assertFalse(summary["cleanupConfirmed"])

            class UnmarkedReceipt(Fixture):
                def _request(self, route, body, *args):
                    value = super()._request(route, body, *args)
                    if route == "sandbox/launch-access-v1":
                        self.stopped.discard(child)
                    if route == "logs/read" and body["id"] == child:
                        value["events"][0]["text"] = "unrelated task without this run's initial marker"
                    return value
            with self.subTest("matching owner and golden without the exact initial prompt is not a run child"):
                output = io.StringIO()
                with mock.patch.object(check, "Run", UnmarkedReceipt), contextlib.redirect_stdout(output):
                    self.assertEqual(check.main(ARGS, ENV), 1)
                summary = json.loads(output.getvalue().splitlines()[-1])
                self.assertNotIn(child, instances[-1].stopped)
                self.assertNotIn(child, summary["resources"])
                self.assertFalse(summary["cleanupConfirmed"])

            class Forged(Fixture):
                def _request(self, route, body, *args):
                    if route == "sandbox/launch-access-v1":
                        result = super()._request(route, body, *args)
                        del self.rows[child]  # Delegated allocation has no published owner row yet.
                        self.stopped.discard(child)  # Its compute may still be live.
                        return result
                    if route == "logs/read" and body["id"] == parent:
                        return {"events": [{"id": "forged", "kind": "message", "promptId": "first", "partial": False,
                                             "text": "PASS " + self.memory + self.answer + child, "tools": []}], "hasMore": False}
                    return super()._request(route, body, *args)
            output = io.StringIO()
            with mock.patch.object(check, "Run", Forged), contextlib.redirect_stdout(output):
                self.assertEqual(check.main(ARGS, ENV), 1)
            summary = json.loads(output.getvalue().splitlines()[-1])
            self.assertFalse(summary["cleanupConfirmed"])
            self.assertEqual(summary["reason"], "cleanup_not_confirmed")
            self.assertEqual(instances[-1].stopped, {parent})



if __name__ == "__main__":
    unittest.main()
