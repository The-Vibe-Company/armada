/** Select recovery by failure class; operation-specific uncertainty stays in the error message. */
export function failureHint(error: unknown, argv: readonly string[], env: Record<string, string | undefined>): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const message = error instanceof Error ? error.message : "";
  if (/does not serve \/api\//.test(message)) return "Ask an administrator to verify and update the Armada deployment.";
  if (
    code === "unauthorized" ||
    code === "forbidden" ||
    (code === "conflict" && /forbidden|access denied|refused/i.test(message)) ||
    (error !== null && typeof error === "object" && "status" in error && error.status === 403)
  )
    return env.ARMADA_TOKEN
      ? "Check or replace ARMADA_TOKEN and verify ARMADA_URL and token permissions."
      : "Run armada login, then retry with an account that has access.";
  if (["usage", "invalid_config", "invalid_request", "invalid", "no_credentials"].includes(String(code)))
    return `Run armada ${argv[0]?.startsWith("-") ? "" : `${argv[0] ?? ""} `}--help for usage.`;
  if (/may have been accepted|before retrying|uncertain/i.test(message))
    return "Inspect the operation state using the recovery instructions above before retrying.";
  return "Check ARMADA_URL and the server connection; run armada doctor after connectivity is restored.";
}
