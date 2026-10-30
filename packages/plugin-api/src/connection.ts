/** Non-secret account information. Email is allowed only in label. */
export interface ProviderStatus {
  installed: boolean;
  version?: string;
  state: "connected" | "disconnected" | "missing";
  account?: { label: string; plan?: string };
  detail?: string;
}

/** Structural pi AuthInteraction contract; protocol/auth.ts owns its wire schemas. */
export type AuthEvent =
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string }
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "terminal"; output: string };
export type AuthPrompt = { signal?: AbortSignal } & (
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
);
export interface AuthInteraction {
  signal?: AbortSignal;
  notify(event: AuthEvent): void;
  prompt(prompt: AuthPrompt): Promise<string>;
}
export interface ProviderConnection {
  status?(signal?: AbortSignal): Promise<ProviderStatus>;
  connect?(interaction: AuthInteraction): Promise<void>;
  disconnect?(): Promise<void>;
}
