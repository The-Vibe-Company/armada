import { createServer } from "node:net";
import { AuthError } from "@armada/auth";
import { GoldenError } from "@armada/core";
import { RELAY_OPCODE, type RelayCloseReason, validateRelayPort } from "@armada/core/relay";
import { acceptedOptions, flag, parseArgs, single } from "../args.ts";
import { readCurrentSandbox } from "../current-sandbox.ts";
import {
  createRelayPipe,
  defaultOnSignal,
  openRelaySession,
  type RelayTcpServer,
  type RelayTcpSocket,
} from "../relay-session.ts";
import type { Command } from "./command.ts";

const LOOPBACK = "127.0.0.1";
type TcpStream = { id: number; socket: RelayTcpSocket; pipe: ReturnType<typeof createRelayPipe>; closed: boolean };
const isPort = (v: string) => /^[1-9]\d{0,4}$/.test(v) && Number(v) <= 65_535;
function parsePort(raw: string, label: string) {
  if (/^[1-9]\d*$/.test(raw)) {
    try {
      return validateRelayPort(Number(raw));
    } catch {}
  }
  throw new GoldenError("invalid_config", `${label} must be an integer between 1 and 65535.`);
}
function parsePositionals(pos: readonly string[], hasCurrentSandbox: boolean) {
  if (!pos.length || pos.length > 3)
    throw new GoldenError("invalid_config", "Use armada port-forward [sandbox-id] <remote-port> [local-port].");
  if (pos.length === 1) {
    const r = parsePort(pos[0]!, "remote-port");
    return { sandboxId: undefined, remotePort: r, localPort: r };
  }
  if (pos.length === 2) {
    const [a, b] = pos;
    if (isPort(a!) && isPort(b!) && hasCurrentSandbox)
      return { sandboxId: undefined, remotePort: parsePort(a!, "remote-port"), localPort: parsePort(b!, "local-port") };
    const r = parsePort(b!, "remote-port");
    return { sandboxId: a, remotePort: r, localPort: r };
  }
  return {
    sandboxId: pos[0],
    remotePort: parsePort(pos[1]!, "remote-port"),
    localPort: parsePort(pos[2]!, "local-port"),
  };
}
const defaultTcp = (onConn: (s: RelayTcpSocket) => void) =>
  createServer((s) => onConn(s as unknown as RelayTcpSocket)) as unknown as RelayTcpServer;

