#!/usr/bin/env python3
"""Operator-only staging proof; no server bodies, prompts, credentials or grants are emitted."""
import argparse
import contextlib
import json
import os
import re
import secrets
import signal
import ssl
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

LIMIT = 1024 * 1024
PRODUCTION = {"armada.thevibecompany.co", "armada.thevibecompany.com"}
API_STEPS = {"golden/list": "golden_list", "sandbox/list": "sandbox_list", "sandbox/status": "sandbox_status",
             "logs/read": "logs_read", "sandbox/launch-access-v1": "parent_launch", "sandbox/launch": "control_launch",
             "sandbox/send": "parent_resume", "sandbox/stop": "sandbox_stop", "sandbox/exec": "control_probe",
             "orchestrator-tools/read": "old_grant_read"}
API_CODES = set("invalid invalid_config invalid_request unauthorized forbidden not_found conflict unsupported unavailable no_credentials start_failed init_failed prompt_failed payment_required provider_not_configured sandbox_not_ready no_running_turn credential_busy credential_binding_required credential_binding_unsafe credential_refused github_hydration_failed provider_unavailable dependency_unavailable outcome_unknown scoped_authority_denied invalid_epoch_authority".split())
API_REASONS = API_CODES | set("helper_missing helper_receipt_invalid helper_capability_unsupported skillpack_credential_missing skillpack_credential_refused skillpack_credential_unreadable skillpack_skill_unavailable skillpack_cli_unavailable skillpack_download_unavailable skillpack_transport_failed visibility_not_persisted native_auth_write_failed repository_ownership_mismatch".split())
LOCAL_REASONS = set("api_refused_or_unexpected response_invalid response_too_large request_outcome_unknown request_deadline_exceeded request_timeout redirect_refused deadline_exceeded interrupted terminated unsupported_api_route".split())



class Failure(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, _message):
        raise Failure("invalid_arguments")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


@contextlib.contextmanager
def request_deadline(seconds):
    # POSIX/macOS wall deadline also bounds a peer slowly dripping a response.
    def expired(_signal, _frame):
        raise Failure("request_deadline_exceeded")
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F-]{36}", value):
        raise Failure("invalid_identifier")
    try:
        return str(uuid.UUID(value))
    except ValueError:
        raise Failure("invalid_identifier") from None


def origin(value):
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment
            or parsed.hostname.lower() in PRODUCTION
            or not re.search(r"(^|[.-])(stage|staging)([.-]|$)", parsed.hostname.lower())):
        raise Failure("explicit_staging_https_origin_required")
    return value.rstrip("/")


def emit(record):
    # Diagnostics must never mask a request outcome or prevent resource cleanup.
    try:
        print(json.dumps(record, sort_keys=True), flush=True)
    except (OSError, ValueError):
        pass


def safe_values(value, protected):
    if isinstance(value, dict):
        return {key: safe_values(item, protected) for key, item in value.items()}
    if isinstance(value, list):
        return [safe_values(item, protected) for item in value]
    return None if isinstance(value, str) and any(secret and secret in value for secret in protected) else value


def repository_selector(selector, config):
    if selector is None or not selector.startswith("/"):
        return selector  # Existing directory and owner/repo API selectors are unchanged.
    prefix = "/home/user/"
    directory = selector[len(prefix):] if selector.startswith(prefix) else ""
    repos = config.get("repos", []) if isinstance(config, dict) else []
    if (re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,80}", directory)
            and isinstance(repos, list) and sum(isinstance(repo, dict) and repo.get("dir") == directory for repo in repos) == 1):
        return directory
    raise Failure("repository_path_not_configured")


def grant_file(path):
    """Read an operator-supplied grant only; never retrieve it from the sandbox."""
    try:
        before = os.lstat(path)
        if (not stat.S_ISREG(before.st_mode) or stat.S_IMODE(before.st_mode) != 0o600
                or before.st_uid != os.getuid()):
            raise Failure("unsafe_grant_file")
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            opened = os.fstat(fd)
            if ((opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
                    or not stat.S_ISREG(opened.st_mode) or stat.S_IMODE(opened.st_mode) != 0o600
                    or opened.st_uid != os.getuid()):
                raise Failure("unsafe_grant_file")
            token = os.read(fd, 256).decode("ascii").rstrip("\r\n")
        finally:
            os.close(fd)
        if not re.fullmatch(r"armada_epoch_[a-f0-9]{64}", token):
            raise Failure("invalid_grant_file")
        return token
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError):
        raise Failure("unsafe_grant_file") from None


