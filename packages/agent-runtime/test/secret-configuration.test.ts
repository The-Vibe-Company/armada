import { expect, test } from "bun:test";
import type { AgentEvent } from "@armada/core";
import { type Driver, Journal, Runner } from "../src/index.ts";

const grant = {
  token: "runtime_fixture_grant",
  sandboxId: "logical",
  generation: "1",
  expiresAt: Date.now() + 60_000,
};
const command = { version: 1 as const, requestId: "configure_fixture", sandboxId: grant.sandboxId };

test.each([
  { secret: 'opaque_fixture_\n"value', prefix: "", suffix: "" },
  { secret: "ess", prefix: "prefix", suffix: "suffix" },
  { secret: "stderr", prefix: "prefix", suffix: "suffix" },
  { secret: "harness_stderr", prefix: "prefix-", suffix: "-suffix" },
  { secret: "snapshot", prefix: "prefix", suffix: "suffix" },
  { secret: "abc", prefix: "prefix", suffix: "suffix", overlap: "bc12345", extension: "12345" },
  { secret: "abc", prefix: "", suffix: "suffix", overlap: "bc!xyz", extension: "!xyz", wholeField: true },
])("masks marked values in event text ($secret)", async (fixture) => {
  const { secret, prefix, suffix, overlap, extension = "", wholeField } = fixture;
  const journal = new Journal(":memory:", (text) => text);
  const variables = { APP_TOKEN: secret, APP_REGION: "fixture_region", ...(overlap ? { APP_OTHER: overlap } : {}) };
  let environment: Record<string, string> = {};
  const driver: Driver = {
    configureReadableVariables(values) {
      environment = values;
    },
    start({ emit }) {
      const text = `${prefix}${environment.APP_TOKEN}${extension}${suffix} ${environment.APP_REGION}`;
      emit({ kind: "other", type: "harness_stderr", data: { text } });
      emit({ kind: "other", type: "raw_diagnostic_fixture", data: { text }, rawDiagnostic: true });
      emit({ kind: "message", text, textMode: "snapshot", partial: false, tools: [], messageId: "message_fixture" });
      return { done: Promise.resolve("finished"), async interrupt() {}, async steer() {} };
    },
    async close() {},
  };
  const runner = new Runner(journal, grant, { codex: driver });
  try {
    const ack = await runner.handleDialout({
      ...command,
      op: "configureReadableVariables",
      harness: "codex",
      variables,
      secretKeys: overlap ? ["APP_TOKEN", "APP_OTHER"] : ["APP_TOKEN"],
    });
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual({ version: 1, requestId: command.requestId, result: { acknowledged: true } });
    expect(environment).toEqual(variables);
    const prompt = await runner.handleDialout({
      ...command,
      requestId: "prompt_fixture",
      op: "prompt",
      input: { sandboxId: grant.sandboxId, harness: "codex", text: "emit diagnostic" },
    });
    expect(prompt.status).toBe(200);
    const events = await runner.handleDialout({ ...command, requestId: "events_fixture", op: "events" });
    const body = await events.json();
    const text = wholeField ? "[REDACTED]" : `${prefix}[REDACTED]${suffix} fixture_region`;
    expect(body).toMatchObject({
      result: {
        events: expect.arrayContaining([
          expect.objectContaining({ kind: "other", type: "harness_stderr", data: { text } }),
          expect.objectContaining({ kind: "message", text, textMode: "snapshot", messageId: "message_fixture" }),
        ]),
      },
    });
    const diagnostics = journal
      .events()
      .flatMap(({ event }) => (event.kind === "other" && event.type === "raw_diagnostic_fixture" ? [event] : []));
    if (secret.length < 8) expect(diagnostics).toHaveLength(0);
    else expect(diagnostics).toEqual([expect.objectContaining({ data: { text } })]);
    expect(JSON.stringify(journal.events())).not.toContain("rawDiagnostic");
    expect(JSON.stringify(journal.events())).not.toContain(
      JSON.stringify(`${prefix}${secret}${extension}${suffix}`).slice(1, -1),
    );
    expect(journal.db.query("select 1 from requests where id=?").get(command.requestId)).toBeNull();
  } finally {
    await runner.close();
    journal.close();
  }
});

