import { AuthError } from "@armada/auth";
import { idlePauseMessage, isSandboxPlacementProvider, SANDBOX_PLACEMENT_LABELS } from "@armada/core";
import { formatTable } from "./table.ts";

export function sandboxListText(rows: unknown[], now: Date, options: { wide?: boolean } = {}): string {
  if (!rows.length) return "No sandboxes.\n";
  const text = (value: unknown): string => {
    if (typeof value !== "string") throw new AuthError("Invalid safe sandbox metadata.", "unavailable");
    return Array.from(value, (character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159) ? " " : character;
    }).join("");
  };
  const wide = options.wide === true;
  const cells = rows.map((value) => {
    if (!value || typeof value !== "object") throw new AuthError("Invalid safe sandbox metadata.", "unavailable");
    const row = value as Record<string, unknown>;
    const created = Date.parse(text(row.createdAt));
    if (!Number.isFinite(created)) throw new AuthError("Invalid safe sandbox metadata.", "unavailable");
    const minutes = Math.max(0, Math.floor((now.getTime() - created) / 60_000));
    const age =
      minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
    const id = text(row.id);
    const label = text(row.displayLabel);
    const provider = isSandboxPlacementProvider(row.provider)
      ? SANDBOX_PLACEMENT_LABELS[row.provider]
      : text(row.provider);
    const status =
      idlePauseMessage(
        {
          status: text(row.status),
          idlePaused: row.idlePaused === true,
          expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : null,
        },
        now,
      ) ?? text(row.status);
    const outcome =
      row.taskOutcome && typeof row.taskOutcome === "object"
        ? text((row.taskOutcome as Record<string, unknown>).state)
        : "—";
    if (!wide) return [id.slice(0, 8), label, provider, status, outcome, age];
    return [
      id,
      label,
      provider,
      row.providerSandboxId === null ? "—" : text(row.providerSandboxId),
      status,
      outcome,
      age,
      row.preservationNote ? text(row.preservationNote) : "—",
      text(row.ownerId),
      typeof row.canOpen !== "boolean" || typeof row.canManage !== "boolean"
        ? "UNKNOWN (server reauthorizes)"
        : row.canOpen
          ? row.canManage
            ? "open/manage"
            : "open"
          : "metadata only",
    ];
  });
  return formatTable(
    wide
      ? ["ID", "LABEL", "PROVIDER", "PROVIDER ID", "STATUS", "OUTCOME", "AGE", "PRESERVATION", "OWNER", "ACCESS"]
      : ["ID", "LABEL", "PROVIDER", "STATUS", "OUTCOME", "AGE"],
    cells,
  );
}