def decoded(value):
    """Accept known MCP result envelopes, not arbitrary recursive model text."""
    for _ in range(6):
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                raise Failure("unsupported_tool_evidence") from None
        elif isinstance(value, list) and len(value) == 1 and value[0].get("type") == "text":
            value = value[0].get("text")
        elif isinstance(value, dict) and value.get("structuredContent") is not None:
            value = value["structuredContent"]
        elif isinstance(value, dict) and set(value) == {"result"}:
            value = value["result"]
        elif isinstance(value, dict) and "content" in value and "id" not in value:
            value = value["content"]
        else:
            break
    if not isinstance(value, dict):
        raise Failure("unsupported_tool_evidence")
    return value


def scoped_tools(events, prompt_id, allowed=("launch", "message", "read", "stop")):
    """Audit native actions, then merge only allowed calls and correlated Claude results."""
    calls = {}
    names = {"mcp__armada_orchestrator__" + name: name for name in allowed}
    # Modal drops item.server; the isolated-golden prerequisite remains essential.
    names.update({name: name for name in allowed})
    metadata_items = {"reasoning", "plan", "userMessage", "agentMessage", "contextCompaction",
                      "enteredReviewMode", "exitedReviewMode", "usage", "metadata"}
    for event in events:
        turn = event.get("promptId")
        if turn is not None and turn != prompt_id:
            continue
        if event.get("kind") == "other":
            data = event.get("data")
            item = data.get("item") if isinstance(data, dict) else None
            kind = item.get("type") if isinstance(item, dict) else None
            event_type = event.get("type", "")
            if kind is not None:
                if kind not in metadata_items:
                    raise Failure("unapproved_native_action")
            elif event_type in ("item/started", "item/completed"):
                raise Failure("unsupported_native_action")
            elif event_type.startswith("item/"):
                if not event_type.startswith(("item/reasoning/", "item/agentMessage/", "item/plan/")):
                    raise Failure("unapproved_native_action")
            elif re.sub(r"[_-]", "", event_type.lower()).startswith(("tool", "command", "exec", "file", "write", "read", "search",
                                                "websearch", "dynamictool", "collabagent", "subagent", "image", "functioncall", "hookprompt")):
                raise Failure("unapproved_native_action")
            continue  # Reasoning, usage and system/thread/turn metadata are not actions.
        if event.get("kind") != "message":
            continue
        for tool in event.get("tools", []):
            call_id, name = tool.get("id"), tool.get("name")
            if not isinstance(call_id, str) or not call_id or event.get("parentToolUseId"):
                raise Failure("unapproved_native_action")
            previous = calls.get(call_id)
            if name in (None, "", "tool_result"):
                if event.get("responseKind") != "tool_result" or previous is None or not isinstance(tool.get("result"), dict):
                    raise Failure("uncorrelated_native_result")
                calls[call_id] = dict(previous, result=tool["result"])
                continue
            if turn is None or name not in names:
                raise Failure("unapproved_native_action")
            method = names[name]
            if previous is not None and previous["method"] != method:
                raise Failure("rebound_native_call_id")
            calls[call_id] = dict(previous or {}, **tool, method=method)
    return list(calls.values())


def native_denial(call):
    result = call.get("result", {})
    if result.get("isError") is not True:
        return False
    output = result.get("output")
    try:
        output = decoded(output)
    except Failure:
        pass
    # A foreign-child 403 is also returned to a valid, differently scoped grant.
    # Only explicit no-auth 401 evidence supports this negative-control claim.
    if not isinstance(output, dict) or output.get("status") != 401:
        return False
    error = output.get("error")
    return output.get("code") == "invalid_epoch_authority" or (isinstance(error, dict) and error.get("code") == "invalid_epoch_authority")


def assistant_has(events, text, prompt_id=None):
    return any(event.get("kind") == "message" and not event.get("partial", True)
               and event.get("responseKind", "assistant") == "assistant"
               and not event.get("retracted") and not event.get("parentToolUseId")
               and (prompt_id is None or event.get("promptId") == prompt_id)
               and text in event.get("text", "") for event in events)


