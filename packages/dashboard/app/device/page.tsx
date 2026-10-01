import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { approveDevice, denyDevice, signOut } from "@/app/auth-actions";
import { AuthCard, AuthNotice } from "@/components/AuthCard";
import { Button, Form, Input } from "@/components/page";
import { requireAccounts, requireSession } from "@/lib/accounts-server";
import { accountsModeOf, DEVICE_PATH } from "@/lib/accounts-settings";
import { DEVICE_ERRORS, type DeviceError, LANGUAGE_COOKIE, STRINGS } from "@/lib/i18n";
import { languageOf } from "@/lib/server";

// Where a person confirms the code `armada login` shows in their terminal.
// The proxy sends a viewer without a session to the sign-in page first and
// back here after. Opening a code binds it to the signed-in person; only they
// can then approve or deny it (Better Auth's device authorization).
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = STRINGS[languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value)];
  return { title: `${t.device.title} — Armada` };
}

type Params = Promise<{ user_code?: string | string[]; error?: string | string[]; done?: string | string[] }>;

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim() : "");

/** The code as the terminal shows it: XXXX-XXXX. */
const shown = (code: string) => {
  const c = code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
};

export default async function Device({ searchParams }: { searchParams: Params }) {
  if (accountsModeOf(process.env).kind !== "accounts") notFound();
  const viewer = await requireSession();
  const [{ auth }, jar, params, h] = await Promise.all([requireAccounts(), cookies(), searchParams, headers()]);
  const t = STRINGS[languageOf(jar.get(LANGUAGE_COOKIE)?.value)];
  const code = one(params.user_code).slice(0, 64);
  const done = one(params.done);
  let error: DeviceError | null = (DEVICE_ERRORS as readonly string[]).includes(one(params.error))
    ? (one(params.error) as DeviceError)
    : null;

  if (done === "approved" || done === "denied")
    return (
      <AuthCard
        kicker={t.device.title}
        heading={done === "approved" ? t.device.approvedHeading : t.device.deniedHeading}
        lead={done === "approved" ? t.device.approved : t.device.denied}
      >
        <p className="au-foot">
          <Link className="au-link" href="/">
            {t.org.back}
          </Link>
        </p>
      </AuthCard>
    );

  // Opening the code binds it to this person, the first to open it.
  const status = code
    ? await auth.api
        .deviceVerify({ query: { user_code: code }, headers: h })
        .then((r) => r.status)
        .catch(() => null)
    : null;
  if (code && !error && status === null) error = "unknown";
  if (code && !error && status && status !== "pending") error = "used";

  if (!code || status !== "pending")
    return (
      <AuthCard kicker={t.device.title} heading={t.device.title} lead={t.device.enterLead}>
        {error && <AuthNotice tone="critical">{t.device.errors[error]}</AuthNotice>}
        <form action={DEVICE_PATH} method="get" className="au-form">
          <label htmlFor="user_code">{t.device.code}</label>
          <Input
            id="user_code"
            name="user_code"
            className="mono"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
            placeholder="ABCD-EFGH"
          />
          <Button tone="primary" className="au-submit">
            {t.device.next}
          </Button>
        </form>
      </AuthCard>
    );

  return (
    <AuthCard
      kicker={t.device.title}
      heading={t.device.confirmHeading}
      lead={t.device.confirmLead(viewer.user.email, viewer.organization?.name ?? null)}
    >
      {error && <AuthNotice tone="critical">{t.device.errors[error]}</AuthNotice>}
      <p className="au-code mono">{shown(code)}</p>
      <div className="au-actions">
        <Form action={approveDevice} grow>
          <input type="hidden" name="code" value={code} />
          <Button tone="primary" className="au-submit">
            {t.device.approve}
          </Button>
        </Form>
        <Form action={denyDevice}>
          <input type="hidden" name="code" value={code} />
          <Button className="au-submit">{t.device.deny}</Button>
        </Form>
      </div>
      <p className="au-hint">{t.device.signedInAs(viewer.user.email)}</p>
      <form action={signOut} className="au-foot">
        <button type="submit" className="au-link">
          {t.auth.logout}
        </button>
      </form>
    </AuthCard>
  );
}
