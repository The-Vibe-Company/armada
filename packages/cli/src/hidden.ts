// Line editing for a hidden prompt in raw mode, kept pure so it can be tested
// without a terminal. Nothing here echoes a character.

export interface HiddenLine {
  answer: string;
  /** Inside an escape sequence (arrow keys: ESC [ ... final byte), which is never part of a key. */
  sequence: "none" | "start" | "csi";
  /** Set once Enter (the answer) or Ctrl-C / Ctrl-D on an empty line (null) is read. */
  result?: string | null;
}

export const emptyHiddenLine = (): HiddenLine => ({ answer: "", sequence: "none" });

/** Feeds one chunk of raw input (a paste arrives as one chunk); stops at the first Enter or cancel. */
export function feedHidden(line: HiddenLine, chunk: string): HiddenLine {
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
