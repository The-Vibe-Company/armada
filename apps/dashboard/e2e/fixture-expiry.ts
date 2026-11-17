/** Keep the explicit expired scenario while ordinary journeys remain usable on every reset. */
export function largeSandboxExpiry(variant: number, now: number): string {
  return new Date(now + (variant === 8 ? -1 : 1) * 86_400_000).toISOString();
}
