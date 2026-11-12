import { PRIVATE_SKILL_FAILURES } from "./private-skill-error.ts";

/** Public, value-free skill diagnostics shared by launches and their clients. */
export function skillRefusalMessage(value: unknown): string {
  const reason =
    typeof value === "string" &&
    [
      ...PRIVATE_SKILL_FAILURES,
      "skillpack_credential_missing",
      "skillpack_credential_refused",
      "skillpack_skill_unavailable",
    ].includes(value)
      ? value
      : "skillpack_install_nonzero";
  const action =
    reason === "skillpack_download_unavailable"
      ? "The last golden build reported skillpack_download_unavailable: allow GitHub release egress, then rebuild; repeating an offline build will not help."
      : reason === "skillpack_cli_unavailable"
        ? "Rebuild the golden with armada golden update to provision the native CLI."
        : "Check the requested public pin, registry access and compatible CLI; see docs/private-skillpack.md.";
  return `Skillpack installation failed: ${reason}. ${action}`;
}
