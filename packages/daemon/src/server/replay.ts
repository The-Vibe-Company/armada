import type { EventBatch, ServerMessage } from "@armada/protocol";

export const REPLAY_WINDOW = 2048;
export const PAGE_BYTES = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const BUFFER_LIMIT = 8 * 1024 * 1024;
const DRAIN_DEADLINE = 10_000;

export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** Only event pages are bounded; a snapshot is one indivisible state, sent once. */
export function* replayFrames(batch: EventBatch): Generator<EventBatch> {
  const { events, snapshot, ...base } = batch;
  const overhead = jsonBytes({ ...base, events: [], more: true });
  let page: EventBatch["events"] = [];
  let bytes = overhead;
  for (const event of events) {
    const size = jsonBytes(event) + (page.length ? 1 : 0);
    if (page.length && bytes + size > PAGE_BYTES) {
      yield { ...base, seq: (page.at(-1) as EventBatch["events"][number]).seq, events: page, more: true };
      page = [];
      bytes = overhead;
    }
    page.push(event);
    bytes += jsonBytes(event) + (page.length > 1 ? 1 : 0);
  }
  const last = { ...base, events: page, ...(snapshot ? { snapshot } : {}) };
  if (page.length && snapshot && jsonBytes(last) > PAGE_BYTES) {
    yield { ...base, seq: (page.at(-1) as EventBatch["events"][number]).seq, events: page, more: true };
    yield { ...base, events: [], snapshot };
  } else yield last;
}

interface Socket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
  close(code: number, reason: string): void;
}
interface Transfer {
  frames: Iterator<ServerMessage>;
  active: boolean;
  done: () => void;
  bytes: number;
}

/** One FIFO per socket: replay and replies wait for the same low-water mark. */
export class Replay {
  readonly #socket: Socket;
  readonly #queue: Transfer[] = [];
  #timer?: ReturnType<typeof setTimeout>;
  #deadline = 0;
  #queuedBytes = 0;
  #pumping = false;

  constructor(socket: Socket) {
    this.#socket = socket;
  }

  send(message: ServerMessage, done: () => void = () => {}): void {
    if (this.#socket.readyState !== 1) return;
    if (!this.#queue.length && this.#socket.bufferedAmount > BUFFER_LIMIT) {
      this.#refuse("Client could not drain daemon updates");
      return;
    }
    const bytes = jsonBytes(message);
    if (this.#queuedBytes + bytes > BUFFER_LIMIT) {
      this.#refuse("Client could not drain daemon updates");
      return;
    }
    this.#queuedBytes += bytes;
    this.#queue.push({ frames: [message][Symbol.iterator](), active: true, done, bytes });
    this.#pump();
  }

  /** A cancelled/replaced subscription drops unsent pages, never its replacement. */
  replay(frames: Iterable<ServerMessage>, done: () => void): () => void {
    const transfer = { frames: frames[Symbol.iterator](), active: true, done, bytes: 0 };
    this.#queue.push(transfer);
    this.#pump();
    return () => {
      transfer.active = false;
      this.#pump();
    };
  }

  close(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#deadline = 0;
    this.#queue.length = 0;
    this.#queuedBytes = 0;
  }

  #refuse(reason: string): void {
    this.close();
    this.#socket.close(4008, reason);
  }

  #write(message: ServerMessage): void {
    this.#socket.send(JSON.stringify(message), (error) => {
      if (error) {
        this.close();
        this.#socket.close(1011, "Daemon could not send updates");
      }
    });
  }

  #pump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#queue.length) {
        if (this.#socket.readyState !== 1) {
          this.close();
          return;
        }
        const transfer = this.#queue[0] as Transfer;
        if (!transfer.active) {
          this.#queue.shift();
          this.#queuedBytes -= transfer.bytes;
          continue;
        }
        if (this.#socket.bufferedAmount > LOW_WATER) {
          this.#deadline ||= Date.now() + DRAIN_DEADLINE;
          if (Date.now() >= this.#deadline) {
            this.#refuse("Replay drain timed out");
            return;
          }
          this.#timer ??= setTimeout(() => {
            this.#timer = undefined;
            this.#pump();
          }, 25);
          this.#timer.unref();
          return;
        }
        clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#deadline = 0;
        const next = transfer.frames.next();
        if (next.done) {
          this.#queue.shift();
          this.#queuedBytes -= transfer.bytes;
          transfer.done();
        } else this.#write(next.value);
      }
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#deadline = 0;
    } catch {
      this.close();
      this.#socket.close(1011, "Daemon could not replay updates");
    } finally {
      this.#pumping = false;
    }
  }
}
