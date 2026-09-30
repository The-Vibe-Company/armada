import type { Metadata } from "next";
import { cookies } from "next/headers";
import { LOGIN_ROUTE, safeNext } from "@/lib/auth";
import { LANGUAGE_COOKIE, STRINGS } from "@/lib/i18n";
import { languageOf } from "@/lib/server";

// The proxy lets a viewer without a session reach this page and nothing else.
export const dynamic = "force-dynamic";

type Params = Promise<{ error?: string | string[]; next?: string | string[] }>;

export async function generateMetadata(): Promise<Metadata> {
  const t = STRINGS[languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value)];
  return { title: `${t.auth.title} — Armada` };
}

export default async function Login({ searchParams }: { searchParams: Params }) {
  const [jar, params] = await Promise.all([cookies(), searchParams]);
  const t = STRINGS[languageOf(jar.get(LANGUAGE_COOKIE)?.value)];
  const error = params.error === "wrong" || params.error === "limited" ? params.error : null;
  // Only the path matters here; the login route checks it again against the real origin.
  const next = safeNext(params.next, new URL("http://dashboard.local"));
  return (
    <main className="login">
      <div className="login-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          Armada <small>{t.brandSub}</small>
        </div>
        <div className="kicker mono">{t.auth.kicker}</div>
        <h1 className="serif">{t.auth.heading}</h1>
        <p className="login-lead">{t.auth.lead}</p>
        <form method="post" action={LOGIN_ROUTE} className="login-form">
          <input type="hidden" name="next" value={next} />
          <label htmlFor="password">{t.auth.password}</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            // biome-ignore lint/a11y/noAutofocus: the password is the page's only field.
            autoFocus
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "login-error" : undefined}
          />
          {error && (
            <p id="login-error" className="login-error" role="alert">
              {t.auth[error]}
            </p>
          )}
          <button type="submit">{t.auth.submit}</button>
        </form>
        <p className="login-hint">{t.auth.hint}</p>
      </div>
    </main>
  );
}
