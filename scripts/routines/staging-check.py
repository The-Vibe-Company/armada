#!/usr/bin/env python3
"""Coordinator-only routine smoke check, Python 3.9+ standard library."""
import argparse
import json
import os
import re
import signal
import sys
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

HOUR, POLL, GRACE = 3600, 10, 120
MAIN_BUDGET, CLEANUP_BUDGET = 130 * 60, 5 * 60
UUID = re.compile(r"^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
REASONS = {
    "previous_run_alive": "Previous sandbox is still alive.",
    "previous_run_uncertain": "Previous launch is uncertain; inspect the existing claim.",
    "daily_limit_reached": "Daily launch budget reached.",
    "owner_authorization_changed": "Execution owner access changed.",
    "launch_failed": "Template launch failed; check owner credentials and references.",
    "launch_uncertain": "Launch outcome uncertain; do not create a replacement claim.",
}
DEFINITION_KEYS = {"goldenId", "provider", "harness", "model", "reasoningEffort", "modelAccount",
                   "connections", "variables", "skills"}


class CheckFailure(Exception):
    """Only local, fixed diagnostic strings; no raw server/transport errors."""


class ApiFailure(CheckFailure):
    def __init__(self, status=None):
        self.status = status
        super().__init__("API request failed" + (" (HTTP %d)." % status if status else "."))


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def identifier(value):
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise CheckFailure("Expected a resource UUID; refusing unsafe cleanup targets.")
    return value


def positive(value):
    if type(value) is not int or value < 1:
        raise CheckFailure("Missing resource version in API response.")
    return value


def rows(response):
    result = response.get("items")
    if not isinstance(result, list) or not all(isinstance(x, dict) for x in result):
        raise CheckFailure("Expected a JSON item list.")
    return result


class Api:
    def __init__(self, origin, org, token):
        try:
            url = urlsplit(origin)
            valid = (not any(c.isspace() for c in origin) and url.scheme == "https" and url.hostname and not url.username and not url.password
                     and url.path in ("", "/") and not url.query and not url.fragment
                     and url.port in (None, 443) and url.hostname.rstrip(".") not in ("armada.thevibecompany.co", "armada-mcp-production.up.railway.app"))
        except ValueError:
            valid = False
        if not valid:
            raise CheckFailure("STAGING_URL must be a non-production HTTPS origin without credentials or a path.")
        if not token or any(c.isspace() for c in token):
            raise CheckFailure("ARMADA_TOKEN must be set to a single token; it is never logged.")
        self.origin, self.org, self.token = origin.rstrip("/"), identifier(org), token
        self.deadline = time.monotonic() + MAIN_BUDGET
        self.opener = build_opener(NoRedirect())

    def call(self, route, **body):
        request = Request(self.origin + "/api/v1/" + route,
                          data=json.dumps(dict(body, org=self.org)).encode(),
                          headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        return self._request(request)

    def delete_sandbox(self, sandbox_id):
        # The public dashboard admits DELETE here, not the backend-only POST alias.
        query = urlencode({"org": self.org})
        request = Request(self.origin + "/api/v1/sandboxes/" + identifier(sandbox_id) + "?" + query,
                          method="DELETE", headers={"Authorization": "Bearer " + self.token})
        return self._request(request)

    def _request(self, request):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise CheckFailure("Bounded staging-check deadline exceeded.")
        # Socket timeouts alone reset during trickling responses. A POSIX timer also
        # bounds the entire request, including DNS/headers/body, on macOS and Linux.
        old_handler = signal.getsignal(signal.SIGALRM)
        old_timer = signal.getitimer(signal.ITIMER_REAL)
        started = time.monotonic()
        def timed_out(_signum, _frame):
            raise ApiFailure()
        signal.signal(signal.SIGALRM, timed_out)
        signal.setitimer(signal.ITIMER_REAL, min(15, remaining))
        try:
            with self.opener.open(request, timeout=min(15, remaining)) as response:
                raw = response.read(4 * 1024 * 1024 + 1)
                if len(raw) > 4 * 1024 * 1024:
                    raise CheckFailure("API response exceeds the size budget.")
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise CheckFailure("Expected a JSON API object.")
                return result
        except HTTPError as error:
            raise ApiFailure(error.code) from None
        except (URLError, OSError, ValueError):
            raise ApiFailure() from None
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, old_handler)
            if old_timer[0]:
                signal.setitimer(signal.ITIMER_REAL, max(0.001, old_timer[0] - (time.monotonic() - started)), old_timer[1])


class Scenario:
    def __init__(self, api):
        self.api = api
        self.name = "routine-staging-" + uuid.uuid4().hex
        self.template_id = self.routine_id = None
        self.template_attempted = self.routine_attempted = False
        self.sandboxes, self.deleted = set(), set()
        self.prompt = ("Read-only routine staging check " + self.name + ". Do not edit files, run commands, "
                       "contact external services, or create resources. Reply with exactly ROUTINES_STAGING_OK.")

    def sleep(self, end):
        remaining = min(end, self.api.deadline) - time.monotonic()
        if remaining <= 0:
            raise CheckFailure("Timed out waiting for routine evidence.")
        time.sleep(min(POLL, remaining))

    def history(self):
        history = rows(self.api.call("routines/history", id=self.routine_id))
        for row in history:
            if row.get("sandboxId"):
                self.sandboxes.add(identifier(row["sandboxId"]))
            if row.get("state") not in ("admitted", "succeeded", "failed", "reconciling", "skipped"):
                raise CheckFailure("Unknown history state.")
            reason = row.get("reason")
            if reason is not None and (reason not in REASONS or not isinstance(row.get("reasonHelp"), str)
                                       or not row["reasonHelp"].strip()):
                raise CheckFailure("History reason is unknown or lacks a readable explanation.")
        return history

    def exact_prompt(self, sandbox_id, end):
        cursor = None
        while time.monotonic() < end:
            body = {"id": sandbox_id, "limit": 200, "maxBytes": 1000000}
            if cursor:
                body["cursor"] = cursor
            page = self.api.call("logs/read", **body)
            for event in page.get("events", []):
                if event.get("kind") == "prompt" and event.get("text") == self.prompt:
                    if event.get("status") in ("failed", "interrupted"):
                        raise CheckFailure("The exact initial prompt was refused or interrupted.")
                    return
            next_cursor = page.get("cursor")
            if page.get("hasMore") and (not next_cursor or next_cursor == cursor):
                raise CheckFailure("Sandbox event cursor did not advance.")
            cursor = next_cursor or cursor
            if not page.get("hasMore"):
                self.sleep(end)
        raise CheckFailure("Exact scheduled prompt was not observed in sandbox events.")

    def stop_delete(self, sandbox_id, end):
        while time.monotonic() < end:
            try:
                # Delete is idempotent even after a lost successful acknowledgement.
                # Stop is NOT: the server rejects stop on an already deleted resource.
                result = self.api.delete_sandbox(sandbox_id)
                if result.get("status") == "deleted":
                    self.deleted.add(sandbox_id)
                    return
            except ApiFailure as error:
                if error.status == 409:
                    try:
                        self.api.call("sandbox/stop", id=sandbox_id)
                    except ApiFailure as stop_error:
                        if stop_error.status not in (409, 429, 500, 502, 503, 504, None):
                            raise
                elif error.status not in (429, 500, 502, 503, 504, None):
                    raise
            self.sleep(end)
        raise CheckFailure("Sandbox stop/deletion could not be confirmed.")

    def run(self, source_id, provider):
        if not source_id:
            sources = rows(self.api.call("templates/list"))
            if len(sources) != 1:
                raise CheckFailure("Choose an existing Codex template with --template UUID; source templates are never modified.")
            source_id = identifier(sources[0].get("id"))
        source = self.api.call("templates/get", id=identifier(source_id))["revision"]["definition"]
        if source.get("harness") != "codex" or source.get("provider") not in ("boat", "modal"):
            raise CheckFailure("Source template must select Codex on Boat or Modal.")
        if provider and source["provider"] != provider:
            raise CheckFailure("Source template does not match --provider.")
        if self.api.deadline - time.monotonic() < 2 * HOUR + GRACE + 30:
            raise CheckFailure("Insufficient time remains for a truthful pause check.")
        print("Test resource nonce: " + self.name, flush=True)
        self.template_attempted = True
        template = self.api.call("templates/create", name=self.name, scope="personal",
                                 definition={k: v for k, v in source.items() if k in DEFINITION_KEYS})
        created_id = identifier(template["item"]["id"])
        if created_id == source_id:
            raise CheckFailure("Create returned the source template; refusing to modify it.")
        self.template_id = created_id
        if template["item"].get("currentRevision") != 1 or template["revision"].get("revision") != 1:
            raise CheckFailure("Expected a new template with only immutable revision 1.")
        self.routine_attempted = True
        routine = self.api.call("routines/create", name=self.name, scope="personal", templateId=self.template_id,
                                templateRevision=1, prompt=self.prompt, intervalHours=1, ttlSeconds=900,
                                maxRunsPerDay=2)["item"]
        self.routine_id = identifier(routine["id"])
        print("Temporary template " + self.template_id + "; routine " + self.routine_id, flush=True)
        enabled_at = time.monotonic()
        enabled = self.api.call("routines/enable", id=self.routine_id,
                                expectedVersion=positive(routine["version"]))["item"]
        version = positive(enabled.get("version"))
        if (enabled.get("status") != "enabled" or enabled.get("templateId") != self.template_id
                or enabled.get("templateRevision") != 1 or enabled.get("intervalHours") != 1
                or enabled.get("prompt") != self.prompt or not enabled.get("nextDueAt")):
            raise CheckFailure("Enabled routine lost its exact pinned configuration.")
        print("Enabled a one-hour Codex routine on %s; first firing is not immediate." % source["provider"], flush=True)
        first_end, first = enabled_at + HOUR + 600, None
        while time.monotonic() < first_end:
            history = self.history()
            if len(history) > 1:
                raise CheckFailure("Unexpected multiple occurrences before first firing.")
            if history:
                first = history[0]
                if first["state"] in ("failed", "reconciling", "skipped"):
                    raise CheckFailure(REASONS.get(first.get("reason"), "First occurrence did not succeed."))
                if first["state"] == "succeeded":
                    break
                first = None
            self.sleep(first_end)
        if not first or first.get("configurationVersion") != version or first.get("reason") is not None:
            raise CheckFailure("Missing successful history for the enabled configuration version.")
        identifier(first.get("templateRequestId"))
        sandbox_id = identifier(first.get("sandboxId"))
        self.sandboxes.add(sandbox_id)
        # Pause before inspection; stop/delete compute so live-run skipping cannot masquerade as pause.
        paused = self.api.call("routines/pause", id=self.routine_id, expectedVersion=version)["item"]
        if paused.get("status") != "paused" or paused.get("nextDueAt") is not None:
            raise CheckFailure("Pause did not clear future scheduling.")
        self.exact_prompt(sandbox_id, first_end)
        template = self.api.call("templates/get", id=self.template_id, revision=1)
        if template["item"].get("currentRevision") != 1 or template["revision"].get("revision") != 1:
            raise CheckFailure("Temporary template no longer has exactly revision 1.")
        self.stop_delete(sandbox_id, min(time.monotonic() + CLEANUP_BUDGET, self.api.deadline))
        print("Observed exact prompt, sole pinned revision 1 and claim history; compute deleted. Checking pause across next due boundary.", flush=True)
        pause_end = enabled_at + 2 * HOUR + GRACE
        while True:
            current = self.api.call("routines/get", id=self.routine_id)["item"]
            history = self.history()
            if current.get("status") != "paused" or len(history) != 1 or history[0].get("id") != first.get("id"):
                raise CheckFailure("Paused routine admitted another occurrence or changed state.")
            if time.monotonic() >= pause_end:
                break
            self.sleep(pause_end + 1)
        print("PASS: paused across next one-hour due boundary; history/reasons validated.", flush=True)

    def discover(self, resource):
        found = [x for x in rows(self.api.call(resource + "/list")) if x.get("name") == self.name]
        if len(found) > 1:
            raise CheckFailure("Ambiguous nonce cleanup name.")
        return identifier(found[0]["id"]) if found else None

    def cleanup(self):
        self.api.deadline = time.monotonic() + CLEANUP_BUDGET
        failures = []
        try:
            if self.routine_attempted and not self.routine_id:
                self.routine_id = self.discover("routines")
                if not self.routine_id:
                    raise CheckFailure("Unknown routine create outcome; cannot confirm absence.")
            if self.routine_id:
                item = self.api.call("routines/get", id=self.routine_id)["item"]
                if item.get("status") == "enabled":
                    item = self.api.call("routines/pause", id=self.routine_id,
                                         expectedVersion=positive(item.get("version")))["item"]
                self.api.call("routines/delete", id=self.routine_id, expectedVersion=positive(item.get("version")))
        except Exception:
            failures.append("routine cleanup not confirmed")
        # History authorization survives tombstoning. Even a failed mutation or lost
        # delete acknowledgement must not hide a late admitted sandbox from cleanup.
        if self.routine_id:
            try:
                while True:
                    history = self.history()
                    for sandbox_id in self.sandboxes - self.deleted:
                        self.stop_delete(sandbox_id, self.api.deadline)
                    if not any(x.get("state") in ("admitted", "reconciling") for x in history):
                        break
                    self.sleep(self.api.deadline)
            except Exception:
                failures.append("history cleanup not confirmed")
        # Still attempt known compute cleanup even if a definition/history read failed.
        for sandbox_id in self.sandboxes - self.deleted:
            try:
                self.stop_delete(sandbox_id, self.api.deadline)
            except Exception:
                failures.append("sandbox cleanup not confirmed")
        try:
            if self.template_attempted and not self.template_id:
                self.template_id = self.discover("templates")
                if not self.template_id:
                    raise CheckFailure("Unknown template create outcome; cannot confirm absence.")
            if self.template_id:
                item = self.api.call("templates/get", id=self.template_id)["item"]
                self.api.call("templates/delete", id=self.template_id,
                              expectedRevision=positive(item.get("currentRevision")))
        except Exception:
            failures.append("template cleanup not confirmed")
        if failures:
            ids = [self.routine_id, self.template_id] + sorted(self.sandboxes - self.deleted)
            print("Cleanup incomplete; inspect nonce name " + self.name + "; resource UUIDs: "
                  + ", ".join(x for x in ids if x), file=sys.stderr)
            raise CheckFailure("; ".join(failures) + ". Uncertain launches need manual reconciliation.")
        print("Cleanup confirmed: temporary definitions soft-deleted, created compute deleted; immutable history retained.", flush=True)


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, "Invalid arguments; use --help. No argument values are printed.\n")