class Run:
    def __init__(self, args, address, org, token):
        self.args, self.address, self.org, self.token = args, address, org, token
        self.run_id = str(uuid.uuid4())
        self.marker = "armada-staging-check:" + self.run_id
        self.child_init = self.marker + " child-init: Reply exactly CHILD_READY without tools, then finish."
        self.memory, self.answer = secrets.token_hex(24), "child-answer:" + secrets.token_hex(24)
        self.started = time.time()
        self.deadline = time.monotonic() + args.timeout
        self.opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
        self.ids, self.checks, self.unverified = [], [], []
        self.parent = self.control = self.child = None
        self.owner = None
        self.owner_prompts = set()
        self.baseline = set()
        self.unknown_allocation = False
        self.delegated_uncertain = False
        self.phase = "preflight"
        self.api_step = "preflight"
        self.failed_step = None
        self._api_trace = None

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise Failure("deadline_exceeded")
        return remaining

    def call(self, route, body, token=None, expected=200, code=None, timeout=30):
        self.api_step = API_STEPS.get(route, "unknown_step")
        trace = {"step": self.api_step, "route": route if route in API_STEPS else "unknown_route",
                 "status": None, "code": None, "reason": None}
        self._api_trace = trace
        try:
            if route not in API_STEPS:
                raise Failure("unsupported_api_route")
            with request_deadline(min(timeout, self.remaining())):
                return self._request(route, body, token, expected, code, timeout)
        except BaseException as error:
            if self.failed_step is None:
                self.failed_step = self.api_step
            if trace["reason"] is None and trace["status"] is None:
                label = str(error) if isinstance(error, Failure) else "interrupted" if isinstance(error, KeyboardInterrupt) else "terminated" if isinstance(error, SystemExit) else "local_failure"
                trace["reason"] = label if label in LOCAL_REASONS else "local_failure"
            raise
        finally:
            # A credential equal to an otherwise safe enum word must still be hidden.
            protected = [value for value in (self.token, token) if isinstance(value, str) and value]
            safe = safe_values(trace, protected)
            emit(safe)

    def _request(self, route, body, token, expected, code, timeout):
        request = urllib.request.Request(self.address + "/api/v1/" + route,
                                        data=json.dumps(body).encode(), method="POST",
                                        headers={"Authorization": "Bearer " + (self.token if token is None else token),
                                                 "Content-Type": "application/json"})
        try:
            response = self.opener.open(request, timeout=min(timeout, self.remaining()))
        except urllib.error.HTTPError as error:
            response = error
        except TimeoutError:
            raise Failure("request_timeout") from None
        except (OSError, urllib.error.URLError):
            raise Failure("request_outcome_unknown") from None
        try:
            self._api_trace["status"] = response.code if isinstance(response.code, int) and 100 <= response.code <= 599 else None
            if isinstance(response.code, int) and 300 <= response.code <= 399:
                raise Failure("redirect_refused")
            raw = response.read(LIMIT + 1)
            if len(raw) > LIMIT:
                raise Failure("response_too_large")
            value = json.loads(raw)
            error = value.get("error") if isinstance(value, dict) else None
            if error is not None:
                if isinstance(error, dict):
                    raw_code = error.get("code")
                    details = error.get("details")
                    raw_reason = error.get("reason")
                    if raw_reason is None and isinstance(details, dict):
                        raw_reason = details.get("reason")
                    self._api_trace["code"] = raw_code if isinstance(raw_code, str) and raw_code in API_CODES else "unknown_code"
                    self._api_trace["reason"] = None if raw_reason is None else raw_reason if isinstance(raw_reason, str) and raw_reason in API_REASONS else "unknown_reason"
                else:
                    self._api_trace.update(code="unknown_code", reason="unknown_reason")

            if response.code != expected or (code and value.get("error", {}).get("code") != code):
                raise Failure("api_refused_or_unexpected")
            if not isinstance(value, dict) or (expected == 200 and "error" in value):
                raise Failure("response_invalid")
            return value
        except (ValueError, TypeError, AttributeError):
            raise Failure("response_invalid") from None
        except TimeoutError:
            raise Failure("request_timeout") from None
        except (OSError, urllib.error.URLError):
            raise Failure("request_outcome_unknown") from None
        finally:
            response.close()

    def tool(self, method, **body):
        return self.call("sandbox/" + method, dict(body, org=self.org))

    def listing(self):
        rows = []
        for page in range(1, 11):
            value = self.tool("list", owner="me", golden=self.args.golden_id, page=page, limit=200)
            rows.extend(value["sandboxes"])
            if value.get("hasMore") is False:
                return rows
        raise Failure("resource_inventory_too_large")

    def logs(self, resource):
        events, cursor = {}, None
        for _ in range(20):
            body = {"id": resource, "org": self.org, "limit": 500, "maxBytes": LIMIT // 2}
            if cursor:
                body["cursor"] = cursor
            value = self.call("logs/read", body)
            for event in value.get("events", []):
                events[event["id"]] = event
            if not value.get("hasMore"):
                return list(events.values())
            if value.get("cursor") == cursor:
                raise Failure("event_cursor_not_advancing")
            cursor = value.get("cursor")
        raise Failure("event_evidence_too_large")

    def record(self, resource):
        resource = identifier(resource)
        if resource in self.baseline or resource in self.ids:
            raise Failure("resource_not_new_or_distinct")
        self.ids.append(resource)
        return resource

    def verify_resource(self, resource, owner=None):
        rows = [row for row in self.listing() if row.get("id") == resource]
        if len(rows) != 1:
            raise Failure("resource_identity_unconfirmed")
        row = rows[0]
        try:
            created = __import__("datetime").datetime.fromisoformat(row["createdAt"].replace("Z", "+00:00")).timestamp()
        except (ValueError, KeyError, TypeError):
            raise Failure("resource_identity_unconfirmed") from None
        if (row.get("orgId") != self.org or row.get("provider") != self.args.provider
                or row.get("harness") != self.args.harness or created < self.started - 5
                or (owner and row.get("ownerId") != owner)):
            raise Failure("resource_identity_unconfirmed")
        state = self.tool("status", id=resource)
        if state.get("golden") != self.args.golden or state.get("model") != self.args.model:
            raise Failure("resource_selection_unconfirmed")
        return row

    def settled(self, resource, prompt):
        while True:
            value = self.tool("status", id=resource, prompt_id=prompt)
            if value.get("settled"):
                if value.get("prompt", {}).get("state") != "finished":
                    raise Failure("agent_turn_not_finished")
                return value
            time.sleep(min(2, self.remaining()))

    def stop(self, resource):
        if self.tool("status", id=resource).get("status") != "stopped":
            result = self.tool("stop", id=resource)
            if result.get("preservationNote") == "checkpoint_failed_disk_not_retained":
                raise Failure("checkpoint_not_retained")
        while self.tool("status", id=resource).get("status") != "stopped":
            time.sleep(min(2, self.remaining()))

    def launch(self, access, prompt):
        self.owner_prompts.add(prompt)
        body = {"org": self.org, "golden": self.args.golden, "provider": self.args.provider,
                "harness": self.args.harness, "credentialId": self.args.account_id,
                "model": self.args.model, "ttlSeconds": self.args.timeout,
                "connections": [], "skills": [], "skipSkillDefaults": True, "prompt": prompt}
        if self.args.repo:
            body["repo"] = self.args.repo
        if access:
            body.update(armadaAccessVersion=1, armadaAccess={"maxActiveChildren": 1})
        self.unknown_allocation = True
        # Even a negative control must be audited before assuming no delegated effect.
        self.delegated_uncertain = True
        value = self.call("sandbox/launch-access-v1" if access else "sandbox/launch", body, timeout=120)
        resource = self.record(value["sandbox"]["id"])
        if access:
            self.parent = resource
        else:
            self.control = resource
        if value["sandbox"].get("credentialId") != self.args.account_id or value["sandbox"].get("credentialVersion") != self.args.account_version:
            raise Failure("account_binding_unconfirmed")
        self.unknown_allocation = False
        if (access and value.get("armadaAccess", {}).get("enabled") is not True) or (not access and value.get("armadaAccess")):
            raise Failure("access_option_not_confirmed")
        return resource, value

    def successful(self, call):
        result = call.get("result", {})
        if result.get("isError") is not False:
            raise Failure("scoped_operation_not_successful")
        return decoded(result.get("output"))

    def scenario(self):
        selected = [row for row in self.call("golden/list", {"org": self.org})["goldens"]
                    if row.get("id") == self.args.golden_id and row.get("name") == self.args.golden
                    and row.get("provider") == self.args.provider and row.get("orgId") == self.org]
        if len(selected) != 1:
            raise Failure("golden_selection_unconfirmed")
        self.api_step = "repository_preflight"
        self.args.repo = repository_selector(self.args.repo, selected[0].get("config"))
        self.baseline = {identifier(row["id"]) for row in self.listing()}
        selection = {"goldenId": self.args.golden_id, "harness": self.args.harness,
                     "credentialId": self.args.account_id, "credentialVersion": self.args.account_version,
                     "model": self.args.model, "prompt": self.child_init}
        if self.args.repo:
            selection["repo"] = self.args.repo
        self.phase = "delegated_child_roundtrip"
        task = (self.marker + " Remember memory nonce " + self.memory + " only in this conversation; do not write files. "
                "Use only native armada_orchestrator MCP tools, never shell/HTTP/owner credentials. "
                "Launch exactly ONE child, idempotencyKey " + self.run_id + "-launch, selection " + json.dumps(selection) + ". "
                "Poll delegated read until the child-init prompt event explicitly has status finished; do not message a running turn. "
                "Then message that child using idempotencyKey " + self.run_id + "-message and text "
                + json.dumps(self.marker + " Reply exactly " + self.answer) + ". "
                "Poll delegated read until the CHILD assistant answers; then stop it with idempotencyKey "
                + self.run_id + "-stop. Retain its ID and the memory nonce; finish without extra workers or tools.")
        self.parent, first = self.launch(True, task)
        emit({"event": "parent_created", "id": self.parent})
        owner = identifier(self.verify_resource(self.parent)["ownerId"])
        self.owner = owner
        prompt_id, conversation = first["promptId"], first["conversationId"]
        self.settled(self.parent, prompt_id)
        tools = scoped_tools(self.logs(self.parent), prompt_id)
        launches = [call for call in tools if call["method"] == "launch"]
        if len(launches) != 1 or launches[0].get("input") != {"idempotencyKey": self.run_id + "-launch", "selection": selection}:
            raise Failure("scoped_launch_evidence_missing")
        receipt = self.successful(launches[0])
        candidate = identifier(receipt["sandboxId"])
        if receipt.get("state") != "succeeded":
            raise Failure("child_allocation_unconfirmed")
        # Native results are evidence, not authorization to stop arbitrary IDs.
        self.verify_resource(candidate, owner)
        prompts = [event for event in self.logs(candidate) if event.get("kind") == "prompt"]
        if not prompts or prompts[0].get("text") != selection["prompt"]:
            raise Failure("child_prompt_marker_unconfirmed")
        self.child = self.record(candidate)
        emit({"event": "child_discovered", "id": self.child})
        for call in tools:
            method = call["method"]
            if method == "launch":
                continue
            expected = {"sandboxId": self.child}
            if method != "read":
                expected["idempotencyKey"] = self.run_id + "-" + method
            if method == "message":
                expected["text"] = self.marker + " Reply exactly " + self.answer
            if call.get("input") != expected:
                raise Failure("unapproved_native_action")
        message_index = next((index for index, call in enumerate(tools) if call["method"] == "message"), -1)
        if not any(call["method"] == "read" and any(event.get("kind") == "prompt"
                   and event.get("text") == self.child_init and event.get("status") == "finished"
                   for event in self.successful(call).get("events", []))
                   for call in tools[:max(message_index, 0)]):
            raise Failure("child_initial_turn_not_confirmed_before_message")
        self.delegated_uncertain = False
        required = {"message": False, "read": False, "stop": False}
        for call in tools:
            method = call["method"]
            if method not in required or call.get("input", {}).get("sandboxId") != self.child:
                continue
            value = self.successful(call)
            if method == "read":
                required[method] |= (value.get("id") == self.child and value.get("credentialId") == self.args.account_id
                                     and value.get("credentialVersion") == self.args.account_version
                                     and assistant_has(value.get("events", []), self.answer))
            else:
                required[method] |= (value.get("sandboxId") == self.child and value.get("state") == "succeeded"
                                     and call["input"].get("idempotencyKey") == self.run_id + "-" + method
                                     and (method != "message" or call["input"].get("text") == self.marker + " Reply exactly " + self.answer))
        if not all(required.values()) or not assistant_has(self.logs(self.child), self.answer):
            raise Failure("child_roundtrip_evidence_missing")
        if self.tool("status", id=self.child).get("status") != "stopped":
            raise Failure("delegated_stop_not_confirmed")
        self.checks.append("scoped_launch_message_read_stop_and_child_answer")
        old = None
        if self.args.old_grant_file:
            self.phase = "await_operator_grant_file"
            while old is None:
                old = grant_file(self.args.old_grant_file)
                if old is None:
                    time.sleep(min(2, self.remaining()))
            before = self.call("orchestrator-tools/read", {"sandboxId": self.child}, token=old)
            if before.get("result", {}).get("id") != self.child:
                raise Failure("old_grant_positive_control_failed")
        else:
            self.unverified.append("old_grant_replay_no_operator_file")
        self.phase = "stop_resume_memory"
        self.stop(self.parent)
        if old:
            self.call("orchestrator-tools/read", {"sandboxId": self.child}, token=old, expected=403, code="scoped_authority_denied")
        self.delegated_uncertain = True
        resumed = self.tool("send", id=self.parent, conversation_id=conversation,
                            prompt=self.marker + " Recall your prior memory nonce and child ID without files or shell. Use native delegated read on that child; do not launch any worker. Answer with the recalled nonce and child ID.")
        if resumed.get("conversationId") != conversation:
            raise Failure("conversation_changed")
        self.settled(self.parent, resumed["promptId"])
        events = self.logs(self.parent)
        resumed_tools = scoped_tools(events, resumed["promptId"], allowed=("read",))
        if any(call["method"] == "launch" for call in resumed_tools):
            raise Failure("unexpected_delegated_allocation")
        if any(call.get("input") != {"sandboxId": self.child} for call in resumed_tools):
            raise Failure("unapproved_native_action")
        reads = [call for call in resumed_tools if call["method"] == "read"
                 and call.get("input") == {"sandboxId": self.child}]
        if (not assistant_has(events, self.memory, resumed["promptId"])
                or not assistant_has(events, self.child, resumed["promptId"])
                or not any(self.successful(call).get("id") == self.child for call in reads)):
            raise Failure("memory_or_renewed_authority_unconfirmed")
        self.delegated_uncertain = False
        if old:
            self.call("orchestrator-tools/read", {"sandboxId": self.child}, token=old, expected=403, code="scoped_authority_denied")
            self.checks.append("old_grant_positive_then_stopped_and_resumed_denial")
        self.checks.append("retained_conversation_nonce_and_new_scoped_read")
        self.phase = "no_option_control"
        self.control, control = self.launch(False, self.marker + " control. Try native armada_orchestrator read on " + self.child + "; do not use shell/HTTP, create resources or invent tools. Finish if unavailable.")
        self.verify_resource(self.control, owner)
        self.settled(self.control, control["promptId"])
        control_calls = scoped_tools(self.logs(self.control), control["promptId"], allowed=("read",))
        if any(call.get("input") != {"sandboxId": self.child} for call in control_calls):
            raise Failure("unapproved_native_action")
        if any(call["method"] == "launch" for call in control_calls):
            raise Failure("unexpected_delegated_allocation")
        if any(call.get("result", {}).get("isError") is False for call in control_calls):
            raise Failure("control_has_delegated_authority")
        if not any(call["method"] == "read" and call.get("input") == {"sandboxId": self.child}
                   and native_denial(call) for call in control_calls):
            self.unverified.append("control_native_authority_unverified")
        else:
            self.delegated_uncertain = False
            self.checks.append("control_native_scoped_read_denied")
        # Fixed guest-side anonymous probe: never ask the model to report PASS.
        source = ("import urllib.request,urllib.error,json\n"
                  "r=urllib.request.Request(" + repr(self.address + "/api/v1/orchestrator-tools/read")
                  + ",data=" + repr(json.dumps({"sandboxId": self.child}).encode()) + ",headers={'Content-Type':'application/json'})\n"
                  "class N(urllib.request.HTTPRedirectHandler):\n def redirect_request(self,*a,**k): return None\n"
                  "try:\n urllib.request.build_opener(N()).open(r,timeout=15); print('unexpected_success')\n"
                  "except urllib.error.HTTPError as e:\n b=e.read(4096); v=json.loads(b); print('control-denied' if e.code==401 and v.get('error',{}).get('code')=='invalid_epoch_authority' else 'unexpected_denial')\n")
        import shlex
        probe = self.tool("exec", id=self.control, command="python3 -c " + shlex.quote(source), timeout_seconds=20)
        if probe.get("exitCode") != 0 or probe.get("truncated") or probe.get("timedOut"):
            raise Failure("control_probe_unconfirmed")
        if probe.get("stdout", "").strip() != "control-denied":
            raise Failure("control_probe_not_denied")
        self.checks.append("control_anonymous_gateway_denied_no_successful_native_call")

    def cleanup(self):
        self.deadline = time.monotonic() + 90
        failed = False
        # Fence known producers BEFORE inventory: a timed-out turn may still allocate.
        fenced = {resource for resource in (self.parent, self.control) if resource}
        for resource in (self.parent, self.control):
            if resource:
                try:
                    self.stop(resource)
                except (Failure, KeyError, TypeError, ValueError):
                    failed = True
        try:
            # Only prompt-marked, newly created owner resources can be discovered.
            for row in sorted(self.listing(), key=lambda row: row.get("createdAt", "")):
                candidate = identifier(row["id"])
                if candidate not in self.baseline and candidate not in self.ids:
                    try:
                        self.verify_resource(candidate, self.owner)
                    except Failure as error:
                        if str(error) in ("resource_identity_unconfirmed", "resource_selection_unconfirmed"):
                            continue  # Not an independently correlated run resource.
                        raise
                    prompts = [event for event in self.logs(candidate) if event.get("kind") == "prompt"]
                    if prompts and prompts[0].get("text") in self.owner_prompts | {self.child_init}:
                        self.record(candidate)
        except (Failure, KeyError, TypeError, ValueError):
            failed = True
        for resource in self.ids:
            if resource not in fenced:
                try:
                    self.stop(resource)
                except (Failure, KeyError, TypeError, ValueError):
                    failed = True
        # An empty list cannot prove that a pending/uncertain child never allocated.
        return not failed and not self.unknown_allocation and not self.delegated_uncertain


def arguments(argv):
    parser = Parser(description=__doc__)
    parser.add_argument("--provider", choices=("boat", "modal"), required=True)
    parser.add_argument("--harness", choices=("codex", "claude"), required=True)
    for name in ("golden", "golden-id", "account-id", "model"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--account-version", type=int, required=True)
    parser.add_argument("--repo")
    parser.add_argument("--old-grant-file")
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--confirm-real-compute", action="store_true", required=True)
    args = parser.parse_args(argv)
    args.golden_id, args.account_id = identifier(args.golden_id), identifier(args.account_id)
    if not 60 <= args.timeout <= 1800 or args.account_version < 1:
        raise Failure("invalid_arguments")
    return args


def main(argv=None, env=None):
    env = os.environ if env is None else env
    run, failure, cleaned = None, None, True
    proof_step = "validation"
    def terminate(_signal, _frame):
        raise SystemExit(1)
    previous_term = signal.signal(signal.SIGTERM, terminate)
    try:
        args = arguments(sys.argv[1:] if argv is None else argv)
        if not all(env.get(name) for name in ("STAGING_URL", "STAGING_ORG", "ARMADA_TOKEN")):
            raise Failure("staging_environment_required")
        run = Run(args, origin(env["STAGING_URL"]), identifier(env["STAGING_ORG"]), env["ARMADA_TOKEN"])
        run.scenario()
    except Failure as error:
        failure = str(error)
    except KeyboardInterrupt:
        failure = "interrupted"
    except SystemExit:
        if run is None:
            raise
        failure = "terminated"
    except Exception:
        failure = "unsupported_response_or_local_failure"
    finally:
        if run:
            proof_step = run.failed_step or run.api_step
            previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            try:
                cleaned = run.cleanup()
            except BaseException:
                cleaned = False
            finally:
                signal.signal(signal.SIGINT, previous)
        signal.signal(signal.SIGTERM, previous_term)
    cause = failure if not cleaned else None
    if not cleaned:
        failure = "cleanup_not_confirmed"
    unverified = run.unverified if run else []
    status = "FAILED" if failure else "UNVERIFIED" if unverified else "PASS"
    emit(safe_values({"status": status, "reason": failure, "cause": cause, "phase": run.phase if run else "validation", "step": proof_step, "checks": run.checks if run else [],
                      "unverified": unverified, "cleanupConfirmed": cleaned,
                      "resources": run.ids if run else []}, [env.get("ARMADA_TOKEN", "")]))
    return 0 if status == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
