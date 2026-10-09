import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Local hook reads are bounded, never follow a pipe, and keep unfinished lines for the next Stop. */
export async function readTranscriptRange(
  path: string,
  offset: number,
  maxBytes: number,
): Promise<{ text: string; nextOffset: number } | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    const from = offset > stat.size ? 0 : offset;
    const start = Math.max(from, stat.size - maxBytes);
    const buffer = Buffer.alloc(Math.min(maxBytes, stat.size - start));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const bytes = buffer.subarray(0, bytesRead);
    const end = bytes.lastIndexOf(10) + 1;
    const begin = start > from ? bytes.indexOf(10) + 1 : 0;
    // A line larger than the cap cannot be parsed; move past it without keeping its content.
    return {
      text: end > begin ? bytes.subarray(begin, end).toString("utf8") : "",
      nextOffset: end ? start + end : start + (bytesRead === maxBytes ? bytesRead : 0),
    };
  } finally {
    await file.close();
  }
}
