import { randomBytes } from "node:crypto";
import { RELAY_MODES, type RelayMode } from "@armada/core/contract";
import {
  decodeRelayMessage,
  encodeRelayMessage,
  MAX_PTYS_PER_SANDBOX,
  MAX_RELAY_FRAME,
  MAX_STREAMS_PER_SANDBOX,
  MAX_TCP_PER_SANDBOX,
  RELAY_OPCODE,
  type RelayCloseReason,
} from "@armada/core/relay";
import { decryptSecret, encryptSecret, type Sql } from "@armada/core/server";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { z } from "zod";
import type { Caller } from "./caller.ts";
import { type createRuntimeEnrolments, RuntimeEnrolmentDenied } from "./runtime-enrolment.ts";
import { SANDBOX_VISIBLE } from "./sandbox-visibility.ts";

const { OPEN_PTY, OPEN_TCP, OPEN_OK, DATA, CREDIT, RESIZE, CLOSE, PING, PONG } = RELAY_OPCODE;
const PREFIX = "armada_relay_";
const MS = { ticket: 60_000, auth: 5_000, ping: 20_000, idle: 60_000, recheck: 30_000 } as const;
const ACTIVE = new Set(["ready", "running"]);
const claimsSchema = z.strictObject({
  purpose: z.literal("sandbox-relay-v1"),
  nonce: z.string().min(16),
  sandboxId: z.string().min(1),
  epoch: z.string().min(1),
  userId: z.string().min(1),
  orgIds: z.array(z.string().min(1)).min(1),
  mode: z.enum(RELAY_MODES),
  port: z.number().int().min(1).max(65_535).optional(),
  cwd: z.string().min(1).optional(),
  exp: z.number().finite(),
});
export type RelayTicketClaims = z.infer<typeof claimsSchema>;
export type RelaySocketData =
  | { kind: "runtime-relay"; token: string; epoch: string; sandboxId: string }
  | { kind: "client-relay"; claims?: RelayTicketClaims };
export type RelayClock = {
  now(): number;
  every(ms: number, cb: () => void): () => void;
  after(ms: number, cb: () => void): () => void;
};
export type RelayHubOptions = {
  sql: Sql;
  authority: ReturnType<typeof createRuntimeEnrolments>;
  encryptionKey: string | undefined;
  publicUrl: string;
  dashboardUrl: string;
  clock?: RelayClock;
};
export type LocalTcpCallbacks = {
  onOpen: () => void;
  onData: (data: Uint8Array) => void;
  onCredit: (bytes: number) => void;
  onClose: (code: number, reason: RelayCloseReason) => void;
};
export type LocalTcpStream = {
  sendData: (data: Uint8Array) => boolean;
  sendCredit: (bytes: number) => boolean;
  close: (code?: number, reason?: RelayCloseReason) => void;
};
type Ws = ServerWebSocket<RelaySocketData>;
type ClientStream = { client: ClientConn; clientId: number; runtimeId: number; kind: "pty" | "tcp" };
type LocalStream = { local: LocalTcpCallbacks; runtimeId: number; kind: "tcp"; closed: boolean };
type Stream = ClientStream | LocalStream;
type AccessRow = {
  id: string;
  status: string;
  stopping: boolean;
  deleted: boolean;
  expired: boolean;
  tainted: boolean;
  epoch: string | null;
};
class RelayTaintedError extends Error {}
class RuntimeConn {
  closed = false;
  revalidating = false;
  pingBusy = false;
  lastTcpAt?: number;
  nextId = 1;
  streams = new Map<number, Stream>();
  clients = new Set<ClientConn>();
  cancel = () => {};
  constructor(
    readonly socket: Ws,
    readonly token: string,
    readonly epoch: string,
    readonly sandboxId: string,
    public lastSeen: number,
  ) {}
}
class ClientConn {
  authed = false;
  authBusy = false;
  revalidating = false;
  closed = false;
  claims?: RelayTicketClaims;
  runtime?: RuntimeConn;
  streams = new Map<number, ClientStream>();
  cancel = () => {};
  constructor(readonly socket: Ws) {}
}

