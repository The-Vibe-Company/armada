import { describe, expect, test } from "bun:test";
import {
  composerAdmission,
  composerKeyAction,
  drivingFailureMessage,
  isDefiniteComposerRefusal,
  messageKeyFor,
  modelChange,
  PINNED_MODEL,
  pinnedSend,
  UNCERTAIN_SEND_MESSAGE,
  UNCONFIRMED_ACTION,
} from "./composer.ts";

const fields = (model = "", otherModel = "", reasoningEffort = "") => ({ model, otherModel, reasoningEffort });

describe("composer guards", () => {
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
  const fields = ["sandbox", "prompt", "model", "other_model", "reasoning_effort"];
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

  test("expiry and lost retention prevent a Docker wake", () => {
    const ordinary = { ...docker, renderedStatusReason: null };
    for (const change of [
      { expiresAt: now.toISOString() },
      { preservationNote: "checkpoint_failed_disk_not_retained" },
    ]) {
      const admission = composerAdmission({ ...ordinary, ...change }, now);
      expect(admission.refusal).toContain("same branch");
      expect(admission.wakes).toBe(false);
    }
  });

  test("a rendered stop reason is ignored once a poll reports another status", () => {
    const polled = composerAdmission(
      { ...docker, renderedStatus: "running", renderedStatusReason: "agent_finished" },
      now,
    );
    expect(polled).toEqual({ refusal: null, wakes: true });
  });

  test("isDefiniteComposerRefusal excludes unconfirmed and outcome_unknown failures", () => {
    expect(isDefiniteComposerRefusal({ ok: true })).toBe(false);
    expect(isDefiniteComposerRefusal({ ok: false, error: UNCONFIRMED_ACTION })).toBe(false);
    expect(isDefiniteComposerRefusal({ ok: false, error: UNCERTAIN_SEND_MESSAGE })).toBe(false);
    expect(
      isDefiniteComposerRefusal({
        ok: false,
        error: drivingFailureMessage({ message: "unknown", code: "outcome_unknown" }, true),
      }),
    ).toBe(false);
    expect(
      isDefiniteComposerRefusal({
        ok: false,
        error: drivingFailureMessage({ message: "Sandbox stopped", code: "sandbox_terminal" }, true),
      }),
    ).toBe(true);
  });
});

describe("composer keyboard shortcuts", () => {
  const base = { shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false };
  const idle = { running: false, pending: false };
  const running = { running: true, pending: false };

  test("Enter and Cmd/Ctrl+Enter submit; Shift+Enter, Alt+Enter, IME and Escape follow rules", () => {
    const cases: Array<[Partial<typeof base> & { key: string; keyCode?: number }, typeof idle, string]> = [
      [{ key: "Enter" }, idle, "submit"],
      [{ key: "Enter", metaKey: true }, idle, "submit"],
      [{ key: "Enter", ctrlKey: true }, idle, "submit"],
      [{ key: "Enter", shiftKey: true }, idle, "none"],
      [{ key: "Enter", metaKey: true, shiftKey: true }, idle, "none"],
      [{ key: "Enter", altKey: true }, idle, "none"],
      [{ key: "Enter", isComposing: true }, idle, "none"],
      [{ key: "Enter", keyCode: 229 }, idle, "none"],
      [{ key: "Escape" }, running, "interrupt"],
      [{ key: "Escape" }, idle, "none"],
      [{ key: "Escape" }, { running: true, pending: true }, "none"],
      [{ key: "Escape", shiftKey: true }, running, "none"],
      [{ key: "Escape", isComposing: true }, running, "none"],
    ];
    for (const [ev, opts, expected] of cases) expect(composerKeyAction({ ...base, ...ev }, opts)).toBe(expected);
  });
});
