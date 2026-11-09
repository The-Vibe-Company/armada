import { createHash } from "node:crypto";
import type { Journal } from "./journal.ts";
import type { McpConfiguration, OrchestratorEpochBinding } from "./protocol.ts";

const SERVER = "armada_orchestrator";
const deny = (): never => {
  throw Error("orchestrator_epoch_denied");
};

/** Private, quiescent session configuration; no live-client reload is promised.
 * Only a monotonic epoch tombstone is durable. Bearer material stays in memory
 * and the journal redactor, never in request receipts, metadata or snapshots. */
export class NativeEpoch {
  private installed: { epoch: string; hash: string; url: string } | undefined;
  private readonly key: string;
  constructor(
    private readonly generation: string,
    private readonly journal: Journal,
    identityKey: string,
    private readonly quiescent: () => boolean,
    private readonly configuration: () => McpConfiguration | undefined,
    private readonly configure: (configuration: McpConfiguration) => void,
  ) {
    this.key = `orchestrator-epoch:${identityKey}`;
  }

  get active(): boolean {
    return this.installed !== undefined;
  }

  install(token: string, binding: OrchestratorEpochBinding, url: string): { acknowledged: boolean } {
    if (
      typeof token !== "string" ||
      !/^armada_epoch_[a-f0-9]{64}$/.test(token) ||
      !binding ||
      binding.physicalGeneration !== this.generation ||
      typeof binding.epoch !== "string" ||
      !/^[1-9][0-9]{0,18}$/.test(binding.epoch)
    )
      return deny();
    this.journal.registerSecrets([token]);
    if (!this.quiescent()) return deny();
    let endpoint: URL;
    try {
      endpoint = new URL(url);
    } catch {
      return deny();
    }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) return deny();
    const row = this.journal.db.query("SELECT value FROM metadata WHERE key=?").get(this.key) as {
      value: string;
    } | null;
    const minimum = row?.value ?? "0";
    if (!/^[0-9]{1,19}$/.test(minimum)) return deny();
    const hash = createHash("sha256").update(token).digest("hex");
    if (BigInt(binding.epoch) < BigInt(minimum)) return deny();
    if (BigInt(binding.epoch) === BigInt(minimum)) {
      if (
        this.installed?.epoch === binding.epoch &&
        this.installed.hash === hash &&
        this.installed.url === endpoint.href
      )
        return { acknowledged: true };
      return deny(); // A restart/scrub cannot resurrect a previously consumed epoch.
    }
    const current = this.configuration();
    if (!this.installed && current?.servers[SERVER]) return deny();
    // Reserve before configuration. Failed delivery consumes the epoch, never opens it.
    this.journal.db.query("INSERT OR REPLACE INTO metadata VALUES(?,?)").run(this.key, binding.epoch);
    this.configure({
      revision: `orchestrator-epoch-${binding.epoch}`,
      servers: {
        ...current?.servers,
        [SERVER]: { type: "http", url: endpoint.href, headers: { Authorization: `Bearer ${token}` } },
      },
    });
    this.installed = { epoch: binding.epoch, hash, url: endpoint.href };
    return { acknowledged: true };
  }

  scrub(tokenHash?: string): void {
    if (tokenHash !== undefined && !/^[a-f0-9]{64}$/.test(tokenHash)) deny();
    if (!this.installed || (tokenHash !== undefined && tokenHash !== this.installed.hash)) return;
    if (!this.quiescent()) deny();
    const current = this.configuration();
    const servers = { ...current?.servers };
    delete servers[SERVER];
    this.configure({ revision: `orchestrator-epoch-${this.installed.epoch}-scrubbed`, servers });
    this.installed = undefined;
  }

  assertEmpty(): void {
    if (this.installed) deny();
  }
}
