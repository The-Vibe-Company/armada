"""Offline coordinator-client tests; no network, real waits or staging credentials."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

SPEC = importlib.util.spec_from_file_location("staging_check", Path(__file__).with_name("staging-check.py"))
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)
SOURCE, TEMPLATE, ROUTINE, SANDBOX, RUN, CLAIM, ORG = ["00000000-0000-4000-8000-%012d" % x for x in range(1, 8)]


class Clock:
    now = 0

    def sleep(self, seconds):
        self.now += seconds


class FakeApi:
    """Protocol peer: tests own client proof/cleanup, not scheduler correctness."""
    def __init__(self, clock, bad_prompt=False, pause_broken=False, lose_create=False):
        self.clock, self.deadline = clock, check.MAIN_BUDGET
        self.bad_prompt, self.pause_broken, self.lose_create = bad_prompt, pause_broken, lose_create
        self.calls, self.history_rows = [], []
        self.template, self.routine = None, None
        self.compute_deleted_at, self.paused_read_at = None, 0
        self.compute_stopped = False
        self.definition = {"goldenId": SOURCE, "provider": "boat", "harness": "codex", "model": "test-model",
                           "reasoningEffort": "low", "connections": [], "variables": [], "skills": [], "goldenBinding": None}

    def call(self, route, **body):
        if self.clock.now >= self.deadline:
            raise check.CheckFailure("deadline exceeded")
        self.calls.append((route, dict(body)))
        if route == "templates/list":
            return {"items": [{"id": SOURCE, "name": "existing source"}]
                    + ([self.template] if self.template and self.template["status"] != "deleted" else [])}
        if route == "templates/get":
            item = {"id": SOURCE, "currentRevision": 1} if body["id"] == SOURCE else self.template
            return {"item": dict(item), "revision": {"revision": 1, "definition": self.definition}}
        if route == "templates/create":
            self.template = {"id": TEMPLATE, "name": body["name"], "currentRevision": 1, "status": "active"}
            if self.lose_create == "template":
                raise check.ApiFailure()
            return {"item": dict(self.template), "revision": {"revision": 1}}
        if route == "templates/delete":
            self.template["status"] = "deleted"
            return {"item": dict(self.template)}
        if route == "routines/list":
            return {"items": [self.routine] if self.routine and self.routine["status"] != "deleted" else []}
        if route == "routines/create":
            self.routine = dict(body, id=ROUTINE, status="paused", version=1, nextDueAt=None)
            if self.lose_create == "routine":
                raise check.ApiFailure()  # Committed but acknowledgement lost.
            return {"item": dict(self.routine)}
        if route in ("routines/enable", "routines/pause", "routines/delete"):
            if body["expectedVersion"] != self.routine["version"]:
                raise check.ApiFailure(409)
            status = {"routines/enable": "enabled", "routines/pause": "paused", "routines/delete": "deleted"}[route]
            self.routine.update(status=status, version=self.routine["version"] + 1,
                                nextDueAt="future-server-time" if status == "enabled" else None)
            return {"item": dict(self.routine)}
        if route == "routines/get":
            if self.routine["status"] == "paused":
                self.paused_read_at = self.clock.now
            return {"item": dict(self.routine)}
        if route == "routines/history":
            if not self.history_rows and self.clock.now >= check.HOUR:
                self.history_rows = [{"id": RUN, "state": "succeeded", "reason": None,
                                      "configurationVersion": 2, "templateRequestId": CLAIM, "sandboxId": SANDBOX}]
            if self.pause_broken and self.clock.now >= 2 * check.HOUR:
                self.history_rows.append({"id": CLAIM, "state": "skipped", "reason": "previous_run_alive",
                                          "reasonHelp": "Previous run is alive.", "sandboxId": None})
            return {"items": list(self.history_rows)}
        if route == "logs/read":
            return {"events": [{"kind": "prompt", "status": "finished",
                                "text": "wrong prompt" if self.bad_prompt else self.routine["prompt"]}],
                    "hasMore": False, "cursor": "one"}
        if route == "sandbox/stop":
            self.compute_stopped = True
            return {"id": body["id"], "status": "stopped"}
        if route == "sandbox/delete":
            if not self.compute_stopped:
                raise check.ApiFailure(409)
            self.compute_deleted_at = self.clock.now
            return {"id": body["id"], "status": "deleted"}
        raise AssertionError("unexpected protocol route")


class CoordinatorTests(unittest.TestCase):
    def invoke(self, api):
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(check, "Api", return_value=api), patch.object(check.time, "monotonic", side_effect=lambda: api.clock.now), \
             patch.object(check.time, "sleep", side_effect=api.clock.sleep), patch.object(check.signal, "signal"), \
             patch.object(check.sys, "argv", ["staging-check.py", "--template", SOURCE, "--provider", "boat"]), \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            status = check.main()
        return status, output.getvalue(), errors.getvalue()

    def test_success_proves_due_boundary_exact_prompt_revision_and_cleanup(self):
        api = FakeApi(Clock())
        status, output, errors = self.invoke(api)
        self.assertEqual((status, errors), (0, ""))
        self.assertGreaterEqual(api.paused_read_at, 2 * check.HOUR + check.GRACE)
        self.assertLess(api.compute_deleted_at, 2 * check.HOUR)
        self.assertEqual(api.routine["status"], "deleted")
        self.assertEqual(api.template["status"], "deleted")
        self.assertIn("PASS", output)
        create = next(b for r, b in api.calls if r == "templates/create")
        self.assertNotIn("goldenBinding", create["definition"])
        routine = next(b for r, b in api.calls if r == "routines/create")
        self.assertEqual((routine["templateId"], routine["templateRevision"], routine["intervalHours"]), (TEMPLATE, 1, 1))
        self.assertFalse(any(r in ("templates/delete", "templates/create") and b.get("id") == SOURCE for r, b in api.calls))

    def test_false_prompt_and_post_pause_occurrence_fail_and_clean(self):
        for mode in ("bad_prompt", "pause_broken"):
            with self.subTest(mode=mode):
                api = FakeApi(Clock(), **{mode: True})
                status, output, errors = self.invoke(api)
                self.assertEqual(status, 1)
                self.assertNotIn("PASS:", output)
                self.assertIn("FAIL:", errors)
                self.assertEqual(api.routine["status"], "deleted")
                self.assertEqual(api.template["status"], "deleted")
                self.assertIsNotNone(api.compute_deleted_at)

    def test_lost_create_ack_discovers_nonce_without_recreating(self):
        for resource in ("template", "routine"):
            with self.subTest(resource=resource):
                api = FakeApi(Clock(), lose_create=resource)
                status, _, _ = self.invoke(api)
                self.assertEqual(status, 1)
                self.assertEqual(sum(r == resource + "s/create" for r, _ in api.calls), 1)
                if api.routine:
                    self.assertEqual(api.routine["status"], "deleted")
                self.assertEqual(api.template["status"], "deleted")

    def test_late_admitted_sandbox_is_discovered_during_cleanup(self):
        api = FakeApi(Clock())
        original, cleanup_reads = api.call, []
        def late(route, **body):
            if route == "routines/enable":
                original(route, **body)
                raise check.ApiFailure()  # Caller cannot know whether a run was already admitted.
            if route == "routines/history" and api.routine["status"] == "deleted":
                cleanup_reads.append(api.clock.now)
                if len(cleanup_reads) == 1:
                    return {"items": [{"id": RUN, "state": "admitted", "reason": None, "sandboxId": None}]}
                return {"items": [{"id": RUN, "state": "succeeded", "reason": None, "sandboxId": SANDBOX}]}
            return original(route, **body)
        api.call = late
        status, output, _ = self.invoke(api)
        self.assertEqual(status, 1)
        self.assertGreaterEqual(len(cleanup_reads), 2)
        self.assertIsNotNone(api.compute_deleted_at)
        self.assertEqual(api.template["status"], "deleted")
        self.assertIn("Cleanup confirmed", output)

    def test_definition_failure_cannot_skip_late_history_cleanup(self):
        for failed_route, committed in (("routines/pause", False), ("routines/delete", False), ("routines/delete", True)):
            with self.subTest(route=failed_route, committed=committed):
                api = FakeApi(Clock())
                original, failed_read, cleanup_reads = api.call, [], []
                def interrupted_history(route, **body):
                    if route == "routines/history" and not failed_read and api.clock.now >= check.HOUR:
                        failed_read.append(True)
                        raise check.ApiFailure()
                    if failed_read and route == failed_route:
                        if committed:
                            original(route, **body)
                        raise check.ApiFailure(403 if not committed else None)
                    if failed_read and route == "routines/history":
                        cleanup_reads.append(True)
                        return {"items": [{"id": RUN, "state": "admitted" if len(cleanup_reads) == 1 else "succeeded",
                                           "reason": None, "sandboxId": None if len(cleanup_reads) == 1 else SANDBOX}]}
                    return original(route, **body)
                api.call = interrupted_history
                status, _, errors = self.invoke(api)
                self.assertEqual(status, 1)
                self.assertIn("Cleanup incomplete", errors)
                self.assertIsNotNone(api.compute_deleted_at)
                self.assertEqual(api.template["status"], "deleted")

    def test_delete_lost_ack_retries_delete_not_stop(self):
        api, committed = FakeApi(Clock()), []
        original = api.call
        def lost_ack(route, **body):
            if route == "sandbox/stop" and committed:
                raise check.ApiFailure(409)  # Real stop rejects an already deleted sandbox.
            if route == "sandbox/delete" and not committed:
                original(route, **body)
                committed.append(True)
                raise check.ApiFailure()
            return original(route, **body)
        api.call = lost_ack
        status, output, errors = self.invoke(api)
        self.assertEqual((status, errors), (0, ""))
        self.assertIn("PASS:", output)
        self.assertEqual(api.routine["status"], "deleted")
        self.assertEqual(api.template["status"], "deleted")

    def test_cleanup_failure_still_attempts_known_compute_and_template(self):
        api = FakeApi(Clock(), bad_prompt=True)
        original = api.call
        def refused(route, **body):
            if route == "routines/delete":
                raise check.ApiFailure(403)
            return original(route, **body)
        api.call = refused
        status, output, errors = self.invoke(api)
        self.assertEqual(status, 1)
        self.assertIn("Cleanup incomplete", errors)
        self.assertNotIn("Cleanup confirmed", output)
        self.assertIsNotNone(api.compute_deleted_at)
        self.assertEqual(api.template["status"], "deleted")

    def test_argument_errors_do_not_echo_sensitive_values(self):
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors), self.assertRaises(SystemExit):
            check.parser().parse_args(["--provider", "synthetic-private-value"])
        self.assertNotIn("synthetic-private-value", errors.getvalue())

    def test_transport_token_header_only_no_redirect_or_raw_errors(self):
        token = "synthetic-not-a-real-token"
        api = check.Api("https://staging.example", ORG, token)
        with patch.object(api.opener, "open", return_value=io.BytesIO(json.dumps({"items": []}).encode())) as opened:
            self.assertEqual(api.call("routines/list"), {"items": []})
        request = opened.call_args.args[0]
        self.assertNotIn(token, request.full_url)
        self.assertNotIn(token, request.data.decode())
        self.assertEqual(request.get_header("Authorization"), "Bearer " + token)
        self.assertIsNone(check.NoRedirect().redirect_request(None, None, 302, None, None, "https://elsewhere.example"))
        with patch.object(api.opener, "open", side_effect=HTTPError("https://staging.example", 500, token, {}, io.BytesIO(token.encode()))):
            with self.assertRaises(check.ApiFailure) as error:
                api.call("routines/list")
        self.assertNotIn(token, str(error.exception))
        def timeout(*args, **kwargs):
            check.signal.raise_signal(check.signal.SIGALRM)
        with patch.object(api.opener, "open", side_effect=timeout), self.assertRaises(check.ApiFailure):
            api.call("routines/list")
        for origin in ("http://staging.example", "https://armada.thevibecompany.co", "https://armada-mcp-production.up.railway.app", "https://armada.thevibecompany.co.", "https://user:pass@staging.example", "https://staging.example/?token=bad"):
            with self.subTest(origin=origin), self.assertRaises(check.CheckFailure):
                check.Api(origin, ORG, token)


if __name__ == "__main__":
    unittest.main()