const portForwardRun: Command["run"] = async (argv, { io, deps, auth }) => {
  const args = parseArgs(argv);
  acceptedOptions(args, "port-forward", ["--org", "--json"]);
  const hasCurrentSandbox =
    args.positionals.length === 2 && isPort(args.positionals[0]!) && isPort(args.positionals[1]!)
      ? Boolean(await readCurrentSandbox(auth.env, deps.sandboxFile))
      : false;
  const { sandboxId: explicitSandboxId, remotePort, localPort } = parsePositionals(args.positionals, hasCurrentSandbox);
  const onSignal = deps.relay?.onSignal ?? defaultOnSignal;
  const session = await openRelaySession({
    auth,
    deps,
    explicitSandboxId,
    org: single(args, "--org"),
    mode: "tcp",
    port: remotePort,
  });

  const streams = new Map<number, TcpStream>(),
    cleanups: (() => void)[] = [];
  let nextId = 1,
    shuttingDown = false,
    server: RelayTcpServer | undefined;

  const allocId = () => {
    for (let i = 0; i < 65_536; i++) {
      const id = nextId;
      nextId = id >= 0xffff_ffff ? 1 : id + 1;
      if (!streams.has(id)) return id;
    }
    return null;
  };
  const closeStream = (s: TcpStream, reason: RelayCloseReason, notifyRemote: boolean, graceful = false) => {
    if (s.closed) return;
    s.closed = true;
    s.pipe.stop();
    streams.delete(s.id);
    if (notifyRemote) session.send({ type: RELAY_OPCODE.CLOSE, streamId: s.id, code: 0, reason });
    if (graceful) s.socket.end();
    else s.socket.destroy();
  };
  const onConnection = (socket: RelayTcpSocket) => {
    const id = shuttingDown ? null : allocId();
    if (id === null) return void socket.destroy();
    const s: TcpStream = {
      id,
      socket,
      closed: false,
      pipe: createRelayPipe(session, id, {
        write: (d) => socket.write(d),
        pause: () => socket.pause(),
        resume: () => socket.resume(),
        onViolation: () => closeStream(s, "backpressure", true),
      }),
    };
    s.pipe.pauseSource();
    streams.set(id, s);
    socket.on("data", (c: Uint8Array) => s.pipe.push(c instanceof Uint8Array ? c : new Uint8Array(c)));
    socket.on("drain", () => s.pipe.onDrain());
    socket.on("error", () => closeStream(s, "eof", true));
    socket.on("close", () => {
      if (s.closed) return;
      s.pipe.flush();
      closeStream(s, "eof", true);
    });
    if (!session.send({ type: RELAY_OPCODE.OPEN_TCP, streamId: id, port: remotePort })) closeStream(s, "eof", false);
  };

  try {
    server = (deps.relay?.createTcpServer ?? defaultTcp)(onConnection);
    const boundPort = await new Promise<number>((resolve, reject) => {
      let listening = false;
      server!.on("error", (err) => {
        if (listening) return void io.err(`armada port-forward: local listener error: ${err.message}\n`);
        const detail =
          (err as NodeJS.ErrnoException).code === "EADDRINUSE" ? `port ${localPort} is already in use.` : err.message;
        reject(new AuthError(`Could not bind ${LOOPBACK}:${localPort}: ${detail}`, "unavailable"));
      });
      server!.listen(localPort, LOOPBACK, () => {
        listening = true;
        const addr = server!.address();
        resolve(typeof addr === "object" && addr ? addr.port : localPort);
      });
    });
    io.out(
      flag(args, "--json")
        ? `${JSON.stringify({ host: LOOPBACK, localPort: boundPort, sandboxId: session.sandboxId, remotePort })}\n`
        : `Forwarding ${LOOPBACK}:${boundPort} -> sandbox ${session.sandboxId}:${remotePort}\n`,
    );

    return await new Promise<number>((resolve) => {
      const stop = (code: number, notify: boolean) => {
        if (shuttingDown) return;
        shuttingDown = true;
        for (const s of [...streams.values()]) closeStream(s, "eof", notify);
        server?.close();
        session.close(1000);
        resolve(code);
      };
      cleanups.push(
        onSignal("SIGINT", () => stop(0, true)),
        onSignal("SIGTERM", () => stop(0, true)),
      );
      session.start({
        onMessage(msg) {
          if (shuttingDown || !("streamId" in msg)) return;
          const s = streams.get(msg.streamId);
          if (!s || s.closed) return;
          if (msg.type === RELAY_OPCODE.OPEN_OK) s.pipe.markOpened();
          else if (msg.type === RELAY_OPCODE.DATA) s.pipe.onData(msg.data);
          else if (msg.type === RELAY_OPCODE.CREDIT) s.pipe.onCredit(msg.bytes);
          else if (msg.type === RELAY_OPCODE.CLOSE) closeStream(s, msg.reason, false, msg.reason === "eof");
        },
        onClose(code) {
          if (shuttingDown) return;
          io.err(`armada port-forward: relay connection closed (${code}).\n`);
          stop(1, false);
        },
      });
    });
  } finally {
    for (const fn of cleanups) fn();
    for (const s of [...streams.values()]) closeStream(s, "eof", false);
    server?.close();
    session.close();
  }
};

const usage = "armada port-forward [sandbox-id] <remote-port> [local-port] [--org UUID] [--json]";
export default {
  name: "port-forward",
  summary: "Forward a local loopback TCP port to a sandbox port",
  usage: {
    interactive: `  ${usage}\n                                           Forward 127.0.0.1:<local-port> to sandbox TCP port`,
  },
  help: `Usage: ${usage}\nBind 127.0.0.1:<local-port> locally and tunnel TCP connections to the sandbox's <remote-port>.\nlocal-port defaults to remote-port. Both ports must be integers in 1–65535.\nOmit sandbox-id to use ARMADA_SANDBOX or .armada/sandbox.\nWith two numeric arguments and a current sandbox, they are <remote-port> <local-port>; pass a longer/full sandbox ID or 3 arguments to disambiguate a numeric prefix.\n--json emits {host,localPort,sandboxId,remotePort} once listening.\nPress Ctrl-C (SIGINT) or send SIGTERM to stop forwarding cleanly.\nExample: armada port-forward SANDBOX_UUID 3000 8080\n`,
  useSelectedOrg: true,
  validateProfileForHelp: true,
  run: portForwardRun,
} satisfies Command;
