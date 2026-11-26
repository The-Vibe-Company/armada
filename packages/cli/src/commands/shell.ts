import { GoldenError } from "@armada/core";
import { clampTerminalSize, RELAY_OPCODE } from "@armada/core/relay";
import { acceptedOptions, parseArgs, single } from "../args.ts";
import { createRelayPipe, defaultOnSignal, openRelaySession, type RelayTerminal } from "../relay-session.ts";
import type { Command } from "./command.ts";

const STREAM = 1;
function on<T extends (...args: never[]) => void>(
  em: { on(e: string, f: T): unknown; off(e: string, f: T): unknown },
  e: string,
  f: T,
) {
  em.on(e, f);
  return () => void em.off(e, f);
}

function productionTerminal() {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    get columns() {
      return process.stdout.columns;
    },
    get rows() {
      return process.stdout.rows;
    },
    setRawMode: process.stdin.setRawMode ? (m) => process.stdin.setRawMode?.(m) : undefined,
    pause: () => void process.stdin.pause(),
    resume: () => void process.stdin.resume(),
    writeStdout: (c) => process.stdout.write(c),
    onStdoutDrain: (fn) => on(process.stdout, "drain", fn),
    onStdinData: (fn) =>
      on(process.stdin, "data", (c: Buffer | string) =>
        fn(typeof c === "string" ? Buffer.from(c) : new Uint8Array(c.buffer, c.byteOffset, c.byteLength)),
      ),
    onStdinEnd: (fn) => on(process.stdin, "end", fn),
    onResize(fn) {
      let last = "";
      const emit = () => {
        const cols = process.stdout.columns ?? 80,
          rows = process.stdout.rows ?? 24,
          k = `${cols}x${rows}`;
        if (k === last) return;
        last = k;
        fn(cols, rows);
      };
      const offs = [on(process.stdout, "resize", emit), on(process, "SIGWINCH", emit)];
      return () => {
        for (const off of offs) off();
      };
    },
  } satisfies RelayTerminal;
}

const shellRun: Command["run"] = async (argv, { io, deps, auth }) => {
  const args = parseArgs(argv);
  acceptedOptions(args, "shell", ["--cwd", "--org"]);
  if (args.positionals.length > 1) throw new GoldenError("invalid_config", "Pass at most one sandbox ID.");
  const cwd = single(args, "--cwd");
  if (cwd !== undefined && (!cwd.length || cwd.length > 4096 || cwd.includes("\0")))
    throw new GoldenError("invalid_config", "--cwd must be a non-empty path without NUL bytes.");
  const term = deps.relay?.terminal ?? productionTerminal(),
    onSignal = deps.relay?.onSignal ?? defaultOnSignal;
  const session = await openRelaySession({
    auth,
    deps,
    explicitSandboxId: args.positionals[0],
    org: single(args, "--org"),
    mode: "pty",
    cwd,
  });

  let raw = false;
  const cleanups: (() => void)[] = [];
  try {
    if (term.isTTY && term.setRawMode) {
      term.setRawMode(true);
      raw = true;
    }
    let settled = false;
    const size = () => clampTerminalSize(term.columns ?? 80, term.rows ?? 24);
    return await new Promise<number>((resolve) => {
      const done = (code: number) => {
        if (settled) return;
        settled = true;
        pipe.stop();
        resolve(code);
      };
      const pipe = createRelayPipe(session, STREAM, {
        write: (d) => term.writeStdout(d),
        pause: () => term.pause?.(),
        resume: () => term.resume?.(),
        onViolation() {
          session.send({ type: RELAY_OPCODE.CLOSE, streamId: STREAM, code: 0, reason: "backpressure" });
          io.err("armada shell: stream flow-control violation.\n");
          done(1);
        },
      });
      const onSig = (code: number) => () => {
        session.send({ type: RELAY_OPCODE.CLOSE, streamId: STREAM, code: 0, reason: "eof" });
        done(code);
      };
      cleanups.push(
        term.onStdoutDrain(() => pipe.onDrain()),
        term.onStdinData((c) => pipe.push(c)),
        ...(term.onStdinEnd
          ? [
              term.onStdinEnd(() => {
                if (settled) return;
                if (!term.isTTY) {
                  pipe.push(new Uint8Array([4]));
                } else {
                  session.send({ type: RELAY_OPCODE.CLOSE, streamId: STREAM, code: 0, reason: "eof" });
                  done(0);
                }
              }),
            ]
          : []),
        term.onResize(
          (c, r) =>
            pipe.opened &&
            !settled &&
            session.send({ type: RELAY_OPCODE.RESIZE, streamId: STREAM, ...clampTerminalSize(c, r) }),
        ),
        onSignal("SIGTERM", onSig(143)),
        ...(term.isTTY ? [] : [onSignal("SIGINT", onSig(130))]),
      );
      term.resume?.();
      session.start({
        onMessage(msg) {
          if (settled || !("streamId" in msg) || msg.streamId !== STREAM) return;
          if (msg.type === RELAY_OPCODE.OPEN_OK) {
            pipe.markOpened();
            if (term.isTTY) session.send({ type: RELAY_OPCODE.RESIZE, streamId: STREAM, ...size() });
          } else if (msg.type === RELAY_OPCODE.DATA) pipe.onData(msg.data);
          else if (msg.type === RELAY_OPCODE.CREDIT) pipe.onCredit(msg.bytes);
          else if (msg.type === RELAY_OPCODE.CLOSE) {
            if (msg.reason === "eof") done(msg.code);
            else {
              io.err(`armada shell: session closed (${msg.reason}).\n`);
              done(1);
            }
          }
        },
        onClose(code) {
          if (settled) return;
          io.err(`armada shell: connection closed (${code}).\n`);
          done(1);
        },
      });
      if (!session.send({ type: RELAY_OPCODE.OPEN_PTY, streamId: STREAM, ...size(), ...(cwd ? { cwd } : {}) })) done(1);
    });
  } finally {
    for (const fn of cleanups) fn();
    if (raw) {
      try {
        term.setRawMode?.(false);
      } catch {}
    }
    term.pause?.();
    session.close();
  }
};

const usage = "armada shell [sandbox-id] [--cwd PATH] [--org UUID]";
export default {
  name: "shell",
  summary: "Open an interactive shell in a sandbox",
  usage: { interactive: `  ${usage}\n                                           Open an interactive PTY shell` },
  help: `Usage: ${usage}\nOpen an interactive PTY shell inside a running sandbox over the Armada relay.\nOmit sandbox-id to use ARMADA_SANDBOX or .armada/sandbox.\nEnables raw TTY mode and forwards terminal resizes when attached to a terminal.\nExits with the remote shell exit code.\nExample: armada shell SANDBOX_UUID --cwd /home/user\n`,
  useSelectedOrg: true,
  validateProfileForHelp: true,
  run: shellRun,
} satisfies Command;