def parser():
    p = SafeParser(description="Coordinator-only routine staging check (Python 3.9+ stdlib; macOS/Linux).",
        epilog="Minimum interval: ONE HOUR. Runs about 122 minutes plus setup/cleanup; "
               "130-minute main deadline + 5-minute cleanup budget (about 135 minutes maximum). "
               "Uses STAGING_URL, STAGING_ORG (UUID), ARMADA_TOKEN; never prints the token or raw API errors. "
               "Requires a usable existing Codex template and current model credentials in staging. "
               "Run once each for Boat and Modal, optionally in parallel. Creates a private temporary clone "
               "with only revision 1, never modifies its source. Cleanup soft-deletes definitions and stops/deletes "
               "spawned sandboxes; history is immutable. Interruptions attempt cleanup; network/auth failures or "
               "uncertain in-flight launches exit nonzero with residual UUIDs. Two consecutive firings, live-run skip, "
               "restart/replica idempotency, downtime, revocation and cost-guard checks need a longer or manual run; "
               "this script does NOT claim them.")
    p.add_argument("--template", metavar="UUID", help="Codex template to clone (auto-select only if exactly one visible)")
    p.add_argument("--provider", choices=("boat", "modal"), help="assert source provider; run once per provider")
    return p


def main():
    args = parser().parse_args()
    failed = False
    try:
        api = Api(os.environ.get("STAGING_URL", ""), os.environ.get("STAGING_ORG", ""), os.environ.get("ARMADA_TOKEN", ""))
        scenario = Scenario(api)
        def interrupted(_signum, _frame):
            raise CheckFailure("Interrupted; attempting bounded cleanup.")
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, interrupted)
        try:
            scenario.run(args.template, args.provider)
        finally:
            for sig in (signal.SIGINT, signal.SIGTERM):
                signal.signal(sig, signal.SIG_IGN)
            scenario.cleanup()
    except CheckFailure as error:
        print("FAIL: " + str(error), file=sys.stderr)
        failed = True
    except Exception:
        print("FAIL: unexpected response or local error; no raw diagnostics printed.", file=sys.stderr)
        failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
