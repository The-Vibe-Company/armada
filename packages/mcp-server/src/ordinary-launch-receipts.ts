import { createHash } from "node:crypto";
import { GoldenError, LaunchError, ProviderError, VaultError } from "@armada/core/server";

export type OrdinaryLaunchFailure =
  | { kind: "launch"; code: LaunchError["code"]; sandboxId?: string }
  | { kind: "golden"; code: GoldenError["code"] }
  | { kind: "vault"; code: VaultError["code"]; message: string }
  | {
      kind: "provider";
      code: ProviderError["code"];
      provider: string;
      status?: number;
      retryable: boolean;
      retryAfterSeconds?: number;
    };

export const freshBoatAdmission = Symbol("freshBoatAdmission");

// WARNING: These discriminators are part of existing receipt hashes. Changing them invalidates replay.
const controlReceiptFields = {
  ordinaryRoute: "native",
  modalTransportField: "runtimeTransport",
};

export function controlLaunchReceiptPayload(
  body: Record<string, unknown>,
  goldenId: string,
  runtime: boolean | "modal",
) {
  const { idempotencyKey: _key, modalTransport, ...request } = body;
  return {
    surface: "control",
    route: runtime === "modal" ? "modal-runtime" : runtime ? "boat-runtime" : controlReceiptFields.ordinaryRoute,
    request: {
      ...request,
      ...(modalTransport === undefined ? {} : { [controlReceiptFields.modalTransportField]: modalTransport }),
    },
    goldenId,
  };
}

export function ordinaryLaunchFingerprint(payload: unknown) {
  return createHash("sha256").update(canonical(payload)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function replayOrdinaryLaunchFailure(failure: OrdinaryLaunchFailure): Error {
  const message = `Launch refused (${failure.code}). This key records a terminal failure; correct the configuration before submitting a new launch key.`;
  switch (failure.kind) {
    case "vault":
      return new VaultError(failure.code, failure.message);
    case "golden":
      return new GoldenError(failure.code, message);
    case "launch":
      return new LaunchError(failure.code, message, failure.sandboxId ? { sandboxId: failure.sandboxId } : undefined);
    case "provider":
      return new ProviderError({ ...failure, message });
  }
}
