// A page of another site, in the system browser (THE-2071): through the
// desktop shell's bridge (packages/desktop/src/preload.ts), which hands it to
// `shell.openExternal`; in a browser, a new tab without a handle back here.
// `window.armadaShell` is declared in src/notify/shell.ts.

export function openExternal(url: string): void {
  if (window.armadaShell?.openExternal) {
    window.armadaShell.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
