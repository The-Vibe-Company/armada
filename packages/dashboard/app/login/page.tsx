import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { signInWithEmail, signInWithGitHub, signUpWithEmail } from "@/app/auth-actions";
import { AuthCard, AuthNotice } from "@/components/AuthCard";
import { Button, Input } from "@/components/page";
import { accountsModeOf } from "@/lib/accounts-settings";
import { LOGIN_ROUTE, safeNext } from "@/lib/auth";
import { AUTH_ERRORS, type AuthError, LANGUAGE_COOKIE, STRINGS, type Strings } from "@/lib/i18n";
import { languageOf } from "@/lib/server";

// The proxy lets a viewer without a session reach this page and the sign-in
// routes, nothing else. With accounts it offers GitHub (and email and password
// where enabled); until they are configured, the shared password (THE-834).
export const dynamic = "force-dynamic";

type Params = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  const t = STRINGS[languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value)];
  return { title: `${t.auth.title} — Armada` };
}

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/** Our own codes, plus the ones Better Auth adds to the URL when GitHub sign-in fails. */
function errorOf(value: string | undefined): AuthError | null {
  if (!value) return null;
  if ((AUTH_ERRORS as readonly string[]).includes(value)) return value as AuthError;
  const code = value.toUpperCase();
  if (code.includes("NOT_INVITED")) return "not-invited";
  if (code.includes("GITHUB_EMAIL_NOT_VERIFIED")) return "github-unverified";
  if (code.includes("RATE") || code.includes("TOO_MANY")) return "limited";
  return "github";
}

export default async function Login({ searchParams }: { searchParams: Params }) {
  const [jar, params] = await Promise.all([cookies(), searchParams]);
  const t = STRINGS[languageOf(jar.get(LANGUAGE_COOKIE)?.value)];
  const mode = accountsModeOf(process.env);
  // Half-configured accounts: proxy.ts already answers 503.
  if (mode.kind === "incomplete") notFound();
  if (mode.kind === "off") return <PasswordLogin t={t} error={one(params.error)} next={one(params.next)} />;
  const github = mode.settings.github !== null;
  const emailPassword = mode.settings.emailPassword;
  const error = errorOf(one(params.error));
  const sent = one(params.sent) === "1";
  const signUp = emailPassword && one(params.mode) === "signup";
  // Only the path matters here; the actions check it again.
  const next = safeNext(one(params.next), new URL("http://dashboard.local"));
  const switchMode = new URLSearchParams(signUp ? {} : { mode: "signup" });
  if (next !== "/") switchMode.set("next", next);

  return (
    <AuthCard kicker={t.auth.kicker} heading={t.auth.heading} lead={t.auth.lead}>
      {sent && <AuthNotice tone="done">{t.auth.sent}</AuthNotice>}
      {error && (
        <AuthNotice tone="critical" id="login-error">
          {t.auth.errors[error]}
        </AuthNotice>
      )}
      {github && (
        <form action={signInWithGitHub} className="au-form">
          <input type="hidden" name="next" value={next} />
          <Button className="au-submit is-github">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            {t.auth.github}
          </Button>
        </form>
      )}
      {emailPassword && (
        <>
          {github && <div className="au-or">{t.auth.orEmail}</div>}
          <form action={signUp ? signUpWithEmail : signInWithEmail} className="au-form">
            <input type="hidden" name="next" value={next} />
            {signUp && (
              <>
                <label htmlFor="name">{t.auth.name}</label>
                <Input id="name" name="name" autoComplete="name" required maxLength={80} />
              </>
            )}
            <label htmlFor="email">{t.auth.email}</label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "login-error" : undefined}
            />
            <label htmlFor="password">{t.auth.password}</label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete={signUp ? "new-password" : "current-password"}
              required
              minLength={signUp ? 12 : undefined}
              maxLength={128}
              placeholder={signUp ? t.auth.passwordHint : undefined}
              aria-invalid={error ? true : undefined}
            />
            <Button tone="primary" className="au-submit">
              {signUp ? t.auth.signUp : t.auth.signIn}
            </Button>
          </form>
          <p className="au-foot">
            <a className="au-link" href={`/login${switchMode.size ? `?${switchMode}` : ""}`}>
              {signUp ? t.auth.toSignIn : t.auth.toSignUp}
            </a>
          </p>
        </>
      )}
      <p className="au-hint">{t.auth.hint}</p>
    </AuthCard>
  );
}

/** The shared-password form of THE-834, while accounts are not configured. */
function PasswordLogin({
  t,
  error: raw,
  next: rawNext,
}: {
  t: Strings;
  error: string | undefined;
  next: string | undefined;
}) {
  const error = raw === "wrong" || raw === "limited" ? raw : null;
  // Only the path matters here; the login route checks it again against the real origin.
  const next = safeNext(rawNext, new URL("http://dashboard.local"));
  return (
    <AuthCard kicker={t.gate.kicker} heading={t.gate.heading} lead={t.gate.lead}>
      <form method="post" action={LOGIN_ROUTE} className="au-form">
        <input type="hidden" name="next" value={next} />
        <label htmlFor="password">{t.gate.password}</label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "login-error" : undefined}
        />
        {error && (
          <AuthNotice tone="critical" id="login-error">
            {t.gate[error]}
          </AuthNotice>
        )}
        <Button tone="primary" className="au-submit">
          {t.gate.submit}
        </Button>
      </form>
      <p className="au-hint">{t.gate.hint}</p>
    </AuthCard>
  );
}
