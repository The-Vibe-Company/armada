import type { Readable } from "node:stream";

export const commandOutputLimit = 65536;

export function captureCommandOutput(stream: Readable) {
  const capture = { text: "", truncated: false };
  stream.setEncoding("utf8");
  stream.on("data", (text: string) => {
    if (capture.truncated) return;
    capture.text += text;
    if (capture.text.length > commandOutputLimit) {
      capture.text = capture.text.slice(0, commandOutputLimit);
      capture.truncated = true;
    }
  });
  return capture;
}
