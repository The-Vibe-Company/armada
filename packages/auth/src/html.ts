import type { Provider } from "./supabase-auth.ts";

const DEFAULT_LOGIN_PROVIDERS: readonly Provider[] = ["github", "google"];

const PROVIDER_LABELS: Record<Provider, string> = {
  github: "GitHub",
  google: "Google",
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formActionSource(redirect: URL): string {
  if ((redirect.protocol === "https:" || redirect.protocol === "http:") && redirect.origin !== "null") {
    return redirect.origin;
  }
  return redirect.protocol;
}

export function resolveLoginProviders(providers?: readonly Provider[]): readonly Provider[] {
  if (providers === undefined) return DEFAULT_LOGIN_PROVIDERS;
  return Array.from(new Set(providers));
}

export function page(title: string, body: string, status = 200, formAction = "'self'"): Response {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escapeHtml(title)}</title><h1>${escapeHtml(title)}</h1>${body}`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": `default-src 'none'; form-action ${formAction}`,
    },
  });
}

export function loginPage(csrf: string, providers?: readonly Provider[]) {
  const token = escapeHtml(csrf);
  const enabled = resolveLoginProviders(providers);
  if (enabled.length === 0) {
    return page("Sign in to Armada", "<p>No sign-in providers are configured.</p>", 503);
  }
  const links = enabled
    .map(
      (provider) =>
        `<p><a href="/oauth/start?provider=${provider}&amp;csrf=${token}">Continue with ${PROVIDER_LABELS[provider]}</a></p>`,
    )
    .join("");
  return page("Sign in to Armada", links);
}

export function orgPage(
  orgs: readonly { orgId: string; name: string; role: string }[],
  csrf: string,
  clientName: string,
  redirectUri: string,
) {
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
    200,
    `'self' ${formActionSource(redirect)}`,
  );
}
