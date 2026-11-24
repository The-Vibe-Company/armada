import { antigravityLoginOperations } from "@armada/core/contract";
import { modelAccountFailure } from "./model-accounts";

export const ANTIGRAVITY_METHODS = [
  { id: "google", label: "Google account" },
  { id: "gemini-api-key", label: "Gemini API key" },
] as const;

export function antigravityMethod(value: unknown) {
  return ANTIGRAVITY_METHODS.find(({ id }) => id === value)?.id;
}

export const GOOGLE_CODE_ERROR = "Enter the code or callback URL from Google.";

export function googleCode(value: unknown) {
  if (typeof value !== "string") return null;
  const code = value.trim();
  return !/\s/.test(code) && antigravityLoginOperations.completeAntigravityLogin.input.body.safeParse({ code }).success
    ? code
    : null;
}

export function googleSignInFailure(stage: "start" | "complete", status?: number, code?: string) {
  if (stage === "complete") {
    if (code === "not_found" || code === "unavailable")
      return "That Google code is invalid or expired. Get a new code.";
    if (code === "invalid") return "Enter the code or callback URL from the matching Google sign-in.";
  }
  if (stage === "start" && code === "conflict")
    return "A Google sign-in is already open. Finish it or wait for it to expire before trying again.";
  return modelAccountFailure(status, code);
}
