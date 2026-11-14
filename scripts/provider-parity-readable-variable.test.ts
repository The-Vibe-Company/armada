import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { prepareReadableProbe, type ReadableProbeIo } from "./provider-parity-readable-variable.ts";

const binding = { id: "abcdef01-0000-4000-8000-000000000001", version: 1, key: "ARMADA_PARITY_READABLE" };
const template = { id: "10000000-0000-4000-8000-000000000001", revision: 2 };
function fixture(mode: string, provider: "boat" | "modal" | "docker" = "modal") {
  const value = `parity_readable_${crypto.randomUUID()}`;
  const reference = { key: binding.key, variableId: binding.id, version: 1 };
  const calls: string[] = [];
  let digest = "",
    reads = 0;
  const io: ReadableProbeIo = {
    until: 110_000,
    poll: async (read, done, attempts, until) => {
      expect(attempts).toBe(110);
      expect(until).toBe(110_000);
      for (let i = 0; i < 3; i++) {
        const result = await read();
        if (done(result)) return result;
      }
      throw new Error("poll exhausted");
    },
    request: async <T>(path: string, body: object): Promise<T> => {
      calls.push(path);
      let result: unknown;
      if (path === "templates/get") {
        expect(body).toEqual(template);
        result = {
          revision: {
            revision: mode === "revision" ? 3 : 2,
            definition: {
              variables:
                mode === "duplicate"
                  ? [reference, reference]
                  : [{ ...reference, variableId: mode === "reference" ? "wrong" : binding.id }],
            },
          },
        };
      } else if (path === "variables/read") {
        expect(body).toEqual({ id: binding.id });
        result = {
          item: { id: binding.id, version: mode === "rotated" ? 2 : 1, status: "active" },
          value: mode === "non_canary" ? "private_config_placeholder" : value,
        };
      } else if (path === "sandbox/exec") {
        const execution = body as { command: string; request_id?: string };
        expect(execution.command).not.toContain(value);
        expect(Boolean(execution.request_id)).toBe(provider === "docker");
        const nonce = execution.command.match(/'([a-f0-9-]{36})'/)?.[1];
        expect(nonce).toBeDefined();
        result = {
          exitCode: 0,
          timedOut: false,
          stdout:
            mode === "wrong_environment"
              ? "wrong_digest"
              : createHash("sha256").update(`${value}:${nonce}`).digest("hex"),
        };
      } else if (path === "sandbox/send") {
        const sent = body as { id: string; prompt: string; request_id?: string };
        expect(sent.id).toBe("sandbox");
        expect(sent.prompt).toContain(`$${binding.key}`);
        expect(sent.prompt).not.toContain(value);
        expect(sent.prompt).toContain("sha256sum");
        expect(Boolean(sent.request_id)).toBe(provider === "docker");
        const nonce = sent.prompt.match(/'([a-f0-9-]{36})'/)?.[1];
        expect(nonce).toBeDefined();
        digest = createHash("sha256")
          .update(`${mode === "wrong_value" ? "wrong" : value}:${nonce}`)
          .digest("hex");
        expect(sent.prompt).not.toContain(digest);
        result = { promptId: "turn" };
      } else if (path === "logs/read") {
        reads++;
        expect(body).toMatchObject({ id: "sandbox", coalesce: true, maxBytes: 262144 });
        const message = {
          id: "message",
          kind: "message",
          promptId: mode === "wrong_prompt" ? "other" : "turn",
          text: digest,
          partial: mode === "partial",
          responseKind: mode === "echo" ? "tool_result" : "assistant",
          parentToolUseId: mode === "child" ? "parent" : undefined,
          retracted: mode === "retracted" && reads > 1,
        };
        result = {
          cursor: `page_${reads}`,
          events: [
            ...(mode === "retracted" && reads === 1
              ? []
              : [
                  {
                    id: "finished",
                    kind: "prompt",
                    promptId: "turn",
                    status: mode === "failed" ? "failed" : "finished",
                  },
                ]),
            ...(mode === "delta"
              ? [
                  { ...message, text: digest.slice(0, 32), partial: true, textMode: "delta" },
                  { ...message, text: digest.slice(32), textMode: "delta" },
                ]
              : [message]),
          ],
        };
      } else throw new Error(`Unexpected route ${path}`);
      return result as T;
    },
  };
  return { io, provider, calls, reference };
}

// Owns the canary binding and native digest oracle; no provider or subprocess is used.
test.each(["boat", "modal", "docker"] as const)(
  "proves readable delivery without exposing the value on %s",
  async (provider) => {
    const f = fixture("success", provider);
    const probe = await prepareReadableProbe(template, binding, f.io);
    probe.verifyManifest({ variableProvenance: [f.reference] });
    await probe.verify("sandbox", provider);
    expect(f.calls).toEqual(["templates/get", "variables/read", "sandbox/exec", "sandbox/send", "logs/read"]);
  },
);

test.each(["revision", "reference", "duplicate", "rotated", "non_canary", "unsafe_key"])(
  "refuses unsafe/stale fixture before a model turn: %s",
  async (mode) => {
    const f = fixture(mode);
    await expect(
      prepareReadableProbe(template, mode === "unsafe_key" ? { ...binding, key: "PATH;unsafe" } : binding, f.io),
    ).rejects.toThrow(mode === "non_canary" ? "readable_canary_required" : "invalid_readable_binding");
    expect(f.calls).not.toContain("sandbox/send");
  },
);

test("frozen manifest cannot substitute a different variable version", async () => {
  const f = fixture("success");
  const probe = await prepareReadableProbe(template, binding, f.io);
  expect(() => probe.verifyManifest({ variableProvenance: [{ ...f.reference, version: 2 }] })).toThrow(
    "invalid_readable_binding",
  );
  expect(f.calls).not.toContain("sandbox/send");
});

test.each(["wrong_value", "echo", "child", "partial", "retracted", "wrong_prompt", "failed"])(
  "requires the final parent assistant digest and exact turn outcome: %s",
  async (mode) => {
    const f = fixture(mode);
    const probe = await prepareReadableProbe(template, binding, f.io);
    await expect(probe.verify("sandbox", f.provider)).rejects.toThrow(
      mode === "failed" ? "readable_turn_failed" : "poll exhausted",
    );
  },
);

test("coalesced native deltas remain correlated to one final message", async () => {
  const f = fixture("delta");
  const probe = await prepareReadableProbe(template, binding, f.io);
  await probe.verify("sandbox", f.provider);
});

test("a native answer alone cannot hide missing guest environment delivery", async () => {
  const f = fixture("wrong_environment");
  const probe = await prepareReadableProbe(template, binding, f.io);
  await expect(probe.verify("sandbox", f.provider)).rejects.toThrow("readable_delivery_mismatch");
  expect(f.calls).not.toContain("sandbox/send");
});

test("variable UUID casing does not change binding identity", async () => {
  const f = fixture("success");
  const probe = await prepareReadableProbe(template, { ...binding, id: binding.id.toUpperCase() }, f.io);
  probe.verifyManifest({ variableProvenance: [f.reference] });
  await probe.verify("sandbox", f.provider);
});
