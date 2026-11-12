#!/usr/bin/env bun
// Synthetic wire peer using the pinned generated schema. Not an authenticated model recording.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { TurnStartParams } from "../../src/codex-schema/v2/TurnStartParams.ts";
import recordedTerminal from "./codex-terminal-recorded.json";

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
let loggedIn = false;
let turn = 0;
let thread = "fixture-thread";
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (process.env.ARMADA_CWD_PROOF) {
    const path = "native-cwd-proof.json";
    let records: unknown[];
    try {
      records = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      records = [];
    }
    records.push({
      method: m.method,
      processCwd: process.cwd(),
      cwd: m.params?.cwd ?? null,
      text: m.params?.input?.[0]?.text ?? null,
      model: m.params?.model ?? null,
    });
    writeFileSync(path, JSON.stringify(records));
  }

  const reply = (result: unknown) => send({ id: m.id, result });
  const notify = (method: string, params: unknown) => send({ method, params });
  if (m.method === "initialize") reply({ userAgent: "fixture" });
  else if (m.method === "account/login/start") {
    if (m.params.type !== "apiKey" || m.params.apiKey !== process.env.OPENAI_API_KEY)
      throw Error("invalid API-key login");
    loggedIn = true;
    reply({ type: "apiKey" });
  } else if (m.method === "account/rateLimits/read") {
    if (process.env.ARMADA_QUOTA_UNAVAILABLE === "1") {
      send({ id: m.id, error: { code: -32000, message: "Synthetic quota unavailable" } });
      return;
    }
    reply({
      ordinaryUsageAllowed: true,
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 25, resetsAt: 1794268800 },
        secondary: null,
        credits: { hasCredits: false, unlimited: false, balance: "0" },
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: { usedPercent: 25, resetsAt: 1794268800 },
          credits: { hasCredits: false, unlimited: false, balance: "0" },
        },
        review: {
          limitId: "review",
          primary: { usedPercent: 42, resetsAt: null },
          credits: { hasCredits: true, unlimited: false, balance: "12.3400" },
        },
      },
      accountId: "synthetic-upstream-account",
    });
  } else if (m.method === "thread/start" || m.method === "thread/resume") {
    if (process.env.OPENAI_API_KEY && !loggedIn) throw Error("API-key login must precede thread operations");
    if (m.method === "thread/resume") thread = m.params.threadId;
    if (process.env.ARMADA_READABLE_INSPECTION)
      writeFileSync(
        process.env.ARMADA_READABLE_INSPECTION,
        JSON.stringify({ region: process.env.APP_REGION, empty: process.env.APP_EMPTY }),
      );
    if (process.env.ARMADA_MCP_INSPECTION) {
      const header = "mcp-header-fixture-sensitive",
        stdio = "mcp-env-fixture-sensitive";
      const argv = readFileSync("/proc/self/cmdline", "utf8");
      const servers = m.params.config?.mcp_servers;
      writeFileSync(
        process.env.ARMADA_MCP_INSPECTION,
        JSON.stringify({
          argvLeak: argv.includes(header) || argv.includes(stdio),
          serverNames: Object.keys(servers ?? {}),
          headerFingerprint: servers?.remote?.http_headers?.Authorization
            ? createHash("sha256").update(servers.remote.http_headers.Authorization).digest("hex")
            : null,
          environmentLeak: Object.values(process.env).some((v) => v?.includes(header) || v?.includes(stdio)),
          configured:
            servers?.remote?.http_headers?.Authorization === header && servers?.local?.env?.PRIVATE_MCP_VALUE === stdio,
        }),
      );
    }

    notify("account/rateLimits/updated", {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1794268800 },
        secondary: null,
      },
    });
    reply({
      thread: { id: process.env.ARMADA_NATIVE_RESUME_MISMATCH === "thread" ? "replacement-native" : thread },
      model:
        process.env.ARMADA_NATIVE_RESUME_MISMATCH === "model"
          ? "replacement-model"
          : process.env.ARMADA_USAGE_MODEL === "missing"
            ? undefined
            : (process.env.ARMADA_USAGE_MODEL ?? m.params.model ?? "gpt-6.1-sol"),
    });
  } else if (m.method === "turn/start") {
    const params = m.params as TurnStartParams;
    turn++;
    if (params.threadId !== thread || params.approvalPolicy !== "never") throw Error("incorrect turn parameters");
    reply({ turn: { id: `turn-${turn}`, status: "inProgress" } });
    if (params.input[0]?.type === "text" && params.input[0].text === "message-semantics") {
      for (const id of ["answer-a", "answer-b"]) {
        notify("item/agentMessage/delta", { threadId: thread, turnId: `turn-${turn}`, itemId: id, delta: "Hello" });
        notify("item/completed", {
          threadId: thread,
          turnId: `turn-${turn}`,
          item: { type: "agentMessage", id, text: "Hello world" },
        });
      }
      notify("turn/completed", {
        threadId: thread,
        turn: { id: `turn-${turn}`, status: "completed", items: [], error: null },
      });
      return;
    }
    notify("thread/tokenUsage/updated", {
      threadId: thread,
      turnId: `turn-${turn}`,
      tokenUsage: {
        total: {
          inputTokens: 100 * turn,
          outputTokens: 20 * turn,
          cachedInputTokens: 30 * turn,
          cacheWriteInputTokens: 10 * turn,
          reasoningOutputTokens: 4 * turn,
        },
        last: { inputTokens: 40, outputTokens: 5, cachedInputTokens: 10 },
      },
    });
    if (process.env.ARMADA_USAGE_REROUTE) {
      notify("model/rerouted", {
        threadId: process.env.ARMADA_USAGE_REROUTE === "foreign" ? "another-thread" : thread,
        turnId: `turn-${turn}`,
        fromModel: "native-selected",
        toModel: "native-alternate",
        reason: "test",
      });
    }
    notify("item/agentMessage/delta", { threadId: thread, turnId: `turn-${turn}`, itemId: "text", delta: "partial" });
    if (
      params.input[0]?.type === "text" &&
      ["recorded-failure", "unauthorized", "usageLimitExceeded", "rateLimitExceeded"].includes(params.input[0].text)
    ) {
      send({
        ...recordedTerminal,
        params: {
          ...recordedTerminal.params,
          threadId: thread,
          turn: {
            ...recordedTerminal.params.turn,
            id: `turn-${turn}`,
            error: {
              ...recordedTerminal.params.turn.error,
              codexErrorInfo:
                params.input[0].text === "recorded-failure"
                  ? recordedTerminal.params.turn.error.codexErrorInfo
                  : params.input[0].text,
            },
          },
        },
      });
      return;
    }
    if (params.input[0]?.type === "text" && params.input[0].text === "redirect") {
      notify("item/completed", {
        threadId: thread,
        item: { type: "agentMessage", id: "final", text: "redirect delivered once" },
      });
      notify("turn/completed", {
        threadId: thread,
        turn: { id: `turn-${turn}`, status: "completed", items: [], error: null },
      });
    }
  } else if (m.method === "turn/interrupt") {
    reply({});
    notify("turn/completed", {
      threadId: thread,
      turn: { id: `turn-${turn}`, status: "interrupted", items: [], error: null },
    });
  }
});
