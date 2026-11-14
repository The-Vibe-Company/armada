import { createInterface } from "node:readline";
import { Writable } from "node:stream";

/** Read a single secret without echoing it, including through readline redraws. */
export function promptSecret(input = process.stdin, output = process.stderr): Promise<string> {
  if (!input.isTTY || !output.isTTY) return Promise.reject(new Error("A terminal is required"));
  const muted = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  const reader = createInterface({ input, output: muted, terminal: true, historySize: 0 });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      reader.close();
      input.setRawMode(Boolean(wasRaw));
      if (wasPaused) input.pause();
      muted.destroy();
      output.write("\n");
      if (value === undefined) reject(new Error("Secret input cancelled"));
      else resolve(value);
    };
    reader.once("line", (value) => finish(value));
    reader.once("SIGINT", () => finish());
    reader.once("close", () => finish());
    reader.once("error", () => finish());
    output.write("Paste the token, then Enter: ");
  });
}
