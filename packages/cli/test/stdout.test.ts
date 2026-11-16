import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createStdoutWriter } from "../src/stdout.ts";

describe("executable stdout boundary", () => {
  for (const delivery of ["throw", "event"] as const) {
    test(`closed pipe via ${delivery} terminates quietly with success`, () => {
      const closed = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
      const terminated = new Error("terminated");
      const exits: number[] = [];
      const stream = Object.assign(new EventEmitter(), {
        write: () => {
          if (delivery === "throw") throw closed;
        },
      });
      const out = createStdoutWriter(stream, (code) => {
        exits.push(code);
        throw terminated;
      });
      expect(() => (delivery === "throw" ? out("event\n") : stream.emit("error", closed))).toThrow(terminated);
      expect(exits).toEqual([0]);
    });
  }

  test("ordinary output is preserved", () => {
    const chunks: string[] = [];
    const stream = Object.assign(new EventEmitter(), {
      write: (text: string) => chunks.push(text),
    });
    const out = createStdoutWriter(stream, () => {
      throw new Error("unexpected exit");
    });
    out("receipt\n");
    expect(chunks).toEqual(["receipt\n"]);
  });

  for (const delivery of ["throw", "event"] as const) {
    test(`unrelated ${delivery} errors remain failures`, () => {
      const failure = Object.assign(new Error("disk failure"), { code: "EIO" });
      const stream = Object.assign(new EventEmitter(), {
        write: () => {
          if (delivery === "throw") throw failure;
        },
      });
      const out = createStdoutWriter(stream, () => {
        throw new Error("unexpected exit");
      });
      expect(() => (delivery === "throw" ? out("receipt\n") : stream.emit("error", failure))).toThrow(failure);
    });
  }
});
