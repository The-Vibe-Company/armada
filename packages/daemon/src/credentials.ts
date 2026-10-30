import {
  type ClientMessage,
  MODELS_MINOR,
  type ModelKindEntry,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "@armada/protocol";
import { Ajv } from "ajv";
import { coordinatorModelConfig, type Keychain } from "./keychain.ts";
import type { ModelRegistry } from "./models/registry.ts";

export type CredentialRequest = Extract<ClientMessage, { type: "credentials.set" | "credentials.status" }>;

/** Called only after protocol admission. No event writer or logger has access to the request. */
export async function dispatchCredentials(
  request: CredentialRequest,
  keychain: Keychain,
  models?: readonly ModelKindEntry[],
  pi?: ModelRegistry,
): Promise<ServerMessage> {
  const base = { version: PROTOCOL_VERSION, id: request.id };
  try {
    if (request.type === "credentials.set") {
      const usePi =
        request.target === "pi" ||
        (request.target !== "plugin" && request.config === undefined && request.version.minor >= MODELS_MINOR);
      if (request.target === "pi" && !pi?.models.getProvider(request.provider))
        return { ...base, type: "error", code: "invalid-message", message: "Unknown pi model provider" };
      if (usePi && pi?.models.getProvider(request.provider)) {
        await pi.setKey(request.provider, request.key);
        return {
          ...base,
          type: "credentials.result",
          ...(await keychain.status()),
          ...(models ? { models: [...models] } : {}),
        };
      }
      const normalized = coordinatorModelConfig(request.provider, request.config);
      const entry = models?.find((entry) => entry.kind === normalized.provider);
      if (models && !entry)
        return {
          ...base,
          type: "error",
          code: "invalid-message",
          message: "Model provider is not loaded. Enable its plugin and restart the daemon.",
        };
      const existing = await keychain.pluginCoordinator().catch(() => null);
      const prior = existing?.provider === normalized.provider ? existing.config : undefined;
      const config = structuredClone({ ...normalized.config, ...prior, ...request.config });
      if (
        entry &&
        !new Ajv({
          useDefaults: true,
          strict: false,
          formats: { uri: { type: "string", validate: URL.canParse } },
        }).compile(entry.config as object)(config)
      )
        return {
          ...base,
          type: "error",
          code: "invalid-message",
          message: "Complete the model settings required by this provider.",
        };
      await keychain.setCoordinator(
        normalized.provider,
        request.key,
        entry || Object.keys(config).length || request.config ? config : undefined,
      );
    }
    const status = await keychain.status();
    return {
      ...base,
      type: "credentials.result",
      ...status,
      ...(request.version.minor < 3 && status.provider === "openai-compatible" ? { provider: "openai" } : {}),
      ...(models ? { models: [...models] } : {}),
    };
  } catch {
    return {
      ...base,
      type: "error",
      code: "internal",
      message: "Could not access credential storage. Unlock it and try again.",
    };
  }
}
