import { readFileSync, writeFileSync } from "node:fs";

/**
 * The desktop app's updates (THE-2231): GitHub releases are the feed, electron-updater
 * downloads in the background, Squirrel.Mac installs. This module decides; `index.ts` wires
 * electron-updater, Electron's native updater and the dialogs to it.
 */

/** The public repository's releases; never a token (`private: false` keeps GH_TOKEN out of it). */
export const UPDATE_FEED = { provider: "github", owner: "The-Vibe-Company", repo: "armada", private: false } as const;
/** Set (to anything but `0`, `false` or nothing) to turn update checks off. */
export const NO_UPDATE_VARIABLE = "ARMADA_DESKTOP_NO_UPDATE";
export const FIRST_CHECK_MS = 10_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

type Env = Record<string, string | undefined>;

/** Updates run in an installed app only: never from source, headless, or with ARMADA_DESKTOP_NO_UPDATE. */
export function updatesEnabled(options: { packaged: boolean; headless: boolean; env: Env }): boolean {
  const off = (options.env[NO_UPDATE_VARIABLE] ?? "").trim().toLowerCase();
  return options.packaged && !options.headless && (off === "" || off === "0" || off === "false");
}

/**
 * Squirrel.Mac's refusal to install into an app without a valid signature (an unsigned or
 * ad-hoc signed build): it checks the running app's code signature before taking the update.
 * Only these messages count; any other failure is logged and shown to nobody.
 */
const SIGNATURE_REFUSALS = [
  /could not get code signature for running application/i,
  /code signature at url .* did not pass validation/i,
  /SQRLCodeSignatureErrorDomain/,
];

export function signatureRefused(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  return SIGNATURE_REFUSALS.some((pattern) => pattern.test(text));
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The release's page on GitHub (tag `vX.Y.Z`, release-please's); null for anything not a version. */
export function releasePage(version: string): string | null {
  return VERSION.test(version)
    ? `https://github.com/${UPDATE_FEED.owner}/${UPDATE_FEED.repo}/releases/tag/v${version}`
    : null;
}

export type UpdateState =
  | { kind: "idle" }
  /** electron-updater found or downloaded it; Squirrel.Mac has not taken it yet. */
  | { kind: "downloading"; version: string }
  /** Squirrel.Mac holds it: a restart installs it. */
  | { kind: "ready"; version: string }
  | { kind: "failed"; version?: string; error: unknown };

export type Decision = "silent" | "dialog-restart" | "dialog-open-release";

/**
 * What to show for an update state: the restart dialog once Squirrel holds a signed update, the
 * release page when an unsigned build was refused, nothing otherwise. At most one dialog per
 * version (`shown`), whether the check was automatic or from the menu.
 */
export function decide(input: {
  packaged: boolean;
  signed: boolean;
  state: UpdateState;
  shown: ReadonlySet<string>;
}): Decision {
  const { packaged, signed, state, shown } = input;
  if (!packaged || state.kind === "idle" || state.kind === "downloading") return "silent";
  if (state.version === undefined || shown.has(state.version)) return "silent";
  if (state.kind === "ready") return signed ? "dialog-restart" : "dialog-open-release";
  return signed ? "silent" : "dialog-open-release";
}

/** electron-updater, as far as the controller uses it. */
export interface Updater {
  checkForUpdates(): Promise<{ downloadPromise?: Promise<unknown> | null } | null>;
  quitAndInstall(): void;
}

/** What the controller needs from the shell: dialogs, the daemon's stop, memory and the log. */
export interface UpdateShell {
  /** "Armada X.Y.Z is ready." Restart now (true) or Later (false). */
  askRestart(version: string): Promise<boolean>;
  /** "Armada X.Y.Z is available." with an Open release page button. */
  offerRelease(version: string, url: string): Promise<void>;
  /** After a menu check that found nothing new, or failed for another reason. */
  tellManual(outcome: "up-to-date" | "failed"): Promise<void>;
  /** Stops the daemon as on quit; resolves once it has exited. */
  stopDaemon(): Promise<void>;
  /** The versions a dialog was already shown for, kept across launches. */
  shown: Set<string>;
  remember(shown: ReadonlySet<string>): void;
  log(message: string): void;
}

