import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { checkpointIdentity, checkpointIdentityKey, sameCheckpointIdentity } from "./identity.ts";
import type { CheckpointIdentity } from "./protocol.ts";
/** One sanitizer for returned output, WAL rows and the only allowlisted native session files. */
export interface Redactor {
  (text: string): string;
  register(values: readonly string[]): void;
}
export function createRedactor(values: readonly string[]): Redactor {
  let secrets: string[] = [];
  const register = (values: readonly string[]) => {
    const next = [
      ...new Set([
        ...secrets,
        ...values.filter(Boolean).flatMap((v) => [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)]),
      ]),
    ].sort((a, b) => b.length - a.length);
    if (next.reduce((size, v) => size + Buffer.byteLength(v), 0) > 4 * 1024 * 1024)
      throw Error("mcp_secret_budget_exceeded");
    secrets = next;
  };
  register(values);
  const scrub = (text: string, identifier = false) =>
    secrets
      .reduce((out, v) => {
        if (v.length >= 8) return out.split(v).join("[REDACTED]");
        if (identifier) return out;
        const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return out.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "g"), "[REDACTED]");
      }, text)
      .replace(/(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]");
  const visit = (value: unknown): unknown =>
    typeof value === "string"
      ? scrub(value)
      : Array.isArray(value)
        ? value.map(visit)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([key, v]) => [
                key,
                /^(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|mcp_servers|mcpServers|http_headers|headers|env|token|credentials?|client_secret|cookie|set-cookie|configuration|servers)$/i.test(
                  key,
                )
                  ? "[REDACTED]"
                  : typeof v === "string" &&
                      /^(?:id|uuid|session_id|thread_id|conversationId|promptId|sandboxId|model|cwd|parentUuid|leafUuid|sessionId|threadId)$/.test(
                        key,
                      )
                    ? scrub(v, true)
                    : visit(v),
              ]),
            )
          : value;
  const redact = (text: string): string => {
    try {
      return JSON.stringify(visit(JSON.parse(text)));
    } catch {
      return scrub(text);
    }
  };
  return Object.assign(redact, { register });
}
/** Persist only native transcripts, never entire harness homes, indexes, logs, auth or config. */
export class HarnessState {
  constructor(
    readonly root: string,
    private redact: (text: string) => string,
  ) {}
  private allowed(harness: string, path: string) {
    return harness === "codex"
      ? /^(?:sessions|archived_sessions)\/.*\.jsonl$/.test(path)
      : /^projects\/.*(?:\.jsonl|\/tool-results\/[^/]+\.txt)$/.test(path);
  }
  private async collect(harness: string, source: string, destination: string) {
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw Error("checkpoint_session_io_failed");
      })) {
        const path = join(dir, entry.name);
        const rel = relative(source, path);
        if (entry.isSymbolicLink()) throw Error("checkpoint_session_symlink");
        if (entry.isDirectory()) {
          // Do not descend into auth/cache/config directories at all.
          if (
            rel.split("/")[0] === (harness === "claude" ? "projects" : "sessions") ||
            (harness === "codex" && rel.split("/")[0] === "archived_sessions")
          )
            await walk(path);
        } else if (entry.isFile() && this.allowed(harness, rel)) {
          const text = await readFile(path, "utf8");
          const sanitized = rel.endsWith(".jsonl")
            ? text
                .split("\n")
                .map((line) => (line ? this.redact(line) : ""))
                .join("\n")
            : this.redact(text);
          const target = join(destination, rel);
          await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
          await this.durableWrite(target, sanitized);
        }
      }
    };
    const sourceInfo = await lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw Error("checkpoint_session_io_failed");
    });
    if (!sourceInfo) return;
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) throw Error("checkpoint_session_symlink");
    await walk(source);
  }
  /** Also used after an unclean restart; never read auth/cache files to discover tokens. */
  private async hasNativeData(names: readonly string[]): Promise<boolean> {
    const walk = async (path: string): Promise<boolean> => {
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw Error("checkpoint_session_io_failed");
      });
      if (!info) return false;
      if (info.isSymbolicLink() || !info.isDirectory()) return true;
      for (const entry of await readdir(path)) {
        if (await walk(join(path, entry))) return true;
      }
      return false;
    };
    for (const name of names) if (await walk(join(this.root, name))) return true;
    return false;
  }
  async restore(identity?: CheckpointIdentity, verifiedSource?: CheckpointIdentity) {
    const manifest = await this.verifySaved();
    if (identity) {
      const target = checkpointIdentity(identity),
        source = verifiedSource ? checkpointIdentity(verifiedSource) : undefined;
      if (!source) {
        if (
          manifest ||
          (await this.hasNativeData([
            "claude",
            "codex",
            "session-state",
            "exec-transient",
            "claude.restore",
            "codex.restore",
            "session-state.next",
            "session-state.previous",
          ]))
        )
          throw Error("checkpoint_identity_ambiguous");
      } else {
        if (manifest && !manifest.identity) throw Error("checkpoint_identity_ambiguous");
        if (
          manifest?.identity &&
          manifest.identity.sandboxId !== source.sandboxId &&
          Object.keys(manifest.files).length
        )
          throw Error("checkpoint_identity_ambiguous");
        if (source.sandboxId !== target.sandboxId) {
          if (manifest && Object.keys(manifest.files).length) throw Error("golden_native_history_not_empty");
          if (
            (await this.hasNativeData([
              "claude",
              "codex",
              "exec-transient",
              "claude.restore",
              "codex.restore",
              "session-state.next",
              "session-state.previous",
            ])) ||
            (!manifest && (await this.hasNativeData(["session-state"])))
          )
            throw Error("golden_transient_state_not_empty");
        }
      }
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (await this.exists(join(this.root, "session-state.previous"))) throw Error("checkpoint_state_ambiguous");
    for (const harness of ["claude", "codex"]) {
      const live = join(this.root, harness),
        saved = join(this.root, "session-state", harness),
        stage = join(this.root, `${harness}.restore`);
      if (await this.exists(stage)) throw Error("checkpoint_state_ambiguous");
      await mkdir(stage, { recursive: true, mode: 0o700 });
      await this.collect(harness, saved, stage);
      await this.collect(harness, live, stage);
      await rm(live, { recursive: true, force: true });
      await rename(stage, live);
    }
  }

  private async durableWrite(path: string, body: string) {
    const file = await open(path, "w", 0o600);
    try {
      await file.writeFile(body);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  private async syncDirectory(path: string) {
    const dir = await open(path, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  private async exists(path: string) {
    try {
      await readdir(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw Error("checkpoint_session_io_failed");
    }
  }
  private async fingerprints(root: string, durable = false): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name),
          rel = relative(root, path);
        if (entry.isSymbolicLink()) throw Error("checkpoint_session_symlink");
        if (rel === ".checkpoint.json") continue;
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) {
          const [harness, ...parts] = rel.split("/");
          if (!harness || !["claude", "codex"].includes(harness) || !this.allowed(harness, parts.join("/")))
            throw Error("checkpoint_saved_state_unexpected");
          files[rel] = createHash("sha256")
            .update(await readFile(path))
            .digest("hex");
        } else throw Error("checkpoint_saved_state_unexpected");
      }
      if (durable) await this.syncDirectory(dir);
    };
    await walk(root);
    return files;
  }
  private async verifySaved(): Promise<
    { version: 2; identity: CheckpointIdentity | null; files: Record<string, string> } | undefined
  > {
    const saved = join(this.root, "session-state");
    let raw: string;
    try {
      const savedInfo = await lstat(saved),
        sealInfo = await lstat(join(saved, ".checkpoint.json"));
      if (savedInfo.isSymbolicLink() || !savedInfo.isDirectory() || sealInfo.isSymbolicLink() || !sealInfo.isFile())
        throw Error("checkpoint_session_symlink");
      raw = await readFile(join(saved, ".checkpoint.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof Error && error.message === "checkpoint_session_symlink") throw error;
      throw Error("checkpoint_manifest_unreadable");
    }
    let manifest: { version: 2; identity: CheckpointIdentity | null; files: Record<string, string> };
    try {
      manifest = JSON.parse(raw);
    } catch {
      throw Error("checkpoint_manifest_invalid");
    }
    if (
      !manifest ||
      typeof manifest !== "object" ||
      manifest.version !== 2 ||
      !manifest.files ||
      typeof manifest.files !== "object" ||
      Array.isArray(manifest.files)
    )
      throw Error("checkpoint_manifest_invalid");
    if (manifest.identity !== null) {
      try {
        checkpointIdentity(manifest.identity);
        if (Object.keys(manifest.identity).sort().join(",") !== "generation,sandboxId") throw Error();
      } catch {
        throw Error("checkpoint_manifest_invalid");
      }
    }
    const actual = await this.fingerprints(saved);
    if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(manifest.files).sort()))
      throw Error("checkpoint_saved_state_changed");
    return manifest;
  }
  private checkpointWork: Promise<void> | undefined;
  private checkpointScope: string | undefined;
  checkpoint(identity?: CheckpointIdentity): Promise<void> {
    const bound = identity ? checkpointIdentity(identity) : undefined,
      scope = bound ? checkpointIdentityKey(bound) : "unscoped";
    if (this.checkpointWork && this.checkpointScope !== scope)
      return Promise.reject(Error("checkpoint_identity_conflict"));
    if (!this.checkpointWork) {
      this.checkpointScope = scope;
      this.checkpointWork = this.seal(bound).finally(() => {
        this.checkpointWork = undefined;
        this.checkpointScope = undefined;
      });
    }
    return this.checkpointWork;
  }
  private async seal(identity?: CheckpointIdentity) {
    const manifest = await this.verifySaved();
    const live = await Promise.all(["claude", "codex"].map((h) => this.exists(join(this.root, h))));
    if (!live.some(Boolean)) {
      if (manifest && (identity === undefined || sameCheckpointIdentity(manifest.identity, identity))) return;
      throw Error("checkpoint_state_ambiguous");
    }
    const stage = join(this.root, "session-state.next");
    // A previous interrupted rename must not be erased by a retry.
    if (await this.exists(join(this.root, "session-state.previous"))) throw Error("checkpoint_state_ambiguous");
    await rm(stage, { recursive: true, force: true });
    for (const [index, harness] of ["claude", "codex"].entries()) {
      if (!live[index] && (await this.exists(join(this.root, "session-state", harness)))) {
        if (
          Object.keys(await this.fingerprints(join(this.root, "session-state"))).some((p) =>
            p.startsWith(`${harness}/`),
          )
        )
          throw Error("checkpoint_state_ambiguous");
      }
      const destination = join(stage, harness);
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await this.collect(harness, join(this.root, harness), destination);
    }
    const files = await this.fingerprints(stage, true);
    const previousFiles =
      manifest?.files ??
      ((await this.exists(join(this.root, "session-state")))
        ? await this.fingerprints(join(this.root, "session-state"))
        : {});
    for (const harness of ["claude", "codex"])
      if (
        Object.keys(previousFiles).some((p) => p.startsWith(`${harness}/`)) &&
        !Object.keys(files).some((p) => p.startsWith(`${harness}/`))
      )
        throw Error("checkpoint_state_ambiguous");
    if (identity !== undefined && manifest && sameCheckpointIdentity(manifest.identity, identity)) {
      if (JSON.stringify(Object.entries(files).sort()) !== JSON.stringify(Object.entries(manifest.files).sort()))
        throw Error("checkpoint_state_ambiguous");
      await rm(stage, { recursive: true, force: true });
    } else {
      await this.durableWrite(
        join(stage, ".checkpoint.json"),
        JSON.stringify({ version: 2, identity: identity ?? null, files }),
      );
      await this.syncDirectory(stage);
      const saved = join(this.root, "session-state"),
        previous = join(this.root, "session-state.previous");
      await rename(saved, previous).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      await rename(stage, saved);
      await this.syncDirectory(this.root);
      await rm(previous, { recursive: true, force: true });
    }
    await Promise.all(["claude", "codex"].map((name) => rm(join(this.root, name), { recursive: true, force: true })));
    await this.syncDirectory(this.root);
  }
}
