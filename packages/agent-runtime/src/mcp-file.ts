import { closeSync, constants, fstatSync, mkdtempSync, openSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { McpConfiguration } from "./protocol.ts";
/** Linux-only, descriptor-anchored config file. Neither secret JSON nor an untrusted symlink enters argv. */
export class PrivateMcpFile {
  private base: number | undefined;
  private directory: number | undefined;
  private location: string | undefined;
  readonly path: string;
  constructor(env: Record<string, string>, servers: McpConfiguration["servers"]) {
    try {
      const parent = env.CLAUDE_CONFIG_DIR ?? env.HOME ?? tmpdir();
      this.base = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const parentInfo = fstatSync(this.base),
        uid = process.getuid?.();
      const ownedPrivate = parentInfo.uid === uid && (parentInfo.mode & 0o022) === 0;
      const trustedSticky =
        !(env.CLAUDE_CONFIG_DIR ?? env.HOME) && parentInfo.uid === 0 && (parentInfo.mode & 0o1000) !== 0;
      if (!ownedPrivate && !trustedSticky) throw Error("unsafe_mcp_config_home");
      this.location = mkdtempSync(`/proc/self/fd/${this.base}/.armada-mcp-`);
      this.directory = openSync(this.location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const file = openSync(
        `/proc/self/fd/${this.directory}/mcp.json`,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(file, JSON.stringify({ mcpServers: servers }));
      } finally {
        closeSync(file);
      }
      this.path = `/proc/${process.pid}/fd/${this.directory}/mcp.json`;
    } catch {
      try {
        this.close();
      } catch {}
      throw Error("mcp_config_setup_failed");
    }
  }
  close() {
    let failed = false;
    if (this.directory !== undefined) {
      try {
        unlinkSync(`/proc/self/fd/${this.directory}/mcp.json`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true;
      }
      try {
        closeSync(this.directory);
      } catch {
        failed = true;
      }
      this.directory = undefined;
    }
    if (this.location) {
      try {
        rmdirSync(this.location);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true;
      }
      this.location = undefined;
    }
    if (this.base !== undefined) {
      try {
        closeSync(this.base);
      } catch {
        failed = true;
      }
      this.base = undefined;
    }
    if (failed) throw Error("mcp_config_cleanup_failed");
  }
}
