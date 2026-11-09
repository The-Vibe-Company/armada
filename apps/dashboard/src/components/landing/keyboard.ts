// The method's tabs (THE-1049), from armada-v1-final's lib/keyboard.ts. Pure: it reads a key, never the page.

/** Where an arrow key, Home or End moves the focus in a row of `count` tabs; null for any other key. */
export function tabStep(key: string, at: number, count: number): number | null {
  if (count === 0) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (at + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (at - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
