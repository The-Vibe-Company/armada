import { type ArmadaConfig, type ClaimRef, herdrClaimHandle, RuntimeError } from "@armada/core";
import { Herdr, type HerdrClaimHandle, HerdrError, parseHerdrHandle } from "../herdr.ts";
import type { Io } from "../io.ts";
import { detectLocalTools } from "../local-tools.ts";
import {
  type Archived,
  type ArchiveOptions,
  checkedMutation,
  type Delivery,
  type Launched,
  type LaunchSpec,
  type OutgoingMessage,
  type Peek,
  type PreflightInput,
  type RuntimeAdapter,
  recheckMutation,
  redactRuntimeText,
} from "./adapter.ts";

export class HerdrAdapter implements RuntimeAdapter {
  readonly name = "herdr";
  readonly guide = "armada-runtime-herdr";
  readonly can = {
    launch: true,
    resumeInPlace: true,
    deliver: true,
    observe: true,
    peek: true,
    cancel: true,
    archive: true,
  };
  private readonly runtime: Herdr;
  constructor(
    private readonly io: Io,
    _config?: ArmadaConfig,
    private readonly secretValues: readonly string[] = [],
  ) {
    this.runtime = new Herdr(io, recheckMutation);
  }
  parse(handle: string): HerdrClaimHandle {
    try {
      return parseHerdrHandle(handle);
    } catch {
      throw new RuntimeError("invalid herdr handle", "invalid", "armada status");
    }
  }
  async preflight(input: PreflightInput) {
    if (!input.profile.herdr)
      return [{ level: "error" as const, message: "herdr needs a full local profile", fix: "armada doctor" }];
    return (
      await detectLocalTools(
        this.io,
        [input.profile.herdr.harness],
        [{ name: input.profile.name, harness: input.profile.herdr.harness, model: input.profile.herdr.model }],
      )
    ).checks.map(({ level, message, fix }) => ({ level, message, fix }));
  }
  async launch(spec: LaunchSpec): Promise<Launched> {
    return this.launchPrepared(spec, async () => spec.prompt);
  }
  async resumeState(target: ClaimRef) {
    await this.verify(target);
    const tree = await this.runtime.worktree(this.parse(target.handle));
    const git = await this.io.exec?.("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: tree.path,
      timeoutMs: 5000,
    });
    if (git?.code !== 0)
      throw new RuntimeError("could not read the old worktree", "unavailable", "herdr worktree list");
    return { ready: true, clean: !git.stdout.trim(), path: tree.path };
  }
  /** Preserve the old branch, commits and dirty files while freeing the ticket branch for a fresh checkout. */
  async retainBranch(target: ClaimRef, branch: string): Promise<ClaimRef> {
    const tree = await this.runtime.worktree(this.parse(target.handle));
    await checkedMutation(
      target,
      () => this.verify(target),
      async () => {
        const result = await this.io.exec?.("git", ["branch", "-m", branch], { cwd: tree.path, timeoutMs: 5000 });
        if (result?.code !== 0)
          throw new RuntimeError("could not retain the old worktree branch", "unavailable", "herdr worktree list");
      },
    );
    return { ...target, branch };
  }
  /** Legacy herdr briefs need the created handle before startup; no token touches disk. */
  async launchPrepared(spec: LaunchSpec, prepare: (worker: Launched) => Promise<string>): Promise<Launched> {
    if (!spec.profile.herdr) throw new RuntimeError("herdr needs a full local profile", "invalid", "armada doctor");
    const profile = spec.profile.herdr;
    const from = spec.from;
    if (from.kind === "in-place") {
      if (!from.previous.releasedAt)
        throw new RuntimeError("release the previous worker before relaunching", "busy", "armada release");
      await checkedMutation(
        from.previous,
        () => this.verify(from.previous),
        () => this.runtime.ensureServer(),
      );
    } else await this.runtime.ensureServer();
    const h =
      from.kind === "in-place"
        ? await checkedMutation(
            from.previous,
            () => this.verify(from.previous),
            () =>
              this.runtime.resume(this.parse(from.previous.handle), {
                ticket: spec.ticket,
                secrets: spec.blankSecrets,
              }),
          )
        : await this.runtime.create({
            repo: this.io.cwd,
            branch: spec.branch,
            base: from.kind === "branch" ? from.head : spec.base,
            ticket: spec.ticket,
            secrets: spec.blankSecrets,
            ...spec.herdrTarget,
          });
    const prompt = await prepare({ handle: herdrClaimHandle(h), path: h.path, link: null, state: "idle" });
    if (from.kind === "in-place") {
      await checkedMutation(
        from.previous,
        () => this.verify(from.previous),
        () => this.runtime.startChecked(h, profile),
      );
      await checkedMutation(
        from.previous,
        () => this.verify(from.previous),
        () => this.runtime.promptChecked(h, profile, prompt),
      );
    } else {
      await this.runtime.startChecked(h, profile);
      await this.runtime.promptChecked(h, profile, prompt);
    }
    return { handle: herdrClaimHandle(h), link: null, path: h.path, state: "working" };
  }
  async verify(target: ClaimRef): Promise<void> {
    const tree = await this.runtime.worktree(this.parse(target.handle));
    const git = async (cwd: string, args: string[]) => {
      const r = await this.io.exec?.("git", args, { cwd, timeoutMs: 5000 });
      if (r?.code !== 0)
        throw new RuntimeError("could not verify the herdr claim repository", "mismatch", "armada status");
      return r.stdout.trim();
    };
    const common = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
    const local = await git(this.io.cwd, common);
    if (
      !local ||
      local !== (await git(tree.path, common)) ||
      (target.claimedAt !== null && !target.branch) ||
      (target.branch && (await git(tree.path, ["branch", "--show-current"])) !== target.branch)
    )
      throw new RuntimeError(
        "herdr workspace does not match the claimed repository and branch",
        "mismatch",
        "armada status",
      );
  }
  async deliver(target: ClaimRef, message: OutgoingMessage): Promise<Delivery> {
    if (target.releasedAt)
      throw new RuntimeError("herdr worker has ended; no answer was delivered", "gone", "armada inbox");
    await checkedMutation(
      target,
      () => this.verify(target),
      () => this.runtime.message(this.parse(target.handle), message.text),
    );
    return { via: "herdr", messageId: null, queued: false };
  }
  async observe(target: ClaimRef) {
    await this.verify(target);
    const r = await this.runtime.reading(this.parse(target.handle));
    return { ...r, since: null, detail: r.state };
  }
  async peek(target: ClaimRef, options: { actions: number; cursor: string | null }): Promise<Peek> {
    const reading = await this.observe(target);
    const r = await this.io.exec?.(
      "herdr",
      ["pane", "read", this.parse(target.handle).pane, "--source", "recent-unwrapped", "--lines", "40"],
      { cwd: this.io.cwd, timeoutMs: 5000, maxOutputBytes: 100_000 },
    );
    if (r?.code !== 0)
      throw new RuntimeError("could not inspect the herdr pane", "unavailable", "use the armada-runtime-herdr guide");
    return {
      ...reading,
      link: null,
      lastReply: { at: null, text: redactRuntimeText(r.stdout, this.secretValues) },
      actions: [],
      cursor: options.cursor,
      truncated: false,
    };
  }
  async cancel(target: ClaimRef, options: { waitMs: number }) {
    if (!Number.isFinite(options.waitMs) || options.waitMs < 0 || options.waitMs > 600_000)
      throw new RuntimeError("invalid herdr cancellation timeout", "invalid", "armada status");
    const state = await this.runtime.state(this.parse(target.handle));
    await checkedMutation(
      target,
      () => this.verify(target),
      () => this.runtime.quiesce(this.parse(target.handle), options.waitMs),
    );
    return {
      wasWorking: state !== "idle" && state !== "done",
      state: await this.runtime.state(this.parse(target.handle)),
    };
  }
  /** Herdr's historical stop also permits active claims once Git safety checks pass. */
  async archive(target: ClaimRef, options: ArchiveOptions): Promise<Archived> {
    if (!Number.isFinite(options.waitMs) || options.waitMs < 0 || options.waitMs > 600_000)
      throw new RuntimeError("invalid herdr archive timeout", "invalid", "armada status");
    const handle = this.parse(target.handle);
    const runtime = this.runtime;
    if (options.reason === "relaunched") {
      if (!target.releasedAt)
        throw new RuntimeError("release the old worker before archiving its pane", "busy", "armada release");
      await checkedMutation(
        target,
        () => this.verify(target),
        () => runtime.quiesce(handle),
      );
      await checkedMutation(
        target,
        () => this.verify(target),
        () => runtime.closeIdlePane(handle),
      );
      return { archived: true, alreadyGone: false, path: null };
    }
    let tree: { repo: string; path: string };
    try {
      tree = await runtime.worktree(handle);
    } catch (error) {
      if (!(error instanceof HerdrError) || error.code !== "workspace_not_found") throw error;
      return { archived: false, alreadyGone: true, path: null };
    }
    if (options.whenWorking === "refuse" && (await runtime.state(handle)) === "working")
      throw new RuntimeError("herdr worker is still working", "busy", "armada status");
    const git = async (cwd: string, argv: string[]) => {
      const r = await this.io.exec?.("git", argv, { cwd, timeoutMs: 30_000 });
      if (r?.code !== 0)
        throw new RuntimeError(
          "could not verify the worker's Git state; left its worktree untouched",
          "mismatch",
          `git -C ${tree.path} status`,
        );
      return r.stdout.trim();
    };
    // Bind the workspace's provenance to this repository and this claim's branch.
    const localCommon = await git(this.io.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const treeCommon = await git(tree.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const branch = await git(tree.path, ["branch", "--show-current"]);
    if (localCommon !== treeCommon || !target.branch || branch !== target.branch)
      throw new RuntimeError(
        "herdr worktree does not match this repository and claim branch; left it untouched",
        "mismatch",
        "herdr worktree list",
      );
    const dirty = await git(tree.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (dirty)
      throw new RuntimeError(
        `cannot stop ${target.ticket}: uncommitted work remains`,
        "dirty",
        `git -C ${tree.path} status`,
      );
    // Refresh exactly the configured upstream. A cached tracking ref alone does
    // not prove that work is still on the remote. No broad fetch or shell input.
    const upstream = await git(tree.path, [
      "for-each-ref",
      "--format=%(upstream:remotename)%00%(upstream:remoteref)",
      `refs/heads/${branch}`,
    ]);
    const [remote, ref] = upstream.split("\0");
    if (!remote || remote === "." || remote.startsWith("-") || !ref?.startsWith("refs/heads/"))
      throw new RuntimeError(
        `cannot stop ${target.ticket}: the branch has no verified remote upstream`,
        "dirty",
        `git -C ${tree.path} push -u origin ${branch}`,
      );
    const advertised = await git(tree.path, ["ls-remote", "--exit-code", "--heads", "--", remote, ref]);
    const [remoteHead, remoteRef] = advertised.split("\t");
    if (!/^[a-f0-9]{40,64}$/.test(remoteHead ?? "") || remoteRef !== ref)
      throw new RuntimeError(
        `cannot stop ${target.ticket}: could not verify the upstream head`,
        "dirty",
        `git -C ${tree.path} fetch`,
      );
    // FETCH_HEAD is shared by every checkout. Pin the advertised commit instead
    // so another worker's fetch cannot change which history we compare against.
    await git(tree.path, ["fetch", "--no-tags", "--no-write-fetch-head", "--", remote, ref]);
    const localHead = await git(tree.path, ["rev-parse", "HEAD"]);
    const left = await git(tree.path, ["log", "--format=%h %s", `${remoteHead}..${localHead}`]);
    if (left)
      throw new RuntimeError(
        `cannot stop ${target.ticket}: unpushed commits remain`,
        "dirty",
        `git -C ${tree.path} push`,
      );
    if (options.whenWorking === "wait") {
      const now = this.io.now ?? (() => new Date());
      const deadline = now().getTime() + options.waitMs;
      for (let n = 0; n < Math.ceil(options.waitMs / 15_000) && now().getTime() < deadline; n++) {
        const state = await runtime.state(handle);
        if (state === "idle" || state === "done") break;
        await (this.io.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms))))(
          Math.min(15_000, deadline - now().getTime()),
        );
      }
    }
    // Cancel a running turn and wait for a confirmed idle state before the final
    // Git checks. On timeout retain the checkout; never delete beneath a writer.
    await checkedMutation(
      target,
      () => this.verify(target),
      () => runtime.quiesce(handle),
    );
    // Recheck immediately before deletion; Git also refuses dirty removal. Herdr
    // removes the checkout and ends its terminals in one operation, never force.
    if (await git(tree.path, ["status", "--porcelain=v1", "--untracked-files=all"]))
      throw new RuntimeError(
        `cannot stop ${target.ticket}: the worktree changed during verification`,
        "dirty",
        `git -C ${tree.path} status`,
      );
    const state = await runtime.state(handle);
    if (state !== "idle" && state !== "done")
      throw new RuntimeError("worker resumed during stop; left its worktree untouched", "busy", "armada status");
    if ((await git(tree.path, ["rev-parse", "HEAD"])) !== localHead)
      throw new RuntimeError(
        `cannot stop ${target.ticket}: new commits appeared during verification`,
        "dirty",
        `git -C ${tree.path} status`,
      );
    await checkedMutation(
      target,
      async () => {
        await this.verify(target);
        if ((await runtime.state(handle)) !== "idle" && (await runtime.state(handle)) !== "done")
          throw new RuntimeError("worker resumed during stop; left its worktree untouched", "busy", "armada status");
        if (
          (await git(tree.path, ["rev-parse", "HEAD"])) !== localHead ||
          (await git(tree.path, ["status", "--porcelain=v1", "--untracked-files=all"]))
        )
          throw new RuntimeError("worktree changed during verification; left it untouched", "dirty", "armada status");
      },
      () => runtime.remove(handle, tree.path),
    );
    return { archived: true, alreadyGone: false, path: tree.path };
  }
}
