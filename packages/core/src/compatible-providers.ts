/** Compatible model services; endpoints are wire-specific, never sandbox-provider-specific. */
export const COMPATIBLE_MODEL_PROVIDERS = {
  morph: {
    models: ["morph-kimik31", "morph-dsv41flash", "morph-dsv41flash-1017"],
    claude: {
      version: 1,
      baseUrl: "https://api.morphllm.com",
      auth: "api-key",
      aliases: { opus: "morph-kimik31", sonnet: "morph-kimik31", haiku: "morph-dsv41flash" },
    },
    codex: { version: 1, baseUrl: "https://api.morphllm.com/v1" },
  },
} as const;