/** Drives one updater: checks, the state its events move, the one dialog per version and the restart. */
export class UpdateController {
  private state: UpdateState = { kind: "idle" };
  private checking?: Promise<void>;
  private restarting = false;
  /** A menu check asked during the running check. */
  private manual = false;
  private readonly updater: Updater;
  private readonly shell: UpdateShell;
  private readonly packaged: boolean;

  constructor(updater: Updater, shell: UpdateShell, packaged: boolean) {
    this.updater = updater;
    this.shell = shell;
    this.packaged = packaged;
  }

  /** The first check after `FIRST_CHECK_MS`, then every `CHECK_INTERVAL_MS`. */
  schedule(timers: { setTimeout: typeof setTimeout; setInterval: typeof setInterval } = globalThis): void {
    timers.setTimeout(() => {
      void this.check(false);
      timers.setInterval(() => void this.check(false), CHECK_INTERVAL_MS);
    }, FIRST_CHECK_MS);
  }

  /** One check at a time; a menu check while one runs joins it and still gets its answer. */
  check(manual: boolean): Promise<void> {
    if (manual) this.manual = true;
    this.checking ??= this.run().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async run(): Promise<void> {
    this.shell.log("checking for updates");
    let outcome: "up-to-date" | "failed" | undefined;
    try {
      const result = await this.updater.checkForUpdates();
      // Download failures reach `failed` through the updater's error event; never unhandled.
      void result?.downloadPromise?.catch(() => {});
      if (this.state.kind === "idle") outcome = "up-to-date";
    } catch (error) {
      this.shell.log(`update check failed: ${describe(error)}`);
      if (!signatureRefused(error)) outcome = "failed";
    }
    const manual = this.manual;
    this.manual = false;
    if (manual && outcome) await this.shell.tellManual(outcome);
  }

  /** electron-updater's update-available and update-downloaded. */
  found(version: string): Promise<void> {
    this.shell.log(`update ${version} found`);
    // The update Squirrel holds stays ready; a newer release starts its own download and dialog.
    if (this.state.kind !== "ready" || this.state.version !== version) this.state = { kind: "downloading", version };
    return this.settle();
  }

  /** electron-updater's update-not-available. */
  none(): void {
    if (this.state.kind !== "ready") this.state = { kind: "idle" };
  }

  /** Electron's native update-downloaded: Squirrel.Mac took the update. */
  ready(): Promise<void> {
    const version = this.state.kind === "idle" ? undefined : this.state.version;
    if (version === undefined) return Promise.resolve();
    this.shell.log(`update ${version} ready to install`);
    this.state = { kind: "ready", version };
    return this.settle();
  }

  /** electron-updater's error event. */
  failed(error: unknown): Promise<void> {
    this.shell.log(`update failed: ${describe(error)}`);
    const version = this.state.kind === "idle" ? undefined : this.state.version;
    this.state = { kind: "failed", version, error };
    return this.settle();
  }

  private async settle(): Promise<void> {
    const state = this.state;
    const signed = !(state.kind === "failed" && signatureRefused(state.error));
    const decision = decide({ packaged: this.packaged, signed, state, shown: this.shell.shown });
    if (decision === "silent" || state.kind === "idle" || state.version === undefined) return;
    const version = state.version;
    this.shell.shown.add(version);
    this.shell.remember(this.shell.shown);
    if (decision === "dialog-open-release") {
      const url = releasePage(version);
      if (url) await this.shell.offerRelease(version, url);
      return;
    }
    if (await this.shell.askRestart(version)) await this.restart();
    else this.shell.log(`update ${version} installs on quit`);
  }

  private async restart(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    this.shell.log("stopping the daemon to install the update");
    await this.shell.stopDaemon();
    this.updater.quitAndInstall();
  }
}

/** One line for the log: the message only, with any URL's query (a signed download link) cut. */
export function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return redact(text.split("\n")[0] ?? "");
}

export const redact = (text: string): string => text.replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/g, "$1");

/** The versions already shown, from `updates.json` under the user data; empty when missing or unreadable. */
export function readShown(path: string): Set<string> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return new Set(Array.isArray(value?.shown) ? value.shown.filter((v: unknown) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeShown(path: string, shown: ReadonlySet<string>): void {
  try {
    writeFileSync(path, `${JSON.stringify({ shown: [...shown].slice(-20) })}\n`);
  } catch {}
}