test("invalid secret keys do not configure the harness or consume its configuration slot", async () => {
  const journal = new Journal(":memory:", (text) => text);
  const runner = new Runner(journal, grant, {
    codex: {
      configureReadableVariables() {},
      start() {
        throw Error("unexpected prompt");
      },
      async close() {},
    },
  });
  try {
    const configure = {
      ...command,
      op: "configureReadableVariables" as const,
      harness: "codex" as const,
      variables: { APP_REGION: "fixture_region" },
    };
    for (const secretKeys of [["APP_ABSENT"], ["APP_REGION", "APP_REGION"]]) {
      const rejected = await runner.handleDialout({ ...configure, secretKeys });
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toEqual({ error: "invalid_request" });
    }
    expect((await runner.handleDialout(configure)).status).toBe(200);
  } finally {
    await runner.close();
    journal.close();
  }
});

test("event pages mask values registered after append while preserving the stored event", async () => {
  const journal = new Journal(":memory:", (text) => text);
  const runner = new Runner(journal, grant, {});
  try {
    const message = {
      id: "stored_answer",
      at: 1,
      kind: "message",
      textMode: "snapshot",
      text: "prefix-snapshot-suffix",
      partial: false,
      tools: [],
    } satisfies AgentEvent;
    journal.append(message);
    journal.registerApplicationSecrets(["snapshot"]);
    const response = await runner.handleDialout({ ...command, op: "events" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { cursor: "1", hasMore: false, events: [{ ...message, text: "prefix-[REDACTED]-suffix" }] },
    });
    expect(journal.events()).toEqual([{ sequence: 1, event: message }]);
  } finally {
    await runner.close();
    journal.close();
  }
});

test("checkpoint sanitation masks a short value registered after stderr append", () => {
  const journal = new Journal(":memory:", (text) => text);
  try {
    journal.append({
      id: "diagnostic",
      at: 1,
      kind: "other",
      type: "harness_stderr",
      data: { text: "prefix-embeddedvalue-suffix" },
    });
    journal.registerApplicationSecrets(["value", "harness_stderr"]);
    journal.sanitize();
    expect(journal.events()).toMatchObject([
      {
        sequence: 1,
        event: { kind: "other", type: "harness_stderr", data: { text: "prefix-embedded[REDACTED]-suffix" } },
      },
    ]);
  } finally {
    journal.close();
  }
});

test("checkpoint sanitation keeps expanding stderr within the journal row limit", () => {
  const journal = new Journal(":memory:", (text) => text);
  try {
    journal.append({
      id: "diagnostic",
      at: 1,
      kind: "other",
      type: "harness_stderr",
      data: { text: "x".repeat(30_000) },
    });
    journal.registerApplicationSecrets(["x"]);
    journal.sanitize();
    expect(journal.events()).toMatchObject([
      { sequence: 1, event: { kind: "other", type: "harness_stderr", data: { truncated: true } } },
    ]);
  } finally {
    journal.close();
  }
});

