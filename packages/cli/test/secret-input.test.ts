import { expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { promptSecret } from "../src/secret-input.ts";

test("terminal secrets are read without echo and terminal mode is restored", async () => {
  const input = new PassThrough();
  const terminal = Object.assign(input, {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) {
      this.isRaw = raw;
      return this;
    },
  });
  let visible = "";
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        if (chunk.toString().includes("Paste")) expect(terminal.isRaw).toBe(true);
        visible += chunk.toString();
        done();
      },
    }),
    { isTTY: true },
  );
  const result = promptSecret(terminal as unknown as typeof process.stdin, output as typeof process.stderr);
  input.write("private-token\r");
  expect(await result).toBe("private-token");
  expect(visible).toBe("Paste the token, then Enter: \n");
  expect(terminal.isRaw).toBe(false);
});

test("interrupt cancels secret input without exposing partial input", async () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) {
      this.isRaw = raw;
      return this;
    },
  });
  let visible = "";
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        visible += chunk.toString();
        done();
      },
    }),
    { isTTY: true },
  );
  const result = promptSecret(input as unknown as typeof process.stdin, output as typeof process.stderr);
  input.write("partial\u0003");
  await expect(result).rejects.toThrow("cancelled");
  expect(visible).not.toContain("partial");
  expect(input.isRaw).toBe(false);
});
