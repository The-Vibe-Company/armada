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

export function orgPage(orgs: readonly { orgId: string; name: string; role: string }[], csrf: string): Response {
  const buttons = orgs
    .map(
      (org) =>
        `<p><button type="submit" name="org" value="${escapeHtml(org.orgId)}">${escapeHtml(org.name)} (${escapeHtml(org.role)})</button></p>`,
    )
    .join("");
  return page(
    "Choose an organization",
    `<form method="post" action="/oauth/org"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">${buttons}</form>`,
  );
}
