import type { Harness } from "../harnesses.ts";

/** Private to a member within one organization. References only, never credential material. */
export interface OttoEngine {
  harness: Harness;
  model: string;
  credentialId: string;
}
export type OttoEnginePreflight =
  | { ready: true }
  | { ready: false; error: "unsupported_engine" | "account_unavailable"; message: string; connectUrl?: string };