test.each([
  {
    type: "armada/opencodeShell",
    data: { tool: "bash", command: "echo prefixvalue", output: "prefixvalue", exitCode: 0, truncated: false },
    masked: {
      tool: "bash",
      command: "echo prefix[REDACTED]",
      output: "prefix[REDACTED]",
      exitCode: 0,
      truncated: false,
    },
  },
  {
    type: "armada/opencodeMcp",
    data: {
      server: "prefixvalue",
      nativeToolName: "prefixvalue",
      input: { prefixlongfixture: 2, "field-value": 3 },
      result: { output: "prefixvalue", isError: false },
    },
    masked: {
      server: "prefix[REDACTED]",
      nativeToolName: "prefix[REDACTED]",
      input: { "prefix[REDACTED]": 2, "field-[REDACTED]": 3 },
      result: { output: "prefix[REDACTED]", isError: false },
    },
  },
  {
    type: "model/rerouted",
    data: {
      threadId: "thread-prefixvalue",
      turnId: "turn-fixture",
      fromModel: "prefixvalue",
      toModel: "model-fixture",
      reason: "prefixvalue",
      prefixlongfixture: 3,
    },
    masked: {
      threadId: "thread-prefix[REDACTED]",
      turnId: "turn-fixture",
      fromModel: "prefix[REDACTED]",
      toModel: "model-fixture",
      reason: "prefix[REDACTED]",
      "prefix[REDACTED]": 3,
    },
  },
  {
    type: "usage_report",
    data: {
      rate_limits: {
        limits: [{ group: "plan-prefixvalue", percent: 25, scope: { model: { display_name: "model-prefixvalue" } } }],
        extra_usage: { is_enabled: true, currency: "EUR" },
      },
      session: { model_usage: { prefixlongfixture: { prefixvalue: "model-prefixvalue" } } },
    },
    masked: {
      rate_limits: {
        limits: [
          { group: "plan-prefix[REDACTED]", percent: 25, scope: { model: { display_name: "model-prefix[REDACTED]" } } },
        ],
        extra_usage: { is_enabled: true, currency: "EUR" },
      },
      session: { model_usage: { "prefix[REDACTED]": { "prefix[REDACTED]": "model-prefix[REDACTED]" } } },
    },
  },
  {
    type: "armada/turnUsage",
    data: {
      model: "model-prefixvalue",
      inputTokens: 17,
      outputTokens: 42,
      cachedTokens: null,
      prefixlongfixture: "prefixvalue",
    },
    masked: {
      model: "model-prefix[REDACTED]",
      inputTokens: 17,
      outputTokens: "[REDACTED]",
      cachedTokens: null,
      "prefix[REDACTED]": "prefix[REDACTED]",
    },
  },
  ...["account/rateLimits/read", "account/rateLimits/updated"].map((type) => ({
    type,
    data: {
      rateLimits: {
        limitId: "codex",
        limitName: "quota-prefixvalue",
        primary: { usedPercent: 17, resetsAt: 17944288 },
        credits: { hasCredits: true, unlimited: false, balance: "42" },
      },
      ...(type.endsWith("/read") ? { rateLimitsByLimitId: { prefixvalue: { limitId: "prefixvalue" } } } : {}),
    },
    masked: {
      rateLimits: {
        limitId: "codex",
        limitName: "quota-prefix[REDACTED]",
        primary: { usedPercent: 17, resetsAt: "[REDACTED]" },
        credits: { hasCredits: true, unlimited: false, balance: "[REDACTED]" },
      },
      ...(type.endsWith("/read")
        ? { rateLimitsByLimitId: { "prefix[REDACTED]": { limitId: "prefix[REDACTED]" } } }
        : {}),
    },
  })),
  {
    type: "result",
    data: {
      subtype: "success",
      result: "prefixvalue",
      errors: ["prefixvalue"],
      structured_output: { prefixlongfixture: "prefixvalue" },
      permission_denials: [{ tool_name: "prefixvalue", tool_input: { prefixlongfixture: "prefixvalue" } }],
      session_id: "prefixvalue",
      uuid: "prefixvalue",
      user_message_uuid: "prefixvalue",
      user_message_uuids: ["prefixvalue"],
      stop_reason: "prefixvalue",
      deferred_tool_use: { id: "tool", name: "fixture", input: { valueText: "prefixvalue" } },
      local_command: "prefixvalue",
      resume_reason: "prefixvalue",
      origin: { kind: "peer", from: "fixture", body: "prefixvalue" },
      modelUsage: {
        prefixvalue: { inputTokens: 3, outputTokens: 42, provider: "prefixlongfixture" },
        prefixlongfixture: { inputTokens: 5 },
      },
      usage: {
        input_tokens: 3,
        inference_geo: "prefixvalue",
        iterations: [{ type: "message", input_tokens: 3, model: "prefixvalue" }],
        output_tokens_details: { thinking_tokens: 6 },
      },
      total_cost_usd: 0.15,
    },
    masked: {
      subtype: "success",
      result: "prefix[REDACTED]",
      errors: ["prefix[REDACTED]"],
      structured_output: { "prefix[REDACTED]": "prefix[REDACTED]" },
      permission_denials: [{ tool_name: "prefix[REDACTED]", tool_input: { "prefix[REDACTED]": "prefix[REDACTED]" } }],
      session_id: "prefix[REDACTED]",
      uuid: "prefix[REDACTED]",
      user_message_uuid: "prefix[REDACTED]",
      user_message_uuids: ["prefix[REDACTED]"],
      stop_reason: "prefix[REDACTED]",
      deferred_tool_use: { id: "tool", name: "fixture", input: { "[REDACTED]Text": "prefix[REDACTED]" } },
      local_command: "prefix[REDACTED]",
      resume_reason: "prefix[REDACTED]",
      origin: { kind: "peer", from: "fixture", body: "prefix[REDACTED]" },
      modelUsage: {
        "prefix[REDACTED]": { inputTokens: 3, outputTokens: "[REDACTED]", provider: "prefix[REDACTED]" },
        "[REDACTED]#1": { inputTokens: 5 },
      },
      usage: {
        input_tokens: 3,
        inference_geo: "prefix[REDACTED]",
        iterations: [{ type: "message", input_tokens: 3, model: "prefix[REDACTED]" }],
        output_tokens_details: { thinking_tokens: 6 },
      },
      total_cost_usd: 0.15,
    },
  },
])("masks typed $type output at each journal boundary", async ({ type, data, masked }) => {
  const journal = new Journal(":memory:", (text) => text);
  const runner = new Runner(journal, grant, {});
  try {
    const event = { id: "proof", at: 1, kind: "other", type, data } satisfies AgentEvent;
    journal.append(event);
    journal.registerApplicationSecrets([
      "value",
      type,
      "bash",
      "longfixture",
      ...(type === "usage_report" ? ["limits"] : []),
      ...(type.startsWith("account/") ? ["rateLimits", "42"] : []),
      ...(type === "result" || type === "armada/turnUsage" ? ["Tokens", "tokens", "42"] : []),
    ]);
    journal.append({ ...event, id: "new-proof" });
    const expected = { ...event, data: masked };
    const newer = { ...expected, id: "new-proof" };
    expect(journal.events().map(({ event }) => event)).toEqual([event, newer]);

    const response = await runner.handleDialout({ ...command, op: "events" });
    expect(await response.json()).toMatchObject({ result: { events: [expected, newer] } });
    journal.sanitize();
    expect(journal.events().map(({ event }) => event)).toEqual([expected, newer]);
  } finally {
    await runner.close();
    journal.close();
  }
});

