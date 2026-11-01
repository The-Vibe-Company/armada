/** Local page shown while armadad opens its log. No network, renderer script or Node access. */
export const STARTUP_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Armada</title><style>
:root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; background: #0f1012; color: #e6e7e9; min-height: 100vh; display: grid; place-items: center; }
main { padding: 32px; text-align: center; }
svg { width: 40px; height: 40px; margin-bottom: 20px; }
h1 { font-size: 22px; font-weight: 500; letter-spacing: -.5px; margin: 0 0 12px; }
p { color: #a3a6ad; font-size: 14px; margin: 0; min-height: 20px; }
</style></head><body><main role="status" aria-live="polite">
<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 4.5L20 11.5H12Z" fill="#b6f15a"/><path d="M10 13L14 20H6ZM22 13L26 20H18Z" fill="#f0efec"/><path d="M4 21.5L8 28.5H0ZM28 21.5L32 28.5H24Z" fill="#f0efec" opacity=".45"/></svg>
<h1>Starting the daemon…</h1><p id="progress">Opening your event log</p>
</main></body></html>`;

export const STARTUP_URL = `data:text/html;charset=utf-8,${encodeURIComponent(STARTUP_HTML)}`;
