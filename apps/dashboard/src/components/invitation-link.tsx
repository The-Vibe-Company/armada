"use client";

import { Loader2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { adoptEmailLink, type EmailLinkCheck, inspectEmailLink } from "@/app/actions/invitation-signin";
import {
  INVITATION_LOGIN_HREF,
  IntendedEmailField,
  IntendedEmailIntro,
  InvitationShell,
  OwnSignIn,
} from "@/components/invitations";
import { Button } from "@/components/ui/button";
import { parseEmailLinkFragment } from "@/lib/invitations";

declare global {
  interface Window {
    __armadaEmailLink?: string | undefined;
  }
}

/**
 * Runs while the HTML is parsed, before hydration or any other script: GoTrue's session fragment leaves the address
 * bar and the history at once, so nothing that later reads `location` (a script, an error report, a bookmark) sees it.
 * The bridge below picks it up from memory.
 */
export const STRIP_EMAIL_LINK_SCRIPT = `(function(){var h=location.hash;if(h&&/(^#|&)(access_token|refresh_token|error|error_code)=/.test(h)){window.__armadaEmailLink=h;history.replaceState(history.state,"",location.pathname+location.search)}})()`;

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "choose"; hash: string; check: Extract<EmailLinkCheck, { ok: true }>; error?: string; busy?: boolean }
  | { kind: "error"; message: string };

/**
 * The invitation email's sign-in, when GoTrue put the session in the URL fragment. The server checks who it is and
 * that the invitation is theirs; the person then chooses to continue as that account. Only then is the session
 * stored, and joining is still the page's own button afterwards. The fragment lives in this component's memory only.
 */
export function EmailLinkBridge({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    const hash = window.__armadaEmailLink ?? window.location.hash;
    window.__armadaEmailLink = undefined;
    if (window.location.hash) window.history.replaceState(window.history.state, "", window.location.pathname);
    if (!hash || !parseEmailLinkFragment(hash)) return;
    setPhase({ kind: "checking" });
    inspectEmailLink(hash).then(
      (check) => setPhase(check.ok ? { kind: "choose", hash, check } : { kind: "error", message: check.error }),
      () => setPhase({ kind: "error", message: "This sign-in link could not be checked. Try again." }),
    );
  }, []);

  if (phase.kind === "idle") return children;
  if (phase.kind === "checking")
    return (
      <InvitationShell title="Checking your sign-in link">
        <p className="flex items-center gap-2">
          <Loader2Icon className="size-4 animate-spin" aria-hidden /> One moment.
        </p>
      </InvitationShell>
    );
  if (phase.kind === "error")
    return (
      <InvitationShell title="This sign-in link did not work" alert>
        <p role="alert">{phase.message}</p>
        <Button asChild className="w-full sm:w-auto">
          <Link href={INVITATION_LOGIN_HREF}>Sign in with your email address</Link>
        </Button>
      </InvitationShell>
    );

  const { check, hash } = phase;
  const signIn = async (form: FormData) => {
    const typed = String(form.get("email") ?? "");
    setPhase({ kind: "choose", hash, check, busy: true });
    const result = await adoptEmailLink(hash, typed).catch(() => null);
    if (!result?.ok) {
      // Nothing was stored: the person can retype, sign in their own way, or stay as they are.
      setPhase({ kind: "choose", hash, check, error: result && !result.ok ? result.error : "Signing in failed." });
      return;
    }
    setPhase({ kind: "idle" });
    router.refresh();
  };
  return (
    <InvitationShell title="Confirm your email address">
      <IntendedEmailIntro />
      {check.currentEmail && (
        <p role="note">
          This browser is signed in as <strong className="break-words text-foreground">{check.currentEmail}</strong>.
          Signing in with this link replaces that session here.
        </p>
      )}
      <form action={signIn} className="flex flex-col gap-3">
        <IntendedEmailField />
        {phase.error && (
          <p role="alert" className="text-sm text-destructive">
            {phase.error}
          </p>
        )}
        <Button type="submit" disabled={phase.busy} className="w-full">
          {phase.busy && <Loader2Icon className="animate-spin" />}
          Sign in with this link
        </Button>
      </form>
      <Button variant="outline" onClick={() => setPhase({ kind: "idle" })} className="w-full">
        {check.currentEmail ? `Stay as ${check.currentEmail}` : "Not now"}
      </Button>
      <OwnSignIn />
    </InvitationShell>
  );
}