const tryOr = <T>(fn: () => T, fallback: T) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};
const bearerOf = (r: Request) => r.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
const emptyRes = (status: number, extra?: Record<string, string>) =>
  new Response(null, { status, headers: { "cache-control": "no-store", ...extra } });
const deny = <C extends "not_found" | "forbidden" | "sandbox_not_ready" | "relay_unavailable">(
  status: number,
  code: C,
  message: string,
) => ({ ok: false as const, status, code, message });
const send = (ws: Ws, data: Uint8Array | string) => tryOr(() => ws.send(data) !== 0, false);
const sendClose = (ws: Ws, streamId: number, code: number, reason: RelayCloseReason) =>
  send(ws, encodeRelayMessage({ type: CLOSE, streamId, code, reason }));
const decodeBin = (raw: string | Buffer) =>
  typeof raw === "string"
    ? undefined
    : tryOr(() => decodeRelayMessage(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)), undefined);
const remapFrame = (raw: string | Buffer, streamId: number) => {
  const src = raw as Buffer;
  const out = new Uint8Array(src.byteLength);
  out.set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength));
  new DataView(out.buffer).setUint32(2, streamId, false);
  return out;
};
const countKind = (rt: RuntimeConn, kind: "pty" | "tcp") => {
  let n = 0;
  for (const s of rt.streams.values()) if (s.kind === kind) n++;
  return n;
};
const allocRuntimeId = (rt: RuntimeConn, pty: boolean) => {
  const limit = pty ? MAX_PTYS_PER_SANDBOX : MAX_TCP_PER_SANDBOX;
  if (countKind(rt, pty ? "pty" : "tcp") >= limit || rt.streams.size >= MAX_STREAMS_PER_SANDBOX) return null;
  for (let i = 0; i < MAX_STREAMS_PER_SANDBOX + 2; i++) {
    const cand = rt.nextId;
    rt.nextId = cand >= 0xffff_ffff ? 1 : cand + 1;
    if (!rt.streams.has(cand)) return cand;
  }
  return null;
};
export function relayWsUrl(publicUrl: string) {
  const url = new URL("/api/v1/relay/ws", publicUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function createRelayHub(options: RelayHubOptions) {
  const { sql, authority, encryptionKey, publicUrl } = options;
  const time: RelayClock = options.clock ?? {
    now: () => Date.now(),
    every: (ms, cb) => {
      const t = setInterval(cb, ms);
      return () => clearInterval(t);
    },
    after: (ms, cb) => {
      const t = setTimeout(cb, ms);
      return () => clearTimeout(t);
    },
  };
  const expectedOrigin = new URL(options.dashboardUrl).origin;
  const runtimes = new Map<string, RuntimeConn>(),
    runtimeByWs = new Map<Ws, RuntimeConn>(),
    clientByWs = new Map<Ws, ClientConn>(),
    usedNonces = new Map<string, number>(),
    pending = new Set<Promise<unknown>>();
  let stopping = false;
  const track = <T>(p: Promise<T>) => {
    pending.add(p);
    void p.finally(() => pending.delete(p)).catch(() => {});
    return p;
  };
  function rtErrCode(e: unknown) {
    if (e instanceof RelayTaintedError) return 4403;
    if (e instanceof RuntimeEnrolmentDenied) return 4401;
    return 1012;
  }
  async function queryAccess(orgIds: readonly string[], userId: string, sandboxId: string) {
    if (!orgIds.length) return deny(404, "not_found", "Sandbox not found.");
    const row = (
      await sql.query<AccessRow>(
        `select s.id,s.status,s.stop_requested_at is not null as stopping,s.deleted_at is not null as deleted,
                s.expires_at<=now() as expired,s.application_secret_tainted as tainted,r.epoch::text as epoch
         from public.sandboxes s left join public.runtime_enrolments r
           on r.sandbox_id=s.id and r.lifecycle_generation=s.lifecycle_generation and r.runtime_hash is not null
         where s.id=$3::uuid and ${SANDBOX_VISIBLE}`,
        [orgIds, userId, sandboxId],
      )
    ).rows[0];
    if (!row || row.deleted || row.status === "deleted") return deny(404, "not_found", "Sandbox not found.");
    if (row.tainted) return deny(403, "forbidden", "Application-secret exposed sandboxes do not allow relay.");
    if (row.stopping || row.expired || !ACTIVE.has(row.status))
      return deny(409, "sandbox_not_ready", "Sandbox is not ready for relay.");
    return { ok: true as const, sandboxId: row.id, epoch: row.epoch };
  }
  const verifyRuntime = (token: string, epoch: string) =>
    authority.withSession(token, epoch, async (tx, scope) => {
      const q = "select application_secret_tainted as t from public.sandboxes where id=$1";
      if ((await tx.query<{ t: boolean }>(q, [scope.sandboxId])).rows[0]?.t) throw new RelayTaintedError();
      return scope;
    });
  const isConnected = (id: string, epoch: string) => {
    const rt = runtimes.get(id);
    return Boolean(rt && !rt.closed && rt.epoch === epoch);
  };
  const hasActiveRelay = (id: string) => {
    const rt = runtimes.get(id);
    return Boolean(
      rt &&
        !rt.closed &&
        (countKind(rt, "pty") > 0 || (rt.lastTcpAt !== undefined && time.now() - rt.lastTcpAt < MS.idle)),
    );
  };
  async function mintTicket(
    caller: Caller,
    sandboxId: string,
    input: { mode: RelayMode; port?: number; cwd?: string },
  ) {
    if (!encryptionKey) return deny(503, "relay_unavailable", "Relay encryption is not configured.");
    const orgIds = caller.orgs.map((o) => o.orgId),
      access = await queryAccess(orgIds, caller.userId, sandboxId);
    if (!access.ok) return access;
    if (!access.epoch || !isConnected(access.sandboxId, access.epoch))
      return deny(503, "relay_unavailable", "Sandbox relay is not connected.");
    const exp = time.now() + MS.ticket;
    const claims: RelayTicketClaims = {
      purpose: "sandbox-relay-v1",
      nonce: randomBytes(16).toString("hex"),
      sandboxId: access.sandboxId,
      epoch: access.epoch,
      userId: caller.userId,
      orgIds,
      mode: input.mode,
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      exp,
    };
    const sealed = await encryptSecret(JSON.stringify(claims), encryptionKey);
    const preview =
      input.mode === "preview" && input.port !== undefined
        ? {
            bootstrapUrl: new URL("/api/v1/relay/preview/enter", publicUrl).toString(),
            previewUrl: new URL(`/api/v1/sandboxes/${access.sandboxId}/ports/${input.port}/`, publicUrl).toString(),
          }
        : {};
    return {
      ok: true as const,
      ticket: PREFIX + Buffer.from(sealed).toString("base64url"),
      wsUrl: relayWsUrl(publicUrl),
      ...preview,
      expiresAt: new Date(exp).toISOString(),
    };
  }
  async function redeemTicket(raw: string) {
    if (!encryptionKey || !raw.startsWith(PREFIX) || raw.length > 8_192) return null;
    const now = time.now();
    for (const [n, exp] of usedNonces) if (exp <= now) usedNonces.delete(n);
    const bytes = new Uint8Array(Buffer.from(raw.slice(PREFIX.length), "base64url"));
    const plaintext = await decryptSecret(bytes, encryptionKey).catch(() => null);
    const parsed = plaintext ? claimsSchema.safeParse(tryOr(() => JSON.parse(plaintext) as unknown, undefined)) : null;
    const c = parsed?.success ? parsed.data : null;
    if (
      !c ||
      c.exp <= now ||
      c.exp > now + MS.ticket ||
      (c.mode === "preview" && c.port === undefined) ||
      (c.mode === "pty" && c.port !== undefined) ||
      (c.cwd !== undefined && (c.mode !== "pty" || c.cwd.includes("\0"))) ||
      usedNonces.has(c.nonce)
    )
      return null;
    usedNonces.set(c.nonce, c.exp);
    return c;
  }
  function closeClient(c: ClientConn, code: number, notify: RelayCloseReason | null = "eof") {
    if (c.closed) return;
    c.closed = true;
    c.cancel();
    clientByWs.delete(c.socket);
    const rt = c.runtime;
    if (rt) {
      rt.clients.delete(c);
      for (const s of [...c.streams.values()]) {
        rt.streams.delete(s.runtimeId);
        if (notify && !rt.closed) sendClose(rt.socket, s.runtimeId, code, notify);
      }
    }
    c.streams.clear();
    tryOr(() => c.socket.close(code), undefined);
  }
  function closeRuntime(rt: RuntimeConn, code: number) {
    if (rt.closed) return;
    rt.closed = true;
    rt.cancel();
    runtimeByWs.delete(rt.socket);
    if (runtimes.get(rt.sandboxId) === rt) runtimes.delete(rt.sandboxId);
    const revoked = code === 4401 || code === 4403,
      cCode = revoked ? code : 1012,
      reason: RelayCloseReason = revoked ? "revoked" : "eof";
    for (const c of [...rt.clients]) {
      for (const s of [...c.streams.values()]) sendClose(c.socket, s.clientId, cCode, reason);
      closeClient(c, cCode, null);
    }
    for (const s of [...rt.streams.values()]) {
      if ("local" in s && !s.closed) {
        s.closed = true;
        s.local.onClose(cCode, reason);
      }
    }
    rt.streams.clear();
    tryOr(() => rt.socket.close(code), undefined);
  }
  async function revalidateRuntime(rt: RuntimeConn) {
    if (rt.closed || stopping || rt.revalidating) return;
    if (time.now() - rt.lastSeen >= MS.idle) return closeRuntime(rt, 1001);
    rt.revalidating = true;
    try {
      await verifyRuntime(rt.token, rt.epoch);
    } catch (e) {
      return closeRuntime(rt, rtErrCode(e));
    } finally {
      rt.revalidating = false;
    }
    if (!rt.closed && !stopping && !send(rt.socket, encodeRelayMessage({ type: PING }))) closeRuntime(rt, 1012);
  }
  async function checkClientClaims(c: ClientConn, claims: RelayTicketClaims, notify: RelayCloseReason | null) {
    const access = await queryAccess(claims.orgIds, claims.userId, claims.sandboxId);
    if (c.closed || stopping) return false;
    if (!access.ok) {
      closeClient(c, access.code === "forbidden" ? 4403 : 4401, notify);
      return false;
    }
    if (access.epoch !== claims.epoch) {
      closeClient(c, 4401, notify);
      return false;
    }
    return true;
  }
  async function revalidateClient(c: ClientConn) {
    if (c.closed || stopping || !c.authed || !c.claims || c.revalidating) return;
    c.revalidating = true;
    try {
      if (!isConnected(c.claims.sandboxId, c.claims.epoch)) closeClient(c, 1012, null);
      else await checkClientClaims(c, c.claims, "revoked");
    } catch {
      closeClient(c, 1012, "revoked");
    } finally {
      c.revalidating = false;
    }
  }
  function attachClient(c: ClientConn, claims: RelayTicketClaims) {
    const rt = runtimes.get(claims.sandboxId);
    if (!rt || rt.closed || rt.epoch !== claims.epoch) return false;
    c.authed = true;
    c.claims = claims;
    c.runtime = rt;
    rt.clients.add(c);
    c.cancel();
    c.cancel = time.every(MS.recheck, () => void track(revalidateClient(c)));
    return true;
  }
  function onRuntimeMessage(rt: RuntimeConn, raw: string | Buffer) {
    if (rt.closed || stopping) return;
    const msg = decodeBin(raw);
    if (!msg) return closeRuntime(rt, 1002);
    rt.lastSeen = time.now();
    if (msg.type === PING || msg.type === PONG) {
      if (msg.type === PING) {
        if (rt.pingBusy) return closeRuntime(rt, 1008);
        rt.pingBusy = true;
        return track(
          (async () => {
            try {
              await verifyRuntime(rt.token, rt.epoch);
            } catch (e) {
              return closeRuntime(rt, rtErrCode(e));
            } finally {
              rt.pingBusy = false;
            }
            const pong = encodeRelayMessage({ type: PONG, ...(msg.nonce ? { nonce: msg.nonce } : {}) });
            if (!rt.closed && !stopping && !send(rt.socket, pong)) closeRuntime(rt, 1012);
          })(),
        );
      }
      return;
    }
    if (msg.type === OPEN_PTY || msg.type === OPEN_TCP || msg.type === RESIZE) return closeRuntime(rt, 1002);
    if (msg.type === CLOSE && msg.streamId === 0) return closeRuntime(rt, 1001);
    const s = rt.streams.get(msg.streamId);
    if (!s) return;
    if (s.kind === "tcp" && msg.type === DATA) rt.lastTcpAt = time.now();
    if ("local" in s) {
      if (s.closed) return;
      if (msg.type === OPEN_OK) s.local.onOpen();
      else if (msg.type === DATA) s.local.onData(new Uint8Array(msg.data));
      else if (msg.type === CREDIT) s.local.onCredit(msg.bytes);
      else if (msg.type === CLOSE) {
        s.closed = true;
        rt.streams.delete(s.runtimeId);
        s.local.onClose(msg.code, msg.reason);
      }
      return;
    }
    if (s.client.closed) return;
    if (msg.type === CLOSE) {
      s.client.streams.delete(s.clientId);
      rt.streams.delete(s.runtimeId);
    }
    if (!send(s.client.socket, remapFrame(raw, s.clientId))) closeClient(s.client, 1012);
  }
  async function onClientAuth(c: ClientConn, raw: string | Buffer) {
    if (c.authBusy) return closeClient(c, 1008, null);
    const parsed =
      typeof raw === "string" && Buffer.byteLength(raw) <= 8_192
        ? tryOr(() => JSON.parse(raw) as unknown, undefined)
        : undefined;
    const f =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    if (
      !f ||
      Object.keys(f).some((k) => k !== "type" && k !== "ticket") ||
      f.type !== "auth" ||
      typeof f.ticket !== "string"
    )
      return closeClient(c, 1002, null);
    c.authBusy = true;
    try {
      const claims = await redeemTicket(f.ticket);
      if (c.closed || stopping) return;
      if (!claims) return closeClient(c, 4401, null);
      if (!(await checkClientClaims(c, claims, null))) return;
      if (!attachClient(c, claims) || !send(c.socket, JSON.stringify({ type: "auth_ok" }))) closeClient(c, 1012, null);
    } catch {
      closeClient(c, 1012, null);
    } finally {
      c.authBusy = false;
    }
  }
  function onClientBinary(c: ClientConn, raw: string | Buffer) {
    const { claims, runtime: rt } = c;
    if (!claims || !rt || rt.closed) return closeClient(c, 1012, null);
    const msg = decodeBin(raw);
    if (!msg || msg.type === OPEN_OK) return closeClient(c, 1002);
    if (msg.type === PING || msg.type === PONG) {
      if (msg.type === PING) {
        const pong = encodeRelayMessage({ type: PONG, ...(msg.nonce ? { nonce: msg.nonce } : {}) });
        if (!send(c.socket, pong)) closeClient(c, 1012);
      }
      return;
    }
    if (msg.type === OPEN_PTY || msg.type === OPEN_TCP) {
      const pty = msg.type === OPEN_PTY,
        reqCwd = "cwd" in msg && typeof msg.cwd === "string" ? msg.cwd : undefined;
      const scopeBad = pty
        ? claims.mode !== "pty" || (claims.cwd !== undefined && reqCwd !== undefined && reqCwd !== claims.cwd)
        : claims.mode === "pty" || (claims.port !== undefined && msg.port !== claims.port);
      if (scopeBad) return !sendClose(c.socket, msg.streamId, 4403, "refused") ? closeClient(c, 1012) : undefined;
      if (c.streams.has(msg.streamId)) return closeClient(c, 1002);
      const runtimeId = allocRuntimeId(rt, pty);
      if (runtimeId === null)
        return !sendClose(c.socket, msg.streamId, 4429, "limit") ? closeClient(c, 1012) : undefined;
      const s: ClientStream = { client: c, clientId: msg.streamId, runtimeId, kind: pty ? "pty" : "tcp" };
      c.streams.set(msg.streamId, s);
      rt.streams.set(runtimeId, s);
      if (!pty) rt.lastTcpAt = time.now();
      const cwd = pty ? (claims.cwd ?? reqCwd) : undefined;
      const out = pty
        ? encodeRelayMessage({
            type: OPEN_PTY,
            streamId: runtimeId,
            cols: msg.cols,
            rows: msg.rows,
            ...(cwd ? { cwd } : {}),
          })
        : encodeRelayMessage({ type: OPEN_TCP, streamId: runtimeId, port: msg.port });
      if (!send(rt.socket, out)) closeRuntime(rt, 1012);
      return;
    }
    if (msg.type === CLOSE && msg.streamId === 0) return closeClient(c, 1000);
    const s = c.streams.get(msg.streamId);
    if (!s) return;
    if (msg.type === RESIZE && s.kind !== "pty") return closeClient(c, 1002);
    if (msg.type === DATA && s.kind === "tcp") rt.lastTcpAt = time.now();
    if (msg.type === CLOSE) {
      c.streams.delete(s.clientId);
      rt.streams.delete(s.runtimeId);
    }
    if (!send(rt.socket, remapFrame(raw, s.runtimeId))) closeRuntime(rt, 1012);
  }
  const websocket: WebSocketHandler<RelaySocketData> = {
    maxPayloadLength: MAX_RELAY_FRAME,
    backpressureLimit: 2 * 1048576,
    closeOnBackpressureLimit: true,
    idleTimeout: 60,
    sendPings: false,
    open(socket) {
      if (stopping) return tryOr(() => socket.close(1012), undefined);
      if (socket.data.kind === "runtime-relay") {
        const { token, epoch, sandboxId } = socket.data,
          old = runtimes.get(sandboxId);
        if (old && !old.closed) {
          if (BigInt(old.epoch) > BigInt(epoch)) return tryOr(() => socket.close(4401), undefined);
          closeRuntime(old, BigInt(epoch) > BigInt(old.epoch) ? 4401 : 1012);
        }
        const rt = new RuntimeConn(socket, token, epoch, sandboxId, time.now());
        runtimes.set(sandboxId, rt);
        runtimeByWs.set(socket, rt);
        rt.cancel = time.every(MS.ping, () => void track(revalidateRuntime(rt)));
        return;
      }
      const c = new ClientConn(socket);
      clientByWs.set(socket, c);
      if (socket.data.claims) {
        if (!attachClient(c, socket.data.claims)) closeClient(c, 1012, null);
      } else c.cancel = time.after(MS.auth, () => !c.authed && closeClient(c, 4401, null));
    },
    message(socket, raw) {
      if (socket.data.kind === "runtime-relay") {
        const rt = runtimeByWs.get(socket);
        return rt ? onRuntimeMessage(rt, raw) : undefined;
      }
      const c = clientByWs.get(socket);
      if (!c || c.closed || stopping) return;
      if (c.authed) {
        onClientBinary(c, raw);
        return;
      }
      return track(onClientAuth(c, raw));
    },
    close(socket) {
      if (socket.data.kind === "runtime-relay") {
        const rt = runtimeByWs.get(socket);
        if (rt) closeRuntime(rt, 1001);
      } else {
        const c = clientByWs.get(socket);
        if (c) closeClient(c, 1000);
      }
    },
  };
  async function runUpgrade(
    r: Request,
    accept: (data: RelaySocketData) => boolean,
    resolve: () => Promise<RelaySocketData | Response>,
  ) {
    if (stopping) return emptyRes(503);
    if (r.method !== "GET") return emptyRes(405, { allow: "GET" });
    if (r.headers.get("upgrade")?.toLowerCase() !== "websocket") return emptyRes(426, { upgrade: "websocket" });
    if (new URL(r.url).search) return emptyRes(400);
    const result = await track(resolve());
    if (result instanceof Response) return result;
    if (stopping) return emptyRes(503);
    if (r.signal.aborted) return emptyRes(499);
    return accept(result) ? undefined : emptyRes(400);
  }
  const upgradeRuntime = (r: Request, accept: (data: RelaySocketData) => boolean) =>
    runUpgrade(r, accept, async () => {
      const token = bearerOf(r) ?? "",
        epoch = r.headers.get("x-armada-runtime-epoch") ?? "";
      try {
        const s = await verifyRuntime(token, epoch);
        return { kind: "runtime-relay", token, epoch: s.epoch, sandboxId: s.sandboxId };
      } catch (e) {
        const code = rtErrCode(e);
        if (code === 4403) return emptyRes(403);
        if (code === 4401) return emptyRes(401);
        return emptyRes(503);
      }
    });
  const upgradeClient = (r: Request, accept: (data: RelaySocketData) => boolean) =>
    runUpgrade(r, accept, async () => {
      const origin = r.headers.get("origin"),
        bearer = bearerOf(r);
      if (origin !== null && origin !== expectedOrigin) return emptyRes(403);
      if (!bearer) {
        if (origin === null) return emptyRes(401);
        return { kind: "client-relay" };
      }
      try {
        const claims = await redeemTicket(bearer);
        if (!claims) return emptyRes(401);
        const access = await queryAccess(claims.orgIds, claims.userId, claims.sandboxId);
        if (!access.ok) return emptyRes(access.status);
        if (access.epoch !== claims.epoch || !isConnected(claims.sandboxId, claims.epoch)) return emptyRes(503);
        return { kind: "client-relay", claims };
      } catch {
        return emptyRes(503);
      }
    });
  function openTcp(sandboxId: string, port: number, local: LocalTcpCallbacks, expectedEpoch?: string) {
    if (stopping) return { ok: false as const, reason: "unavailable" as const };
    const rt = runtimes.get(sandboxId);
    if (!rt || rt.closed || (expectedEpoch !== undefined && rt.epoch !== expectedEpoch))
      return { ok: false as const, reason: "unavailable" as const };
    const runtimeId = allocRuntimeId(rt, false);
    if (runtimeId === null) return { ok: false as const, reason: "limit" as const };
    const s: LocalStream = { local, runtimeId, kind: "tcp", closed: false };
    rt.streams.set(runtimeId, s);
    rt.lastTcpAt = time.now();
    if (!send(rt.socket, encodeRelayMessage({ type: OPEN_TCP, streamId: runtimeId, port }))) {
      s.closed = true;
      rt.streams.delete(runtimeId);
      closeRuntime(rt, 1012);
      return { ok: false as const, reason: "unavailable" as const };
    }
    const stream: LocalTcpStream = {
      sendData(data) {
        if (s.closed || rt.closed || rt.streams.get(runtimeId) !== s) return false;
        rt.lastTcpAt = time.now();
        if (!send(rt.socket, encodeRelayMessage({ type: DATA, streamId: runtimeId, data }))) {
          closeRuntime(rt, 1012);
          return false;
        }
        return true;
      },
      sendCredit(bytes) {
        if (s.closed || rt.closed || rt.streams.get(runtimeId) !== s) return false;
        if (!send(rt.socket, encodeRelayMessage({ type: CREDIT, streamId: runtimeId, bytes }))) {
          closeRuntime(rt, 1012);
          return false;
        }
        return true;
      },
      close(code = 1000, reason = "eof") {
        if (s.closed) return;
        s.closed = true;
        rt.streams.delete(runtimeId);
        if (!rt.closed) sendClose(rt.socket, runtimeId, code, reason);
      },
    };
    return { ok: true as const, stream };
  }
  async function stop() {
    stopping = true;
    for (const c of [...clientByWs.values()]) closeClient(c, 1012, null);
    for (const rt of [...runtimeByWs.values()]) closeRuntime(rt, 1012);
    while (pending.size) await Promise.allSettled([...pending]);
  }
  return {
    upgradeRuntime,
    upgradeClient,
    websocket,
    mintTicket,
    redeemTicket,
    checkAccess: queryAccess,
    openTcp,
    isConnected,
    hasActiveRelay,
    stop,
  };
}
export type RelayHub = ReturnType<typeof createRelayHub>;
