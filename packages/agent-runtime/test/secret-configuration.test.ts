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
    data: { command: "echo prefixvalue", output: "prefixvalue", exitCode: 0, truncated: false },
    masked: { command: "echo prefix[REDACTED]", output: "prefix[REDACTED]", exitCode: 0, truncated: false },
  },
  {
    type: "armada/opencodeMcp",
    data: {
      server: "prefixvalue",
      nativeToolName: "prefixvalue",
      input: { prefixvalue: 1 },
      result: { output: "prefixvalue", isError: false },
    },
    masked: {
      server: "prefix[REDACTED]",
      nativeToolName: "prefix[REDACTED]",
      input: { "prefix[REDACTED]": 1 },
      result: { output: "prefix[REDACTED]", isError: false },
    },
  },
])("masks typed $type proof content at each journal boundary", async ({ type, data, masked }) => {
  const journal = new Journal(":memory:", (text) => text);
  const runner = new Runner(journal, grant, {});
  try {
    const event = { id: "proof", at: 1, kind: "other", type, data } satisfies AgentEvent;
    journal.append(event);
    journal.registerApplicationSecrets(["value", type]);
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
