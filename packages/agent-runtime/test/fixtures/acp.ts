import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";

function checkPinnedMcp(servers: unknown) {
  if (!process.env.EXPECT_PINNED_MCP) return;
  const expected = [
    {
      name: "local",
      command: "npx",
      args: ["--yes", "--", "fixture-mcp@1.2.3", "--local"],
      env: [{ name: "MCP_PRIVATE_VALUE", value: "fixture_private_value" }],
    },
  ];
  if (!isDeepStrictEqual(servers, expected) || process.env.MCP_PRIVATE_VALUE !== undefined)
    throw Error("incorrect ACP stdio MCP configuration");
}

const profile = process.env.GEMINI_HOME;
const authMethods = [
  { id: "oauth-personal", name: "Google" },
  { id: "gemini-api-key", name: "Gemini API key" },
];
const useCategoryIds = process.env.ACP_CATEGORY_CONFIG_IDS === "1";
const useFlatOptions = process.env.ACP_FLAT_OPTIONS === "1";
const modelConfigId = useCategoryIds ? "selected_model" : "model";
const thoughtConfigId = useCategoryIds ? "thinking_budget" : "thought_level";
const availableModels = [
  { value: "fixture/model", name: "Fixture" },
  { value: "gemini-4-neon", name: "Gemini 4 Neon" },
  { value: "gemini-4-carbon", name: "Gemini 4 Carbon" },
];
const thoughtLevelsFor = (model: string) => {
  if (process.env.ACP_OMIT_THOUGHT_LEVEL === "1") return undefined;
  return model === "gemini-4-carbon" ? ["low", "medium", "high"] : ["low", "medium", "high", "xhigh"];
};
const modelConfigOptions = (currentValue: string, thoughtValue = "medium") => {
  const modelOption = {
    id: modelConfigId,
    ...(useCategoryIds ? { category: "model" } : {}),
    name: "Model",
    type: "select",
    currentValue,
    options: useFlatOptions ? availableModels : [{ group: "available", name: "Available", options: availableModels }],
  };
  const levels = thoughtLevelsFor(currentValue);
  if (!levels) return [modelOption];
  const levelItems = levels.map((value) => ({ value, name: value }));
  let thoughtType: { type?: string } = { type: "select" };
  if (process.env.ACP_NON_SELECT_THOUGHT === "1") thoughtType = { type: "boolean" };
  else if (useCategoryIds) thoughtType = {};
  return [
    modelOption,
    {
      id: thoughtConfigId,
      ...(useCategoryIds ? { category: "thought_level" } : {}),
      name: "Thought Level",
      ...thoughtType,
      currentValue: thoughtValue,
      options: useFlatOptions ? levelItems : [{ group: "effort", name: "Effort", options: levelItems }],
    },
  ];
};
let currentModelValue = process.env.ACP_INITIAL_MODEL ?? "base";
let currentThoughtValue = "medium";
const configCalls: Array<{ configId: string; value: string }> = [];
const sessionConfig = () => ({
  ...(profile || process.env.ACP_INITIAL_MODEL !== undefined
    ? { configOptions: modelConfigOptions(currentModelValue, currentThoughtValue) }
    : {}),
  ...(process.env.ACP_MODELS_CURRENT_ID ? { models: { currentModelId: process.env.ACP_MODELS_CURRENT_ID } } : {}),
});
let authenticated = false;
let selectedModel = false;
let active: number | undefined;
let sessionId = "session-1";
const send = (value: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const m = JSON.parse(line);
  const reply = (result: object) => send({ id: m.id, result });
  switch (m.method) {
    case "initialize":
      if (
        process.env.OPENCODE_THROTTLE_SECOND_FAIL &&
        process.env.OPENCODE_THROTTLE_STATE &&
        existsSync(process.env.OPENCODE_THROTTLE_STATE)
      ) {
        send({ id: m.id, error: { code: -32603, message: "session initialization failed" } });
        break;
      }
      reply({
        protocolVersion: process.env.BAD_ACP ? 2 : 1,
        agentCapabilities: { loadSession: true },
        authMethods,
      });
      break;
    case "authenticate": {
      const method = process.env.GEMINI_API_KEY === undefined ? "oauth-personal" : "gemini-api-key";
      if (!profile || authenticated || m.params.methodId !== method) throw Error("wrong_authentication");
      authenticated = true;
      if (process.env.GEMINI_API_KEY === "refuse-fixture-key") {
        send({ id: m.id, error: { code: -32000, message: process.env.GEMINI_API_KEY } });
      } else if (process.env.GEMINI_API_KEY === "banner-fixture-key") {
        process.stdout.write(
          "Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?state=fragment\n",
        );
      } else reply({});
      break;
    }
    case "session/new":
      if (profile && !authenticated) throw Error("missing_authentication");
      if (profile && process.env.GEMINI_API_KEY === "missing-session-auth-key") {
        send({ id: m.id, error: { code: -32000, message: "Authentication required" } });
        break;
      }
      checkPinnedMcp(m.params.mcpServers);
      if (process.env.EXPECT_PINNED_MCP) sessionId = "new-session";
      reply({ sessionId, ...sessionConfig() });
      break;
    case "session/load":
      if (profile && !authenticated) throw Error("missing_authentication");
      checkPinnedMcp(m.params.mcpServers);
      send({
        method: "session/update",
        params: {
          sessionId: m.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "history" } },
        },
      });
      reply(sessionConfig());
      break;
    case "session/set_config_option":
      if ((!profile && process.env.ACP_INITIAL_MODEL === undefined) || m.params.sessionId !== sessionId)
        throw Error("wrong_model_config");
      if (m.params.configId === modelConfigId) {
        if (!availableModels.some((entry) => entry.value === m.params.value)) throw Error("wrong_model_config");
        selectedModel = true;
        currentModelValue = m.params.value;
        currentThoughtValue = "medium";
        configCalls.push({ configId: m.params.configId, value: m.params.value });
        reply(
          process.env.ACP_OMIT_SET_CONFIG_OPTIONS
            ? {}
            : { configOptions: modelConfigOptions(currentModelValue, currentThoughtValue) },
        );
      } else if (m.params.configId === thoughtConfigId) {
        const levels = thoughtLevelsFor(currentModelValue);
        if (!levels?.includes(m.params.value)) throw Error("wrong_thought_config");
        currentThoughtValue = m.params.value;
        configCalls.push({ configId: m.params.configId, value: m.params.value });
        if (process.env.ACP_OMIT_SET_CONFIG_OPTIONS) {
          reply({});
        } else if (process.env.ACP_THOUGHT_REPLY_WITHOUT_MODEL === "1") {
          reply({
            configOptions: modelConfigOptions(currentModelValue, currentThoughtValue).filter(
              (option) => option.id !== modelConfigId,
            ),
          });
        } else {
          reply({ configOptions: modelConfigOptions(currentModelValue, currentThoughtValue) });
        }
      } else {
        throw Error("wrong_model_config");
      }
      break;
    case "session/set_model":
      reply({});
      break;
    case "session/prompt": {
      if (m.params.sessionId !== sessionId) throw Error("wrong_session");
      let text = m.params.prompt[0].text;
      if (text === "never-prompt") throw Error("unexpected_prompt");
      if (text === "report-config") text = JSON.stringify({ configCalls, currentModelValue, currentThoughtValue });
      const echo = text === "echo-token";
      if (profile) {
        if (text === "explicit" && !selectedModel) throw Error("missing_model_config");
        if (text === "default" && selectedModel) throw Error("unexpected_model_config");
        if (text === "environment")
          text = JSON.stringify({
            argv: process.argv.slice(2),
            key: process.env.GEMINI_API_KEY === "fixture-gemini-value",
            region: process.env.APP_REGION,
            isolated: ![
              "GOOGLE_FIXTURE",
              "GCLOUD_PROJECT",
              "CLOUDSDK_CORE_PROJECT",
              "DISPLAY",
              "WAYLAND_DISPLAY",
              "BROWSER",
              "AGY_ACP_UNKNOWN",
              "SSH_CONNECTION",
            ].some((name) => process.env[name] !== undefined),
            gitHubTools: {
              firstPath: process.env.PATH?.split(":")[0],
              bashEnv: process.env.BASH_ENV,
              gitConfig: process.env.GIT_CONFIG_GLOBAL,
              home: process.env.HOME,
            },
            privateEnvironment:
              !!process.env.TMPDIR &&
              process.env.AGY_CLI_DISABLE_AUTO_UPDATE === "1" &&
              process.env.AGY_ACP_FORCE_FILE_STORAGE === "1",
          });
        if (echo) {
          if (!process.env.SSH_CONNECTION || process.env.GEMINI_API_KEY !== undefined) throw Error("wrong_google_env");
          const { token, auth_method } = JSON.parse(
            readFileSync(join(profile, "antigravity-acp", "antigravity-oauth-token"), "utf8"),
          );
          if (auth_method !== "consumer") throw Error("wrong_google_auth_method");
          text = [token.access_token, token.refresh_token, token.expiry, token.token_type, token.expires_in].join(" ");
          send({
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "fixture-tool",
                title: `${"a".repeat(254)}${token.access_token}`,
                rawInput: { [token.access_token]: "echo" },
              },
            },
          });
        }
      }
      if (process.env.OPENCODE_THROTTLE_STATE) {
        const state = process.env.OPENCODE_THROTTLE_STATE;
        if (!existsSync(state)) {
          writeFileSync(state, "throttled");
          send({
            id: m.id,
            error: {
              code: -32603,
              message: "Provider request failed",
              data: { service: "session", errorName: "APIError" },
            },
          });
          break;
        }
        writeFileSync(state, "continued");
      }

      send({
        method: "session/update",
        params: {
          sessionId: "unrelated",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "unrelated" } },
        },
      });
      if (text === "model-update") {
        send({
          method: "session/update",
          params: {
            sessionId: "unrelated",
            update: {
              sessionUpdate: "config_option_update",
              configOptions: modelConfigOptions("wrong/session-model"),
            },
          },
        });
        send({
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "config_option_update",
              configOptions: modelConfigOptions("updated/model"),
            },
          },
        });
        send({
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "config_option_update",
              configOptions: modelConfigOptions("default"),
            },
          },
        });
      }
      if (text === "DOCKER_OK") {
        const command = `echo ${"x".repeat(250)}😀${"y".repeat(155)}`;
        for (const update of [
          { sessionUpdate: "tool_call", toolCallId: command, title: command },
          { sessionUpdate: "tool_call_update", toolCallId: command, title: "" },
          { sessionUpdate: "tool_call_update", toolCallId: command, rawInput: { cwd: "/tmp" } },
          { sessionUpdate: "tool_call", toolCallId: `${command}2`, title: command, rawInput: { cwd: "/tmp" } },
          { sessionUpdate: "tool_call", toolCallId: "\0", title: "  sh\0ell  " },
        ])
          send({ method: "session/update", params: { sessionId, update } });
      }
      if (text === "tool-title-budget") {
        for (let i = 0; i < 33; i++) {
          send({
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: `active-${i}`,
                title: `echo ${"x".repeat(32768)}`,
              },
            },
          });
        }
      }
      if (text === "tool-title-completed") {
        const longTitle = `echo ${"x".repeat(32768)}`;
        for (let i = 0; i < 66; i++) {
          const toolCallId = `done-${i}`;
          send({
            method: "session/update",
            params: {
              sessionId,
              update: { sessionUpdate: "tool_call", toolCallId, title: longTitle },
            },
          });
          send({
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId,
                rawInput: { index: i },
                status: i % 2 === 0 ? "completed" : "failed",
                rawOutput: "ok",
              },
            },
          });
        }
        for (let i = 0; i < 34; i++) {
          send({
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: i === 0 ? "tool_call" : "tool_call_update",
                toolCallId: "replaced",
                title: `echo ${i} ${"y".repeat(32768)}`,
              },
            },
          });
        }
        send({
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "tool_call_update", toolCallId: "replaced", rawInput: { final: true } },
          },
        });
      }
      const fragments = echo
        ? [text.slice(0, 10), text.slice(10)]
        : text === "DOCKER_OK"
          ? ["D", "OCK", "ER", "_OK"]
          : [text];
      for (const fragment of fragments)
        send({
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: fragment } },
          },
        });
      if (text === "hold") {
        active = m.id;
        break;
      }
      reply({
        stopReason: text === "output-limit" ? "max_tokens" : "end_turn",
        ...(text === "unknown"
          ? {}
          : {
              usage: { inputTokens: 3, outputTokens: 2, cachedReadTokens: 1, cachedWriteTokens: 0, thoughtTokens: 0 },
            }),
      });
      break;
    }
    case "session/cancel":
      if (active !== undefined) {
        send({
          id: active,
          result: {
            stopReason: "cancelled",
            usage: { inputTokens: 4, outputTokens: 1, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0 },
          },
        });
        active = undefined;
      }
      break;
    default:
      send({ id: m.id, error: { code: -32601, message: "unknown" } });
  }
}