test.each([{ result: "x".repeat(30_000) }, { usage: { inference_geo: "x".repeat(30_000) } }])(
  "expanding Claude result details are dropped while per-model counters survive",
  (details) => {
    const journal = new Journal(":memory:", (text) => text);
    try {
      const event = {
        id: "result-event",
        at: 1,
        kind: "other",
        type: "result",
        data: { modelUsage: { "model-a": { inputTokens: 3 } }, ...details },
      } satisfies AgentEvent;
      journal.append(event);
      journal.registerApplicationSecrets(["x"]);
      journal.append(event);
      const expected = { ...event, data: { modelUsage: { "model-a": { inputTokens: 3 } }, outputTruncated: true } };
      expect(journal.redactEvent(journal.events()[0]!.event)).toEqual(expected);
      expect(journal.events()[1]!.event).toEqual(expected);
      journal.sanitize();
      expect(journal.events().map(({ event }) => event)).toEqual([expected, expected]);
    } finally {
      journal.close();
    }
  },
);

test("many colliding Claude usage keys stay bounded and stable after masking", () => {
  const journal = new Journal(":memory:", (text) => text);
  try {
    const modelUsage = Object.fromEntries(
      Array.from({ length: 4098 }, (_, index) => [
        index.toString(2).padStart(13, "0").replaceAll("0", "a").replaceAll("1", "b"),
        { inputTokens: index + 1 },
      ]),
    );
    const event = {
      id: "result-event",
      at: 1,
      kind: "other",
      type: "result",
      data: { modelUsage: { "model[[REDACTED]]": { inputTokens: 5000 }, ...modelUsage } },
    } satisfies AgentEvent;
    journal.append(event);
    journal.registerApplicationSecrets(["a", "b", "REDACTED", "model[R"]);
    journal.append(event);

    const stored = journal.events()[1]!.event;
    expect(stored).toMatchObject({ type: "result", data: { modelUsage: { "[REDACTED]": { inputTokens: 5000 } } } });
    if (stored.kind !== "other") throw Error("expected a result event");
    const counterRows = Object.values((stored.data as typeof event.data).modelUsage);
    expect(counterRows.map(({ inputTokens }) => inputTokens).sort((a, b) => a - b)).toEqual([
      ...Array.from({ length: 4098 }, (_, index) => index + 1),
      5000,
    ]);
    expect(journal.redactEvent(stored)).toEqual(stored);
    journal.sanitize();
    expect(journal.events().map(({ event }) => event)).toEqual([stored, stored]);
  } finally {
    journal.close();
  }
});

