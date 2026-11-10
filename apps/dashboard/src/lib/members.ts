export type MemberRole = "admin" | "member";

/**
 * What saving a member's role would do. Only giving up your own admin role asks first: you cannot take it back
 * yourself. Any other change applies at once, and the server still keeps at least one admin.
 */
export type RoleChange = "none" | "change" | "self-demote";

export function roleChange(current: MemberRole, next: MemberRole, self: boolean): RoleChange {
  if (current === next) return "none";
  return self && current === "admin" ? "self-demote" : "change";
}

/** The initial an avatar shows (a member's email, an org's name): its first letter or digit, else a dot. */
export function initialOf(text: string): string {
  return text.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "•";
}
