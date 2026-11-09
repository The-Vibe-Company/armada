#!/usr/bin/env bun
// Synthetic local app-server peer. No provider consent or network access.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

// A wrapper child may own other native handles; EOF alone must not be our cleanup.
if (process.argv.includes("--keep-alive")) setInterval(() => {}, 60_000);
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "account/login/start") {
    if (message.params.type !== "chatgptDeviceCode") throw Error("not a device login");
    const tokens = {
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      account_id: "fixture-account",
    };
    writeFileSync("auth.json", JSON.stringify({ tokens, fixtureHome: process.cwd(), fixturePid: process.pid }), {
      mode: 0o600,
    });
    send({
      id: message.id,
      result: {
        type: "chatgptDeviceCode",
        loginId: "login",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
        untrustedToken: "must-not-be-forwarded",
      },
    });
    send({ method: "account/login/completed", params: { loginId: "login", success: true } });
  }
});
