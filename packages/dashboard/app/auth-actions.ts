"use server";

// Signing in and out, and managing the organization, as server actions over
// Better Auth's API. Each form posts here and the action answers with a
// redirect: the page shows the outcome from its query (`?error=`, `?done=`),
// so every form works without client JavaScript. Better Auth checks roles and
// ownership itself (an admin cannot remove an owner, an invitation is only for
// its address); these actions add the session check and safe redirects.
import { APIError } from "better-auth/api";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isRole, recordApiKeyCreator } from "@/lib/accounts";
import { requireAccounts, requireMember, requireSession } from "@/lib/accounts-server";
import { DEVICE_PATH, INVITATION_PATH, KEYS_PATH, ORGANIZATION_PATH, WELCOME_PATH } from "@/lib/accounts-settings";
import { clientAddress, FailureLimiter, LOGIN_PATH, safeNext } from "@/lib/auth";
import type { AuthError, DeviceError, OrgError, OrgNotice } from "@/lib/i18n";

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};

/** Only the path of a `next` matters; the origin is a placeholder that never leaves the server. */
const nextOf = (form: FormData) => safeNext(text(form, "next"), new URL("http://dashboard.local"));

const codeOf = (err: unknown): { code: string; status: number } | null =>
  err instanceof APIError
    ? { code: String((err.body as { code?: unknown } | undefined)?.code ?? ""), status: err.statusCode }
    : null;

