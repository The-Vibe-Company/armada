// Line editing for a prompt read in raw mode, kept pure so it can be tested
// without a terminal. The caller decides whether to echo (see `echo`).

export interface Line {
  answer: string;
  /** Inside an escape sequence (arrow keys: ESC [ ... final byte), which is never part of an answer. */
  sequence: "none" | "start" | "csi";
  /** Set once Enter (the answer) or Ctrl-C / Ctrl-D on an empty line (null) is read. */
  result?: string | null;
}

export const emptyLine = (): Line => ({ answer: "", sequence: "none" });

/** Feeds one chunk of raw input (a paste arrives as one chunk); stops at the first Enter or cancel. */
export function feedLine(line: Line, chunk: string): Line {
  let { answer, sequence } = line;
  for (const c of chunk) {
    if (sequence === "start") sequence = c === "[" ? "csi" : "none";
    else if (sequence === "csi") {
      if (c >= "@" && c <= "~") sequence = "none";
    } else if (c === "\u001b") sequence = "start";
    else if (c === "\r" || c === "\n") return { answer, sequence, result: answer };
    else if (c === "\u0003" || (c === "\u0004" && !answer)) return { answer, sequence, result: null };
    else if (c === "\u007f" || c === "\b") answer = answer.slice(0, -1);
    else if (c >= " ") answer += c;
  }
  return { answer, sequence };
}

/** What to write so a visible answer on screen goes from `before` to `after`. */
export function echo(before: string, after: string): string {
  let common = 0;
  while (common < before.length && common < after.length && before[common] === after[common]) common++;
  return "\b \b".repeat(before.length - common) + after.slice(common);
}
