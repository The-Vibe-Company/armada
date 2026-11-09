import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { CreateGoldenRequest, ForkRequest, Provider, SandboxInfo, SnapshotInfo } from "@armada/core";
import { resolveModelChoice } from "@armada/core";
import type { App, Sandbox } from "modal";
import { chooseManagementAuthority, matchesManagementAuthority } from "./authority.ts";
import { type ModalConnection, modalConnection } from "./client.ts";
import { ModalOperationError, modalError, refusal } from "./errors.ts";
import { executeGoldenCommand } from "./golden-exec.ts";
import type {
  Machine,
  McpConfiguration,
  ModalManagementProvenance,
  ModalResourceReceipt,
  ModalStore,
  RunnerDistribution,
  RunnerTransport,
  SavedImage,
  Scope,
  SshPreparation,
} from "./ports.ts";
import { createSshPreparation, SSH_PORT } from "./ssh.ts";
import { scopeKey } from "./store.ts";

export interface ModalProviderOptions extends ModalConnection {
  scope: Scope;
  /** Trusted immutable source credential selection; never a requested access visibility. */
  managementAuthority?: ModalManagementProvenance;
  /** Lookup hint only. Actual App ID must match the binding on every operation. */
  appName: string;
  store: ModalStore;
  /** Trusted authorized snapshot scope, distinct from target machine scope for org->private forks. */
  source?: { scope: Scope; store: ModalStore };
  runner: RunnerTransport;
  distribution: RunnerDistribution;
  ssh?: SshPreparation;
  /** Trusted server lifecycle hook. Runs after ready/restore OUTSIDE the store lease; may call
   * get/configureMcp. Failure prevents native submission; incarnation is fenced on reacquisition. */
  beforePrompt?(provider: ModalProvider, sandboxId: string): Promise<void>;
}
export interface ModalProvider extends Provider {
  prepareNativeHarnessCwd(request: { sandboxId: string; harness: "claude" | "codex"; cwd: string }): Promise<void>;
  configureMcp(request: { sandboxId: string; configuration: McpConfiguration }): Promise<{ revision: string }>;
  restoreGoldenMaster(request: { sandboxId?: string; snapshotId: string }): Promise<SandboxInfo>;
  resourceReceipts(): Promise<ModalResourceReceipt[]>;
  collectGarbage(): Promise<void>;
  sshKey(request: {
    sandboxId: string;
    key: string;
  }): Promise<{ sshEndpoint: string; hostKey: string; username?: "user" | "root" }>;
  prepareSsh(
    sandboxId: string,
    publicKey: string,
  ): Promise<{ endpoint: string; hostPublicKey: string; username?: "user" | "root" }>;
}
/** Both scopes are assembled by the authenticated server, never by runner/request JSON. */
export function assertSourceTargetScopes(source: Scope, target: Scope): void {
  if (
    source.orgId !== target.orgId ||
    source.userId !== target.userId ||
    source.binding.workspace !== target.binding.workspace ||
    source.binding.environment !== target.binding.environment ||
    source.binding.appId !== target.binding.appId ||
    (source.visibility === "private" && target.visibility !== "private")
  )
    throw refusal("forbidden", "Source golden and target machine authority do not match.");
}
export function createModalProvider(options: ModalProviderOptions): ModalProvider {
  const { store, runner, distribution } = options;
  const source = options.source ?? { scope: options.scope, store };
  assertSourceTargetScopes(source.scope, options.scope);
  const managementAuthority = chooseManagementAuthority(source.scope, options.managementAuthority);
  function assertAuthority(record: { managementAuthority?: ModalManagementProvenance }): void {
    if (!matchesManagementAuthority(record.managementAuthority, managementAuthority))
      throw refusal("forbidden", "Stored source management authority does not match this provider connection.");
  }
  const ssh = options.ssh ?? createSshPreparation();
  const client = modalConnection(options);
  async function bound(): Promise<App> {
    const app = await client.apps.fromName(options.appName, {
      environment: options.scope.binding.environment,
      createIfMissing: false,
    });
    if (app.appId !== options.scope.binding.appId)
      throw refusal("forbidden", "Modal App does not match the immutable binding.");
    // Public SDK exposes App ID/environment, not authenticated workspace identity. Globally unique
    // App ID reached by an explicit token is authoritative; workspace label is never authentication.
    return app;
  }
  function assertMachineSource(row: Machine) {
    assertAuthority(row);
    const origin = row.sourceImage?.scopeKey ?? scopeKey(options.scope);
    if (origin !== scopeKey(source.scope))
      throw refusal("forbidden", "Machine source golden authority does not match this provider connection.");
  }
  function sandboxInfo(row: Machine): SandboxInfo {
    const { physicalGeneration: _ignored, ...info } = row.info;
    return { ...info, ...(row.physicalId ? { physicalGeneration: String(row.generation) } : {}) };
  }
  async function resourceReceipt(observed: Machine): Promise<ModalResourceReceipt> {
    const durable = await store.get(observed.info.id).catch(() => undefined);
    const row = durable ?? observed;
    const images = await store.images(row.info.id).catch(() => []);
    const snapshots = [
      ...(row.snapshotImages ?? []),
      ...(observed.snapshotImages ?? []),
      ...images.flatMap((x) => (x.imageId ? [{ name: x.info.name, imageId: x.imageId }] : [])),
    ];
    const snapshotImages = [
      ...new Map(snapshots.map((x) => [`${x.name}:${x.imageId}`, { name: x.name, imageId: x.imageId }])).values(),
    ];
    const physicalId = row.physicalId ?? observed.physicalId,
      imageId = row.imageId ?? observed.imageId;
    return {
      sandboxId: row.info.id,
      phase: row.phase,
      observedPhase: observed.phase,
      registryConfirmed: !!durable,
      generation: row.generation,
      physicalName: row.physicalName,
      ...(physicalId ? { physicalId } : {}),
      ...(imageId ? { imageId } : {}),
      recoveryImageIds: [
        ...new Set([
          ...(row.retainedRecoveryIds ?? []),
          ...(observed.retainedRecoveryIds ?? []),
          ...(row.recoveryImageId ? [row.recoveryImageId] : []),
          ...(observed.recoveryImageId ? [observed.recoveryImageId] : []),
        ]),
      ],
      snapshotImages,
      ...(row.sourceImage ? { sourceImage: { ...row.sourceImage } } : {}),
      ...(row.managementAuthority ? { managementAuthority: { ...row.managementAuthority } } : {}),
      binding: { ...options.scope.binding },
      appName: options.appName,
    };
  }
  async function physical(row: Machine): Promise<Sandbox> {
    assertMachineSource(row);
    await bound();
    if (!row.physicalId) throw refusal("sandbox_not_ready", "No current physical machine.");
    return client.sandboxes.fromId(row.physicalId);
  }
  function ownershipTags(row: Machine) {
    return {
      armada_sandbox: row.info.id,
      armada_scope: scopeKey(options.scope),
      armada_generation: String(row.generation),
    };
  }
  async function namedOwned(row: Machine): Promise<Sandbox> {
    assertMachineSource(row);
    await bound();
    let sb: Sandbox;
    try {
      sb = await client.sandboxes.fromName(options.appName, row.physicalName, {
        environment: options.scope.binding.environment,
        includeTerminated: true,
      });
    } catch (error) {
      if (modalError(error).code === "not_found")
        throw refusal(
          "unavailable",
          "Named create outcome is still unknown; reservation preserved. Retry reconciliation, never create a replacement.",
        );
      throw refusal(
        "unavailable",
        "Named create reconciliation unavailable; reservation preserved. Retry delete after Modal recovers.",
      );
    }
    let tags: Record<string, string>;
    try {
      tags = await sb.getTags();
    } catch {
      throw refusal(
        "unavailable",
        "Named machine ownership verification is unavailable; reservation preserved. Retry reconciliation.",
      );
    }
    if (!Object.entries(ownershipTags(row)).every(([key, value]) => tags[key] === value))
      throw refusal("conflict", "Named machine ownership does not match the reservation; resource not modified.");
    return sb;
  }
  async function create(
    row: Machine,
    save: (row: Machine) => Promise<void>,
    env: Readonly<Record<string, string>>,
  ): Promise<SandboxInfo> {
    const app = await bound();
    let sb: Sandbox;
    if (row.phase === "creating") {
      // Unknown create outcome: lookup only. A not-found does NOT prove a delayed create cannot land.
      sb = await namedOwned(row);
      if ((await sb.poll()) !== null)
        throw refusal("conflict", "Reconciled creation already terminated; manual recovery required.");
    } else if (row.phase === "reserved") {
      const image = row.imageId ? await client.images.fromId(row.imageId) : await distribution.image(client);
      row.phase = "creating";
      row.grantExpiresAt = Date.now() + row.ttlSeconds * 1000;
      await save(row);
      sb = await client.sandboxes.create(app, image, {
        name: row.physicalName,
        tags: ownershipTags(row),
        timeoutMs: row.ttlSeconds * 1000,
        workdir: "/home/user",
        unencryptedPorts: [SSH_PORT],
        secrets: [],
        env: {},
        includeOidcIdentityToken: false,
      });
    } else {
      sb = await physical(row);
    }
    row.physicalId = sb.sandboxId;
    row.phase = "booting";
    await save(row);
    if (distribution.captureProcessBaseline && !row.processBaseline) {
      if (row.freshStatePreparedGeneration === row.generation)
        throw refusal(
          "conflict",
          "Cannot trust a control baseline captured after bootstrap; physical source retained.",
        );
      row.processBaseline = await distribution.captureProcessBaseline(sb, row);
      await save(row);
    }
    if (
      row.processBaseline &&
      (row.processBaseline.physicalId !== row.physicalId || row.processBaseline.generation !== row.generation)
    )
      throw refusal("conflict", "Physical process baseline does not match this incarnation.");
    // Only a never-bootstrapped fresh master/new logical fork may discard inherited managed
    // state. Persist the marker BEFORE boot so retries cannot erase a same-id/generation fence.
    if (
      distribution.prepareFreshMachine &&
      (row.golden || row.generation === 1) &&
      row.freshStatePreparedGeneration !== row.generation
    ) {
      await distribution.prepareFreshMachine(sb, row);
      row.freshStatePreparedGeneration = row.generation;
      await save(row);
    }
    await distribution.start(sb, row, env);
    let healthy = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const health = await runner.call<{ generation?: string; ready?: boolean }>(row, "health", {});
        if (health.generation !== String(row.generation) || health.ready !== true)
          throw refusal("conflict", "Runner health belongs to another or closed generation.");
        healthy = true;
        break;
      } catch (error) {
        if (attempt === 119) throw error;
        await Bun.sleep(250);
      }
    }
    if (!healthy) throw refusal("unavailable", "Runner did not become ready.");
    row.phase = "active";
    row.info.state = "ready";
    row.info.providerState = "active";
    row.info.expiresAt = new Date(row.grantExpiresAt ?? Date.now());
    await save(row);
    return sandboxInfo(row);
  }
  async function launch(request: CreateGoldenRequest | ForkRequest, golden: boolean): Promise<SandboxInfo> {
    await bound();
    const ttl = request.ttlSeconds ?? 3600;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400)
      throw refusal("invalid_request", "Modal machine TTL must be 1–86400 seconds (maximum 24 hours).");
    let imageId: string | undefined;
    let sourceImage: Machine["sourceImage"];
    if ("from" in request) {
      const snapshot = await source.store.image(request.from);
      assertAuthority(snapshot);
      if (snapshot.info.status !== "ready" || !snapshot.imageId)
        throw refusal("sandbox_not_ready", "Snapshot is not ready.");
      imageId = snapshot.imageId;
      sourceImage = { scopeKey: scopeKey(source.scope), name: request.from, imageId };
    }
    const key = request.idempotencyKey ?? randomUUID();
    const id = `modal_${randomUUID()}`;
    const row = await store.reserve(key, {
      info: {
        id,
        name: request.name ?? id,
        state: "starting",
        providerState: "reserved",
        labels: request.labels ?? {},
        createdAt: new Date(),
      },
      generation: 1,
      launchUserId: options.scope.userId,
      managementAuthority: { ...managementAuthority },
      modelDefaults: { claude: resolveModelChoice("claude", {}), codex: resolveModelChoice("codex", {}) },
      phase: "reserved",
      golden,
      ttlSeconds: ttl,
      physicalName: `armada-${createHash("sha256").update(id).digest("hex").slice(0, 32)}-1`,
      ...(imageId ? { imageId } : {}),
      ...(sourceImage ? { sourceImage } : {}),
    });
    let observed = row;
    try {
      if (
        row.golden !== golden ||
        row.imageId !== imageId ||
        row.sourceImage?.scopeKey !== sourceImage?.scopeKey ||
        row.sourceImage?.name !== sourceImage?.name
      )
        throw refusal("conflict", "Idempotency key belongs to another launch.");
      assertMachineSource(row);
      if (row.phase === "active" || row.phase === "stopped") return sandboxInfo(row);
      if (!["reserved", "creating", "booting"].includes(row.phase))
        throw refusal("conflict", "Launch is in a terminal or checkpoint phase.");
      return await store.lease(row.info.id, (current, save) => {
        observed = current;
        return create(current, save, "env" in request ? (request.env ?? {}) : {});
      });
    } catch (error) {
      throw new ModalOperationError(error, await resourceReceipt(observed));
    }
  }
  /** Caller holds the lifecycle lease through activation and the admitted operation. */
  async function readyLeased(row: Machine, save: (row: Machine) => Promise<void>): Promise<Machine> {
    assertMachineSource(row);
    if (row.golden && row.quiesced) throw refusal("sandbox_not_ready", "Sealed golden admission cannot be reopened.");
    if (row.phase === "stopped") {
      if (!row.recoveryImageId) throw refusal("conflict", "Stopped sandbox has no durable recovery image.");
      row.generation++;
      row.quiesced = false;
      row.eventBase = row.checkpointWatermark ?? 0;
      row.imageId = row.recoveryImageId;
      row.physicalName = `armada-${createHash("sha256").update(row.info.id).digest("hex").slice(0, 32)}-${row.generation}`;
      row.phase = "reserved";
      row.info.state = "starting";
      delete row.physicalId;
      delete row.processBaseline;
      await save(row);
    }
    if (row.generation > 1 && ["reserved", "creating", "booting"].includes(row.phase))
      await create(row, save, await distribution.restoreEnv(row));
    if (row.phase !== "active") throw refusal("sandbox_not_ready", "Sandbox lifecycle is not active.");
    if ((await (await physical(row)).poll()) !== null)
      throw refusal(
        "sandbox_not_ready",
        "Physical machine expired or exited; no verified checkpoint is available for current writes.",
      );
    return row;
  }
  async function ready(id: string): Promise<Machine> {
    const row = await store.get(id);
    if (row.phase === "stopped" || (row.generation > 1 && ["reserved", "creating", "booting"].includes(row.phase)))
      return store.lease(id, readyLeased);
    // No mutation is necessary; readyLeased cannot save an already-active row.
    return readyLeased(row, async () => {
      throw refusal("conflict", "Activation requires a lifecycle lease.");
    });
  }
  async function healthyAdmission(row: Machine, save: (row: Machine) => Promise<void>): Promise<Machine> {
    const active = await readyLeased(row, save);
    const health = await runner.call<{ generation: string; ready: boolean }>(active, "health", {});
    if (!health || health.generation !== String(active.generation) || health.ready !== true)
      throw refusal("sandbox_not_ready", "Runner admission is not open for this generation.");
    return active;
  }
  /** Queue only a lease acquisition that ran no callback. Never retry an uncertain RPC outcome. */
  async function admit<T>(
    id: string,
    work: (row: Machine, save: (row: Machine) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await store.lease(id, work);
      } catch (error) {
        if (modalError(error).providerCode !== "lifecycle_lease_busy" || attempt >= 99) throw error;
        if ((await store.get(id)).phase !== "active") throw error;
        await Bun.sleep(20);
      }
    }
  }
  async function call<T>(id: string, op: string, input: object): Promise<T> {
    return runner.call<T>(await ready(id), op, input);
  }
  async function checkpoint(row: Machine, save: (row: Machine) => Promise<void>) {
    const result = await runner.call<{ watermark: number; acknowledgedSequence: number; generation: string }>(
      row,
      "checkpoint",
      {},
    );
    if (
      result.generation !== String(row.generation) ||
      !Number.isSafeInteger(result.watermark) ||
      result.watermark < 0 ||
      result.acknowledgedSequence !== result.watermark ||
      (await store.watermark(row.info.id, row.generation)) !== result.watermark
    )
      throw refusal("conflict", "Checkpoint lacks a matching durably acknowledged event watermark; source retained.");
    row.checkpointWatermark = result.watermark;
    await save(row);
  }
  async function collectFrom(imagesStore: ModalStore) {
    for (const source of await imagesStore.list()) {
      if (!matchesManagementAuthority(source.managementAuthority, managementAuthority)) continue;
      const pending = (await imagesStore.images(source.info.id)).filter((x) => x.deleted);
      if (!pending.length) continue;
      await imagesStore.lease(source.info.id, async () => {
        for (const image of (await imagesStore.images(source.info.id)).filter(
          (x) => x.deleted && matchesManagementAuthority(x.managementAuthority, managementAuthority),
        )) {
          if (!image.imageId || (await imagesStore.imageReferenced(image.imageId))) continue;
          if (image.imageId) {
            try {
              await client.images.delete(image.imageId);
            } catch (error) {
              if (modalError(error).code !== "not_found") throw error;
            }
          }
          await imagesStore.purgeImage(image.info.name);
        }
      });
    }
  }
  async function collectImages() {
    await collectFrom(source.store);
  }
  const provider: ModalProvider = {
    id: "modal",
    harnesses: ["claude", "codex"],
    capabilities: distribution.capabilities,
    createGolden: (r) => {
      if (source.scope.visibility !== options.scope.visibility)
        throw refusal("forbidden", "Split source/target adapter is fork-only for golden creation.");
      return launch(r, true);
    },
    async fork(r) {
      const snapshot = await source.store.image(r.from);
      assertAuthority(snapshot);
      return source.store.lease(snapshot.sourceId, async () => launch(r, false));
    },
    async get(id) {
      await bound();
      const row = await store.get(id);
      assertMachineSource(row);
      if (row.phase === "deleted") throw refusal("not_found", "Sandbox was deleted.");
      if (row.phase === "active" && (await (await physical(row)).poll()) !== null)
        return {
          ...sandboxInfo(row),
          state: "failed",
          providerState: "exited",
          physicalExitConfirmed: true,
          error: "Physical machine exited without a new verified checkpoint.",
        };
      return { ...sandboxInfo(row), providerState: row.phase };
    },
    async list(r = {}) {
      await bound();
      const limit = r.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw refusal("invalid_request", "Invalid page limit.");
      const candidates = (await store.list())
        .filter(
          (x) =>
            x.phase !== "deleted" &&
            matchesManagementAuthority(x.managementAuthority, managementAuthority) &&
            (x.sourceImage?.scopeKey ?? scopeKey(options.scope)) === scopeKey(source.scope) &&
            (!r.cursor || x.info.id > r.cursor) &&
            Object.entries(r.labels ?? {}).every(([k, v]) => x.info.labels[k] === v),
        )
        .sort((a, b) => a.info.id.localeCompare(b.info.id));
      const rows: SandboxInfo[] = [];
      for (let offset = 0; offset < candidates.length; offset += 8) {
        const batch = await Promise.all(candidates.slice(offset, offset + 8).map((x) => provider.get(x.info.id)));
        rows.push(...batch.filter((x) => !r.states || r.states.includes(x.state)));
        if (rows.length > limit) break;
      }
      return { items: rows.slice(0, limit), cursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null };
    },
    async restoreGoldenMaster({ sandboxId: requestedSandboxId, snapshotId }) {
      if (scopeKey(source.scope) !== scopeKey(options.scope))
        throw refusal("forbidden", "Golden master restore requires a source-scoped provider connection.");
      const snapshot = await source.store.image(snapshotId);
      assertAuthority(snapshot);
      if (requestedSandboxId !== undefined && snapshot.sourceId !== requestedSandboxId)
        throw refusal("forbidden", "Snapshot does not belong to this golden master.");
      const sandboxId = snapshot.sourceId;
      if (snapshot.info.status !== "ready" || !snapshot.imageId)
        throw refusal("sandbox_not_ready", "Golden snapshot is not ready.");
      if (!snapshot.goldenClean && !distribution.prepareFreshMachine)
        throw refusal(
          "conflict",
          "Legacy golden restore requires a distribution that sanitizes fresh managed state before bootstrap.",
        );
      await bound();
      let observed: Machine | undefined;
      try {
        return await source.store.lease(sandboxId, async (row, save) => {
          observed = row;
          assertMachineSource(row);
          if (!row.golden) throw refusal("invalid_request", "Only a golden master can be restored through this port.");
          const same =
            row.goldenRestore?.snapshotId === snapshotId &&
            (row.goldenRestore.sourceImageId ?? row.goldenRestore.imageId) === snapshot.imageId;
          if (row.phase === "active") {
            if (!same || row.goldenRestore?.generation !== row.generation || row.quiesced)
              throw refusal(
                "conflict",
                "Active golden master has a different restore context; edits were not discarded.",
              );
            return sandboxInfo(await healthyAdmission(row, save));
          }
          if (["reserved", "creating", "booting"].includes(row.phase)) {
            if (!same || row.goldenRestore?.generation !== row.generation)
              throw refusal("conflict", "Another golden restore is in progress.");
            // A committed boot may have lost its last SQL/HTTP response. Reconcile without starting a
            // second runner or resetting admission/session state on that same physical machine.
            if (row.phase === "booting" && row.physicalId) {
              let health: { generation: string; ready: boolean } | undefined;
              try {
                health = await runner.call(row, "health", {});
              } catch {
                /* Unknown boot remains protected by the single-runner lock. */
              }
              if (health?.generation === String(row.generation) && health.ready) {
                row.phase = "active";
                row.info.state = "ready";
                row.info.providerState = "active";
                await save(row);
                return sandboxInfo(row);
              }
            }
            return create(row, save, {});
          }
          if (row.phase !== "restoring") {
            if (!["deleted", "stopped"].includes(row.phase) && !(row.phase === "checkpoint" && row.quiesced))
              throw refusal("conflict", "Uncertain golden checkpoint retained; restore cannot discard that source.");
            const latestBase = row.snapshotImages?.at(-1)?.name ?? row.goldenRestore?.snapshotId;
            const restoreImage =
              row.phase === "stopped" && latestBase === snapshotId && row.recoveryImageId
                ? row.recoveryImageId
                : snapshot.imageId;
            row.goldenRestore = {
              snapshotId,
              sourceImageId: snapshot.imageId as string,
              imageId: restoreImage as string,
              generation: row.generation + 1,
            };
            row.phase = "restoring";
            row.info.state = "starting";
            await save(row);
          } else if (!same) throw refusal("conflict", "Another golden restore intent is already recorded.");
          if (row.physicalId) {
            try {
              const old = await physical(row);
              await old.terminate({ wait: true });
              if ((await old.poll()) === null)
                throw refusal("unavailable", "Previous golden machine termination is pending.");
            } catch (error) {
              if (modalError(error).code !== "not_found") throw error;
            }
          }
          const intent = row.goldenRestore;
          if (!intent) throw refusal("conflict", "Golden restore intent is missing.");
          row.generation = intent.generation;
          row.imageId = intent.imageId;
          row.eventBase = 0;
          row.quiesced = false;
          delete row.checkpointWatermark;
          delete row.physicalId;
          delete row.processBaseline;
          delete row.grantExpiresAt;
          row.physicalName = `armada-${createHash("sha256").update(row.info.id).digest("hex").slice(0, 32)}-${row.generation}`;
          row.phase = "reserved";
          await save(row);
          return create(row, save, {});
        });
      } catch (error) {
        if (observed) throw new ModalOperationError(error, await resourceReceipt(observed));
        throw error;
      }
    },
    async prepareNativeHarnessCwd({ sandboxId, harness, cwd }) {
      // Repository membership/existence is validated by trusted core against the golden. Here reject
      // malformed path data, not shell-escape it or install executable wrappers in a user runner.
      if (
        !["claude", "codex"].includes(harness) ||
        typeof cwd !== "string" ||
        !posix.isAbsolute(cwd) ||
        posix.normalize(cwd) !== cwd ||
        Array.from(cwd).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        Buffer.byteLength(cwd) > 4095
      )
        throw refusal("invalid_request", "Native harness cwd must be a canonical absolute POSIX path.");
      await admit(sandboxId, async (row, save) => {
        if (row.golden) throw refusal("invalid_request", "Native harness cwd preparation requires a working fork.");
        const active = await healthyAdmission(row, save);
        active.harnessCwds = { ...active.harnessCwds, [harness]: cwd };
        await save(active);
      });
    },
    async configureMcp({ sandboxId, configuration }) {
      if (
        !configuration ||
        typeof configuration.revision !== "string" ||
        !configuration.servers ||
        typeof configuration.servers !== "object" ||
        Array.isArray(configuration.servers)
      )
        throw refusal("invalid_request", "Invalid MCP configuration shape.");
      return admit(sandboxId, async (row, save) => {
        if (row.golden)
          throw refusal("invalid_request", "Golden builders cannot receive model connection configuration.");
        const active = await healthyAdmission(row, save);
        const result = await runner.call<{ revision?: unknown }>(active, "configureMcp", { configuration });
        if (!result || result.revision !== configuration.revision)
          throw refusal("unavailable", "Runner did not acknowledge the requested MCP revision.");
        // Do not persist or echo servers, auth or arbitrary fields returned by the runner.
        return { revision: configuration.revision };
      });
    },
    async prompt(r) {
      // Capture only trusted incarnation state, never labels/request data or volatile callback refs.
      const incarnation = (row: Machine) =>
        JSON.stringify([
          row.generation,
          row.physicalId ?? null,
          row.grantExpiresAt ?? null,
          row.processBaseline?.namespace.pid ?? null,
          row.processBaseline?.namespace.mount ?? null,
        ]);
      let expected: string | undefined;
      if (options.beforePrompt) {
        expected = await admit(r.sandboxId, async (row, save) => {
          if (row.golden) throw refusal("invalid_request", "Golden builders cannot run model turns.");
          return incarnation(await healthyAdmission(row, save));
        });
        // configureMcp takes its own lease. Invoking this under admission would deadlock.
        await options.beforePrompt(provider, r.sandboxId);
      }
      return admit(r.sandboxId, async (row, save) => {
        if (row.golden) throw refusal("invalid_request", "Golden builders cannot run model turns.");
        if (expected !== undefined && (row.phase !== "active" || incarnation(row) !== expected))
          throw refusal(
            "conflict",
            "Prompt preparation belongs to a different physical incarnation; turn not submitted.",
          );
        const active = await healthyAdmission(row, save);
        if (expected !== undefined && (active.phase !== "active" || incarnation(active) !== expected))
          throw refusal("conflict", "Runner incarnation changed during admission; turn not submitted.");
        const choice = resolveModelChoice(r.harness, r, active.modelDefaults?.[r.harness]);
        const cwd = active.harnessCwds?.[r.harness];
        return runner.call(active, "prompt", {
          input: {
            sandboxId: r.sandboxId,
            harness: r.harness,
            text: r.text,
            ...choice,
            ...(r.conversationId !== undefined ? { conversationId: r.conversationId } : {}),
            ...(r.fast !== undefined ? { fast: r.fast } : {}),
            ...(cwd !== undefined ? { cwd } : {}),
          },
        });
      });
    },
    async getPrompt(r) {
      const row = await store.get(r.sandboxId);
      assertMachineSource(row);
      // Observation must never use ready(): a stop racing this read must not activate a new generation.
      if (row.phase === "active") return runner.call(row, "getPrompt", r);
      let cursor: string | undefined;
      let latest: import("@armada/core").AgentEvent | undefined;
      for (;;) {
        const page = await store.events({ sandboxId: r.sandboxId, limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const event of page.events) if (event.kind === "prompt" && event.promptId === r.promptId) latest = event;
        if (!page.hasMore) break;
        if (!page.cursor || page.cursor === cursor)
          throw refusal("unavailable", "Prompt event cursor did not advance.");
        cursor = page.cursor;
      }
      if (latest?.kind !== "prompt") throw refusal("not_found", "No durable prompt observation found.");
      return {
        promptId: r.promptId,
        ...(latest.conversationId ? { conversationId: latest.conversationId } : {}),
        status: latest.status,
        done: !["queued", "running"].includes(latest.status),
      };
    },
    steer(r) {
      if (!r.conversationId) throw refusal("invalid_request", "Modal steering requires conversationId.");
      return admit(r.sandboxId, async (row, save) => {
        if (row.golden) throw refusal("invalid_request", "Golden builders cannot run model turns.");
        return runner.call(await healthyAdmission(row, save), "steer", {
          sandboxId: r.sandboxId,
          conversationId: r.conversationId,
          text: r.text,
        });
      });
    },
    interrupt: (r) => call(r.sandboxId, "interrupt", r),
    async exec(r) {
      const target = await store.get(r.sandboxId);
      if (!target.golden) return call(r.sandboxId, "exec", { input: r });
      return admit(r.sandboxId, async (row, save) => {
        if (!row.golden) throw refusal("conflict", "Sandbox role changed during golden exec admission.");
        const active = await healthyAdmission(row, save);
        return executeGoldenCommand(await physical(active), r);
      });
    },
    async events(r) {
      r.signal?.throwIfAborted();
      await bound();
      r.signal?.throwIfAborted();
      await store.get(r.sandboxId);
      r.signal?.throwIfAborted();
      const page = await store.events(r);
      r.signal?.throwIfAborted();
      return page;
    },
    async snapshot(r) {
      await bound();
      let observed: Machine | undefined;
      try {
        return await store.lease(r.sandboxId, async (row, save) => {
          observed = row;
          assertMachineSource(row);
          if (!row.golden || row.phase !== "active")
            throw refusal("conflict", "Only active credential-free builders can become golden snapshots.");
          try {
            await store.image(r.name);
            throw refusal("conflict", "Snapshot name is immutable.");
          } catch (e) {
            if (!(e instanceof Error && "code" in e && e.code === "not_found")) throw e;
          }
          const info: SnapshotInfo = {
            name: r.name,
            status: "saving",
            sourceSandboxId: r.sandboxId,
            createdAt: new Date(),
          };
          await store.saveImage({ info, sourceId: r.sandboxId, managementAuthority: { ...managementAuthority } });
          const sb = await physical(row);
          row.phase = "checkpoint";
          row.info.state = "stopping";
          await save(row);
          await checkpoint(row, save);
          await distribution.prepareSnapshot(sb, row);
          row.quiesced = true;
          row.phase = "snapshot";
          await save(row);
          const image = await sb.snapshotFilesystem({ ttlMs: null });
          row.snapshotImages = [...(row.snapshotImages ?? []), { name: r.name, imageId: image.imageId }];
          await save(row);
          info.status = "ready";
          await store.saveImage({
            info,
            sourceId: r.sandboxId,
            imageId: image.imageId,
            goldenClean: true,
            managementAuthority: { ...managementAuthority },
          });
          row.phase = "checkpoint";
          row.info.state = "stopping";
          await save(row);
          return info;
        });
      } catch (error) {
        if (observed) throw new ModalOperationError(error, await resourceReceipt(observed));
        throw error;
      }
    },
    async getSnapshot(name) {
      await bound();
      const image = await source.store.image(name);
      assertAuthority(image);
      return image.info;
    },
    async deleteSnapshot(name) {
      if (scopeKey(source.scope) !== scopeKey(options.scope))
        throw refusal(
          "forbidden",
          "Snapshot mutation requires the golden-source provider scope, not a private-fork adapter.",
        );
      await bound();
      let image: SavedImage;
      try {
        image = await store.image(name);
        assertAuthority(image);
      } catch (error) {
        if (modalError(error).code !== "not_found") throw error;
        await collectImages();
        return;
      }
      await store.lease(image.sourceId, async () => {
        const current = await store.image(name);
        await store.removeImage(current.info.name);
      });
      await collectImages();
    },
    async stop({ sandboxId }) {
      await bound();
      let observed: Machine | undefined;
      try {
        await store.lease(sandboxId, async (row, save) => {
          observed = row;
          if (row.phase === "stopped") return;
          const sb = await physical(row);
          if (row.phase !== "terminate") {
            if (!["active", "checkpoint"].includes(row.phase))
              throw refusal("conflict", "Snapshot outcome unknown; source retained for reconciliation.");
            row.phase = "checkpoint";
            row.info.state = "stopping";
            await save(row);
            if (!row.quiesced) {
              await checkpoint(row, save);
              await distribution.prepareSnapshot(sb, row);
              row.quiesced = true;
            }
            row.phase = "snapshot";
            await save(row);
            const image = await sb.snapshotFilesystem({ ttlMs: null });
            if (row.recoveryImageId)
              row.retainedRecoveryIds = [...(row.retainedRecoveryIds ?? []), row.recoveryImageId];
            row.recoveryImageId = image.imageId;
            row.phase = "terminate";
            await save(row);
          }
          await sb.terminate({ wait: true });
          if ((await sb.poll()) === null) throw refusal("unavailable", "Termination has not completed.");
          row.phase = "stopped";
          row.info.state = "stopped";
          row.info.providerState = "stopped";
          row.info.stoppedAt = new Date();
          await save(row);
        });
      } catch (error) {
        if (observed) throw new ModalOperationError(error, await resourceReceipt(observed));
        throw error;
      }
    },
    async delete({ sandboxId }) {
      await bound();
      await store.lease(sandboxId, async (row, save) => {
        if (row.phase === "deleted") return;
        assertMachineSource(row);
        // Reserved is provably pre-create: SQL commits creating before issuing any remote request.
        // Creating/booting/deleting without ID is NOT proof of absence, even if name lookup says 404.
        if (!row.physicalId && row.phase !== "reserved") {
          const reconciled = await namedOwned(row);
          row.physicalId = reconciled.sandboxId;
          await save(row);
        }
        row.phase = "deleting";
        await save(row);
        if (row.physicalId) {
          try {
            const sb = await physical(row);
            await sb.terminate({ wait: true });
            if ((await sb.poll()) === null)
              throw refusal("unavailable", "Owned machine termination is not complete; delete remains pending.");
          } catch (error) {
            if (modalError(error).code !== "not_found") throw error;
          }
        }
        for (const imageId of new Set([
          ...(row.retainedRecoveryIds ?? []),
          ...(row.recoveryImageId ? [row.recoveryImageId] : []),
        ])) {
          try {
            await client.images.delete(imageId);
          } catch (error) {
            if (modalError(error).code !== "not_found") throw error;
          }
        }
        row.phase = "deleted";
        await save(row);
      });
      await collectImages();
      return { status: "deleted" };
    },
    async resourceReceipts() {
      const rows = (await store.list()).filter(
        (row) =>
          matchesManagementAuthority(row.managementAuthority, managementAuthority) &&
          (row.sourceImage?.scopeKey ?? scopeKey(options.scope)) === scopeKey(source.scope),
      );
      return Promise.all(rows.map(resourceReceipt));
    },
    async collectGarbage() {
      await bound();
      await collectImages();
    },
    async sshKey({ sandboxId, key }) {
      const row = await ready(sandboxId);
      return store.lease(sandboxId, async (current) => {
        if (current.phase !== "active" || current.generation !== row.generation)
          throw refusal("sandbox_not_ready", "SSH lifecycle changed.");
        const result = await ssh.prepare(await physical(row), row, key);
        if (result.username !== (current.golden ? "root" : "user"))
          throw refusal("conflict", "SSH identity does not match trusted sandbox role.");
        return {
          sshEndpoint: result.endpoint,
          hostKey: result.hostPublicKey,
          ...(result.username ? { username: result.username } : {}),
        };
      });
    },
    async prepareSsh(id, publicKey) {
      const connection = await provider.sshKey({ sandboxId: id, key: publicKey });
      return {
        endpoint: connection.sshEndpoint,
        hostPublicKey: connection.hostKey,
        ...(connection.username ? { username: connection.username } : {}),
      };
    },
  };
  // Normalize all public failures, without leaking SDK request/token diagnostics.
  return Object.fromEntries(
    Object.entries(provider).map(([key, value]) => [
      key,
      typeof value === "function"
        ? async (...args: unknown[]) => {
            try {
              return await value(...args);
            } catch (e) {
              throw modalError(e);
            }
          }
        : value,
    ]),
  ) as unknown as ModalProvider;
}
