import type { Context } from "@earendil-works/chord";
import { type Id, MemoryStorage, type Seq, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import type { Json } from "../src/events.ts";
import type { EventStore } from "../src/store.ts";

export interface LogStorageOptions {
  store: EventStore;
  project: string;
  now: () => string;
}

type Checkpoint =
  | { format: "armada.pi"; version: 1; type: "id"; id: number }
  | { format: "armada.pi"; version: 1; type: "commit"; seq: Seq; writes: readonly StorageWrite[] };

const owners = new WeakMap<EventStore, Set<string>>();

/** One pi Session per project, using the same append boundary as fleet readers and subscriptions. */
export function openCoordinatorStorage(options: LogStorageOptions): Storage {
  const projects = owners.get(options.store) ?? new Set<string>();
  if (projects.has(options.project)) throw new Error(`Coordinator storage already open for ${options.project}`);
  const storage = new LogStorage(options, () => projects.delete(options.project));
  projects.add(options.project);
  owners.set(options.store, projects);
  return storage;
}

/** MemoryStorage is pi's validated projection, never a second source of truth. */
class LogStorage extends MemoryStorage {
  readonly #options: LogStorageOptions;
  readonly #release: () => void;
  #nextId = 2;
  #closed = false;

  constructor(options: LogStorageOptions, release: () => void) {
    super();
    this.#options = options;
    this.#release = release;
    for (const event of options.store.readSince(0, options.project)) {
      if (event.kind !== "coordinator.checkpoint") continue;
      const value = event.payload.checkpoint;
      if (!value || typeof value !== "object" || Array.isArray(value) || value.format !== "armada.pi") continue;
      if (value.version !== 1) throw new Error("Unsupported Armada pi checkpoint version");
      const checkpoint = value as unknown as Checkpoint;
      if (checkpoint.type === "id" && Number.isSafeInteger(checkpoint.id) && checkpoint.id >= this.#nextId) {
        this.#nextId = checkpoint.id + 1;
      } else if (checkpoint.type === "commit" && Array.isArray(checkpoint.writes)) {
        this.prepareCommit(checkpoint.writes, checkpoint.seq).apply();
        this.#observeIds(checkpoint.writes);
      } else {
        throw new Error("Invalid Armada pi checkpoint");
      }
    }
  }

  override async mintId<I extends Id<string>>(): Promise<I> {
    if (this.#closed) throw new Error("Coordinator storage is closed");
    const id = this.#nextId;
    if (!Number.isSafeInteger(id)) throw new Error("Coordinator ID space exhausted");
    this.#append({ format: "armada.pi", version: 1, type: "id", id });
    this.#nextId++;
    return id as I;
  }

  override async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
    // Prepare before append, publish after append. A rejected append leaves the projection unchanged.
    const prepared = this.prepareCommit(writes);
    this.#append({ format: "armada.pi", version: 1, type: "commit", seq: prepared.seq, writes: prepared.writes });
    const seq = prepared.apply();
    this.#observeIds(prepared.writes);
    return seq;
  }

  override async close(context: Context): Promise<void> {
    await super.close(context);
    this.#closed = true;
    this.#release();
    // The daemon owns the shared EventStore, whose lifetime includes other projects and the server.
  }

  #append(checkpoint: Checkpoint): void {
    this.#options.store.append({
      project: this.#options.project,
      kind: "coordinator.checkpoint",
      actor: "coordinator",
      at: this.#options.now(),
      payload: { checkpoint: JSON.parse(JSON.stringify(checkpoint)) as Json },
    });
  }

  #observeIds(writes: readonly StorageWrite[]): void {
    for (const write of writes) {
      const id = "value" in write ? write.value.id : "record" in write ? write.record.id : write.id;
      this.#nextId = Math.max(this.#nextId, id + 1);
    }
  }
}
