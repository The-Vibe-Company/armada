export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escapeHtml(title)}</title><h1>${escapeHtml(title)}</h1>${body}`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy":
        "default-src 'none'; form-action 'self'; navigate-to https: http://localhost http://127.0.0.1 cursor:",
    },
  });
}

export function loginPage(csrf: string): Response {
  const token = escapeHtml(csrf);
  return page(
    "Sign in to Armada",
    `<p><a href="/oauth/start?provider=github&amp;csrf=${token}">Continue with GitHub</a></p><p><a href="/oauth/start?provider=google&amp;csrf=${token}">Continue with Google</a></p>`,
  );
}

export function orgPage(
  orgs: readonly { orgId: string; name: string; role: string }[],
  csrf: string,
  clientName: string,
  redirectUri: string,
): Response {
  const redirect = new URL(redirectUri);
  const destination = redirect.host ? `${redirect.protocol}//${redirect.host}` : redirect.protocol;
  const choices = orgs
    .map(
      (org, index) =>
        `<p><label><input type="radio" name="org" value="${escapeHtml(org.orgId)}"${index === 0 ? " checked" : ""}>${escapeHtml(org.name)} (${escapeHtml(org.role)})</label></p>`,
    )
    .join("");
  return page(
    "Authorize MCP client",
    `<p><strong>${escapeHtml(clientName)}</strong> requests access to Armada.</p><p>This name is supplied by the client and does not verify its identity. Callback destination: ${escapeHtml(destination)}</p><p>Allow this client to act as you in the selected organization through Armada MCP, including viewing organization resources available to you, launching and controlling agents, and running sandbox commands. Your current organization role and private-resource access rules still apply.</p><form method="post" action="/oauth/org"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">${choices}<button type="submit" name="decision" value="allow">Allow</button><button type="submit" name="decision" value="cancel">Cancel</button></form>`,
  );
}
