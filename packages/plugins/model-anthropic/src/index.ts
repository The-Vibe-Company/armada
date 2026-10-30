import { createAnthropic } from "@ai-sdk/anthropic";
import type { JsonSchema, PluginContext } from "@armada/plugin-api";
import { secretConnection } from "@armada/plugin-api/secret-auth";
import { z } from "zod";

const schema = z.strictObject({
  model: z.string().min(1).default("claude-sonnet-4-5"),
  baseURL: z.url().default("https://api.anthropic.com/v1"),
  apiKeySecret: z.enum(["ANTHROPIC_API_KEY", "ARMADA_MODEL_API_KEY"]).default("ANTHROPIC_API_KEY"),
});

export async function activate(ctx: PluginContext) {
  const secrets = new Map<string, string | null>();
  for (const name of ["ANTHROPIC_API_KEY", "ARMADA_MODEL_API_KEY"]) secrets.set(name, await ctx.secrets.get(name));
  const secretName =
    (ctx.config.model?.anthropic as { apiKeySecret?: string } | undefined)?.apiKeySecret ?? "ANTHROPIC_API_KEY";
  ctx.register.model("anthropic", {
    ...secretConnection(ctx.secrets, secretName, "Anthropic", (key) => {
      secrets.set(secretName, key);
    }),
    configSchema: z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as JsonSchema,
    create(model, overrides) {
      const parsed = schema.safeParse({
        ...(ctx.config.model?.anthropic as object),
        ...(overrides as object),
        ...(model ? { model } : {}),
      });
      if (!parsed.success) throw new Error("Invalid Anthropic model configuration");
      const config = parsed.data;
      const apiKey = secrets.get(config.apiKeySecret);
      if (!apiKey) throw new Error("Anthropic model credential is missing");
      return createAnthropic({ apiKey, baseURL: config.baseURL })(config.model);
    },
  });
}
