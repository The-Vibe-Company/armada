import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { JsonSchema, PluginContext } from "@armada/plugin-api";
import { secretConnection } from "@armada/plugin-api/secret-auth";
import { z } from "zod";

const secretNames = ["OPENAI_API_KEY", "ARMADA_MODEL_API_KEY", "ZAI_API_KEY", "AZURE_AI_API_KEY"] as const;
const schema = z.strictObject({
  model: z.string().min(1),
  baseURL: z.url(),
  apiKeySecret: z.enum(secretNames).nullable().default("OPENAI_API_KEY"),
  apiKeyHeader: z.enum(["authorization", "api-key"]).default("authorization"),
  supportsStructuredOutputs: z.boolean().default(true),
});

export async function activate(ctx: PluginContext) {
  const secrets = new Map<string, string | null>();
  for (const name of secretNames) secrets.set(name, await ctx.secrets.get(name));
  const configured = (
    ctx.config.model?.["openai-compatible"] as { apiKeySecret?: (typeof secretNames)[number] | null } | undefined
  )?.apiKeySecret;
  const secretName = configured === undefined ? "OPENAI_API_KEY" : configured;
  ctx.register.model("openai-compatible", {
    ...secretConnection(ctx.secrets, secretName, "OpenAI compatible", (key) => {
      if (secretName) secrets.set(secretName, key);
    }),
    configSchema: z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as JsonSchema,
    create(model, overrides) {
      const parsed = schema.safeParse({
        ...(ctx.config.model?.["openai-compatible"] as object),
        ...(overrides as object),
        ...(model ? { model } : {}),
      });
      if (!parsed.success) throw new Error("Invalid OpenAI-compatible model configuration");
      const config = parsed.data;
      const apiKey = config.apiKeySecret === null ? undefined : secrets.get(config.apiKeySecret);
      if (apiKey === null) throw new Error("OpenAI-compatible model credential is missing");
      return createOpenAICompatible({
        name: "openai-compatible",
        baseURL: config.baseURL,
        apiKey: config.apiKeyHeader === "authorization" ? apiKey : undefined,
        headers: config.apiKeyHeader === "api-key" && apiKey ? { "api-key": apiKey } : undefined,
        supportsStructuredOutputs: config.supportsStructuredOutputs,
      }).chatModel(config.model);
    },
  });
}
