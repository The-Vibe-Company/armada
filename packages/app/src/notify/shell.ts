// The desktop shell's bridge (packages/desktop/src/preload.ts, THE-2055): a
// notification's click brings the window forward, and the dock shows the
// count of notifications not yet read. In a browser, the window's own focus
// and the Badging API where there is one.

export interface ArmadaShell {
  /** Shows, restores and focuses the app's window. */
  reveal(): void;
  /** The dock's badge count; 0 clears it. */
  setBadge(count: number): void;
}

declare global {
  interface Window {
    armadaShell?: ArmadaShell;
  }
}

export function reveal(): void {
  window.focus();
  window.armadaShell?.reveal();
}

export function setBadge(count: number): void {
  if (window.armadaShell) {
    window.armadaShell.setBadge(count);
    return;
  }
  const nav = navigator as Navigator & { setAppBadge?(n: number): Promise<void>; clearAppBadge?(): Promise<void> };
  void (count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.())?.catch(() => {});
}
