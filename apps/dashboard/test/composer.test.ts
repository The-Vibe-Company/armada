import { describe, expect, test } from "bun:test";
import {
  chosenConversation,
  dockerSend,
  drivingFailureMessage,
  modelChange,
  PINNED_MODEL,
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
    expect(dockerSend(fields(), key)).toEqual({ ok: true, requestId: key });
    expect(dockerSend(fields("", "", "high"), key)).toEqual({ ok: false, error: PINNED_MODEL });
    expect(dockerSend(fields(), "")).toMatchObject({ ok: false });
    expect(dockerSend(fields(), key.toUpperCase())).toMatchObject({ ok: false });
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
  expect(
    drivingFailureMessage({ message: "Docker prompt admission pending. Retry with request_id." }, true, true),
  ).toBe("The host has not confirmed the message yet. Send it again unchanged to check, without editing it.");
});
