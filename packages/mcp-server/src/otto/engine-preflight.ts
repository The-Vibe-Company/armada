import type { OttoEngine, OttoEnginePreflight } from "@armada/core";
import { HARNESS_CATALOG, isHarness, resolveModelChoice } from "@armada/core";
import { type CredentialReader, listConnectionModels, resolveCredentials } from "@armada/core/server";

export async function preflightOttoEngine(
  reader: CredentialReader,
  encryptionKey: string | undefined,
  scope: { userId: string; orgId: string },
  engine: OttoEngine,
): Promise<OttoEnginePreflight> {
  if (!isHarness(engine.harness))
    return {
      ready: false,
      error: "unsupported_engine",
      message: "Choose a supported harness and one of its catalog models.",
    };
  if (
    engine.harness !== "opencode" &&
    !HARNESS_CATALOG[engine.harness].models.some((model) => model.id === engine.model)
  )
    return { ready: false, error: "unsupported_engine", message: "Choose a model listed for the selected harness." };
  try {
    await resolveCredentials(reader, encryptionKey, {
      ...scope,
      harness: engine.harness,
      credentialId: engine.credentialId,
    });
    const declared = (await listConnectionModels(reader, encryptionKey, scope)).find(
      (a) => a.id === engine.credentialId,
    );
    try {
      resolveModelChoice(engine.harness, { model: engine.model });
    } catch {
      return { ready: false, error: "unsupported_engine", message: "The model ID is invalid for this harness." };
    }
    if (
      engine.harness === "opencode" &&
      (declared
        ? !declared.models.some((m) => m.model === engine.model)
        : !/^(opencode|opencode-go)\/[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/.test(engine.model))
    )
      return {
        ready: false,
        error: "unsupported_engine",
        message:
          "Choose a model declared by the OpenCode connection, or opencode/<model> or opencode-go/<model> for a plain key. OpenCode requires Modal when launched.",
      };
    return { ready: true };
  } catch {
    // Resolver errors and decrypted values never cross this boundary. No provider call or fallback.
    return {
      ready: false,
      error: "account_unavailable",
      message:
        "The selected account is unavailable, expired or incompatible. Connect it again or select another account.",
      connectUrl: "/harness",
    };
  }
}