function authError(err: unknown): AuthError {
  const e = codeOf(err);
  if (!e) {
    console.error(`armada dashboard: sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
  if (e.status === 429) return "limited";
  if (e.code === "NOT_INVITED") return "not-invited";
  if (e.code === "EMAIL_NOT_VERIFIED") return "unverified";
  if (e.code === "INVALID_EMAIL_OR_PASSWORD" || e.code === "INVALID_EMAIL" || e.code === "INVALID_PASSWORD")
    return "invalid";
  if (e.code.startsWith("USER_ALREADY_EXISTS")) return "exists";
  if (e.code === "PASSWORD_TOO_SHORT" || e.code === "PASSWORD_TOO_LONG") return "weak";
  return "failed";
}

function orgError(err: unknown): OrgError {
  const e = codeOf(err);
  if (!e) {
    console.error(`armada dashboard: organization change failed: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
  if (e.code.includes("ALREADY_A_MEMBER") || e.code.includes("ALREADY_INVITED")) return "member";
  if (e.code.includes("NOT_FOUND")) return "gone";
  if (e.status === 403 || e.status === 401 || e.code.includes("NOT_ALLOWED")) return "forbidden";
  if (e.status === 400) return "invalid";
  return "failed";
}

function loginUrl(params: Record<string, string>): string {
  const q = new URLSearchParams(Object.entries(params).filter(([k, v]) => v && !(k === "next" && v === "/")));
  const s = q.toString();
  return s ? `${LOGIN_PATH}?${s}` : LOGIN_PATH;
}

// ------------------------------------------------------------ sign in

// Server actions call Better Auth's API directly, past its HTTP rate limit, so
// email and password attempts are counted here: per address, per server
// instance, as the shared-password gate does.
const holder = globalThis as unknown as { __armadaAccountLimiter?: FailureLimiter };
const limiter = () => {
  holder.__armadaAccountLimiter ??= new FailureLimiter(10);
  return holder.__armadaAccountLimiter;
};

export async function signInWithGitHub(form: FormData): Promise<void> {
  const { auth, settings } = await requireAccounts();
  const next = nextOf(form);
  if (!settings.github) redirect(loginUrl({ error: "github", next }));
  let url: string | undefined;
  try {
    const res = await auth.api.signInSocial({
      body: { provider: "github", callbackURL: next, errorCallbackURL: LOGIN_PATH },
      headers: await headers(),
    });
    url = res.url;
  } catch (err) {
    redirect(loginUrl({ error: authError(err), next }));
  }
  redirect(url ?? loginUrl({ error: "github", next }));
}

export async function signInWithEmail(form: FormData): Promise<void> {
  const { auth, settings } = await requireAccounts();
  const next = nextOf(form);
  if (!settings.emailPassword) redirect(loginUrl({ error: "failed", next }));
  const h = await headers();
  const address = clientAddress(h);
  if (limiter().blocked(address, Date.now())) redirect(loginUrl({ error: "limited", next }));
  try {
    await auth.api.signInEmail({
      body: { email: text(form, "email"), password: String(form.get("password") ?? ""), callbackURL: next },
      headers: h,
    });
  } catch (err) {
    const error = authError(err);
    if (error === "invalid") limiter().fail(address, Date.now());
    redirect(loginUrl({ error, next }));
  }
  limiter().reset(address);
  redirect(next);
}

export async function signUpWithEmail(form: FormData): Promise<void> {
  const { auth, settings } = await requireAccounts();
  const next = nextOf(form);
  if (!settings.emailPassword) redirect(loginUrl({ error: "failed", next }));
  const address = clientAddress(await headers());
  // Every sign-up counts: each one may send an email.
  if (limiter().fail(address, Date.now())) redirect(loginUrl({ error: "limited", next, mode: "signup" }));
  try {
    await auth.api.signUpEmail({
      body: {
        name: text(form, "name").slice(0, 80),
        email: text(form, "email"),
        password: String(form.get("password") ?? ""),
        callbackURL: next,
      },
      headers: await headers(),
    });
  } catch (err) {
    redirect(loginUrl({ error: authError(err), next, mode: "signup" }));
  }
  // No session yet: the address is confirmed first (the link signs the person in).
  redirect(loginUrl({ sent: "1", next }));
}

export async function signOut(): Promise<void> {
  const { auth } = await requireAccounts();
  try {
    await auth.api.signOut({ headers: await headers() });
  } catch {
    // Already signed out.
  }
  redirect(LOGIN_PATH);
}

// ------------------------------------------------------------ organizations

/** A slug no one picks by hand: the name, lower-cased, plus a random suffix. */
function slugOf(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "org"}-${crypto.randomUUID().slice(0, 6)}`;
}

export async function createOrganization(form: FormData): Promise<void> {
  await requireSession();
  const { auth } = await requireAccounts();
  const name = text(form, "name").replace(/\s+/g, " ").slice(0, 60);
  if (!name) redirect(`${WELCOME_PATH}?error=invalid`);
  try {
    await auth.api.createOrganization({ body: { name, slug: slugOf(name) }, headers: await headers() });
  } catch (err) {
    redirect(`${WELCOME_PATH}?error=${orgError(err)}`);
  }
  redirect("/");
}

function orgPage(result: { done: OrgNotice } | { error: OrgError }, path: string = ORGANIZATION_PATH): string {
  return "done" in result ? `${path}?done=${result.done}` : `${path}?error=${result.error}`;
}

/** Runs one change on the viewer's organization, then shows its page (the members', or `path`) with its outcome. */
async function change(
  done: OrgNotice,
  run: (organizationId: string, h: Headers) => Promise<unknown>,
  path: string = ORGANIZATION_PATH,
): Promise<void> {
  const viewer = await requireMember();
  let target: string;
  try {
    await run(viewer.organization.id, await headers());
    target = orgPage({ done }, path);
  } catch (err) {
    target = orgPage({ error: orgError(err) }, path);
  }
  redirect(target);
}

export async function inviteMember(form: FormData): Promise<void> {
  const { auth } = await requireAccounts();
  const email = text(form, "email").toLowerCase();
  const role = text(form, "role");
  if (!email.includes("@") || !isRole(role)) redirect(orgPage({ error: "invalid" }));
  await change("invited", (organizationId, h) =>
    auth.api.createInvitation({ body: { email, role, organizationId }, headers: h }),
  );
}

export async function cancelInvitation(form: FormData): Promise<void> {
  const { auth } = await requireAccounts();
  await change("cancelled", (_, h) =>
    auth.api.cancelInvitation({ body: { invitationId: text(form, "invitation") }, headers: h }),
  );
}

export async function updateMemberRole(form: FormData): Promise<void> {
  const { auth } = await requireAccounts();
  const role = text(form, "role");
  if (!isRole(role)) redirect(orgPage({ error: "invalid" }));
  await change("updated", (organizationId, h) =>
    auth.api.updateMemberRole({ body: { memberId: text(form, "member"), role, organizationId }, headers: h }),
  );
}

export async function removeMember(form: FormData): Promise<void> {
  const { auth } = await requireAccounts();
  await change("removed", (organizationId, h) =>
    auth.api.removeMember({ body: { memberIdOrEmail: text(form, "member"), organizationId }, headers: h }),
  );
}

export async function switchOrganization(form: FormData): Promise<void> {
  await requireSession();
  const { auth } = await requireAccounts();
  try {
    await auth.api.setActiveOrganization({
      body: { organizationId: text(form, "organization") },
      headers: await headers(),
    });
  } catch (err) {
    redirect(orgPage({ error: orgError(err) }));
  }
  redirect("/");
}

// ------------------------------------------------------------ invitations

export async function acceptInvitation(form: FormData): Promise<void> {
  await requireSession();
  const { auth } = await requireAccounts();
  const id = text(form, "invitation");
  try {
    const h = await headers();
    const accepted = await auth.api.acceptInvitation({ body: { invitationId: id }, headers: h });
    const organizationId = accepted?.member.organizationId;
    if (organizationId) await auth.api.setActiveOrganization({ body: { organizationId }, headers: h });
  } catch (err) {
    redirect(`${INVITATION_PATH}/${encodeURIComponent(id)}?error=${orgError(err)}`);
  }
  redirect("/");
}

export async function rejectInvitation(form: FormData): Promise<void> {
  await requireSession();
  const { auth } = await requireAccounts();
  const id = text(form, "invitation");
  try {
    await auth.api.rejectInvitation({ body: { invitationId: id }, headers: await headers() });
  } catch (err) {
    redirect(`${INVITATION_PATH}/${encodeURIComponent(id)}?error=${orgError(err)}`);
  }
  redirect(WELCOME_PATH);
}

// ------------------------------------------------------------ API keys

/** What the key form shows after a submit: the new key, once, or why there is none. */
export type ApiKeyState = { key: string; name: string } | { error: OrgError } | null;

/**
 * Creates an API key for the viewer's organization and returns it to the form,
 * the only time it is ever shown: Armada keeps its hash. Better Auth lets only
 * the organization's owners do it.
 */
export async function createApiKey(_: ApiKeyState, form: FormData): Promise<ApiKeyState> {
  const viewer = await requireMember();
  const { auth, client } = await requireAccounts();
  const name = text(form, "name").replace(/\s+/g, " ").slice(0, 32);
  if (!name) return { error: "invalid" };
  try {
    const created = await auth.api.createApiKey({
      body: { name, organizationId: viewer.organization.id },
      headers: await headers(),
    });
    // Its rights are its creator's, as long as they hold them (THE-859).
    await recordApiKeyCreator(client, {
      id: created.id,
      organization: viewer.organization.id,
      user: viewer.user.id,
      now: new Date(),
    });
    revalidatePath(KEYS_PATH);
    return { key: created.key, name };
  } catch (err) {
    return { error: orgError(err) };
  }
}

export async function revokeApiKey(form: FormData): Promise<void> {
  const { auth } = await requireAccounts();
  await change(
    "revoked",
    (_, h) => auth.api.deleteApiKey({ body: { keyId: text(form, "key") }, headers: h }),
    KEYS_PATH,
  );
}

// ------------------------------------------------------------ armada login

function deviceError(err: unknown): DeviceError {
  if (!(err instanceof APIError)) {
    console.error(`armada dashboard: device sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
  const body = (err.body ?? {}) as { error?: unknown; error_description?: unknown };
  if (err.statusCode === 403 || body.error === "access_denied") return "forbidden";
  if (
    String(body.error_description ?? "")
      .toLowerCase()
      .includes("already")
  )
    return "used";
  if (err.statusCode === 400) return "unknown";
  return "failed";
}

/** Approves or denies the code `armada login` shows; only the person the code was opened by can. */
async function decideDevice(form: FormData, approve: boolean): Promise<void> {
  await requireSession();
  const { auth } = await requireAccounts();
  const userCode = text(form, "code");
  try {
    const h = await headers();
    if (approve) await auth.api.deviceApprove({ body: { userCode }, headers: h });
    else await auth.api.deviceDeny({ body: { userCode }, headers: h });
  } catch (err) {
    redirect(`${DEVICE_PATH}?${new URLSearchParams({ user_code: userCode, error: deviceError(err) })}`);
  }
  redirect(`${DEVICE_PATH}?done=${approve ? "approved" : "denied"}`);
}

export async function approveDevice(form: FormData): Promise<void> {
  await decideDevice(form, true);
}

export async function denyDevice(form: FormData): Promise<void> {
  await decideDevice(form, false);
}