test("proof truncation persists only scrubbed correlation metadata", () => {
  const journal = new Journal(":memory:", (text) => text);
  try {
    const event = {
      id: "proof",
      at: 1,
      kind: "other",
      type: "armada/opencodeShell",
      conversationId: "conversation-fixturevalue",
      data: { tool: "bash", output: "x".repeat(30_000) },
    } satisfies AgentEvent;
    journal.append(event);
    journal.registerApplicationSecrets(["x", "fixturevalue"]);
    journal.append(event);
    expect(journal.events().at(-1)?.event).toMatchObject({
      kind: "other",
      type: "event_truncated",
      conversationId: "conversation-[REDACTED]",
    });
    journal.sanitize();
    expect(journal.events().map(({ event }) => event)).toMatchObject([
      { type: "event_truncated", conversationId: "conversation-[REDACTED]" },
      { type: "event_truncated", conversationId: "conversation-[REDACTED]" },
    ]);
  } finally {
    journal.close();
  }
});

test("an event expanded beyond the dialout limit is truncated and its cursor advances", async () => {
  const journal = new Journal(":memory:", (text) => text);
  const runner = new Runner(journal, grant, {});
  try {
    const message = {
      id: "large-answer",
      at: 1,
      kind: "message",
      textMode: "snapshot",
      text: "x".repeat(120_000),
      partial: false,
      tools: [],
    } satisfies AgentEvent;
    journal.append(message);
    const next = { ...message, id: "next-answer", text: "done" };
    journal.append(next);
    journal.registerApplicationSecrets(["x"]);

    const response = await runner.handleDialout({ ...command, op: "events", limit: 1 });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(1_048_576);
    const { result } = JSON.parse(body);
    expect(result).toMatchObject({
      cursor: "1",
      hasMore: true,
      events: [{ id: message.id, kind: "other", type: "event_truncated" }],
    });
    const following = await runner.handleDialout({ ...command, op: "events", cursor: result.cursor });
    expect(await following.json()).toMatchObject({
      result: { cursor: "2", hasMore: false, events: [next] },
    });
    expect(journal.events()[0]?.event).toEqual(message);
  } finally {
    await runner.close();
    journal.close();
  }
});

test("event pages stop at the UTF-8 byte limit and resume at the first omitted row", async () => {
  const journal = new Journal(":memory:", (text) => text);
  const runner = new Runner(journal, grant, {});
  try {
    for (let index = 1; index <= 5; index++) {
      journal.append({
        id: String(index),
        at: index,
        kind: "message",
        textMode: "snapshot",
        text: "界".repeat(80_000),
        partial: false,
        tools: [],
      });
    }
    const response = await runner.handleDialout({ ...command, op: "events" });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(1_048_576);
    const { result } = JSON.parse(body);
    expect(result).toMatchObject({ cursor: "4", hasMore: true });
    expect(result.events.map(({ id }: AgentEvent) => id)).toEqual(["1", "2", "3", "4"]);

    const following = await runner.handleDialout({ ...command, op: "events", cursor: result.cursor });
    expect(await following.json()).toMatchObject({
      result: { cursor: "5", hasMore: false, events: [{ id: "5" }] },
    });
  } finally {
    await runner.close();
    journal.close();
  }
});

test("a redacted event that exactly fits is returned intact when another row remains", async () => {
  const journal = new Journal(":memory:", (text) => text);
  const runner = new Runner(journal, grant, {});
  try {
    const message = {
      id: "answer",
      at: 1,
      kind: "message",
      textMode: "snapshot",
      text: "",
      partial: false,
      tools: [],
    } satisfies AgentEvent;
    const emptyTextBytes = Buffer.byteLength(
      JSON.stringify({
        version: 1,
        requestId: command.requestId,
        result: { events: [message], cursor: "1", hasMore: true },
      }),
    );
    const padding = "a".repeat(1_048_576 - emptyTextBytes - 1_000_000);
    journal.append({ ...message, text: "x".repeat(100_000) + padding });
    journal.append({ ...message, id: "next", text: "done" });
    journal.registerApplicationSecrets(["x"]);

    const response = await runner.handleDialout({ ...command, op: "events", limit: 1 });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(body)).toBe(1_048_576);
    expect(JSON.parse(body).result).toEqual({
      events: [{ ...message, text: "[REDACTED]".repeat(100_000) + padding }],
      cursor: "1",
      hasMore: true,
    });
  } finally {
    await runner.close();
    journal.close();
  }
});
