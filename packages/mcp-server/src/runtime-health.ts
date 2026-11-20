export type RuntimeRestore = { epoch: string; watermark: number; conversationId: string | null };
export function runtimeHealthMatches(value: unknown, epoch: string, expected?: RuntimeRestore) {
  const health = value as Record<string, unknown> | undefined;
  const restored = health?.restoredFrom as Record<string, unknown> | undefined;
  return (
    health?.ready === true &&
    health.generation === epoch &&
    (!expected || (["epoch", "watermark", "conversationId"] as const).every((key) => restored?.[key] === expected[key]))
  );
}
