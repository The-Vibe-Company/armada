import { expect, test } from "bun:test";
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
])(
  "marked launch values reach the harness and are masked in event text ($prefix)",
  async ({ secret, prefix, suffix }) => {
    const journal = new Journal(":memory:", (text) => text);
    const variables = { APP_TOKEN: secret, APP_REGION: "fixture_region" };
    let environment: Record<string, string> = {};
    const driver: Driver = {
      configureReadableVariables(values) {
        environment = values;
      },
      start({ emit }) {
        const text = `${prefix}${environment.APP_TOKEN}${suffix} ${environment.APP_REGION}`;
        emit({ kind: "other", type: "harness_stderr", data: { text } });
        emit({ kind: "message", text, partial: false, tools: [], messageId: "message_fixture" });
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
        secretKeys: ["APP_TOKEN"],
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
      const text = `${prefix}[REDACTED]${suffix} fixture_region`;
      expect(body).toMatchObject({
        result: {
          events: expect.arrayContaining([
            expect.objectContaining({ type: "harness_stderr", data: { text } }),
            expect.objectContaining({ kind: "message", text, messageId: "message_fixture" }),
          ]),
        },
      });
      expect(JSON.stringify(body)).not.toContain(JSON.stringify(`${prefix}${secret}${suffix}`).slice(1, -1));
      expect(journal.db.query("select 1 from requests where id=?").get(command.requestId)).toBeNull();
    } finally {
      await runner.close();
      journal.close();
    }
  },
);

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
