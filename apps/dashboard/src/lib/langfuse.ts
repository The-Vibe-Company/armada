export type ContentMode = "metadata" | "full";
export type LangfuseTest = "ok" | "rejected" | "unreachable";

type Status = { enabled: boolean; contentMode: ContentMode };
export type LangfuseAdmin = Status & {
  scope: "admin";
  configured: boolean;
  host: string;
  publicKey: string | null;
  counters: { exported: number; failed: number; dropped: number };
  lastExportAt: string | null;
};
export type LangfuseSettings = LangfuseAdmin | (Status & { scope: "member" });

export type LangfuseInput = {
  host?: string;
  publicKey?: string;
  secretKey?: string;
  contentMode?: ContentMode;
  enabled?: boolean;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("Invalid count");
  return value;
}

export function parseLangfuseSettings(input: unknown, admin: boolean): LangfuseSettings {
  const { enabled, contentMode, configured, host, publicKey, counters, lastExportAt } = record(input);
  if (typeof enabled !== "boolean" || (contentMode !== "metadata" && contentMode !== "full")) {
    throw new Error("Invalid Langfuse status");
  }
  if (!admin) return { scope: "member", enabled, contentMode };
  if (
    typeof configured !== "boolean" ||
    typeof host !== "string" ||
    (publicKey !== null && typeof publicKey !== "string") ||
    (lastExportAt !== null && (typeof lastExportAt !== "string" || !Number.isFinite(Date.parse(lastExportAt))))
  ) {
    throw new Error("Invalid Langfuse settings");
  }
  const { exported, failed, dropped } = record(counters);
  return {
    scope: "admin",
    enabled,
    contentMode,
    configured,
    host,
    publicKey,
    counters: { exported: count(exported), failed: count(failed), dropped: count(dropped) },
    lastExportAt,
  };
}

export function parseLangfuseTest(input: unknown): LangfuseTest {
  const { status } = record(input);
  if (status === "ok" || status === "rejected" || status === "unreachable") return status;
  throw new Error("Invalid Langfuse test result");
}

export type LangfuseEditable = Pick<LangfuseAdmin, "host" | "publicKey" | "contentMode">;

export function readLangfuseForm(form: FormData, baseline?: LangfuseEditable): LangfuseInput | null {
  const host = form.get("host");
  const publicKey = form.get("publicKey");
  const secretKey = form.get("secretKey");
  const contentMode = form.get("contentMode");
  if (
    typeof host !== "string" ||
    !host.trim() ||
    typeof publicKey !== "string" ||
    !publicKey.trim() ||
    (secretKey !== null && (typeof secretKey !== "string" || !secretKey.trim())) ||
    (contentMode !== "metadata" && contentMode !== "full")
  )
    return null;
  const hostValue = host.trim();
  const url = URL.canParse(hostValue) ? new URL(hostValue) : null;
  const origin = url && url.href === `${url.origin}/` ? url.origin : hostValue;
  const hostChanged = origin !== baseline?.host;
  // The API binds stored secrets to their origin. A host move always needs an explicit replacement.
  if (baseline && hostChanged && secretKey === null) return null;
  return {
    ...(hostChanged ? { host: hostValue } : {}),
    ...(hostChanged || publicKey.trim() !== baseline?.publicKey ? { publicKey: publicKey.trim() } : {}),
    ...(secretKey === null ? {} : { secretKey: secretKey.trim() }),
    ...(contentMode === baseline?.contentMode ? {} : { contentMode }),
  };
}
