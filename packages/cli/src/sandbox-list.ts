import { GoldenError } from "@armada/core";

/** Render the #680 sandbox-access-v1 safe DTO, never an interior/golden lookup. */
export function sandboxListText(rows: unknown[], now: Date): string {
  if (!rows.length) return "No sandboxes.\n";
  const text = (value: unknown): string => {
    if (typeof value !== "string") throw new GoldenError("invalid_config", "Invalid safe sandbox metadata.");
    // API labels/owners are untrusted terminal data, not escape sequences.
    return Array.from(value, (character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159) ? " " : character;
    }).join("");
  };
  const lines = rows.map((value) => {
    if (!value || typeof value !== "object") throw new GoldenError("invalid_config", "Invalid safe sandbox metadata.");
    const row = value as Record<string, unknown>;
    const created = Date.parse(text(row.createdAt));
    if (!Number.isFinite(created)) throw new GoldenError("invalid_config", "Invalid safe sandbox metadata.");
    const minutes = Math.max(0, Math.floor((now.getTime() - created) / 60_000));
    const age =
      minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
    const provider = row.provider === "boat" ? "Boat" : row.provider === "modal" ? "Modal" : text(row.provider);
    return [
      text(row.id),
      text(row.displayLabel),
      provider,
      row.providerSandboxId === null ? "—" : text(row.providerSandboxId),
      text(row.status),
      age,
      text(row.ownerId),
      typeof row.canOpen !== "boolean" || typeof row.canManage !== "boolean"
        ? "UNKNOWN (server reauthorizes)"
        : row.canOpen
          ? row.canManage
            ? "open/manage"
            : "open"
          : "metadata only",
    ].join("  ");
  });
  return `ID  LABEL  PROVIDER  PROVIDER ID  STATUS  AGE  OWNER  ACCESS\n${lines.join("\n")}\n`;
}
