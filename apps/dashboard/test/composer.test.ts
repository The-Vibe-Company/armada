import { describe, expect, test } from "bun:test";
import {
  chosenConversation,
  composerAdmission,
  drivingFailureMessage,
  messageKeyFor,
  modelChange,
  PINNED_MODEL,
  pinnedSend,
  UNCONFIRMED_ACTION,
} from "../src/lib/composer.ts";

const fields = (model = "", otherModel = "", reasoningEffort = "") => ({ model, otherModel, reasoningEffort });

describe("composer guards", () => {
  test("only a conversation recorded for the sandbox can be targeted; none lets the server choose", () => {
    expect(chosenConversation("conv-b", ["conv-a", "conv-b"])).toEqual({ ok: true, id: "conv-b" });
    expect(chosenConversation(" ", ["conv-a"])).toEqual({ ok: true, id: undefined });
    expect(chosenConversation("conv-x", ["conv-a"])).toMatchObject({ ok: false });
  });

  test("a model or effort choice is a change a steer refuses; an empty other model id is never the launch model", () => {
    expect(modelChange(fields())).toBe("none");
    expect(modelChange(fields("", "", "high"))).toBe("changed");
    expect(modelChange(fields("gpt-6-luna"))).toBe("changed");
    expect(modelChange(fields("other", "my-model"))).toBe("changed");
    expect(modelChange(fields("other", "  "))).toBe("incomplete");
  });

  test("a Docker send carries its request key and no model overrides", () => {
    const key = "0b9f3c1e-7d2a-4c5b-9e8f-1a2b3c4d5e6f";
    expect(pinnedSend(fields(), key)).toEqual({ ok: true, requestId: key });
    expect(pinnedSend(fields("", "", "high"), key)).toEqual({ ok: false, error: PINNED_MODEL });
    expect(pinnedSend(fields(), "")).toMatchObject({ ok: false });
    expect(pinnedSend(fields(), key.toUpperCase())).toMatchObject({ ok: false });
  });
});

test("composer failures preserve curated recovery steps and never echo API details", () => {
  const raw = "HTTP 503: request_id invalid, image sha256:abc";
  expect(drivingFailureMessage({ message: raw }, true)).toBe(UNCONFIRMED_ACTION);
  expect(drivingFailureMessage({ message: raw, code: "new_provider_failure" }, true)).toBe(UNCONFIRMED_ACTION);
  expect(drivingFailureMessage({ message: raw, code: "credential_binding_required" }, true)).toContain(
    "Choose one above.",
  );
  expect(drivingFailureMessage({ message: raw, code: "credential_binding_required" }, false)).toContain(
    "Only its owner",
  );
  expect(drivingFailureMessage({ message: raw, code: "usage_limit" }, true)).toContain("plan or billing limit");
  expect(drivingFailureMessage({ message: raw, code: "outcome_unknown" }, true)).toContain("before retrying");
  expect(drivingFailureMessage({ message: raw, status: 401 }, true)).toContain("Sign in again");
  expect(drivingFailureMessage({ message: raw, status: 403 }, true)).toContain("check your access");
  expect(drivingFailureMessage({ message: raw }, true, true)).toBe(
    "The host could not confirm delivery. Send the same message again without editing it to check.",
  );
  for (const message of [
    "Docker prompt admission pending. Retry with request_id.",
    "Runtime send outcome is uncertain; reuse the original request_id and identical input.",
    "Resume outcome unknown; inspect status with the same request_id.",
  ])
    expect(drivingFailureMessage({ message }, true, true)).toBe(
      "The message has not been confirmed and may still run. Keep it unchanged and check the sandbox status before retrying.",
    );
});

test("ordinary message keys survive unchanged retries and rotate for any submitted choice", () => {
  const fields = ["sandbox", "prompt", "conversation", "model", "other_model", "reasoning_effort"];
  const data = new FormData();
  for (const name of fields) data.set(name, `${name}-original`);
  let serial = 0;
  const fresh = () => `key-${++serial}`;
  const first = messageKeyFor(null, data, fresh);
  expect(messageKeyFor(first, data, fresh)).toEqual(first);
  for (const name of fields) {
    const changed = new FormData();
    for (const [field, value] of data) changed.set(field, value);
    changed.set(name, "changed");
    expect(messageKeyFor(first, changed, fresh).key).not.toBe(first.key);
  }
});

test("terminal sandbox refusal keeps actionable guidance for keyed and ordinary controls", () => {
  const message =
    "Cannot control docker sandbox: stopped. Its container is removed; start a new sandbox on the same branch.";
  for (const keyed of [true, false])
    expect(drivingFailureMessage({ code: "sandbox_terminal", message }, true, keyed)).toBe(message);
});

describe("composer admission", () => {
  const now = new Date("2026-11-18T08:00:00Z");
  const docker = {
    provider: "docker",
    status: "stopped",
    renderedStatus: "stopped",
    renderedStatusReason: "work_merged",
    idlePaused: false,
    preservationNote: null,
    expiresAt: "2026-11-19T08:00:00Z",
  };

  test("a Docker merge stop takes a message that wakes its retained checkpoint; a finished one does not", () => {
    expect(composerAdmission(docker, now)).toEqual({ refusal: null, wakes: true });
    const finished = composerAdmission({ ...docker, renderedStatusReason: "agent_finished" }, now);
    expect(finished.refusal).toContain("container is removed");
    expect(finished.wakes).toBe(false);
  });

  test("a rendered stop reason is ignored once a poll reports another status", () => {
    const polled = composerAdmission(
      { ...docker, renderedStatus: "running", renderedStatusReason: "work_merged" },
      now,
    );
    expect(polled.refusal).toContain("container is removed");
    expect(polled.wakes).toBe(false);
  });
});
